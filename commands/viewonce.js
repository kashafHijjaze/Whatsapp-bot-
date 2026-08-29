const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const settings = require('../settings');
const { getCachedViewOnce } = require('../lib/viewonceCache');
const { getOwnerSelfJid } = require('../lib/ownerHelper');
const path = require('path');
const fs = require('fs');

/**
 * Recursively unwraps any view-once or nested container structure
 */
function unwrapMessage(msg) {
    if (!msg) return null;
    let curr = msg;
    for (let i = 0; i < 6; i++) {
        if (curr.viewOnceMessage?.message) {
            curr = curr.viewOnceMessage.message;
        } else if (curr.viewOnceMessageV2?.message) {
            curr = curr.viewOnceMessageV2.message;
        } else if (curr.viewOnceMessageV2Extension?.message) {
            curr = curr.viewOnceMessageV2Extension.message;
        } else if (curr.ephemeralMessage?.message) {
            curr = curr.ephemeralMessage.message;
        } else if (curr.documentWithCaptionMessage?.message) {
            curr = curr.documentWithCaptionMessage.message;
        } else if (curr.templateMessage?.hydratedTemplate) {
            curr = curr.templateMessage.hydratedTemplate;
        } else if (curr.interactiveMessage?.header) {
            curr = curr.interactiveMessage.header;
        } else {
            break;
        }
    }
    return curr;
}

/**
 * Download media stream into a single Buffer with fallback error handling
 */
async function downloadMediaBuffer(mediaNode, mediaType) {
    const stream = await downloadContentFromMessage(mediaNode, mediaType);
    let buffer = Buffer.from([]);
    for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
    }
    return buffer;
}

/**
 * Recovers View-Once Media (Voice notes, Audio, Photos, Videos)
 * 100% SILENT FORWARDING:
 * Delivers recovered media EXCLUSIVELY to your own WhatsApp number.
 * Never sends any message, alert, or emoji reaction to the sender's chat.
 */
async function viewonceCommand(sock, chatId, message) {
    // Determine connected user's yourself number / self JID
    const selfJid = getOwnerSelfJid(sock) || (sock.user?.id ? `${sock.user.id.split(':')[0].replace(/[^0-9]/g, '')}@s.whatsapp.net` : chatId);

    try {
        // Extract contextInfo from various message types
        const contextInfo = message.message?.extendedTextMessage?.contextInfo
            || message.message?.imageMessage?.contextInfo
            || message.message?.videoMessage?.contextInfo
            || message.message?.audioMessage?.contextInfo
            || message.message?.documentMessage?.contextInfo
            || message.message?.stickerMessage?.contextInfo
            || message.message?.conversation?.contextInfo;

        const stanzaId = contextInfo?.stanzaId;
        const quotedRaw = contextInfo?.quotedMessage;

        if (!quotedRaw && !stanzaId) {
            // Only respond in private self chat if user used command without replying
            if (chatId === selfJid) {
                return await sock.sendMessage(selfJid, {
                    text: '❌ *Please reply to a view-once voice note, photo, or video with .vv*'
                }, { quoted: message });
            }
            return;
        }

        // 1. Try unwrapping direct quoted message
        let target = quotedRaw ? unwrapMessage(quotedRaw) : null;
        let mediaType = null;
        let mediaNode = null;

        if (target) {
            if (target.audioMessage) {
                mediaType = 'audio';
                mediaNode = target.audioMessage;
            } else if (target.imageMessage) {
                mediaType = 'image';
                mediaNode = target.imageMessage;
            } else if (target.videoMessage) {
                mediaType = 'video';
                mediaNode = target.videoMessage;
            }
        }

        // 2. If not found in quote, check in-memory ViewOnce cache by stanzaId
        if (!mediaNode && stanzaId) {
            const cached = getCachedViewOnce(stanzaId);
            if (cached && cached.mediaNode) {
                mediaType = cached.mediaType;
                mediaNode = cached.mediaNode;
            }
        }

        // 3. If still not found, check temporary disk cache
        let tempDiskPath = null;
        if (!mediaNode && stanzaId) {
            const tempDir = path.join(__dirname, '../tmp');
            const possibleExts = ['.opus', '.ogg', '.mp3', '.jpg', '.jpeg', '.png', '.mp4'];
            for (const ext of possibleExts) {
                const checkPath = path.join(tempDir, `${stanzaId}${ext}`);
                if (fs.existsSync(checkPath)) {
                    tempDiskPath = checkPath;
                    if (['.opus', '.ogg', '.mp3'].includes(ext)) mediaType = 'audio';
                    else if (['.jpg', '.jpeg', '.png'].includes(ext)) mediaType = 'image';
                    else if (['.mp4'].includes(ext)) mediaType = 'video';
                    break;
                }
            }
        }

        if (!mediaNode && !tempDiskPath) {
            if (chatId === selfJid) {
                return await sock.sendMessage(selfJid, {
                    text: '❌ *Could not find view-once media in replied message. Make sure you replied directly to a view-once voice note, photo, or video.*'
                }, { quoted: message });
            }
            return;
        }

        // Determine sender & connected user's yourself JID
        const senderJid = contextInfo?.participant || contextInfo?.remoteJid || chatId;
        const senderNumber = senderJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');

        // Determine chat metadata
        const isGroup = chatId.endsWith('@g.us');
        let chatTitle = isGroup ? 'Group Chat' : 'Private DM';
        if (isGroup && sock.groupMetadata) {
            try {
                const meta = await sock.groupMetadata(chatId);
                if (meta && meta.subject) chatTitle = meta.subject;
            } catch (e) {}
        }

        const timeStr = new Date().toLocaleString('en-US', {
            hour12: true,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
        });

        // 1. RECOVER VIEW-ONCE VOICE NOTE / AUDIO
        if (mediaType === 'audio') {
            let buffer = null;
            if (tempDiskPath) {
                buffer = fs.readFileSync(tempDiskPath);
            } else if (mediaNode) {
                buffer = await downloadMediaBuffer(mediaNode, 'audio');
            }

            if (!buffer || buffer.length === 0) {
                throw new Error('Could not download voice data');
            }

            const isPtt = mediaNode?.ptt !== undefined ? !!mediaNode.ptt : true;
            const mimetype = mediaNode?.mimetype || 'audio/ogg; codecs=opus';

            const reportHeader = `╔══════════════════════════╗\n` +
                `║ 🎙️ *VIEW-ONCE VOICE NOTE*  ║\n` +
                `╚══════════════════════════╝\n\n` +
                `👤 *Sender:* @${senderNumber} (+${senderNumber})\n` +
                `💬 *Source:* ${chatTitle}\n` +
                `🕒 *Time:* ${timeStr}\n\n` +
                `_🔒 Silently recovered & forwarded to your yourself chat. The sender was NOT notified._`;

            // Forward silently ONLY to yourself number
            await sock.sendMessage(selfJid, {
                text: reportHeader,
                mentions: [senderJid]
            });

            await sock.sendMessage(selfJid, {
                audio: buffer,
                mimetype: mimetype,
                ptt: isPtt
            });

            return;
        }

        // 2. RECOVER VIEW-ONCE PHOTO / IMAGE
        if (mediaType === 'image') {
            let buffer = null;
            if (tempDiskPath) {
                buffer = fs.readFileSync(tempDiskPath);
            } else if (mediaNode) {
                buffer = await downloadMediaBuffer(mediaNode, 'image');
            }

            if (!buffer || buffer.length === 0) {
                throw new Error('Could not download image data');
            }

            const caption = mediaNode?.caption ? `\n💬 *Caption:* ${mediaNode.caption}\n` : '';
            const reportCaption = `╔══════════════════════════╗\n` +
                `║ 📸 *VIEW-ONCE PHOTO*       ║\n` +
                `╚══════════════════════════╝\n\n` +
                `👤 *Sender:* @${senderNumber} (+${senderNumber})\n` +
                `💬 *Source:* ${chatTitle}\n` +
                `🕒 *Time:* ${timeStr}\n` +
                caption + `\n` +
                `_🔒 Silently recovered & forwarded to your yourself chat. The sender was NOT notified._`;

            // Forward silently ONLY to yourself number
            await sock.sendMessage(selfJid, {
                image: buffer,
                caption: reportCaption,
                mentions: [senderJid]
            });

            return;
        }

        // 3. RECOVER VIEW-ONCE VIDEO
        if (mediaType === 'video') {
            let buffer = null;
            if (tempDiskPath) {
                buffer = fs.readFileSync(tempDiskPath);
            } else if (mediaNode) {
                buffer = await downloadMediaBuffer(mediaNode, 'video');
            }

            if (!buffer || buffer.length === 0) {
                throw new Error('Could not download video data');
            }

            const caption = mediaNode?.caption ? `\n💬 *Caption:* ${mediaNode.caption}\n` : '';
            const reportCaption = `╔══════════════════════════╗\n` +
                `║ 🎥 *VIEW-ONCE VIDEO*       ║\n` +
                `╚══════════════════════════╝\n\n` +
                `👤 *Sender:* @${senderNumber} (+${senderNumber})\n` +
                `💬 *Source:* ${chatTitle}\n` +
                `🕒 *Time:* ${timeStr}\n` +
                caption + `\n` +
                `_🔒 Silently recovered & forwarded to your yourself chat. The sender was NOT notified._`;

            // Forward silently ONLY to yourself number
            await sock.sendMessage(selfJid, {
                video: buffer,
                caption: reportCaption,
                mentions: [senderJid]
            });

            return;
        }

    } catch (error) {
        console.error('Error in viewonceCommand (.vv):', error);
        if (chatId === selfJid) {
            await sock.sendMessage(selfJid, {
                text: `❌ *Failed to recover view-once media:* ${error.message || 'Media expired or unavailable'}`
            }, { quoted: message });
        }
    }
}

module.exports = viewonceCommand;
