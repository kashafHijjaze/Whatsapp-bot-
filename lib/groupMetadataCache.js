// lib/groupMetadataCache.js
// Safe, cached wrapper around sock.groupMetadata to prevent Boom 500 / missing <group> node errors

const metadataCache = new Map();
const inFlightRequests = new Map();
const CACHE_TTL_MS = 60 * 1000; // 60 seconds

/**
 * Safely fetches group metadata with memory caching and error suppression.
 * 
 * @param {Object} sock - Baileys socket instance
 * @param {string} chatId - Target group JID (must end with @g.us)
 * @param {boolean} forceRefresh - If true, bypasses cache
 * @returns {Promise<Object|null>} Group metadata object or null
 */
async function getGroupMetadataSafe(sock, chatId, forceRefresh = false) {
    if (!sock || !chatId || typeof chatId !== 'string' || !chatId.endsWith('@g.us')) {
        return null;
    }

    const now = Date.now();

    // Check cache
    if (!forceRefresh && metadataCache.has(chatId)) {
        const entry = metadataCache.get(chatId);
        if (now - entry.timestamp < CACHE_TTL_MS && entry.data) {
            return entry.data;
        }
    }

    // Check in-flight requests to avoid duplicate network calls
    if (inFlightRequests.has(chatId)) {
        try {
            return await inFlightRequests.get(chatId);
        } catch (e) {
            return metadataCache.get(chatId)?.data || null;
        }
    }

    const fetchPromise = (async () => {
        try {
            const fetcher = sock.rawGroupMetadata || sock.groupMetadata;
            if (typeof fetcher !== 'function') {
                return null;
            }
            const metadata = await fetcher(chatId);
            if (metadata && Array.isArray(metadata.participants)) {
                metadataCache.set(chatId, {
                    timestamp: Date.now(),
                    data: metadata
                });
                return metadata;
            }
            return null;
        } catch (err) {
            // Silently handle missing <group> node or unauthorized/non-group errors
            const errMsg = err?.message || String(err);
            if (
                errMsg.includes('missing <group> node') ||
                errMsg.includes('item-not-found') ||
                errMsg.includes('not-authorized') ||
                errMsg.includes('rate-overlimit') ||
                errMsg.includes('Internal Server Error')
            ) {
                // Return existing cache if available, else null
                return metadataCache.get(chatId)?.data || null;
            }
            return metadataCache.get(chatId)?.data || null;
        } finally {
            inFlightRequests.delete(chatId);
        }
    })();

    inFlightRequests.set(chatId, fetchPromise);
    return await fetchPromise;
}

/**
 * Invalidate cached metadata for a group (e.g. when participant updates happen)
 */
function invalidateGroupMetadata(chatId) {
    if (chatId) {
        metadataCache.delete(chatId);
    }
}

module.exports = {
    getGroupMetadataSafe,
    invalidateGroupMetadata,
    metadataCache
};
