const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const settings = require('../settings');
const isOwnerOrSudo = require('./isOwner');
const store = require('./lightweight_store');
const { getStoredMessage } = require('../commands/antidelete');
const { getOwnerSelfJid } = require('./ownerHelper');
const { getCachedViewOnce } = require('./viewonceCache');
const { getStatusById } = require('./statusCache');
const { getGroupMetadataSafe } = require('./groupMetadataCache');
const path = require('path');
const fs = require('fs');

// Deduplication map to prevent multiple forwards when reaction arrives via upsert and reaction events
const processedReactions = new Map();
const DEDUP_TTL_MS = 20000; // 20 seconds

// Periodic cleanup of deduplication map
const dedupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, time] of processedReactions.entries()) {
        if (now - time > DEDUP_TTL_MS) {
            processedReactions.delete(key);
        }
    }
}, 30000);
if (dedupTimer.unref) dedupTimer.unref();

/**
 * Checks if emoji is a thumbs-up reaction (👍🏿, 👍🏻, 👍, etc.)
 */
function isThumbsUpReaction(emoji) {
    if (!emoji || typeof emoji !== 'string') return false;
    const clean = emoji.trim();
    return clean === '👍🏿' ||
           clean === '👍🏻' || 
           clean === '👍' || 
           clean === '👍🏼' || 
           clean === '👍🏽' || 
           clean === '👍🏾' || 
           clean.includes('👍') ||
           /\u{1F44D}/u.test(clean) ||
           clean.includes('\uD83D\uDC4D');
}

/**
 * Recursively unwraps any view-once, ephemeral or nested container structure
 */
function unwrapMessage(msg) {
    if (!msg || typeof msg !== 'object') return null;
    let curr = msg;
    for (let i = 0; i < 10; i++) {
        if (!curr || typeof curr !== 'object') break;
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
        } else if (curr.editedMessage?.message?.protocolMessage?.editedMessage) {
            curr = curr.editedMessage.message.protocolMessage.editedMessage;
        } else if (curr.botInvokeMessage?.message) {
            curr = curr.botInvokeMessage.message;
        } else {
            break;
        }
    }
    return curr;
}

/**
 * Helper to extract media type and media node from a message object
 */
function extractMediaFromNode(target) {
    if (!target || typeof target !== 'object') {
        return { mediaType: null, mediaNode: null, isViewOnce: false };
    }
    let isViewOnce = false;

    if (target.audioMessage) {
        if (target.audioMessage.viewOnce) isViewOnce = true;
        return { mediaType: 'audio', mediaNode: target.audioMessage, isViewOnce };
    }
    if (target.imageMessage) {
        if (target.imageMessage.viewOnce) isViewOnce = true;
        return { mediaType: 'image', mediaNode: target.imageMessage, isViewOnce };
    }
    if (target.videoMessage) {
        if (target.videoMessage.viewOnce) isViewOnce = true;
        return { mediaType: 'video', mediaNode: target.videoMessage, isViewOnce };
    }
    if (target.ptvMessage) {
        return { mediaType: 'video', mediaNode: target.ptvMessage, isViewOnce };
    }
    if (target.stickerMessage) {
        return { mediaType: 'sticker', mediaNode: target.stickerMessage, isViewOnce };
    }
    if (target.documentMessage) {
        return { mediaType: 'document', mediaNode: target.documentMessage, isViewOnce };
    }
    return { mediaType: null, mediaNode: null, isViewOnce: false };
}

/**
 * Resilient helper to download media stream into a single Buffer with fallback types and retry
 */
async function downloadMediaBuffer(mediaNode, mediaType) {
    if (!mediaNode) return null;
    const downloadType = mediaType === 'voice' ? 'audio' : (mediaType === 'photo' ? 'image' : mediaType);
    
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
 * Helper to resolve real phone number and name from JID/LID and Group metadata
 */
async function resolveSenderDetails(sock, chatId, senderJid, fallbackPushName = '') {
    let resolvedJid = senderJid || '';
    let displayName = fallbackPushName || '';
    let cleanNumber = '';

    if (resolvedJid.includes('@lid') && chatId && chatId.endsWith('@g.us')) {
        try {
            const meta = await getGroupMetadataSafe(sock, chatId);
            const participants = meta?.participants || [];
            const matched = participants.find(p => p.lid === resolvedJid || (p.lid && resolvedJid.includes(p.lid.split('@')[0])));
            if (matched && matched.id) {
                resolvedJid = matched.id;
                if (matched.notify || matched.name) displayName = displayName || matched.notify || matched.name;
            }
        } catch (e) {}
    }

    cleanNumber = resolvedJid ? resolvedJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '') : '';
    if (!cleanNumber && senderJid) {
        cleanNumber = senderJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
    }
    if (!cleanNumber) cleanNumber = 'Unknown';

    const mentionJid = resolvedJid.endsWith('@s.whatsapp.net') ? resolvedJid : `${cleanNumber}@s.whatsapp.net`;

    return {
        cleanNumber,
        mentionJid,
        displayName
    };
}

/**
 * Forwards any resolved message or media directly to the owner self number
 */
async function forwardToOwnerNumber(sock, { target, mediaNode, mediaType, tempDiskPath, memoryBuffer, stanzaId, senderJid, chatId, pushName = '', customNote = '', source = '👍🏻 reaction', isViewOnce = false, reactionEmoji = '👍' }) {
    const selfJid = getOwnerSelfJid(sock) || (sock.user?.id ? `${sock.user.id.split(':')[0].replace(/[^0-9]/g, '')}@s.whatsapp.net` : null);
    if (!selfJid) {
        console.warn('⚠️ [Owner Reaction] Could not resolve owner WhatsApp number (selfJid).');
        return false;
    }

    try {
        const { cleanNumber, mentionJid, displayName } = await resolveSenderDetails(sock, chatId, senderJid, pushName);
        const isGroup = chatId ? chatId.endsWith('@g.us') : false;
        let chatTitle = isGroup ? 'Group Chat' : 'Private DM';
        if (isGroup) {
            try {
                const meta = await getGroupMetadataSafe(sock, chatId);
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

        const nameDisplay = displayName ? `${displayName} ` : '';
        const senderHeader = `👤 *From:* ${nameDisplay}@${cleanNumber} (+${cleanNumber})`;
        const noteText = customNote ? `\n📝 *Note:* ${customNote}` : '';
        const usedEmoji = reactionEmoji || '👍';
        const isRecoverAction = isViewOnce || usedEmoji === '👍🏿' || source.includes('👍🏿');
        
        const footerTag = isRecoverAction
            ? `_🔒 Silently recovered & forwarded to your yourself number via ${usedEmoji} reaction._`
            : (source.includes('reaction') || source.includes('👍')
                ? `_🔒 Forwarded to your yourself number via ${usedEmoji} reaction._`
                : `_🔒 Forwarded to your yourself number via .f command._`);

        // 1. Audio / Voice Notes (PTT)
        if (mediaType === 'audio') {
            let buffer = memoryBuffer || null;
            if (!buffer && tempDiskPath && fs.existsSync(tempDiskPath)) {
                buffer = fs.readFileSync(tempDiskPath);
            } else if (!buffer && mediaNode) {
                buffer = await downloadMediaBuffer(mediaNode, 'audio');
            }

            if (!buffer || buffer.length === 0) {
                throw new Error('Could not download audio / voice note.');
            }

            const isPtt = mediaNode?.ptt !== undefined ? !!mediaNode.ptt : true;
            const mimetype = mediaNode?.mimetype || 'audio/ogg; codecs=opus';

            const title = isRecoverAction ? `🎙️ *RECOVERED VIEW-ONCE VOICE NOTE*` : `🎙️ *FORWARDED VOICE NOTE*`;
            const header = `╔══════════════════════════╗\n` +
                `║ ${title.padEnd(24, ' ')} ║\n` +
                `╚══════════════════════════╝\n\n` +
                `${senderHeader}\n` +
                `💬 *Chat:* ${chatTitle}\n` +
                `🕒 *Time:* ${timeStr}` +
                noteText + `\n\n` +
                footerTag;

            await sock.sendMessage(selfJid, {
                text: header,
                mentions: mentionJid ? [mentionJid] : []
            });

            await sock.sendMessage(selfJid, {
                audio: buffer,
                mimetype: mimetype,
                ptt: isPtt
            });

            return true;
        }

        // 2. Image / Photo
        if (mediaType === 'image') {
            let buffer = memoryBuffer || null;
            if (!buffer && tempDiskPath && fs.existsSync(tempDiskPath)) {
                buffer = fs.readFileSync(tempDiskPath);
            } else if (!buffer && mediaNode) {
                buffer = await downloadMediaBuffer(mediaNode, 'image');
            }

            if (!buffer || buffer.length === 0) {
                throw new Error('Could not download photo.');
            }

            const originalCaption = mediaNode?.caption ? `\n💬 *Original Caption:* ${mediaNode.caption}` : '';
            const title = isRecoverAction ? `📸 *RECOVERED VIEW-ONCE PHOTO*` : `📸 *FORWARDED PHOTO*`;
            const caption = `╔══════════════════════════╗\n` +
                `║ ${title.padEnd(24, ' ')} ║\n` +
                `╚══════════════════════════╝\n\n` +
                `${senderHeader}\n` +
                `💬 *Chat:* ${chatTitle}\n` +
                `🕒 *Time:* ${timeStr}` +
                originalCaption +
                noteText + `\n\n` +
                footerTag;

            await sock.sendMessage(selfJid, {
                image: buffer,
                caption: caption,
                mentions: mentionJid ? [mentionJid] : []
            });

            return true;
        }

        // 3. Video / Video Note (PTV)
        if (mediaType === 'video') {
            let buffer = memoryBuffer || null;
            if (!buffer && tempDiskPath && fs.existsSync(tempDiskPath)) {
                buffer = fs.readFileSync(tempDiskPath);
            } else if (!buffer && mediaNode) {
                buffer = await downloadMediaBuffer(mediaNode, 'video');
            }

            if (!buffer || buffer.length === 0) {
                throw new Error('Could not download video.');
            }

            const originalCaption = mediaNode?.caption ? `\n💬 *Original Caption:* ${mediaNode.caption}` : '';
            const title = isRecoverAction ? `🎥 *RECOVERED VIEW-ONCE VIDEO*` : `🎥 *FORWARDED VIDEO*`;
            const caption = `╔══════════════════════════╗\n` +
                `║ ${title.padEnd(24, ' ')} ║\n` +
                `╚══════════════════════════╝\n\n` +
                `${senderHeader}\n` +
                `💬 *Chat:* ${chatTitle}\n` +
                `🕒 *Time:* ${timeStr}` +
                originalCaption +
                noteText + `\n\n` +
                footerTag;

            await sock.sendMessage(selfJid, {
                video: buffer,
                caption: caption,
                mimetype: mediaNode?.mimetype || 'video/mp4',
                mentions: mentionJid ? [mentionJid] : []
            });

            return true;
        }

        // 4. Sticker
        if (mediaType === 'sticker') {
            let buffer = memoryBuffer || null;
            if (!buffer && tempDiskPath && fs.existsSync(tempDiskPath)) {
                buffer = fs.readFileSync(tempDiskPath);
            } else if (!buffer && mediaNode) {
                buffer = await downloadMediaBuffer(mediaNode, 'sticker');
            }

            if (!buffer || buffer.length === 0) {
                throw new Error('Could not download sticker.');
            }

            const header = `╔══════════════════════════╗\n` +
                `║ 🖼️ *FORWARDED STICKER*     ║\n` +
                `╚══════════════════════════╝\n\n` +
                `${senderHeader}\n` +
                `💬 *Chat:* ${chatTitle}\n` +
                `🕒 *Time:* ${timeStr}` +
                noteText + `\n\n` +
                footerTag;

            await sock.sendMessage(selfJid, {
                text: header,
                mentions: mentionJid ? [mentionJid] : []
            });

            await sock.sendMessage(selfJid, {
                sticker: buffer
            });

            return true;
        }

        // 5. Document
        if (mediaType === 'document') {
            let buffer = memoryBuffer || null;
            if (!buffer && tempDiskPath && fs.existsSync(tempDiskPath)) {
                buffer = fs.readFileSync(tempDiskPath);
            } else if (!buffer && mediaNode) {
                buffer = await downloadMediaBuffer(mediaNode, 'document');
            }

            if (!buffer || buffer.length === 0) {
                throw new Error('Could not download document.');
            }

            const fileName = mediaNode?.fileName || 'document';
            const mimetype = mediaNode?.mimetype || 'application/octet-stream';
            const caption = `╔══════════════════════════╗\n` +
                `║ 📁 *FORWARDED DOCUMENT*    ║\n` +
                `╚══════════════════════════╝\n\n` +
                `📄 *File:* ${fileName}\n` +
                `${senderHeader}\n` +
                `💬 *Chat:* ${chatTitle}\n` +
                `🕒 *Time:* ${timeStr}` +
                noteText + `\n\n` +
                footerTag;

            await sock.sendMessage(selfJid, {
                document: buffer,
                fileName: fileName,
                mimetype: mimetype,
                caption: caption,
                mentions: mentionJid ? [mentionJid] : []
            });

            return true;
        }

        // 6. Polls
        if (target && (target.pollCreationMessage || target.pollCreationMessageV2 || target.pollCreationMessageV3)) {
            const pollNode = target.pollCreationMessage || target.pollCreationMessageV2 || target.pollCreationMessageV3;
            const pollName = pollNode.name || 'Poll';
            const options = (pollNode.options || []).map(opt => (typeof opt === 'string' ? opt : opt.optionName || 'Option'));
            const selectableCount = pollNode.selectableOptionsCount || 1;

            const formattedOptions = options.map((opt, i) => `${i + 1}. ◽ ${opt}`).join('\n');
            const header = `╔══════════════════════════╗\n` +
                `║ 📊 *FORWARDED POLL*        ║\n` +
                `╚══════════════════════════╝\n\n` +
                `${senderHeader}\n` +
                `💬 *Chat:* ${chatTitle}\n` +
                `🕒 *Time:* ${timeStr}\n\n` +
                `📊 *Question:* ${pollName}\n\n` +
                `*Options:*\n${formattedOptions}` +
                noteText + `\n\n` +
                footerTag;

            await sock.sendMessage(selfJid, {
                text: header,
                mentions: mentionJid ? [mentionJid] : []
            });

            try {
                await sock.sendMessage(selfJid, {
                    poll: {
                        name: pollName,
                        values: options,
                        selectableCount: selectableCount
                    }
                });
            } catch (e) {}

            return true;
        }

        // 7. Contacts
        if (target && (target.contactMessage || target.contactsArrayMessage)) {
            const contacts = target.contactsArrayMessage?.contacts || [target.contactMessage];
            const header = `╔══════════════════════════╗\n` +
                `║ 📇 *FORWARDED CONTACT*     ║\n` +
                `╚══════════════════════════╝\n\n` +
                `${senderHeader}\n` +
                `💬 *Chat:* ${chatTitle}\n` +
                `🕒 *Time:* ${timeStr}` +
                noteText + `\n\n` +
                footerTag;

            await sock.sendMessage(selfJid, {
                text: header,
                mentions: mentionJid ? [mentionJid] : []
            });

            for (const c of contacts) {
                if (c && c.vcard) {
                    await sock.sendMessage(selfJid, {
                        contacts: {
                            displayName: c.displayName || 'Contact',
                            contacts: [{ vcard: c.vcard }]
                        }
                    });
                }
            }
            return true;
        }

        // 8. Locations
        if (target && (target.locationMessage || target.liveLocationMessage)) {
            const loc = target.locationMessage || target.liveLocationMessage;
            const header = `╔══════════════════════════╗\n` +
                `║ 📍 *FORWARDED LOCATION*    ║\n` +
                `╚══════════════════════════╝\n\n` +
                `${senderHeader}\n` +
                `💬 *Chat:* ${chatTitle}\n` +
                `🕒 *Time:* ${timeStr}\n\n` +
                `📍 *Coordinates:* ${loc.degreesLatitude}, ${loc.degreesLongitude}\n` +
                (loc.name ? `🏢 *Name:* ${loc.name}\n` : '') +
                (loc.address ? `📫 *Address:* ${loc.address}\n` : '') +
                noteText + `\n\n` +
                footerTag;

            await sock.sendMessage(selfJid, {
                text: header,
                mentions: mentionJid ? [mentionJid] : []
            });

            try {
                await sock.sendMessage(selfJid, {
                    location: {
                        degreesLatitude: loc.degreesLatitude,
                        degreesLongitude: loc.degreesLongitude,
                        name: loc.name || '',
                        address: loc.address || ''
                    }
                });
            } catch (e) {}

            return true;
        }

        // 9. Text / Conversation / Fallback
        const textContent = (typeof target === 'string' ? target : null)
            || target?.conversation
            || target?.extendedTextMessage?.text
            || (target?.contactMessage ? `📇 Contact: ${target.contactMessage.displayName || 'VCard'}` : '')
            || (target?.locationMessage ? `📍 Location: ${target.locationMessage.degreesLatitude}, ${target.locationMessage.degreesLongitude}` : '');

        if (textContent) {
            const report = `╔══════════════════════════╗\n` +
                `║ 💬 *FORWARDED MESSAGE*     ║\n` +
                `╚══════════════════════════╝\n\n` +
                `${senderHeader}\n` +
                `💬 *Chat:* ${chatTitle}\n` +
                `🕒 *Time:* ${timeStr}\n\n` +
                `📝 *Message Content:*\n${textContent}` +
                (customNote ? `\n\n📌 *Note:* ${customNote}` : '') + `\n\n` +
                footerTag;

            await sock.sendMessage(selfJid, {
                text: report,
                mentions: mentionJid ? [mentionJid] : []
            });

            return true;
        }

        return false;
    } catch (err) {
        console.error('Error forwarding message to owner number:', err.message);
        if (selfJid) {
            try {
                await sock.sendMessage(selfJid, {
                    text: `❌ *Failed to forward to yourself number:* ${err.message || 'Unknown error'}`
                });
            } catch (e) {}
        }
        return false;
    }
}

/**
 * Handles owner reaction forwarding logic for a target message key
 */
async function processOwnerReaction(sock, { targetKey, reactionText, reactionSender, fromMe, source = 'reaction' }) {
    try {
        if (!targetKey || !targetKey.id) return;
        if (!isThumbsUpReaction(reactionText)) return;

        let chatId = targetKey.remoteJid;
        const targetId = targetKey.id;

        // Verify that the person who reacted is the owner, sudo, or from the bot account
        const isOwner = fromMe || await isOwnerOrSudo(reactionSender, sock, chatId);
        if (!isOwner) return;

        const cleanEmoji = reactionText ? reactionText.trim() : '👍';

        // Normalized deduplication key (targetId + cleanEmoji)
        const dedupKey = `${targetId}_${cleanEmoji}`;
        const now = Date.now();
        if (processedReactions.has(dedupKey) && (now - processedReactions.get(dedupKey)) < DEDUP_TTL_MS) {
            return;
        }
        processedReactions.set(dedupKey, now);

        console.log(`👍 [Owner Reaction] Detected ${cleanEmoji} reaction from owner on message ID: ${targetId} in chat: ${chatId}`);

        let resolvedTarget = null;
        let mediaType = null;
        let mediaNode = null;
        let tempDiskPath = null;
        let memoryBuffer = null;
        let isViewOnce = false;
        let senderJid = targetKey.participant || (targetKey.fromMe ? sock.user?.id : chatId);
        let pushName = '';
        let foundRaw = null;

        // 1. Check ViewOnce dedicated cache (stores pre-buffered view-once media and indexed messages)
        const cachedVo = getCachedViewOnce(targetId);
        if (cachedVo) {
            if (cachedVo.isViewOnce) isViewOnce = true;
            if (cachedVo.sender) senderJid = cachedVo.sender;
            if (cachedVo.pushName) pushName = cachedVo.pushName;
            if (cachedVo.chatId && !chatId) chatId = cachedVo.chatId;
            if (cachedVo.mediaType) mediaType = cachedVo.mediaType;
            if (cachedVo.mediaNode) {
                mediaNode = cachedVo.mediaNode;
                resolvedTarget = { [mediaType + 'Message']: mediaNode };
            } else if (cachedVo.unwrapped) {
                resolvedTarget = cachedVo.unwrapped;
            }
            if (cachedVo.buffer) {
                memoryBuffer = cachedVo.buffer;
            }
            if (cachedVo.filePath && fs.existsSync(cachedVo.filePath)) {
                tempDiskPath = cachedVo.filePath;
            }
        }

        // 2. Check Antidelete in-memory store (stores rawMsg, innerMsg, mediaPath, content)
        if (!resolvedTarget || !mediaNode) {
            const storedAntidelete = getStoredMessage(targetId);
            if (storedAntidelete) {
                if (storedAntidelete.sender && !senderJid) senderJid = storedAntidelete.sender;
                if (storedAntidelete.senderName && !pushName) pushName = storedAntidelete.senderName;
                if (!mediaType) mediaType = storedAntidelete.mediaType;
                if (storedAntidelete.mediaPath && fs.existsSync(storedAntidelete.mediaPath) && !tempDiskPath) {
                    tempDiskPath = storedAntidelete.mediaPath;
                }
                if (storedAntidelete.innerMsg && !resolvedTarget) {
                    resolvedTarget = storedAntidelete.innerMsg;
                    const extracted = extractMediaFromNode(resolvedTarget);
                    if (extracted.mediaNode) {
                        mediaNode = extracted.mediaNode;
                        mediaType = extracted.mediaType;
                        if (extracted.isViewOnce) isViewOnce = true;
                    }
                }
                if (storedAntidelete.rawMsg && !foundRaw) {
                    foundRaw = storedAntidelete.rawMsg;
                }
            }
        }

        // 3. Check lightweight Baileys store (with multi-hundred message history & global ID index)
        if (!resolvedTarget && store) {
            if (chatId) {
                foundRaw = await store.loadMessage(chatId, targetId);
            }
            if (!foundRaw) {
                foundRaw = await store.loadMessage(null, targetId);
            }
            if (foundRaw && foundRaw.message) {
                if (foundRaw.key?.participant) senderJid = foundRaw.key.participant;
                if (foundRaw.pushName && !pushName) pushName = foundRaw.pushName;
                if (foundRaw.key?.remoteJid && !chatId) chatId = foundRaw.key.remoteJid;
                resolvedTarget = unwrapMessage(foundRaw.message);
                const extracted = extractMediaFromNode(resolvedTarget);
                if (extracted.mediaNode) {
                    mediaNode = extracted.mediaNode;
                    mediaType = extracted.mediaType;
                    if (extracted.isViewOnce) isViewOnce = true;
                }
            }
        }

        // 4. Check Status cache
        if (!resolvedTarget) {
            const statusObj = getStatusById(targetId);
            if (statusObj && statusObj.message) {
                resolvedTarget = unwrapMessage(statusObj.message);
                if (statusObj.participant) senderJid = statusObj.participant;
                if (statusObj.pushName && !pushName) pushName = statusObj.pushName;
                const extracted = extractMediaFromNode(resolvedTarget);
                if (extracted.mediaNode) {
                    mediaNode = extracted.mediaNode;
                    mediaType = extracted.mediaType;
                    if (extracted.isViewOnce) isViewOnce = true;
                }
            }
        }

        // 5. Check Disk Temp cache files (including vo_, temp, and recovery files)
        if (!tempDiskPath) {
            const tempDirs = [
                path.join(__dirname, '../tmp'),
                path.join(__dirname, '../tmp/recovery'),
                path.join(__dirname, '../temp'),
                path.join(process.cwd(), 'temp')
            ];
            const possibleExts = [
                { ext: '.opus', type: 'audio' },
                { ext: '.ogg', type: 'audio' },
                { ext: '.mp3', type: 'audio' },
                { ext: '.jpg', type: 'image' },
                { ext: '.jpeg', type: 'image' },
                { ext: '.png', type: 'image' },
                { ext: '.mp4', type: 'video' },
                { ext: '.webp', type: 'sticker' },
                { ext: '.bin', type: 'document' }
            ];

            for (const tempDir of tempDirs) {
                if (!fs.existsSync(tempDir)) continue;
                for (const item of possibleExts) {
                    const voPath = path.join(tempDir, `vo_${targetId}${item.ext}`);
                    const directPath = path.join(tempDir, `${targetId}${item.ext}`);
                    const antideletePath = path.join(tempDir, `antidelete_${targetId}${item.ext}`);
                    const recoveryPath = path.join(tempDir, 'recovery', `${targetId}${item.ext}`);

                    if (fs.existsSync(voPath)) {
                        tempDiskPath = voPath;
                        mediaType = item.type;
                        isViewOnce = true;
                        break;
                    } else if (fs.existsSync(directPath)) {
                        tempDiskPath = directPath;
                        mediaType = item.type;
                        break;
                    } else if (fs.existsSync(antideletePath)) {
                        tempDiskPath = antideletePath;
                        mediaType = item.type;
                        break;
                    } else if (fs.existsSync(recoveryPath)) {
                        tempDiskPath = recoveryPath;
                        mediaType = item.type;
                        break;
                    }
                }
                if (tempDiskPath) break;
            }
        }

        // 6. Handle Quoted/Replied Media: If target message itself is text quoting a media message
        if (!mediaNode && !tempDiskPath && !memoryBuffer) {
            const contextInfo = resolvedTarget?.extendedTextMessage?.contextInfo
                || resolvedTarget?.conversation?.contextInfo
                || foundRaw?.message?.extendedTextMessage?.contextInfo
                || foundRaw?.message?.conversation?.contextInfo;

            if (contextInfo) {
                const quotedRaw = contextInfo.quotedMessage ? unwrapMessage(contextInfo.quotedMessage) : null;
                if (quotedRaw) {
                    const extracted = extractMediaFromNode(quotedRaw);
                    if (extracted.mediaNode) {
                        mediaNode = extracted.mediaNode;
                        mediaType = extracted.mediaType;
                        resolvedTarget = quotedRaw;
                        if (extracted.isViewOnce) isViewOnce = true;
                        if (contextInfo.participant) senderJid = contextInfo.participant;
                        console.log(`👍 [Owner Reaction] Successfully resolved quoted media (${mediaType}) from replied message`);
                    }
                }

                if ((!mediaNode && !tempDiskPath && !memoryBuffer) && contextInfo.stanzaId) {
                    const quotedId = contextInfo.stanzaId;
                    const cachedQuotedVo = getCachedViewOnce(quotedId);
                    if (cachedQuotedVo) {
                        mediaNode = cachedQuotedVo.mediaNode;
                        mediaType = cachedQuotedVo.mediaType;
                        memoryBuffer = cachedQuotedVo.buffer;
                        tempDiskPath = cachedQuotedVo.filePath;
                        isViewOnce = true;
                        if (cachedQuotedVo.sender) senderJid = cachedQuotedVo.sender;
                        if (cachedQuotedVo.pushName && !pushName) pushName = cachedQuotedVo.pushName;
                    } else {
                        const storedQuoted = getStoredMessage(quotedId);
                        if (storedQuoted) {
                            if (storedQuoted.mediaPath && fs.existsSync(storedQuoted.mediaPath)) {
                                tempDiskPath = storedQuoted.mediaPath;
                            }
                            if (storedQuoted.innerMsg) {
                                const ext = extractMediaFromNode(storedQuoted.innerMsg);
                                if (ext.mediaNode) {
                                    mediaNode = ext.mediaNode;
                                    mediaType = ext.mediaType;
                                    if (ext.isViewOnce) isViewOnce = true;
                                }
                            }
                            if (storedQuoted.sender) senderJid = storedQuoted.sender;
                            if (storedQuoted.senderName && !pushName) pushName = storedQuoted.senderName;
                        }
                    }
                }
            }
        }

        // 7. Forward / recover content directly to the owner's WhatsApp number (yourself number)
        const success = await forwardToOwnerNumber(sock, {
            target: resolvedTarget,
            mediaNode,
            mediaType,
            tempDiskPath,
            memoryBuffer,
            stanzaId: targetId,
            senderJid,
            chatId,
            pushName,
            isViewOnce,
            reactionEmoji: cleanEmoji,
            source: `${cleanEmoji} reaction`
        });

        if (success) {
            console.log(`✅ [Owner Reaction] Successfully forwarded/recovered ${mediaType || 'message'} to owner yourself number!`);
        }

    } catch (err) {
        console.error('❌ [Owner Reaction] Error processing reaction forward:', err);
    }
}

/**
 * Handle incoming reaction message from messages.upsert
 */
async function handleOwnerReactionUpsert(sock, message) {
    try {
        const unwrapped = unwrapMessage(message.message) || message.message;
        const reactionMessage = unwrapped?.reactionMessage || message.message?.reactionMessage;
        if (!reactionMessage) return;

        const targetKey = reactionMessage.key ? {
            ...reactionMessage.key,
            remoteJid: reactionMessage.key.remoteJid || message.key.remoteJid
        } : null;
        if (!targetKey) return;

        const reactionText = reactionMessage.text;
        const fromMe = Boolean(message.key.fromMe);
        const reactionSender = message.key.participant || (fromMe ? (sock.user?.id || getOwnerSelfJid(sock)) : message.key.remoteJid);

        await processOwnerReaction(sock, {
            targetKey,
            reactionText,
            reactionSender,
            fromMe,
            source: 'upsert'
        });
    } catch (err) {
        console.error('Error in handleOwnerReactionUpsert:', err);
    }
}

/**
 * Handle reaction event from messages.reaction event in Baileys
 */
async function handleOwnerReactionEvent(sock, reactionUpdates) {
    try {
        if (!Array.isArray(reactionUpdates)) {
            reactionUpdates = [reactionUpdates];
        }

        for (const item of reactionUpdates) {
            if (!item) continue;

            // In Baileys: item.key is the target message key, item.reaction.key is the reaction's message key
            let targetKey = (item.key && item.key.id) ? { ...item.key } : (item.reaction?.key && item.reaction.key.id ? { ...item.reaction.key } : null);
            if (!targetKey || !targetKey.id) continue;

            if (!targetKey.remoteJid) {
                targetKey.remoteJid = item.reaction?.key?.remoteJid || item.userJid;
            }

            const reactionText = item.reaction?.text || item.text;
            if (!reactionText) continue;

            const reactionMsgKey = item.reaction?.key || {};
            const botIdClean = sock.user?.id ? sock.user.id.split(':')[0].split('@')[0].replace(/[^0-9]/g, '') : '';
            const userJidClean = item.userJid ? item.userJid.split(':')[0].split('@')[0].replace(/[^0-9]/g, '') : '';
            
            const fromMe = Boolean(
                reactionMsgKey.fromMe || 
                item.fromMe || 
                (botIdClean && userJidClean && botIdClean === userJidClean)
            );
            
            const reactionSender = reactionMsgKey.participant || 
                                   item.userJid || 
                                   item.participant || 
                                   (fromMe ? (sock.user?.id || getOwnerSelfJid(sock)) : (reactionMsgKey.remoteJid || item.key?.remoteJid));

            await processOwnerReaction(sock, {
                targetKey,
                reactionText,
                reactionSender,
                fromMe,
                source: 'messages.reaction'
            });
        }
    } catch (err) {
        console.error('Error in handleOwnerReactionEvent:', err);
    }
}

module.exports = {
    isThumbsUpReaction,
    processOwnerReaction,
    handleOwnerReactionUpsert,
    handleOwnerReactionEvent,
    forwardToOwnerNumber
};
