const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const path = require('path');
const fs = require('fs');

// In-memory cache of recent view-once and media messages
// Keyed by message id (stanzaId)
const recentViewOnceCache = new Map();
const MAX_CACHE_SIZE = 2000;

const TMP_DIR = path.join(__dirname, '../tmp');
try {
    if (!fs.existsSync(TMP_DIR)) {
        fs.mkdirSync(TMP_DIR, { recursive: true });
    }
} catch (e) {}

/**
 * Resilient helper to download media stream into a Buffer with retry and fallback types
 */
async function downloadMedia(mediaNode, mediaType) {
    if (!mediaNode) return null;
    const downloadType = mediaType === 'voice' ? 'audio' : (mediaType === 'photo' ? 'image' : mediaType);
    
    // Types to try in order
    const candidateTypes = [downloadType];
    if (downloadType === 'video') candidateTypes.push('ptv', 'document');
    if (downloadType === 'audio') candidateTypes.push('document');
    if (downloadType === 'image') candidateTypes.push('document');

    for (const type of candidateTypes) {
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const stream = await downloadContentFromMessage(mediaNode, type);
                let buffer = Buffer.from([]);
                for await (const chunk of stream) {
                    buffer = Buffer.concat([buffer, chunk]);
                }
                if (buffer && buffer.length > 0) return buffer;
            } catch (err) {
                if (attempt === 0) {
                    await new Promise(r => setTimeout(r, 200));
                }
            }
        }
    }
    return null;
}

/**
 * Recursively unwrap message to find media node and view-once metadata
 */
function extractMediaAndMetadata(msg) {
    if (!msg || typeof msg !== 'object') {
        return { unwrapped: null, isViewOnce: false, mediaType: null, mediaNode: null };
    }

    let curr = msg;
    let isViewOnce = false;

    for (let i = 0; i < 10; i++) {
        if (!curr || typeof curr !== 'object') break;
        if (curr.viewOnceMessage?.message) {
            isViewOnce = true;
            curr = curr.viewOnceMessage.message;
        } else if (curr.viewOnceMessageV2?.message) {
            isViewOnce = true;
            curr = curr.viewOnceMessageV2.message;
        } else if (curr.viewOnceMessageV2Extension?.message) {
            isViewOnce = true;
            curr = curr.viewOnceMessageV2Extension.message;
        } else if (curr.ephemeralMessage?.message) {
            curr = curr.ephemeralMessage.message;
        } else if (curr.documentWithCaptionMessage?.message) {
            curr = curr.documentWithCaptionMessage.message;
        } else if (curr.templateMessage?.hydratedTemplate) {
            curr = curr.templateMessage.hydratedTemplate;
        } else if (curr.interactiveMessage?.header) {
            curr = curr.interactiveMessage.header;
        } else if (curr.editedMessage?.message?.protocolMessage?.editedMessage) {
            curr = curr.editedMessage.message.protocolMessage.editedMessage;
        } else if (curr.botInvokeMessage?.message) {
            curr = curr.botInvokeMessage.message;
        } else {
            break;
        }
    }

    if (!curr) return { unwrapped: null, isViewOnce, mediaType: null, mediaNode: null };

    let mediaType = null;
    let mediaNode = null;

    if (curr.imageMessage) {
        mediaType = 'image';
        mediaNode = curr.imageMessage;
        if (curr.imageMessage.viewOnce) isViewOnce = true;
    } else if (curr.videoMessage) {
        mediaType = 'video';
        mediaNode = curr.videoMessage;
        if (curr.videoMessage.viewOnce) isViewOnce = true;
    } else if (curr.audioMessage) {
        mediaType = 'audio';
        mediaNode = curr.audioMessage;
        if (curr.audioMessage.viewOnce) isViewOnce = true;
    } else if (curr.documentMessage) {
        mediaType = 'document';
        mediaNode = curr.documentMessage;
    } else if (curr.stickerMessage) {
        mediaType = 'sticker';
        mediaNode = curr.stickerMessage;
    } else if (curr.ptvMessage) {
        mediaType = 'video';
        mediaNode = curr.ptvMessage;
    }

    return { unwrapped: curr, isViewOnce, mediaType, mediaNode };
}

/**
 * Cache incoming message if it contains view-once or media
 */
async function cacheIncomingViewOnce(message) {
    try {
        if (!message || !message.key || !message.key.id) return;
        const msgId = message.key.id;
        const rawMsg = message.message;
        if (!rawMsg) return;

        const { unwrapped, isViewOnce, mediaType, mediaNode } = extractMediaAndMetadata(rawMsg);

        const chatId = message.key.remoteJid;
        const sender = message.key.participant || message.key.remoteJid;

        const entry = {
            id: msgId,
            key: message.key,
            chatId: chatId,
            sender: sender,
            pushName: message.pushName || '',
            mediaType: mediaType || null,
            mediaNode: mediaNode || null,
            isViewOnce: isViewOnce || false,
            caption: mediaNode?.caption || '',
            timestamp: Date.now(),
            rawMessage: message,
            unwrapped: unwrapped || rawMsg,
            buffer: null,
            filePath: null
        };

        recentViewOnceCache.set(msgId, entry);

        if (mediaType && mediaNode) {
            // Proactively buffer media in the background so reaction/forwarding is instant
            downloadMedia(mediaNode, mediaType).then(buf => {
                if (buf && buf.length > 0) {
                    entry.buffer = buf;
                    const ext = mediaType === 'audio' ? '.opus' : (mediaType === 'image' ? '.jpg' : (mediaType === 'video' ? '.mp4' : (mediaType === 'sticker' ? '.webp' : '.bin')));
                    const savePath = path.join(TMP_DIR, `vo_${msgId}${ext}`);
                    fs.writeFile(savePath, buf, () => {
                        entry.filePath = savePath;
                    });
                }
            }).catch(() => {});
        }

        // Prevent cache memory overflow
        if (recentViewOnceCache.size > MAX_CACHE_SIZE) {
            const firstKey = recentViewOnceCache.keys().next().value;
            recentViewOnceCache.delete(firstKey);
        }
    } catch (err) {
        // silent fail on cache
    }
}

/**
 * Find cached view-once by ID
 */
function getCachedViewOnce(id) {
    if (!id) return null;
    return recentViewOnceCache.get(id) || null;
}

module.exports = {
    downloadMedia,
    cacheIncomingViewOnce,
    getCachedViewOnce,
    extractMediaAndMetadata,
    recentViewOnceCache
};

