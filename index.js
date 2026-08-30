/**
 * HijjazI AI - WhatsApp Automation & AI Assistant
 * Copyright (c) 2024 HijjazI AI
 * 
 * Baileys Multi-Device WhatsApp Socket Manager
 */
require('./settings');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const chalk = require('chalk');
const path = require('path');
const pino = require('pino');
const NodeCache = require('node-cache');
const qrcode = require('qrcode');
const PhoneNumber = require('awesome-phonenumber');
const sessionVault = require('./lib/sessionVault');
const botState = require('./lib/botState');

// Intercept and auto-heal known transient libsignal / Signal protocol decryption errors
const originalConsoleError = console.error;
console.error = function(...args) {
    const fullText = args.map(a => (typeof a === 'object' ? (a?.stack || a?.message || JSON.stringify(a)) : String(a))).join(' ');
    if (
        fullText.includes('Failed to decrypt message with any known session') ||
        fullText.includes('Session error:Error: Bad MAC') ||
        fullText.includes('Session error: Error: Bad MAC') ||
        fullText.includes('Session error:') ||
        fullText.includes('Bad MAC')
    ) {
        // Auto-heal session keys in the background
        try {
            sessionVault.autoHealBadMac();
        } catch (e) {}
        console.warn(chalk.yellow('🛡️ [Session Auto-Repair] Auto-healed Signal decryption session ratchet (Bad MAC desync resolved).'));
        return;
    }
    originalConsoleError.apply(console, args);
};

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    jidDecode,
    jidNormalizedUser,
    makeCacheableSignalKeyStore,
    delay,
    Browsers,
    generateWAMessageFromContent,
    proto
} = require('@whiskeysockets/baileys');

const { handleMessages, handleGroupParticipantUpdate, handleStatus, handleOwnerReactionEvent, handleOwnerReactionUpsert } = require('./main');
const { smsg } = require('./lib/myfunc');
const store = require('./lib/lightweight_store');
const settings = require('./settings');
const { getGroupMetadataSafe, invalidateGroupMetadata } = require('./lib/groupMetadataCache');
const { cacheIncomingViewOnce } = require('./lib/viewonceCache');
const { cacheStatusMessage } = require('./lib/statusCache');
const { handleStatusAutoRecovery, handleStatusRevocation } = require('./lib/mediaRecovery');
const { storeMessage } = require('./commands/antidelete');

// Global 24/7 Crash Shield - Ensures process never exits on unexpected network or socket exceptions
process.on('uncaughtException', (err) => {
    const errMsg = err?.message || String(err || '');
    if (errMsg.includes('Bad MAC') || errMsg.includes('Failed to decrypt message') || errMsg.includes('Session error') || errMsg.includes('SessionError')) {
        console.warn(chalk.yellow('🛡️ [Session Auto-Repair] Corrupted session ratchet detected (Bad MAC). Auto-healing Signal keys...'));
        try {
            const count = sessionVault.autoHealBadMac();
            botState.addLog(`🛡️ Auto-healed corrupted Signal session ratchet (Bad MAC repaired, ${count} stale ratchets cleared)`, 'info');
        } catch (e) {}
        return;
    }
    console.error(chalk.red('🛡️ [24/7 Shield] Uncaught exception caught:'), errMsg);
    try { botState.addLog(`🛡️ Protected from crash: ${errMsg}`, 'warn'); } catch (e) {}
});

process.on('unhandledRejection', (reason) => {
    const msg = reason?.message || String(reason || 'Unknown rejection');
    if (msg.includes('Bad MAC') || msg.includes('Failed to decrypt message') || msg.includes('Session error') || msg.includes('SessionError')) {
        console.warn(chalk.yellow('🛡️ [Session Auto-Repair] Corrupted session ratchet in promise (Bad MAC). Auto-healing Signal keys...'));
        try {
            const count = sessionVault.autoHealBadMac();
            botState.addLog(`🛡️ Auto-healed corrupted Signal session ratchet (Bad MAC repaired, ${count} stale ratchets cleared)`, 'info');
        } catch (e) {}
        return;
    }
    console.error(chalk.yellow('🛡️ [24/7 Shield] Unhandled rejection:'), msg);
});

/**
 * Creates a self-healing Signal Key Store wrapper around Baileys key store
 * Automatically recovers from corrupted keys or Bad MAC errors on specific ratchets
 */
function createResilientSignalKeyStore(keys, logger) {
    const keyCache = new NodeCache({ stdTTL: 300, useClones: false });
    const baseStore = makeCacheableSignalKeyStore(keys, logger, keyCache);
    return {
        get: async (type, ids) => {
            try {
                return await baseStore.get(type, ids);
            } catch (err) {
                const msg = err?.message || String(err || '');
                if (msg.includes('Bad MAC') || msg.includes('Failed to decrypt') || msg.includes('Session error') || msg.includes('SessionError')) {
                    try {
                        keyCache.flushAll();
                        for (const id of ids) {
                            sessionVault.autoHealBadMac(id);
                        }
                    } catch {}
                }
                return {};
            }
        },
        set: async (data) => {
            try {
                return await baseStore.set(data);
            } catch (err) {
                const msg = err?.message || String(err || '');
                if (msg.includes('Bad MAC') || msg.includes('Session error')) {
                    try { keyCache.flushAll(); } catch {}
                }
            }
        },
        clear: async () => {
            try {
                keyCache.flushAll();
                if (baseStore.clear) await baseStore.clear();
            } catch {}
        }
    };
}

// Initialize lightweight message & contact store
store.readFromFile();
setInterval(() => store.writeToFile(), settings.storeWriteInterval || 10000);

// Memory optimization
setInterval(() => {
    if (global.gc) {
        try { global.gc(); } catch (e) {}
    }
}, 60_000);

global.botname = settings.botname || settings.botName || 'HijjazI AI';
global.themeemoji = settings.themeemoji || '•';

let activeBotSocket = null;
let isStarting = false;
let reconnectTimer = null;
let consecutiveFailures = 0;

// Initialize & restore session credentials permanently from environmental variables or vault
function initSessionFromVaultAndEnv() {
    try {
        sessionVault.ensureDirectories();

        // 1. Priority: Check Environmental Variables (SESSION_ID, CREDS_JSON, SESSION_DATA, WA_SESSION, etc.)
        const envSession = sessionVault.detectSessionFromEnvironment();
        if (envSession.detected && envSession.creds) {
            sessionVault.persistCreds(envSession.creds);
            botState.checkCreds();
            const accountInfo = envSession.user?.name || envSession.user?.id || 'Configured Account';
            botState.addLog(`🔑 Detected WhatsApp session from environmental variable (${envSession.source}) [${accountInfo}]. Activating session...`, 'success');
            console.log(chalk.green(`🔑 [Env Detector] Activated WhatsApp session from environmental variable: ${envSession.source}`));
            return true;
        }

        // 2. Fallback to persistent session vault and local file storage
        const restoredFromVault = sessionVault.restoreCredsIfNeeded();
        if (restoredFromVault) {
            botState.checkCreds();
            console.log(chalk.green('🔒 [Vault] Loaded existing credentials from storage vault'));
            return true;
        }

        botState.checkCreds();
        return false;
    } catch (e) {
        console.error('Error in initSessionFromVaultAndEnv:', e);
        return false;
    }
}

// Cleanly close existing socket before recreation
async function closeActiveSocket(reason = 'Socket recreating') {
    if (activeBotSocket) {
        const sock = activeBotSocket;
        activeBotSocket = null;
        try {
            if (sock.ev && typeof sock.ev.removeAllListeners === 'function') {
                sock.ev.removeAllListeners();
            }
            if (sock.ws) {
                try {
                    if (typeof sock.ws.removeAllListeners === 'function') sock.ws.removeAllListeners();
                    if (typeof sock.ws.terminate === 'function') sock.ws.terminate();
                    else if (typeof sock.ws.close === 'function') sock.ws.close();
                } catch (e) {}
            }
            if (typeof sock.end === 'function') {
                sock.end(new Boom(reason, { statusCode: DisconnectReason.connectionReplaced }));
            }
        } catch (e) {
            // ignore close errors
        }
        await delay(600);
    }
}

async function startXeonBotInc(isPairing = false) {
    if (isStarting) {
        console.log(chalk.yellow('Socket start already in progress, waiting...'));
        return activeBotSocket;
    }

    isStarting = true;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    try {
        await closeActiveSocket('Restarting socket');
        if (!isPairing) {
            initSessionFromVaultAndEnv();
        }

        let version = [2, 3000, 1015901307];
        try {
            const fetched = await Promise.race([
                fetchLatestBaileysVersion(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Version fetch timeout')), 3500))
            ]);
            if (fetched && fetched.version) version = fetched.version;
        } catch (e) {
            // Safe fallback to default version
        }

        const { state, saveCreds } = await useMultiFileAuthState('./session');
        const msgRetryCounterCache = new NodeCache({ stdTTL: 3600, checkperiod: 120, useClones: false });

        const isPairingOrRegistered = isPairing || state.creds.registered || process.argv.includes('--pairing-code');

        const XeonBotInc = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: !isPairingOrRegistered,
            browser: Browsers ? Browsers.ubuntu('Chrome') : ['Ubuntu', 'Chrome', '22.04.4'],
            auth: {
                creds: state.creds,
                keys: createResilientSignalKeyStore(state.keys, pino({ level: 'silent' })),
            },
            markOnlineOnConnect: true,
            generateHighQualityLinkPreview: true,
            syncFullHistory: false,
            getMessage: async (key) => {
                try {
                    if (store) {
                        let jid = jidNormalizedUser(key.remoteJid);
                        let msg = await store.loadMessage(jid, key.id);
                        if (msg && msg.message) return msg.message;
                    }
                } catch {}
                return undefined;
            },
            msgRetryCounterCache,
            defaultQueryTimeoutMs: 60000,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            retryRequestDelayMs: 500,
            maxMsgRetryCount: 5
        });

        // Save credentials when updated & sync permanently to vault
        XeonBotInc.ev.on('creds.update', async () => {
            try {
                await saveCreds();
                sessionVault.persistCreds();
                botState.checkCreds();
            } catch (err) {
                console.error('Error saving creds:', err);
            }
        });

        store.bind(XeonBotInc.ev);

        // Safe group metadata wrapper
        const originalGroupMetadata = XeonBotInc.groupMetadata ? XeonBotInc.groupMetadata.bind(XeonBotInc) : null;
        XeonBotInc.rawGroupMetadata = originalGroupMetadata;
        XeonBotInc.groupMetadata = async (chatId) => {
            return (await getGroupMetadataSafe(XeonBotInc, chatId)) || { id: chatId, participants: [] };
        };

        // Helper methods on socket
        XeonBotInc.decodeJid = (jid) => {
            if (!jid) return jid;
            if (/:\d+@/gi.test(jid)) {
                let decode = jidDecode(jid) || {};
                return decode.user && decode.server && decode.user + '@' + decode.server || jid;
            } else return jid;
        };

        XeonBotInc.getName = (jid, withoutContact = false) => {
            let id = XeonBotInc.decodeJid(jid);
            withoutContact = XeonBotInc.withoutContact || withoutContact;
            let v;
            if (id.endsWith('@g.us')) {
                return new Promise(async (resolve) => {
                    v = store.contacts[id] || {};
                    if (!(v.name || v.subject)) {
                        v = (await getGroupMetadataSafe(XeonBotInc, id)) || {};
                    }
                    resolve(v.name || v.subject || PhoneNumber('+' + id.replace('@s.whatsapp.net', '')).getNumber('international'));
                });
            } else {
                v = id === '0@s.whatsapp.net' ? { id, name: 'WhatsApp' } :
                    id === XeonBotInc.decodeJid(XeonBotInc.user?.id) ? XeonBotInc.user :
                    (store.contacts[id] || {});
            }
            return (withoutContact ? '' : v.name) || v.subject || v.verifiedName || PhoneNumber('+' + jid.replace('@s.whatsapp.net', '')).getNumber('international');
        };

        XeonBotInc.public = true;
        XeonBotInc.serializeM = (m) => smsg(XeonBotInc, m, store);

        // Messages upsert
        XeonBotInc.ev.on('messages.upsert', async (chatUpdate) => {
            try {
                const mek = chatUpdate.messages[0];
                if (!mek) return;

                // If message failed decryption (CIPHERTEXT stub), heal session for that sender
                if (mek.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT || !mek.message) {
                    const stubParam = mek.messageStubParameters?.[0] || '';
                    if (stubParam.includes('Bad MAC') || stubParam.includes('Failed to decrypt') || stubParam.includes('Session error') || stubParam.includes('SessionError')) {
                        const targetId = mek.key?.participant || mek.key?.remoteJid;
                        if (targetId) {
                            sessionVault.autoHealBadMac(targetId);
                        }
                    }
                    return;
                }

                botState.incrementMessageCount();

                // Store messages, cache view-once media and handle owner reactions for all messages in the batch
                if (Array.isArray(chatUpdate.messages)) {
                    for (const m of chatUpdate.messages) {
                        if (m && m.message) {
                            storeMessage(XeonBotInc, m);
                            cacheIncomingViewOnce(m);
                            if (m.message?.reactionMessage) {
                                handleOwnerReactionUpsert(XeonBotInc, m).catch(e => console.error('Owner reaction upsert error:', e.message));
                            }
                        }
                    }
                }

                mek.message = (Object.keys(mek.message)[0] === 'ephemeralMessage') ? mek.message.ephemeralMessage.message : mek.message;

                const protoMsg = mek.message?.protocolMessage || mek.message?.ephemeralMessage?.message?.protocolMessage || mek.message?.viewOnceMessage?.message?.protocolMessage || mek.message?.viewOnceMessageV2?.message?.protocolMessage;

                if (mek.key && mek.key.remoteJid === 'status@broadcast') {
                    // Check if this is a deleted status revocation
                    if (protoMsg && (protoMsg.type === 0 || protoMsg.type === 'REVOKE' || protoMsg.key?.id)) {
                        handleStatusRevocation(XeonBotInc, mek).catch(e => console.error('Status revocation error:', e.message));
                        return;
                    }
                    cacheStatusMessage(mek);
                    handleStatusAutoRecovery(XeonBotInc, mek).catch(e => console.error('Status recovery error:', e.message));
                    await handleStatus(XeonBotInc, chatUpdate);
                    return;
                }

                // If protocol message for status deletion arrives in regular upsert
                if (protoMsg && (protoMsg.key?.remoteJid === 'status@broadcast' || protoMsg.type === 0 || protoMsg.type === 'REVOKE')) {
                    handleStatusRevocation(XeonBotInc, mek).catch(e => console.error('Status revocation error:', e.message));
                }

                if (!XeonBotInc.public && !mek.key.fromMe && chatUpdate.type === 'notify') {
                    const isGroup = mek.key?.remoteJid?.endsWith('@g.us');
                    if (!isGroup) return;
                }

                if (mek.key.id && mek.key.id.startsWith('BAE5') && mek.key.id.length === 16) return;

                try {
                    await handleMessages(XeonBotInc, chatUpdate, true);
                } catch (err) {
                    console.error('Error in handleMessages:', err);
                }
            } catch (err) {
                console.error('Error in messages.upsert:', err);
            }
        });

        // Messages update (captures message revocations / delete for everyone)
        XeonBotInc.ev.on('messages.update', async (updates) => {
            try {
                const { handleMessageRevocation } = require('./commands/antidelete');
                for (const update of updates) {
                    if (update.update?.protocolMessage || update.update?.messageStubType === 68 || update.update?.message === null || update.key?.remoteJid === 'status@broadcast') {
                        handleStatusRevocation(XeonBotInc, update).catch(e => console.error('Status revocation error in update:', e.message));
                        await handleMessageRevocation(XeonBotInc, update);
                    }
                }
            } catch (err) {
                console.error('Error in messages.update:', err);
            }
        });

        // Contacts update
        XeonBotInc.ev.on('contacts.update', (update) => {
            for (let contact of update) {
                let id = XeonBotInc.decodeJid(contact.id);
                if (store && store.contacts) store.contacts[id] = { id, name: contact.notify };
            }
        });

        // Group participants update
        XeonBotInc.ev.on('group-participants.update', async (update) => {
            if (update?.id) {
                invalidateGroupMetadata(update.id);
            }
            await handleGroupParticipantUpdate(XeonBotInc, update);
        });

        XeonBotInc.ev.on('groups.update', async (updates) => {
            if (Array.isArray(updates)) {
                for (const u of updates) {
                    if (u?.id) invalidateGroupMetadata(u.id);
                }
            }
        });

        // Status updates & reactions
        XeonBotInc.ev.on('status.update', async (status) => {
            await handleStatus(XeonBotInc, status);
        });

        XeonBotInc.ev.on('messages.reaction', async (reactions) => {
            handleOwnerReactionEvent(XeonBotInc, reactions).catch(e => console.error('Owner reaction event error:', e.message));
            await handleStatus(XeonBotInc, reactions);
        });

        // Anticall handler
        const antiCallNotified = new Set();
        XeonBotInc.ev.on('call', async (calls) => {
            try {
                const { readState: readAnticallState } = require('./commands/anticall');
                const state = readAnticallState();
                if (!state.enabled) return;
                for (const call of calls) {
                    const callerJid = call.from || call.peerJid || call.chatId;
                    if (!callerJid) continue;
                    try {
                        if (typeof XeonBotInc.rejectCall === 'function' && call.id) {
                            await XeonBotInc.rejectCall(call.id, callerJid);
                        } else if (typeof XeonBotInc.sendCallOfferAck === 'function' && call.id) {
                            await XeonBotInc.sendCallOfferAck(call.id, callerJid, 'reject');
                        }
                        if (!antiCallNotified.has(callerJid)) {
                            antiCallNotified.add(callerJid);
                            setTimeout(() => antiCallNotified.delete(callerJid), 60000);
                            await XeonBotInc.sendMessage(callerJid, { text: '📵 Anticall is enabled. Your call was rejected and you will be blocked.' });
                        }
                    } catch {}
                    setTimeout(async () => {
                        try { await XeonBotInc.updateBlockStatus(callerJid, 'block'); } catch {}
                    }, 800);
                }
            } catch (e) {}
        });

        // Connection Handling
        XeonBotInc.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log(chalk.yellow('📱 [QR Event] Fresh WhatsApp QR code received:'));
                try {
                    const qrcodeTerminal = require('qrcode-terminal');
                    qrcodeTerminal.generate(qr, { small: true });
                } catch (e) {
                    console.log(chalk.cyan(`QR String: ${qr}`));
                }
                botState.setStatus('qr_ready', { qrCode: null, pairingCode: null });
                botState.addLog('📱 WhatsApp QR Code generated in terminal', 'info');
            }

            if (connection === 'connecting') {
                console.log(chalk.yellow('🔄 Connecting to WhatsApp...'));
                botState.setStatus('connecting', { error: null });
                botState.addLog('🔄 Connecting to WhatsApp...', 'info');
            }

            if (connection === 'open') {
                consecutiveFailures = 0;
                // Secure credentials in persistent vault forever
                sessionVault.persistCreds();
                sessionVault.backupSessionKeys();
                botState.checkCreds();

                botState.setStatus('connected', { user: XeonBotInc.user, qrCode: null, pairingCode: null, error: null });
                botState.addLog('🌿 Connected to WhatsApp: ' + (XeonBotInc.user?.name || XeonBotInc.user?.id || 'Bot Online'), 'success');
                botState.addLog('🔒 WhatsApp session permanently stored in file vault (24/7 protected)', 'success');
                console.log(chalk.green('🌿 Connected to WhatsApp => ' + JSON.stringify(XeonBotInc.user, null, 2)));

                // Send simple connected message directly to the connected user's WhatsApp number after connection stabilizes
                setTimeout(() => {
                    sendConnectedMessageToUser(XeonBotInc).catch(err => {
                        console.log('Connected message check completed.');
                    });
                }, 3500);
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const errorMessage = lastDisconnect?.error?.message || String(lastDisconnect?.error || 'Closed');
                const errLower = errorMessage.toLowerCase();

                const isConflict = statusCode === DisconnectReason.connectionReplaced || statusCode === 440 || errLower.includes('conflict') || errLower.includes('replaced');
                const isRestartRequired = (statusCode === DisconnectReason.restartRequired || statusCode === 515 || statusCode === 503 || (errLower.includes('stream errored') && !isConflict) || errLower.includes('restart required'));
                const isLoggedOut = !isConflict && !isRestartRequired && (statusCode === DisconnectReason.loggedOut || (statusCode === 401 && !errLower.includes('stream errored')));
                const isReplaced = isConflict;
                const shouldReconnect = !isLoggedOut;

                if (isRestartRequired) {
                    console.log(chalk.cyan(`🔄 WhatsApp stream refresh handshake (code: 515) - reconnecting seamlessly...`));
                } else if (isConflict) {
                    console.log(chalk.yellow(`⚡ WhatsApp stream conflict / connection replaced (code: 440) - releasing socket and auto-reconnecting...`));
                } else {
                    console.log(chalk.red(`Connection closed due to: ${errorMessage} (status code: ${statusCode}), reconnecting: ${shouldReconnect}`));
                }

                // Clean up closing socket listeners and terminate websocket to prevent lingering stream collisions
                try {
                    if (XeonBotInc.ev && typeof XeonBotInc.ev.removeAllListeners === 'function') {
                        XeonBotInc.ev.removeAllListeners();
                    }
                    if (XeonBotInc.ws) {
                        try {
                            if (typeof XeonBotInc.ws.removeAllListeners === 'function') XeonBotInc.ws.removeAllListeners();
                            if (typeof XeonBotInc.ws.terminate === 'function') XeonBotInc.ws.terminate();
                            else if (typeof XeonBotInc.ws.close === 'function') XeonBotInc.ws.close();
                        } catch (e) {}
                    }
                } catch (e) {}

                if (activeBotSocket === XeonBotInc) {
                    activeBotSocket = null;
                }

                if (isRestartRequired) {
                    // Standard Baileys handshake/stream refresh event (515) - reconnect cleanly without error flag
                    botState.setStatus('connecting', { error: null });
                    botState.addLog('🔄 Stream handshake synchronized (code 515) - reconnecting...', 'info');
                    consecutiveFailures = 0;
                } else if (isLoggedOut) {
                    const currentCreds = sessionVault.readCurrentCreds();
                    if (currentCreds) {
                        sessionVault.markSessionRevoked(currentCreds, 'Session was unlinked or logged out from WhatsApp');
                    }
                    sessionVault.hardResetAll();
                    botState.setStatus('disconnected', {
                        error: 'WhatsApp session was unlinked/logged out on mobile. Please connect again using Pairing Code or QR Code.',
                        user: null,
                        qrCode: null,
                        pairingCode: null
                    });
                    botState.addLog('⚠️ WhatsApp session logged out. Dead session cleared. Ready for fresh Pairing Code or QR scan.', 'warn');
                    botState.checkCreds();
                } else if (isReplaced || isConflict) {
                    botState.setStatus('conflict', { error: 'WhatsApp stream conflict (440) detected. Auto-reconnecting in background...' });
                    botState.addLog('⚠️ WhatsApp stream conflict (440) resolved. Re-establishing socket connection...', 'warn');
                } else {
                    botState.setStatus('disconnected', { error: errorMessage });
                    botState.addLog(`Connection closed (${errorMessage}). Reconnecting for 24/7 uptime...`, 'warn');
                }

                if (shouldReconnect) {
                    if (!isRestartRequired && !isConflict) {
                        consecutiveFailures++;
                    }
                    // For stream restart 515: swift (400ms); For conflict 440: release backoff (5000-8000ms); For other disconnects: exponential backoff
                    const delayMs = isRestartRequired ? 400 : (isConflict ? Math.min(5000 + (consecutiveFailures * 2000), 15000) : Math.min(2500 * Math.min(consecutiveFailures, 4), 12000));
                    if (reconnectTimer) clearTimeout(reconnectTimer);
                    reconnectTimer = setTimeout(() => {
                        reconnectTimer = null;
                        startXeonBotInc().catch((err) => {
                            console.error('Reconnect failure:', err);
                        });
                    }, delayMs);
                }
            }
        });

        activeBotSocket = XeonBotInc;
        isStarting = false;
        return activeBotSocket;
    } catch (error) {
        isStarting = false;
        consecutiveFailures++;
        console.error('Error in startXeonBotInc:', error);
        botState.setStatus('error', { error: error.message });
        botState.addLog('Error starting bot: ' + error.message, 'error');
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
            startXeonBotInc().catch(console.error);
        }, Math.min(5000 * consecutiveFailures, 20000));
    }
}

// 24/7 Automatic Watchdog & Keep-Alive Ping
// Continuously monitors connection health, auto-reconnects if disconnected, and pings WhatsApp servers
setInterval(async () => {
    try {
        const hasSessionCreds = botState.checkCreds();
        if (hasSessionCreds) {
            if (activeBotSocket && botState.status === 'connected') {
                // Keep-alive presence ping to maintain active socket connection 24/7
                try {
                    await activeBotSocket.sendPresenceUpdate('available');
                } catch (e) {
                    // socket may be reconnecting
                }
            } else if (!isStarting && !reconnectTimer && (botState.status === 'disconnected' || botState.status === 'error' || !activeBotSocket)) {
                console.log(chalk.cyan('⏱️ [24/7 Watchdog] Re-engaging bot socket to maintain 24/7 uptime...'));
                botState.addLog('⏱️ [24/7 Watchdog] Re-engaging WhatsApp connection...', 'info');
                await startXeonBotInc();
            }
        }
    } catch (err) {
        console.error('Error in 24/7 watchdog:', err.message);
    }
}, 30000);

async function sendConnectedMessageToUser(sock, force = false) {
    try {
        if (!sock || !sock.user) return;
        // Verify socket is active
        if (activeBotSocket && activeBotSocket !== sock) return;

        const rawId = sock.user.id || '';
        const cleanNumber = rawId.split(':')[0].replace(/[^0-9]/g, '');
        if (!cleanNumber) return;
        const targetJid = `${cleanNumber}@s.whatsapp.net`;

        // Prevent duplicate sending on rapid reconnections
        if (!force && sessionVault.isSessionDelivered(cleanNumber, 'connected_notice')) {
            console.log(chalk.gray(`ℹ️ [Session] Connected notification already delivered to +${cleanNumber}.`));
            return;
        }

        try {
            await sock.sendMessage(targetJid, {
                text: 'Hijjazi Ai connected'
            });
            sessionVault.markSessionDelivered(cleanNumber, 'connected_notice');
            console.log(chalk.green(`📤 [Connection] Sent connected message to +${cleanNumber}`));
            botState.addLog(`📤 Sent connected notification to WhatsApp (+${cleanNumber})`, 'success');
        } catch (e1) {
            console.log('Notice: Connected message skipped or socket reconnecting.');
        }
    } catch (err) {
        console.log('Connected notification notice:', err.message);
    }
}

async function requestPairingCodeForNumber(num) {
    if (!num) {
        throw new Error('Please provide a WhatsApp phone number with international country code (e.g. 15551234567, 919876543210)');
    }
    const cleanedNum = num.replace(/[^0-9]/g, '');
    if (cleanedNum.length < 7 || cleanedNum.length > 16) {
        throw new Error('Invalid phone number length. Please include international country code (e.g. 15551234567 or 919876543210) without + or spaces.');
    }

    // Completely reset prior/stale session so Baileys generates a fresh unregistered keypair
    sessionVault.hardResetAll();
    await closeActiveSocket('Pairing new account');
    botState.setStatus('connecting', { qrCode: null, pairingCode: null, error: null, phoneNumber: cleanedNum });
    botState.addLog(`🧹 Reset session. Initializing fresh WhatsApp socket for +${cleanedNum}...`, 'info');
    const sock = await startXeonBotInc(true);
    await delay(3200);

    try {
        botState.addLog(`🔑 Requesting pairing code for +${cleanedNum}...`, 'info');
        const targetSock = activeBotSocket || sock;
        if (!targetSock || typeof targetSock.requestPairingCode !== 'function') {
            throw new Error('WhatsApp socket initializing. Please retry in a few seconds.');
        }
        let code = await targetSock.requestPairingCode(cleanedNum);
        code = code?.match(/.{1,4}/g)?.join('-') || code;
        botState.setStatus('pairing_code', { pairingCode: code, phoneNumber: cleanedNum });
        botState.addLog(`✅ Pairing Code generated: ${code}`, 'success');
        return code;
    } catch (err) {
        console.error('Error generating pairing code, refreshing socket:', err.message);
        botState.addLog(`Retrying pairing code for +${cleanedNum}...`, 'warn');
        sessionVault.hardResetAll();
        await closeActiveSocket('Pairing code retry');
        const retrySock = await startXeonBotInc(true);
        await delay(3500);
        const targetSock = activeBotSocket || retrySock;
        let code = await targetSock.requestPairingCode(cleanedNum);
        code = code?.match(/.{1,4}/g)?.join('-') || code;
        botState.setStatus('pairing_code', { pairingCode: code, phoneNumber: cleanedNum });
        botState.addLog(`✅ Pairing Code generated: ${code}`, 'success');
        return code;
    }
}

async function requestQrCode() {
    try {
        sessionVault.hardResetAll();
        await closeActiveSocket('Generating fresh QR code');
        botState.setStatus('connecting', { qrCode: null, pairingCode: null, error: null });
        botState.addLog('📱 Reset session. Initializing fresh WhatsApp socket for QR scan...', 'info');
        await startXeonBotInc(true);

        // Wait up to 15 seconds for Baileys to emit the first QR code
        return new Promise((resolve) => {
            let finished = false;
            const interval = setInterval(() => {
                if (botState.qrCode) {
                    clearInterval(interval);
                    clearTimeout(timeout);
                    finished = true;
                    resolve({ success: true, qrCode: botState.qrCode });
                }
            }, 300);

            const timeout = setTimeout(() => {
                clearInterval(interval);
                if (!finished) {
                    resolve({
                        success: !!botState.qrCode,
                        qrCode: botState.qrCode,
                        message: botState.qrCode ? 'QR code ready' : 'WhatsApp socket initialized. QR code will appear momentarily.'
                    });
                }
            }, 14000);
        });
    } catch (err) {
        console.error('Error in requestQrCode:', err);
        botState.addLog('Failed to generate QR code: ' + err.message, 'error');
        throw err;
    }
}

async function resetSession() {
    try {
        botState.addLog('⚠️ Resetting WhatsApp session and clearing creds vault...', 'warn');
        await closeActiveSocket('Session reset');
        sessionVault.hardResetAll();
        sessionVault.clearRevokedSessions();
        botState.setStatus('disconnected', { qrCode: null, pairingCode: null, user: null, error: null });
        botState.checkCreds();
        botState.addLog('✨ Session cleared. Starting fresh bot socket for new account...', 'info');
        await delay(1000);
        await startXeonBotInc(true);
        return { success: true, message: 'Session reset successfully' };
    } catch (err) {
        botState.addLog('Failed to reset session: ' + err.message, 'error');
        throw err;
    }
}

async function importSession(credsInput) {
    try {
        if (!credsInput) throw new Error('No session data provided');
        const parsed = sessionVault.parseSessionInput(credsInput);
        if (!parsed || typeof parsed !== 'object') {
            throw new Error('Invalid creds.json or SESSION_ID format');
        }

        await closeActiveSocket('Importing session');

        // Replace credentials permanently in files and session vault
        sessionVault.replaceWithNewCreds(parsed);
        botState.checkCreds();
        const acct = parsed.me?.name || parsed.me?.id || 'Account';
        botState.addLog(`📥 Session credentials (${acct}) loaded and secured in vault. Starting bot...`, 'success');

        await delay(1000);
        await startXeonBotInc();
        return { success: true, message: 'creds.json imported and bot connected' };
    } catch (err) {
        botState.addLog('Import session failed: ' + err.message, 'error');
        throw err;
    }
}

function exportSession() {
    const credsPath = path.join(__dirname, 'session', 'creds.json');
    let targetFile = credsPath;
    if (!fs.existsSync(targetFile) || fs.statSync(targetFile).size <= 50) {
        if (fs.existsSync(sessionVault.VAULT_CREDS) && fs.statSync(sessionVault.VAULT_CREDS).size > 50) {
            targetFile = sessionVault.VAULT_CREDS;
        } else if (fs.existsSync(sessionVault.DATA_CREDS) && fs.statSync(sessionVault.DATA_CREDS).size > 50) {
            targetFile = sessionVault.DATA_CREDS;
        }
    }

    if (fs.existsSync(targetFile)) {
        try {
            const raw = fs.readFileSync(targetFile, 'utf8');
            const parsed = JSON.parse(raw);
            const base64 = Buffer.from(raw).toString('base64');
            return {
                exists: true,
                registered: !!parsed.registered,
                me: parsed.me || null,
                rawJson: raw,
                sessionId: 'HijjaziAI;;;' + base64,
                vaultSecured: true
            };
        } catch (e) {
            return { exists: false, error: e.message };
        }
    }
    return { exists: false };
}

async function repairSession() {
    try {
        botState.addLog('🛠️ Performing session auto-repair and purging stale ratchets...', 'info');
        const cleaned = sessionVault.purgeCorruptedSession();
        botState.addLog(`✨ Purged ${cleaned} stale session ratchets. Re-synchronizing WhatsApp socket...`, 'success');
        await closeActiveSocket('Repairing session');
        await delay(1000);
        await startXeonBotInc();
        return { success: true, count: cleaned, message: `Auto-repaired session (${cleaned} stale ratchets purged)` };
    } catch (err) {
        botState.addLog('Failed to repair session: ' + err.message, 'error');
        throw err;
    }
}

// Module exports for web control
module.exports = {
    startXeonBotInc,
    requestPairingCodeForNumber,
    requestQrCode,
    resetSession,
    repairSession,
    importSession,
    exportSession,
    getBotSocket: () => activeBotSocket
};

// Auto start only when executed directly (not when required by server.js)
if (require.main === module) {
    startXeonBotInc().catch((error) => {
        console.error('Fatal error in bot runner:', error);
    });
}
