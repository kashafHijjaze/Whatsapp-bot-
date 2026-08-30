const fs = require('fs');
const path = require('path');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const settings = require('../settings');
const { resolvePhoneAndLid, downloadStatusMedia, getStatusById } = require('./statusCache');
const { getOwnerSelfJid } = require('./ownerHelper');

const CONFIG_PATH = path.join(__dirname, '../data/mediaRecovery.json');
const TEMP_DIR = path.join(__dirname, '../tmp/recovery');

// Ensure tmp/recovery dir exists
try {
    if (!fs.existsSync(TEMP_DIR)) {
        fs.mkdirSync(TEMP_DIR, { recursive: true });
    }
} catch (e) {}

// Global channel & newsletter context
const channelInfo = {
    contextInfo: {
        forwardingScore: 999,
        isForwarded: true,
        forwardedNewsletterMessageInfo: {
            newsletterJid: '120363426834632590@newsletter',
            newsletterName: 'HijjazI AI',
            serverMessageId: -1
        }
    }
};

// Processed message sets to prevent duplicate forwarding
const processedStatuses = new Set();
const processedMediaMessages = new Set();
const processedDeletedStatuses = new Set();

// Clean up processed IDs periodically
setInterval(() => {
    if (processedStatuses.size > 2000) {
        const arr = Array.from(processedStatuses).slice(-1000);
        processedStatuses.clear();
        arr.forEach(id => processedStatuses.add(id));
    }
    if (processedMediaMessages.size > 3000) {
        const arr = Array.from(processedMediaMessages).slice(-1500);
        processedMediaMessages.clear();
        arr.forEach(id => processedMediaMessages.add(id));
    }
    if (processedDeletedStatuses.size > 2000) {
        const arr = Array.from(processedDeletedStatuses).slice(-1000);
        processedDeletedStatuses.clear();
        arr.forEach(id => processedDeletedStatuses.add(id));
    }
}, 10 * 60 * 1000);

/**
 * Load Auto Recovery configuration
 */
function loadRecoveryConfig() {
    try {
        if (!fs.existsSync(CONFIG_PATH)) {
            const defaultConfig = {
                enabled: false,
                recoverStatus: false,
                recoverDeletedStatus: false,
                recoverMedia: false,
                recoverViewOnce: false,
                includeGroups: false,
                includePrivate: false
            };
            saveRecoveryConfig(defaultConfig);
            return defaultConfig;
        }
        const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        return {
            enabled: Boolean(data.enabled),
            recoverStatus: Boolean(data.recoverStatus),
            recoverDeletedStatus: Boolean(data.recoverDeletedStatus),
            recoverMedia: Boolean(data.recoverMedia),
            recoverViewOnce: Boolean(data.recoverViewOnce),
            includeGroups: Boolean(data.includeGroups),
            includePrivate: Boolean(data.includePrivate)
        };
    } catch {
        return {
            enabled: false,
            recoverStatus: false,
            recoverDeletedStatus: false,
            recoverMedia: false,
            recoverViewOnce: false,
            includeGroups: false,
            includePrivate: false
        };
    }
}

/**
 * Save Auto Recovery configuration
 */
function saveRecoveryConfig(config) {
    try {
        const dir = path.dirname(CONFIG_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    } catch (err) {
        console.error('Media recovery config save error:', err);
    }
}

/**
 * Unwraps nested message structures
 */
function unwrapMessage(msg) {
    if (!msg) return null;
    let curr = msg;
    for (let i = 0; i < 6; i++) {
        if (curr.ephemeralMessage?.message) {
            curr = curr.ephemeralMessage.message;
        } else if (curr.viewOnceMessage?.message) {
            curr = curr.viewOnceMessage.message;
        } else if (curr.viewOnceMessageV2?.message) {
            curr = curr.viewOnceMessageV2.message;
        } else if (curr.viewOnceMessageV2Extension?.message) {
            curr = curr.viewOnceMessageV2Extension.message;
        } else if (curr.documentWithCaptionMessage?.message) {
            curr = curr.documentWithCaptionMessage.message;
        } else if (curr.templateMessage?.hydratedTemplate) {
            curr = curr.templateMessage.hydratedTemplate;
        } else if (curr.interactiveMessage?.header) {
            curr = curr.interactiveMessage.header;
        } else if (curr.editedMessage?.message?.protocolMessage?.editedMessage) {
            curr = curr.editedMessage.message.protocolMessage.editedMessage;
        } else {
            break;
        }
    }
    return curr;
}

/**
 * Download media with a safety timeout
 */
async function downloadMediaBuffer(mediaNode, mediaType, timeoutMs = 25000) {
    return new Promise(async (resolve, reject) => {
        let isDone = false;
        const timer = setTimeout(() => {
            if (!isDone) {
                isDone = true;
                reject(new Error(`Download timeout after ${timeoutMs}ms`));
            }
        }, timeoutMs);

        try {
            const stream = await downloadContentFromMessage(mediaNode, mediaType);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) {
                buffer = Buffer.concat([buffer, chunk]);
            }
            if (!isDone) {
                isDone = true;
                clearTimeout(timer);
                resolve(buffer);
            }
        } catch (err) {
            if (!isDone) {
                isDone = true;
                clearTimeout(timer);
                reject(err);
            }
        }
    });
}

/**
 * Auto-recovers and forwards new WhatsApp status updates immediately to owner
 */
async function handleStatusAutoRecovery(sock, statusMsg) {
    try {
        const config = loadRecoveryConfig();
        if (!config.enabled || !config.recoverStatus) return;

        if (!statusMsg || !statusMsg.key) return;
        const statusId = statusMsg.key.id;
        if (!statusId || processedStatuses.has(statusId)) return;

        // Skip statuses posted by the bot account itself
        if (statusMsg.key.fromMe) return;

        const selfJid = getOwnerSelfJid(sock);
        if (!selfJid) return;

        processedStatuses.add(statusId);

        const participant = statusMsg.key.participant || statusMsg.participant || '';
        const remoteJidAlt = statusMsg.key.remoteJidAlt || '';
        const { phone } = resolvePhoneAndLid(participant, remoteJidAlt);
        const cleanPhone = phone || participant.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
        const pushName = statusMsg.pushName || 'WhatsApp Contact';
        const senderJid = cleanPhone ? `${cleanPhone}@s.whatsapp.net` : participant;

        const unwrapped = unwrapMessage(statusMsg.message);
        if (!unwrapped) return;

        const ts = statusMsg.messageTimestamp ? new Date(Number(statusMsg.messageTimestamp) * 1000).toLocaleString() : new Date().toLocaleString();

        let mediaType = null;
        let mediaNode = null;
        let caption = '';
        let textContent = '';

        if (unwrapped.imageMessage) {
            mediaType = 'image';
            mediaNode = unwrapped.imageMessage;
            caption = mediaNode.caption || '';
        } else if (unwrapped.videoMessage) {
            mediaType = 'video';
            mediaNode = unwrapped.videoMessage;
            caption = mediaNode.caption || '';
        } else if (unwrapped.audioMessage) {
            mediaType = 'audio';
            mediaNode = unwrapped.audioMessage;
        } else if (unwrapped.extendedTextMessage) {
            mediaType = 'text';
            textContent = unwrapped.extendedTextMessage.text || '';
        } else if (unwrapped.conversation) {
            mediaType = 'text';
            textContent = unwrapped.conversation;
        }

        if (!mediaType) return;

        console.log(`📥 [Auto Recovery] New status detected from +${cleanPhone || 'unknown'} (${mediaType}). Auto-forwarding to owner...`);

        // Prepare Header Caption
        const headerCaption = 
`╔══════════════════════════╗
║  📸 *AUTO RECOVERED STATUS*  ║
╚══════════════════════════╝

👤 *User:* @${cleanPhone || 'contact'} ${cleanPhone ? `(+${cleanPhone})` : ''}
📛 *Name:* ${pushName}
🕒 *Posted:* ${ts}
${caption ? `📝 *Caption:* ${caption}\n` : ''}
_🔒 Auto-recovered & forwarded to yourself by HijjazI AI_`;

        if (mediaType === 'image' && mediaNode) {
            const buffer = await downloadMediaBuffer(mediaNode, 'image');
            if (buffer && buffer.length > 0) {
                await sock.sendMessage(selfJid, {
                    image: buffer,
                    caption: headerCaption,
                    mentions: cleanPhone ? [senderJid] : [],
                    ...channelInfo
                });
            }
        } else if (mediaType === 'video' && mediaNode) {
            const buffer = await downloadMediaBuffer(mediaNode, 'video');
            if (buffer && buffer.length > 0) {
                await sock.sendMessage(selfJid, {
                    video: buffer,
                    caption: headerCaption,
                    mentions: cleanPhone ? [senderJid] : [],
                    ...channelInfo
                });
            }
        } else if (mediaType === 'audio' && mediaNode) {
            const buffer = await downloadMediaBuffer(mediaNode, 'audio');
            if (buffer && buffer.length > 0) {
                await sock.sendMessage(selfJid, {
                    text: headerCaption,
                    mentions: cleanPhone ? [senderJid] : [],
                    ...channelInfo
                });
                await sock.sendMessage(selfJid, {
                    audio: buffer,
                    mimetype: mediaNode.mimetype || 'audio/ogg; codecs=opus',
                    ptt: !!mediaNode.ptt,
                    ...channelInfo
                });
            }
        } else if (mediaType === 'text' && textContent) {
            const textStoryMsg = 
`╔══════════════════════════╗
║  📝 *AUTO RECOVERED STATUS*  ║
╚══════════════════════════╝

👤 *User:* @${cleanPhone || 'contact'} ${cleanPhone ? `(+${cleanPhone})` : ''}
📛 *Name:* ${pushName}
🕒 *Posted:* ${ts}

💬 *Status Story Content:*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${textContent}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

_🔒 Auto-recovered & forwarded to yourself by HijjazI AI_`;

            await sock.sendMessage(selfJid, {
                text: textStoryMsg,
                mentions: cleanPhone ? [senderJid] : [],
                ...channelInfo
            });
        }
    } catch (err) {
        console.error('⚠️ Error in handleStatusAutoRecovery:', err.message);
    }
}

/**
 * Auto-recovers and forwards incoming picture/video media messages immediately to owner
 */
async function handleIncomingMediaRecovery(sock, message) {
    try {
        const config = loadRecoveryConfig();
        if (!config.enabled || !config.recoverMedia) return;

        if (!message || !message.key) return;
        const msgId = message.key.id;
        if (!msgId || processedMediaMessages.has(msgId)) return;

        // Skip bot's own outbound messages
        if (message.key.fromMe) return;

        const chatId = message.key.remoteJid || '';
        if (chatId === 'status@broadcast') return; // Handled by status recovery

        const isGroup = chatId.endsWith('@g.us');
        if (isGroup && !config.includeGroups) return;
        if (!isGroup && !config.includePrivate) return;

        const selfJid = getOwnerSelfJid(sock);
        if (!selfJid) return;

        // Do not forward messages that are already inside the owner's self DM
        if (!isGroup && chatId === selfJid) return;

        const unwrapped = unwrapMessage(message.message);
        if (!unwrapped) return;

        let isViewOnce = false;
        if (message.message?.viewOnceMessage || 
            message.message?.viewOnceMessageV2 || 
            message.message?.viewOnceMessageV2Extension) {
            isViewOnce = true;
        }

        let mediaType = null;
        let mediaNode = null;
        let originalCaption = '';

        if (unwrapped.imageMessage) {
            mediaType = 'image';
            mediaNode = unwrapped.imageMessage;
            originalCaption = mediaNode.caption || '';
        } else if (unwrapped.videoMessage) {
            mediaType = 'video';
            mediaNode = unwrapped.videoMessage;
            originalCaption = mediaNode.caption || '';
        }

        // Only recover picture and video media
        if (!mediaType || !mediaNode) return;

        processedMediaMessages.add(msgId);

        const senderParticipant = message.key.participant || message.key.remoteJid || '';
        const cleanSender = senderParticipant.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
        const senderJid = cleanSender ? `${cleanSender}@s.whatsapp.net` : senderParticipant;
        const pushName = message.pushName || 'WhatsApp User';
        const ts = message.messageTimestamp ? new Date(Number(message.messageTimestamp) * 1000).toLocaleString() : new Date().toLocaleString();

        let chatName = isGroup ? 'Group Chat' : 'Private DM';
        if (isGroup) {
            try {
                const groupMetadata = await sock.groupMetadata(chatId).catch(() => null);
                if (groupMetadata && groupMetadata.subject) {
                    chatName = groupMetadata.subject;
                }
            } catch (e) {}
        }

        console.log(`📥 [Auto Recovery] Intercepted ${mediaType}${isViewOnce ? ' (view-once)' : ''} from +${cleanSender}. Forwarding to owner...`);

        const bannerTitle = isViewOnce ? '🔒 *AUTO RECOVERED VIEW-ONCE*' : '📥 *AUTO RECOVERED MEDIA*';
        const headerCaption = 
`╔══════════════════════════╗
║  ${bannerTitle}  ║
╚══════════════════════════╝

👤 *Sender:* @${cleanSender || 'user'} ${cleanSender ? `(+${cleanSender})` : ''}
📛 *Name:* ${pushName}
💬 *Chat:* ${chatName}
🕒 *Sent At:* ${ts}
${originalCaption ? `📝 *Caption:* ${originalCaption}\n` : ''}
_⚡ Auto-recovered and forwarded to yourself by HijjazI AI_`;

        if (mediaType === 'image') {
            const buffer = await downloadMediaBuffer(mediaNode, 'image');
            if (buffer && buffer.length > 0) {
                await sock.sendMessage(selfJid, {
                    image: buffer,
                    caption: headerCaption,
                    mentions: cleanSender ? [senderJid] : [],
                    ...channelInfo
                });
            }
        } else if (mediaType === 'video') {
            const buffer = await downloadMediaBuffer(mediaNode, 'video');
            if (buffer && buffer.length > 0) {
                await sock.sendMessage(selfJid, {
                    video: buffer,
                    caption: headerCaption,
                    mentions: cleanSender ? [senderJid] : [],
                    ...channelInfo
                });
            }
        }
    } catch (err) {
        console.error('⚠️ Error in handleIncomingMediaRecovery:', err.message);
    }
}

/**
 * Recovers deleted / revoked status updates and forwards them directly to owner
 */
async function handleStatusRevocation(sock, revocationData) {
    try {
        const config = loadRecoveryConfig();
        if (!config.enabled || config.recoverDeletedStatus === false) return;
        if (!revocationData) return;

        // Extract status ID and deleter from protocolMessage / revocation updates
        let statusId = null;
        let deleterJid = null;
        let isStatusBroadcast = false;

        const protoMsg = revocationData.message?.protocolMessage ||
                         revocationData.message?.ephemeralMessage?.message?.protocolMessage ||
                         revocationData.update?.protocolMessage ||
                         revocationData.protocolMessage;

        if (protoMsg && protoMsg.key) {
            statusId = protoMsg.key.id;
            deleterJid = protoMsg.key.participant || revocationData.key?.participant || revocationData.participant;
            if (protoMsg.key.remoteJid === 'status@broadcast' || revocationData.key?.remoteJid === 'status@broadcast') {
                isStatusBroadcast = true;
            }
        } else if (revocationData.key) {
            statusId = revocationData.key.id;
            deleterJid = revocationData.key.participant || revocationData.participant || revocationData.key.remoteJid;
            if (revocationData.key.remoteJid === 'status@broadcast') {
                isStatusBroadcast = true;
            }
        }

        if (!statusId) return;

        // Check if this status deletion was already processed
        if (processedDeletedStatuses.has(statusId)) return;

        // Look up status in statusCache
        const statusEntry = getStatusById(statusId);
        if (!statusEntry && !isStatusBroadcast) {
            return;
        }

        if (!statusEntry) {
            return;
        }

        // Prevent forwarding if bot owner deleted their own status
        const selfJid = getOwnerSelfJid(sock);
        if (!selfJid) return;

        const selfNumber = selfJid.split('@')[0].replace(/[^0-9]/g, '');
        const participant = statusEntry.participant || deleterJid || '';
        const remoteJidAlt = statusEntry.remoteJidAlt || '';
        const { phone } = resolvePhoneAndLid(participant, remoteJidAlt);
        const cleanPhone = phone || statusEntry.phone || participant.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');

        if (statusEntry.key?.fromMe || (cleanPhone && cleanPhone === selfNumber)) {
            // Owner deleted their own status - do not notify
            return;
        }

        processedDeletedStatuses.add(statusId);

        const pushName = statusEntry.pushName || 'WhatsApp Contact';
        const senderJid = cleanPhone ? `${cleanPhone}@s.whatsapp.net` : participant;
        const postedTime = statusEntry.timestamp ? new Date(Number(statusEntry.timestamp)).toLocaleString() : 'Earlier';
        const deletedTime = new Date().toLocaleString();
        const caption = statusEntry.caption || '';
        const textContent = statusEntry.textContent || '';
        const mediaType = statusEntry.mediaType;

        console.log(`🗑️ [Deleted Status Recovery] Detected deleted status from +${cleanPhone || 'unknown'} (${mediaType}). Forwarding to owner...`);

        const headerCaption = 
`╔══════════════════════════╗
║  🗑️ *DELETED STATUS RECOVERED* ║
╚══════════════════════════╝

👤 *User:* @${cleanPhone || 'contact'} ${cleanPhone ? `(+${cleanPhone})` : ''}
📛 *Name:* ${pushName}
🕒 *Originally Posted:* ${postedTime}
⏰ *Deleted At:* ${deletedTime}
${caption ? `📝 *Caption:* ${caption}\n` : ''}
_🔒 Auto-recovered deleted status forwarded to yourself by HijjazI AI_`;

        // Fetch media via downloadStatusMedia
        let mediaResult = null;
        try {
            mediaResult = await downloadStatusMedia(statusEntry);
        } catch (e) {
            console.warn('Could not download status media for deleted status:', e.message);
        }

        if (mediaType === 'image' && mediaResult?.buffer) {
            await sock.sendMessage(selfJid, {
                image: mediaResult.buffer,
                caption: headerCaption,
                mentions: cleanPhone ? [senderJid] : [],
                ...channelInfo
            });
        } else if (mediaType === 'video' && mediaResult?.buffer) {
            await sock.sendMessage(selfJid, {
                video: mediaResult.buffer,
                caption: headerCaption,
                mentions: cleanPhone ? [senderJid] : [],
                ...channelInfo
            });
        } else if (mediaType === 'audio' && mediaResult?.buffer) {
            await sock.sendMessage(selfJid, {
                text: headerCaption,
                mentions: cleanPhone ? [senderJid] : [],
                ...channelInfo
            });
            await sock.sendMessage(selfJid, {
                audio: mediaResult.buffer,
                mimetype: mediaResult.mimetype || 'audio/ogg; codecs=opus',
                ptt: !!mediaResult.ptt,
                ...channelInfo
            });
        } else if (mediaType === 'text' || textContent) {
            const textStoryMsg = 
`╔══════════════════════════╗
║  🗑️ *DELETED STATUS RECOVERED* ║
╚══════════════════════════╝

👤 *User:* @${cleanPhone || 'contact'} ${cleanPhone ? `(+${cleanPhone})` : ''}
📛 *Name:* ${pushName}
🕒 *Originally Posted:* ${postedTime}
⏰ *Deleted At:* ${deletedTime}

💬 *Deleted Story Content:*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${textContent || '(Empty text)'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

_🔒 Auto-recovered deleted status forwarded to yourself by HijjazI AI_`;

            await sock.sendMessage(selfJid, {
                text: textStoryMsg,
                mentions: cleanPhone ? [senderJid] : [],
                ...channelInfo
            });
        }
    } catch (err) {
        console.error('⚠️ Error in handleStatusRevocation:', err.message);
    }
}

module.exports = {
    loadRecoveryConfig,
    saveRecoveryConfig,
    getOwnerSelfJid,
    handleStatusAutoRecovery,
    handleIncomingMediaRecovery,
    handleStatusRevocation
};

