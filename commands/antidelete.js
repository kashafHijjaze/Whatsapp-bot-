const fs = require('fs');
const path = require('path');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const isOwnerOrSudo = require('../lib/isOwner');
const isAdmin = require('../lib/isAdmin');
const { getOwnerSelfJid } = require('../lib/ownerHelper');

const CONFIG_PATH = path.join(__dirname, '../data/antidelete.json');
const GROUP_CONFIG_PATH = path.join(__dirname, '../data/groupAntidelete.json');
const TEMP_MEDIA_DIR = path.join(__dirname, '../tmp');

// Ensure tmp and data dirs exist
if (!fs.existsSync(TEMP_MEDIA_DIR)) {
    fs.mkdirSync(TEMP_MEDIA_DIR, { recursive: true });
}
const DATA_DIR = path.join(__dirname, '../data');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// In-memory bounded message store (stores up to 2500 messages with 24hr TTL)
const messageStore = new Map();
const MAX_STORED_MESSAGES = 2500;
const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

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

// Periodic cleanup of expired stored messages and tmp media files
function cleanExpiredStorage() {
    try {
        const now = Date.now();
        for (const [id, msg] of messageStore.entries()) {
            if (now - msg.createdTime > MESSAGE_TTL_MS) {
                if (msg.mediaPath && fs.existsSync(msg.mediaPath)) {
                    try { fs.unlinkSync(msg.mediaPath); } catch {}
                }
                messageStore.delete(id);
            }
        }

        // Clean tmp directory if size > 150MB
        if (fs.existsSync(TEMP_MEDIA_DIR)) {
            const files = fs.readdirSync(TEMP_MEDIA_DIR);
            let totalBytes = 0;
            for (const file of files) {
                try {
                    const fp = path.join(TEMP_MEDIA_DIR, file);
                    totalBytes += fs.statSync(fp).size;
                } catch {}
            }
            if (totalBytes > 150 * 1024 * 1024) {
                for (const file of files) {
                    try {
                        fs.unlinkSync(path.join(TEMP_MEDIA_DIR, file));
                    } catch {}
                }
            }
        }
    } catch (e) {
        console.error('Antidelete cleanup error:', e);
    }
}
setInterval(cleanExpiredStorage, 5 * 60 * 1000);

// Load global antidelete config
function loadAntideleteConfig() {
    try {
        if (!fs.existsSync(CONFIG_PATH)) {
            const defaultConfig = { enabled: false, destination: 'both' };
            saveAntideleteConfig(defaultConfig);
            return defaultConfig;
        }
        const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        return {
            enabled: Boolean(data.enabled),
            destination: data.destination || 'both' // 'owner' (self DM), 'same_chat', 'both'
        };
    } catch {
        return { enabled: false, destination: 'both' };
    }
}

// Save global config
function saveAntideleteConfig(config) {
    try {
        const dir = path.dirname(CONFIG_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    } catch (err) {
        console.error('Antidelete config save error:', err);
    }
}

// Load per-group antidelete config (Universal for all groups - Default: Disabled)
function loadGroupAntideleteConfig() {
    try {
        if (!fs.existsSync(GROUP_CONFIG_PATH)) {
            const defaultConfig = {
                enabled: false,
                destination: 'off',
                defaultMode: 'off',
                requireAdmin: false,
                groups: {}
            };
            saveGroupAntideleteConfig(defaultConfig);
            return defaultConfig;
        }
        const data = JSON.parse(fs.readFileSync(GROUP_CONFIG_PATH, 'utf8'));
        const isEnabled = Boolean(data.enabled) && data.defaultMode !== 'off' && data.destination !== 'off';
        const dest = data.destination || data.defaultMode || 'off';
        return {
            enabled: isEnabled,
            destination: dest,
            defaultMode: dest,
            requireAdmin: Boolean(data.requireAdmin),
            groups: data.groups || {}
        };
    } catch {
        return {
            enabled: false,
            destination: 'off',
            defaultMode: 'off',
            requireAdmin: false,
            groups: {}
        };
    }
}

// Save per-group config
function saveGroupAntideleteConfig(config) {
    try {
        const dir = path.dirname(GROUP_CONFIG_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(GROUP_CONFIG_PATH, JSON.stringify(config, null, 2));
    } catch (err) {
        console.error('Group antidelete config save error:', err);
    }
}

// Get group setting (Universal for all groups - Default: Off)
function getGroupAntideleteSetting(groupId) {
    const config = loadGroupAntideleteConfig();
    const isEnabled = Boolean(config.enabled) && config.destination !== 'off' && config.defaultMode !== 'off';
    const dest = config.destination || config.defaultMode || 'off';
    return {
        enabled: isEnabled,
        destination: dest,
        updatedAt: config.updatedAt,
        updatedBy: config.updatedBy
    };
}

// Set group setting (Universal for all groups)
function setGroupAntideleteSetting(groupId, settings) {
    const config = loadGroupAntideleteConfig();
    const isExplicitlyDisabled = settings.enabled === false || settings.destination === 'off';
    const destination = isExplicitlyDisabled ? 'off' : (settings.destination || config.destination || 'both');
    
    const updated = {
        ...config,
        ...settings,
        enabled: !isExplicitlyDisabled,
        destination: destination,
        defaultMode: destination,
        updatedAt: new Date().toISOString()
    };
    saveGroupAntideleteConfig(updated);
    return updated;
}

/**
 * Unwraps nested message containers (ephemeral, view-once, document with caption, etc.)
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
 * Download Baileys media stream to buffer
 */
async function downloadMediaToBuffer(mediaNode, mediaType) {
    try {
        const stream = await downloadContentFromMessage(mediaNode, mediaType);
        let buffer = Buffer.from([]);
        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }
        return buffer;
    } catch (err) {
        console.error(`Error downloading ${mediaType} buffer:`, err.message);
        return null;
    }
}

// Global Command Handler
async function handleAntideleteCommand(sock, chatId, message, match) {
    const isGroup = chatId.endsWith('@g.us');
    const senderId = message.key.participant || message.key.remoteJid;
    const isOwner = message.key.fromMe || await isOwnerOrSudo(senderId, sock, chatId);
    const ownerSelfJid = getOwnerSelfJid(sock);
    const ownerSelfNumber = ownerSelfJid ? ownerSelfJid.split('@')[0] : 'Owner';

    // If user typed .antidelete group ... in group, route to group command logic
    const tokens = (match || '').trim().split(/\s+/);
    if (tokens[0] === 'group' || tokens[0] === 'groups' || tokens[0] === 'gp') {
        const groupAntidelete = require('./groupantidelete');
        return groupAntidelete(sock, chatId, message, tokens.slice(1));
    }
    
    if (!message.key.fromMe && !isOwner) {
        // If non-owner admin in group calls .antidelete, route to group handler
        if (isGroup) {
            const groupAntidelete = require('./groupantidelete');
            return groupAntidelete(sock, chatId, message, tokens);
        }
        return sock.sendMessage(chatId, {
            text: '❌ *Only the bot owner can configure Antidelete globally.*',
            ...channelInfo
        }, { quoted: message });
    }

    const config = loadAntideleteConfig();
    const arg = (match || '').trim().toLowerCase();

    if (!arg || arg === 'status') {
        const destDesc = config.destination === 'owner' 
            ? `🔒 Owner Self DM (+${ownerSelfNumber}) [Private]` 
            : (config.destination === 'both' ? '👥 Both This Chat/Group & Owner Self DM (+ ' + ownerSelfNumber + ')' : '💬 Same Chat/Group');
        return sock.sendMessage(chatId, {
            text:
`╔══════════════════════════╗
║   🛡️ *ANTIDELETE CONFIG*       ║
╚══════════════════════════╝

📌 *Status:* ${config.enabled ? '✅ Enabled (Active)' : '❌ Disabled'}
📍 *Forwarding Mode:* ${destDesc}
📦 *Cached Messages:* ${messageStore.size} in memory
📱 *Yourself Number:* +${ownerSelfNumber}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 *Global Commands:*
• *.antidelete both* ➔ Auto detect & forward to *BOTH* this group/chat AND *YOURSELF NUMBER*
• *.antidelete dm* ➔ Forward deleted messages privately to *YOURSELF NUMBER (+${ownerSelfNumber})*
• *.antidelete chat* ➔ Restore messages in the same chat/group
• *.antidelete off* ➔ Turn Antidelete OFF
• *.groupantidelete both* ➔ Manage group-specific anti-delete`,
            ...channelInfo
        }, { quoted: message });
    }

    if (arg === 'both' || arg === 'all') {
        config.destination = 'both';
        config.enabled = true;
        saveAntideleteConfig(config);
        return sock.sendMessage(chatId, {
            text: `✅ *Antidelete Mode Set to BOTH!*\nDeleted messages will be automatically detected and forwarded to **BOTH this group/chat AND your WhatsApp number (+${ownerSelfNumber})**.`,
            ...channelInfo
        }, { quoted: message });
    } else if (arg === 'on' || arg === 'enable' || arg === '1' || arg === 'true') {
        config.enabled = true;
        config.destination = 'both';
        saveAntideleteConfig(config);
        return sock.sendMessage(chatId, {
            text: `✅ *Antidelete has been enabled (BOTH mode)!* All deleted messages will be forwarded to this chat and privately to your own WhatsApp number (+${ownerSelfNumber}).`,
            ...channelInfo
        }, { quoted: message });
    } else if (arg === 'off' || arg === 'disable' || arg === '0' || arg === 'false') {
        config.enabled = false;
        saveAntideleteConfig(config);
        return sock.sendMessage(chatId, {
            text: `❌ *Antidelete has been disabled.*`,
            ...channelInfo
        }, { quoted: message });
    } else if (arg === 'dm' || arg === 'owner' || arg === 'pm' || arg === 'self') {
        config.destination = 'owner';
        config.enabled = true;
        saveAntideleteConfig(config);
        return sock.sendMessage(chatId, {
            text: `✅ *Antidelete Forwarding Configured:* Deleted messages will be forwarded **privately to your own number (+${ownerSelfNumber})** only.`,
            ...channelInfo
        }, { quoted: message });
    } else if (arg === 'chat' || arg === 'same') {
        config.destination = 'same_chat';
        config.enabled = true;
        saveAntideleteConfig(config);
        return sock.sendMessage(chatId, {
            text: `✅ *Antidelete Destination Set:* Deleted messages will be restored in the same chat/group only.`,
            ...channelInfo
        }, { quoted: message });
    } else {
        return sock.sendMessage(chatId, {
            text: `❓ *Invalid option.* Use *.antidelete both*, *.antidelete dm*, *.antidelete chat*, or *.antidelete off*.`,
            ...channelInfo
        }, { quoted: message });
    }
}

// Store incoming messages
async function storeMessage(sock, rawMsg) {
    try {
        if (!rawMsg || !rawMsg.key || !rawMsg.key.id) return;
        const messageId = rawMsg.key.id;

        // Extract and unwrap message
        const innerMsg = unwrapMessage(rawMsg.message);
        if (!innerMsg) return;

        // Skip protocol messages (e.g. key exchange or deletions) from being stored as content
        if (innerMsg.protocolMessage) return;

        const sender = rawMsg.key.participant || rawMsg.key.remoteJid;
        const remoteJid = rawMsg.key.remoteJid;
        const fromMe = Boolean(rawMsg.key.fromMe);

        let content = '';
        let mediaType = null;
        let mediaBuffer = null;
        let mediaPath = null;
        let mimetype = null;
        let fileName = null;

        if (innerMsg.conversation) {
            content = innerMsg.conversation;
        } else if (innerMsg.extendedTextMessage?.text) {
            content = innerMsg.extendedTextMessage.text;
        } else if (innerMsg.imageMessage) {
            mediaType = 'image';
            content = innerMsg.imageMessage.caption || '';
            mimetype = innerMsg.imageMessage.mimetype || 'image/jpeg';
            mediaBuffer = await downloadMediaToBuffer(innerMsg.imageMessage, 'image');
        } else if (innerMsg.videoMessage) {
            mediaType = 'video';
            content = innerMsg.videoMessage.caption || '';
            mimetype = innerMsg.videoMessage.mimetype || 'video/mp4';
            mediaBuffer = await downloadMediaToBuffer(innerMsg.videoMessage, 'video');
        } else if (innerMsg.audioMessage) {
            mediaType = 'audio';
            mimetype = innerMsg.audioMessage.mimetype || 'audio/ogg; codecs=opus';
            mediaBuffer = await downloadMediaToBuffer(innerMsg.audioMessage, 'audio');
        } else if (innerMsg.stickerMessage) {
            mediaType = 'sticker';
            mimetype = innerMsg.stickerMessage.mimetype || 'image/webp';
            mediaBuffer = await downloadMediaToBuffer(innerMsg.stickerMessage, 'sticker');
        } else if (innerMsg.documentMessage) {
            mediaType = 'document';
            content = innerMsg.documentMessage.caption || '';
            fileName = innerMsg.documentMessage.fileName || 'file';
            mimetype = innerMsg.documentMessage.mimetype || 'application/octet-stream';
            mediaBuffer = await downloadMediaToBuffer(innerMsg.documentMessage, 'document');
        } else if (innerMsg.contactMessage) {
            mediaType = 'contact';
            content = `📇 Contact: ${innerMsg.contactMessage.displayName || 'VCard'}`;
        } else if (innerMsg.locationMessage) {
            mediaType = 'location';
            content = `📍 Location: ${innerMsg.locationMessage.degreesLatitude}, ${innerMsg.locationMessage.degreesLongitude}`;
        }

        // If media buffer downloaded, save to tmp file
        if (mediaBuffer && mediaBuffer.length > 0) {
            const ext = mediaType === 'image' ? 'jpg' : (mediaType === 'video' ? 'mp4' : (mediaType === 'audio' ? 'ogg' : (mediaType === 'sticker' ? 'webp' : 'bin')));
            mediaPath = path.join(TEMP_MEDIA_DIR, `antidelete_${messageId}.${ext}`);
            try {
                fs.writeFileSync(mediaPath, mediaBuffer);
            } catch (e) {
                console.error('Error writing antidelete media file:', e);
            }
        }

        // Maintain size cap
        if (messageStore.size >= MAX_STORED_MESSAGES) {
            const firstKey = messageStore.keys().next().value;
            const old = messageStore.get(firstKey);
            if (old?.mediaPath && fs.existsSync(old.mediaPath)) {
                try { fs.unlinkSync(old.mediaPath); } catch {}
            }
            messageStore.delete(firstKey);
        }

        messageStore.set(messageId, {
            id: messageId,
            content,
            mediaType,
            mediaPath,
            mimetype,
            fileName,
            sender,
            remoteJid,
            fromMe,
            rawMsg,
            innerMsg,
            isGroup: remoteJid ? remoteJid.endsWith('@g.us') : false,
            createdTime: Date.now(),
            timestamp: new Date().toLocaleString()
        });

    } catch (err) {
        console.error('storeMessage error:', err);
    }
}

// Helper to retrieve cached stored message by ID
function getStoredMessage(messageId) {
    if (!messageId) return null;
    return messageStore.get(messageId) || null;
}

// Handle message deletion / revocation
async function handleMessageRevocation(sock, revocationMessage) {
    try {
        const globalConfig = loadAntideleteConfig();
        const groupConfig = loadGroupAntideleteConfig();

        // Extract deleted message ID and deleter info
        let messageId = null;
        let deletedBy = null;
        let chatJid = null;

        if (revocationMessage.message?.protocolMessage?.key) {
            messageId = revocationMessage.message.protocolMessage.key.id;
            chatJid = revocationMessage.message.protocolMessage.key.remoteJid || revocationMessage.key?.remoteJid;
            deletedBy = revocationMessage.key?.participant || revocationMessage.participant || revocationMessage.key?.remoteJid;
        } else if (revocationMessage.update?.protocolMessage?.key) {
            messageId = revocationMessage.update.protocolMessage.key.id;
            chatJid = revocationMessage.update.protocolMessage.key.remoteJid || revocationMessage.key?.remoteJid;
            deletedBy = revocationMessage.key?.participant || revocationMessage.participant || revocationMessage.key?.remoteJid;
        } else if (revocationMessage.key?.id) {
            messageId = revocationMessage.key.id;
            chatJid = revocationMessage.key.remoteJid;
            deletedBy = revocationMessage.key.participant || revocationMessage.participant || revocationMessage.key.remoteJid;
        }

        if (!messageId) return;

        const original = messageStore.get(messageId);
        if (!original) {
            if (chatJid === 'status@broadcast' || messageId) {
                try {
                    const { handleStatusRevocation } = require('../lib/mediaRecovery');
                    await handleStatusRevocation(sock, revocationMessage);
                } catch (e) {}
            }
            return;
        }

        const isGroup = original.isGroup || (original.remoteJid && original.remoteJid.endsWith('@g.us'));
        const groupSetting = isGroup ? getGroupAntideleteSetting(original.remoteJid) : null;

        // Check if enabled
        if (isGroup) {
            if (!groupSetting || !groupSetting.enabled) {
                return;
            }
        } else {
            if (!globalConfig || !globalConfig.enabled) {
                return;
            }
        }

        // Owner's own WhatsApp number (by which bot is activated)
        const ownerJid = getOwnerSelfJid(sock);
        if (!ownerJid) return;

        // Retrieve sender and group details
        const sender = original.sender || deletedBy || '';
        const senderNumber = sender.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
        const deleterNumber = (deletedBy || sender).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
        const ownerSelfNumber = ownerJid.split('@')[0];

        // If the owner themselves deleted their own message and it was fromMe, no need to alert self
        if (original.fromMe && deleterNumber === ownerSelfNumber && !isGroup) {
            return;
        }
        
        let groupName = '';
        let isBotOrOwnerAdmin = false;
        if (isGroup && original.remoteJid) {
            try {
                const groupMeta = await sock.groupMetadata(original.remoteJid);
                groupName = groupMeta?.subject || 'Group Chat';
                
                // Check if bot or owner is admin in this group
                if (groupConfig.requireAdmin) {
                    const adminCheck = await isAdmin(sock, original.remoteJid, ownerJid);
                    isBotOrOwnerAdmin = adminCheck.isBotAdmin || adminCheck.isSenderAdmin;
                    if (!isBotOrOwnerAdmin) {
                        console.log(`[Group Antidelete] Skipped revocation in ${groupName} because admin requirement is enabled and bot/owner is not admin.`);
                        return;
                    }
                }
            } catch {
                groupName = 'Group Chat';
            }
        }

        const reportText =
`╔══════════════════════════╗
║   🛡️ *HIJJAZI ANTIDELETE*      ║
╚══════════════════════════╝

📌 *Deleted Message Recovered*
👤 *Sender:* @${senderNumber} (+${senderNumber})
🗑️ *Deleted By:* @${deleterNumber} (+${deleterNumber})
${groupName ? `👥 *Source:* Group - ${groupName}\n` : `💬 *Source:* Private DM (Chat with +${senderNumber})\n`}⏰ *Time Sent:* ${original.timestamp}
⏱️ *Deleted At:* ${new Date().toLocaleString()}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${original.content ? `💬 *Deleted Content:*\n${original.content}` : `📁 *Deleted Media:* [${(original.mediaType || 'Media').toUpperCase()}] (Attached below)`}

_⚡ Auto-recovered & forwarded by HijjazI AI_`;

        const targetChats = new Set();

        // Determine destination based on group settings or global config
        let effectiveDest = 'both';
        if (isGroup) {
            if (groupSetting && groupSetting.destination) {
                effectiveDest = groupSetting.destination;
            } else {
                effectiveDest = globalConfig.destination || 'both';
            }
        } else {
            effectiveDest = globalConfig.destination || 'both';
        }

        if (effectiveDest === 'both' || effectiveDest === 'all') {
            // Forward to BOTH this group/chat AND owner's yourself number
            if (original.remoteJid) targetChats.add(original.remoteJid);
            targetChats.add(ownerJid);
        } else if (effectiveDest === 'same_chat' || effectiveDest === 'group' || effectiveDest === 'chat') {
            // Forward to the group/chat only
            if (original.remoteJid) targetChats.add(original.remoteJid);
        } else if (effectiveDest === 'owner' || effectiveDest === 'dm' || effectiveDest === 'self' || effectiveDest === 'pm') {
            // Forward to owner's self number only
            targetChats.add(ownerJid);
        } else {
            // Default to both
            if (original.remoteJid) targetChats.add(original.remoteJid);
            targetChats.add(ownerJid);
        }

        // Mention tags
        const mentions = [];
        if (sender && sender.includes('@')) mentions.push(sender);
        if (deletedBy && deletedBy.includes('@') && deletedBy !== sender) mentions.push(deletedBy);

        for (const target of targetChats) {
            try {
                // Send text report
                await sock.sendMessage(target, {
                    text: reportText,
                    mentions,
                    ...channelInfo
                });

                // Send media if exists
                if (original.mediaType && original.mediaPath && fs.existsSync(original.mediaPath)) {
                    const mediaBuffer = fs.readFileSync(original.mediaPath);
                    const caption = `*Deleted ${(original.mediaType || '').toUpperCase()}*\nSender: +${senderNumber} | Group: ${groupName || 'Chat'}`;

                    if (original.mediaType === 'image') {
                        await sock.sendMessage(target, {
                            image: mediaBuffer,
                            caption,
                            mentions: [sender]
                        });
                    } else if (original.mediaType === 'video') {
                        await sock.sendMessage(target, {
                            video: mediaBuffer,
                            caption,
                            mentions: [sender]
                        });
                    } else if (original.mediaType === 'audio') {
                        await sock.sendMessage(target, {
                            audio: mediaBuffer,
                            mimetype: original.mimetype || 'audio/ogg; codecs=opus',
                            ptt: true
                        });
                    } else if (original.mediaType === 'sticker') {
                        await sock.sendMessage(target, {
                            sticker: mediaBuffer
                        });
                    } else if (original.mediaType === 'document') {
                        await sock.sendMessage(target, {
                            document: mediaBuffer,
                            fileName: original.fileName || 'file',
                            mimetype: original.mimetype || 'application/octet-stream',
                            caption
                        });
                    }
                }
            } catch (err) {
                console.error(`Error sending antidelete notification to ${target}:`, err);
            }
        }

    } catch (err) {
        console.error('handleMessageRevocation error:', err);
    }
}

module.exports = {
    handleAntideleteCommand,
    handleMessageRevocation,
    storeMessage,
    getStoredMessage,
    loadAntideleteConfig,
    saveAntideleteConfig,
    loadGroupAntideleteConfig,
    saveGroupAntideleteConfig,
    getGroupAntideleteSetting,
    setGroupAntideleteSetting,
    getOwnerSelfJid
};

