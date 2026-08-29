const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '../temp/status_cache.json');
const MEDIA_DIR = path.join(__dirname, '../temp/status_media');
const MAX_STATUS_AGE_MS = 48 * 60 * 60 * 1000; // 48 hours
const MAX_STORE_SIZE = 1000; // Cache up to 1000 recent status items

// Ensure directories exist
try {
    if (!fs.existsSync(MEDIA_DIR)) {
        fs.mkdirSync(MEDIA_DIR, { recursive: true });
    }
} catch (e) {}

// In-memory status store
let statusStore = [];

/**
 * Ensure any serialized buffer representation is converted back to a true Node.js Buffer
 */
function ensureBuffer(val) {
    if (!val) return val;
    if (Buffer.isBuffer(val)) return val;
    if (val.type === 'Buffer' && Array.isArray(val.data)) return Buffer.from(val.data);
    if (typeof val === 'string') return Buffer.from(val, 'base64');
    if (Array.isArray(val)) return Buffer.from(val);
    if (val instanceof Uint8Array) return Buffer.from(val);
    return val;
}

/**
 * Normalizes all cryptographic and binary buffer fields in a Baileys media node
 */
function normalizeMediaNode(node) {
    if (!node || typeof node !== 'object') return node;
    const copy = { ...node };
    if (copy.mediaKey) copy.mediaKey = ensureBuffer(copy.mediaKey);
    if (copy.fileSha256) copy.fileSha256 = ensureBuffer(copy.fileSha256);
    if (copy.fileEncSha256) copy.fileEncSha256 = ensureBuffer(copy.fileEncSha256);
    if (copy.jpegThumbnail) copy.jpegThumbnail = ensureBuffer(copy.jpegThumbnail);
    return copy;
}

/**
 * Load cached statuses from disk on startup
 */
function loadStatusCache() {
    try {
        if (!fs.existsSync(path.dirname(CACHE_FILE))) {
            fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
        }
        if (fs.existsSync(CACHE_FILE)) {
            const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                const now = Date.now();
                statusStore = parsed.filter(s => (now - (s.timestamp || s.cachedAt || now)) < MAX_STATUS_AGE_MS);
            }
        }
    } catch (err) {
        console.warn('⚠️ Error loading status cache:', err.message);
        statusStore = [];
    }
}

/**
 * Save cached statuses to disk
 */
function saveStatusCache() {
    try {
        if (!fs.existsSync(path.dirname(CACHE_FILE))) {
            fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
        }
        fs.writeFileSync(CACHE_FILE, JSON.stringify(statusStore.slice(-MAX_STORE_SIZE), null, 2));
    } catch (err) {
        console.warn('⚠️ Error saving status cache:', err.message);
    }
}

// Initial load
loadStatusCache();

/**
 * Resolve phone number from LID or vice-versa using Baileys session mappings
 */
function resolvePhoneAndLid(participant, remoteJidAlt) {
    let phone = null;
    let lid = null;

    if (remoteJidAlt && remoteJidAlt.includes('@s.whatsapp.net')) {
        phone = remoteJidAlt.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    }

    if (participant) {
        if (participant.includes('@s.whatsapp.net')) {
            phone = participant.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
        } else if (participant.includes('@lid')) {
            lid = participant.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
        }
    }

    // If phone missing, check session folder for reverse LID mapping
    if (!phone && lid) {
        const sessionDir = path.join(__dirname, '../session');
        try {
            const reverseMapPath = path.join(sessionDir, `lid-mapping-${lid}_reverse.json`);
            if (fs.existsSync(reverseMapPath)) {
                const val = JSON.parse(fs.readFileSync(reverseMapPath, 'utf-8'));
                if (typeof val === 'string') {
                    phone = val.replace(/[^0-9]/g, '');
                }
            }
        } catch (e) {}
    }

    // If LID missing, check session folder for phone mapping
    if (!lid && phone) {
        const sessionDir = path.join(__dirname, '../session');
        try {
            const forwardMapPath = path.join(sessionDir, `lid-mapping-${phone}.json`);
            if (fs.existsSync(forwardMapPath)) {
                const val = JSON.parse(fs.readFileSync(forwardMapPath, 'utf-8'));
                if (typeof val === 'string') {
                    lid = val.replace(/[^0-9]/g, '');
                }
            }
        } catch (e) {}
    }

    return { phone, lid };
}

/**
 * Unwrap nested message wrappers (ephemeral, viewOnce, etc.)
 */
function unwrapStatusMessage(msg) {
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
        } else {
            break;
        }
    }
    return curr;
}

/**
 * Downloads media stream with timeout
 */
async function downloadWithTimeout(mediaNode, type, timeoutMs = 25000) {
    const normalized = normalizeMediaNode(mediaNode);
    return new Promise(async (resolve, reject) => {
        let timer = null;
        let isDone = false;

        timer = setTimeout(() => {
            if (!isDone) {
                isDone = true;
                reject(new Error(`Download timed out after ${timeoutMs}ms`));
            }
        }, timeoutMs);

        try {
            const stream = await downloadContentFromMessage(normalized, type);
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
 * Pre-downloads media to disk in background so broadcast media keys never expire
 */
function preDownloadStatusMedia(statusId, mediaNode, mediaType) {
    if (!statusId || !mediaNode || !mediaType || mediaType === 'text') return;
    const ext = mediaType === 'image' ? 'jpg' : (mediaType === 'video' ? 'mp4' : 'ogg');
    const diskMediaFile = path.join(MEDIA_DIR, `${statusId}.${ext}`);

    if (fs.existsSync(diskMediaFile)) return;

    downloadWithTimeout(mediaNode, mediaType, 30000)
        .then((buf) => {
            if (buf && buf.length > 0) {
                try {
                    fs.writeFileSync(diskMediaFile, buf);
                } catch (e) {}
            }
        })
        .catch(() => {});
}

/**
 * Caches an incoming status message (supports all statuses from users with multiple uploads)
 */
function cacheStatusMessage(mek) {
    try {
        if (!mek || !mek.key) return;
        if (mek.key.remoteJid !== 'status@broadcast') return;

        const rawMsg = mek.message;
        if (!rawMsg) return;

        const unwrapped = unwrapStatusMessage(rawMsg);
        if (!unwrapped) return;

        const msgId = mek.key.id;
        if (!msgId) return;

        // Check if already in cache
        const exists = statusStore.some(s => s.id === msgId);
        if (exists) return;

        const participant = mek.key.participant || mek.participant || '';
        const remoteJidAlt = mek.key.remoteJidAlt || '';
        const { phone, lid } = resolvePhoneAndLid(participant, remoteJidAlt);
        const pushName = mek.pushName || '';

        const ts = mek.messageTimestamp ? (Number(mek.messageTimestamp) * 1000) : Date.now();

        let mediaType = null;
        let caption = '';
        let textContent = '';
        let mediaNode = null;
        let backgroundArgb = null;
        let font = null;

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
            backgroundArgb = unwrapped.extendedTextMessage.backgroundArgb;
            font = unwrapped.extendedTextMessage.font;
        } else if (unwrapped.conversation) {
            mediaType = 'text';
            textContent = unwrapped.conversation;
        }

        if (!mediaType) return;

        // Asynchronously pre-download media in background so all multiple statuses are preserved
        if (mediaNode && mediaType !== 'text') {
            preDownloadStatusMedia(msgId, mediaNode, mediaType);
        }

        const statusEntry = {
            id: msgId,
            key: mek.key,
            participant,
            remoteJidAlt,
            phone: phone || (participant.includes('@s.whatsapp.net') ? participant.split('@')[0].split(':')[0].replace(/[^0-9]/g, '') : null),
            lid,
            pushName,
            timestamp: ts,
            cachedAt: Date.now(),
            mediaType,
            caption,
            textContent,
            backgroundArgb,
            font,
            rawMessage: unwrapped
        };

        statusStore.push(statusEntry);

        // Keep last MAX_STORE_SIZE statuses in total
        if (statusStore.length > MAX_STORE_SIZE) {
            statusStore = statusStore.slice(-MAX_STORE_SIZE);
        }

        saveStatusCache();
    } catch (err) {
        console.warn('⚠️ Error in cacheStatusMessage:', err.message);
    }
}

/**
 * Downloads media from a status entry buffer with disk caching
 */
async function downloadStatusMedia(statusEntry) {
    const raw = statusEntry.rawMessage;
    if (!raw) throw new Error('No raw message available');

    const diskMediaFile = path.join(MEDIA_DIR, `${statusEntry.id}.${statusEntry.mediaType === 'image' ? 'jpg' : statusEntry.mediaType === 'video' ? 'mp4' : 'ogg'}`);

    // If already saved on disk, reuse immediately
    if (fs.existsSync(diskMediaFile)) {
        try {
            const diskBuffer = fs.readFileSync(diskMediaFile);
            if (diskBuffer && diskBuffer.length > 0) {
                return {
                    type: statusEntry.mediaType,
                    buffer: diskBuffer,
                    mimetype: statusEntry.mediaType === 'image' ? 'image/jpeg' : statusEntry.mediaType === 'video' ? 'video/mp4' : 'audio/ogg; codecs=opus',
                    caption: statusEntry.caption || '',
                    ptt: statusEntry.mediaType === 'audio'
                };
            }
        } catch (e) {}
    }

    if (statusEntry.mediaType === 'image') {
        const buffer = await downloadWithTimeout(raw.imageMessage, 'image');
        try { fs.writeFileSync(diskMediaFile, buffer); } catch (e) {}
        return {
            type: 'image',
            buffer,
            mimetype: raw.imageMessage.mimetype || 'image/jpeg',
            caption: statusEntry.caption || ''
        };
    }

    if (statusEntry.mediaType === 'video') {
        const buffer = await downloadWithTimeout(raw.videoMessage, 'video');
        try { fs.writeFileSync(diskMediaFile, buffer); } catch (e) {}
        return {
            type: 'video',
            buffer,
            mimetype: raw.videoMessage.mimetype || 'video/mp4',
            caption: statusEntry.caption || ''
        };
    }

    if (statusEntry.mediaType === 'audio') {
        const buffer = await downloadWithTimeout(raw.audioMessage, 'audio');
        try { fs.writeFileSync(diskMediaFile, buffer); } catch (e) {}
        return {
            type: 'audio',
            buffer,
            mimetype: raw.audioMessage.mimetype || 'audio/ogg; codecs=opus',
            ptt: !!raw.audioMessage.ptt
        };
    }

    if (statusEntry.mediaType === 'text') {
        return {
            type: 'text',
            text: statusEntry.textContent || '',
            font: statusEntry.font,
            backgroundArgb: statusEntry.backgroundArgb
        };
    }

    throw new Error(`Unsupported media type: ${statusEntry.mediaType}`);
}

/**
 * Find all active/recent statuses for a target user (by phone, LID, pushName, or JID)
 * If targetIdentifier is 'all', returns all statuses across all contacts.
 */
function findStatusesForUser(targetIdentifier, fallbackStore = null) {
    if (!targetIdentifier) return [];

    const isAll = typeof targetIdentifier === 'string' && (targetIdentifier.toLowerCase() === 'all' || targetIdentifier.toLowerCase() === '*');

    // Clean target digits
    const targetStr = targetIdentifier.toString();
    const cleanedTarget = targetStr.replace(/[^0-9]/g, '');

    // Check if target is a LID and resolve phone
    const { phone: resolvedPhone, lid: resolvedLid } = resolvePhoneAndLid(
        targetStr.includes('@') ? targetStr : `${cleanedTarget}@s.whatsapp.net`,
        null
    );

    const matchDigits = new Set();
    if (cleanedTarget) matchDigits.add(cleanedTarget);
    if (resolvedPhone) matchDigits.add(resolvedPhone);
    if (resolvedLid) matchDigits.add(resolvedLid);

    const targetLower = targetStr.toLowerCase();

    // Filter statuses from in-memory cache
    let matches = statusStore.filter(s => {
        if (!s) return false;
        if (isAll) return true;
        if (s.phone && matchDigits.has(s.phone)) return true;
        if (s.lid && matchDigits.has(s.lid)) return true;
        if (s.participant && matchDigits.has(s.participant.replace(/[^0-9]/g, ''))) return true;
        if (s.remoteJidAlt && matchDigits.has(s.remoteJidAlt.replace(/[^0-9]/g, ''))) return true;
        if (s.pushName && s.pushName.toLowerCase().includes(targetLower) && targetLower.length >= 3) return true;
        return false;
    });

    // Also check lightweight_store fallback if provided
    if (fallbackStore && fallbackStore.messages && Array.isArray(fallbackStore.messages['status@broadcast'])) {
        const storeMessages = fallbackStore.messages['status@broadcast'];
        for (const mek of storeMessages) {
            if (!mek || !mek.key) continue;
            const participant = mek.key.participant || mek.participant || '';
            const remoteJidAlt = mek.key.remoteJidAlt || '';
            const { phone, lid } = resolvePhoneAndLid(participant, remoteJidAlt);
            
            const partDigits = participant.replace(/[^0-9]/g, '');
            const altDigits = remoteJidAlt.replace(/[^0-9]/g, '');
            const pushName = mek.pushName || '';

            const isMatch = isAll ||
                            (phone && matchDigits.has(phone)) ||
                            (lid && matchDigits.has(lid)) ||
                            (partDigits && matchDigits.has(partDigits)) ||
                            (altDigits && matchDigits.has(altDigits)) ||
                            (pushName && pushName.toLowerCase().includes(targetLower) && targetLower.length >= 3);

            if (isMatch) {
                // Ensure it gets cached if not already present
                cacheStatusMessage(mek);
                if (!matches.some(m => m.id === mek.key.id)) {
                    const unwrapped = unwrapStatusMessage(mek.message);
                    if (unwrapped) {
                        let mediaType = null;
                        let caption = '';
                        let textContent = '';
                        if (unwrapped.imageMessage) {
                            mediaType = 'image';
                            caption = unwrapped.imageMessage.caption || '';
                        } else if (unwrapped.videoMessage) {
                            mediaType = 'video';
                            caption = unwrapped.videoMessage.caption || '';
                        } else if (unwrapped.audioMessage) {
                            mediaType = 'audio';
                        } else if (unwrapped.extendedTextMessage) {
                            mediaType = 'text';
                            textContent = unwrapped.extendedTextMessage.text || '';
                        } else if (unwrapped.conversation) {
                            mediaType = 'text';
                            textContent = unwrapped.conversation;
                        }

                        if (mediaType) {
                            matches.push({
                                id: mek.key.id,
                                key: mek.key,
                                participant,
                                remoteJidAlt,
                                phone: phone || partDigits,
                                lid,
                                pushName,
                                timestamp: mek.messageTimestamp ? (Number(mek.messageTimestamp) * 1000) : Date.now(),
                                mediaType,
                                caption,
                                textContent,
                                rawMessage: unwrapped
                            });
                        }
                    }
                }
            }
        }
    }

    // Deduplicate matches by status id
    const seenIds = new Set();
    matches = matches.filter(item => {
        if (!item || !item.id || seenIds.has(item.id)) return false;
        seenIds.add(item.id);
        return true;
    });

    // Sort chronologically (oldest to newest) so stories play in order
    matches.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    return matches;
}

/**
 * Get a specific cached status by its WhatsApp message ID
 */
function getStatusById(id) {
    if (!id) return null;
    return statusStore.find(s => s && s.id === id) || null;
}

module.exports = {
    cacheStatusMessage,
    downloadStatusMedia,
    findStatusesForUser,
    getStatusById,
    resolvePhoneAndLid
};
