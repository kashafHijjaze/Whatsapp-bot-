const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const settings = require('../settings');
const { getCachedViewOnce } = require('../lib/viewonceCache');
const { getStoredMessage } = require('./antidelete');
const { getOwnerSelfJid } = require('../lib/ownerHelper');
const { getGroupMetadataSafe } = require('../lib/groupMetadataCache');
const store = require('../lib/lightweight_store');
const path = require('path');
const fs = require('fs');

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
 * .f / .forward command
 * Forwards any replied or sent message (voice note, audio, image, video, document, sticker, poll, contact, location, or text)
 * directly and reliably to the user's own (yourself) number or custom destination.
 */
async function forwardToSelfCommand(sock, chatId, message, customNote = '') {
    const defaultSelfJid = getOwnerSelfJid(sock) || (sock.user?.id ? `${sock.user.id.split(':')[0].replace(/[^0-9]/g, '')}@s.whatsapp.net` : chatId);
    let targetDestination = defaultSelfJid;
    let parsedNote = (customNote || '').trim();

    try {
        const unwrappedSource = unwrapMessage(message?.message) || message?.message;

        // Extract contextInfo from all possible message structures
        const contextInfo = unwrappedSource?.extendedTextMessage?.contextInfo
            || unwrappedSource?.imageMessage?.contextInfo
            || unwrappedSource?.videoMessage?.contextInfo
            || unwrappedSource?.audioMessage?.contextInfo
            || unwrappedSource?.documentMessage?.contextInfo
            || unwrappedSource?.stickerMessage?.contextInfo
            || unwrappedSource?.conversation?.contextInfo
            || unwrappedSource?.pollCreationMessage?.contextInfo
            || message.message?.extendedTextMessage?.contextInfo;

        // Parse destination from customNote if user specified e.g. `.f 923001234567` or `.f @user` or `.f groupJid`
        if (parsedNote) {
            const parts = parsedNote.split(/\s+/);
            const firstToken = parts[0].trim();
            if (firstToken.toLowerCase() === 'me' || firstToken.toLowerCase() === 'self') {
                targetDestination = defaultSelfJid;
                parsedNote = parts.slice(1).join(' ').trim();
            } else if (firstToken.endsWith('@s.whatsapp.net') || firstToken.endsWith('@g.us')) {
                targetDestination = firstToken;
                parsedNote = parts.slice(1).join(' ').trim();
            } else if (/^\+?[0-9]{7,15}$/.test(firstToken.replace(/[\s\-\(\)]/g, ''))) {
                const cleanNum = firstToken.replace(/[^0-9]/g, '');
                targetDestination = `${cleanNum}@s.whatsapp.net`;
                parsedNote = parts.slice(1).join(' ').trim();
            } else if (firstToken.startsWith('@') && contextInfo?.mentionedJid && contextInfo.mentionedJid.length > 0) {
                targetDestination = contextInfo.mentionedJid[0];
                parsedNote = parts.slice(1).join(' ').trim();
            }
        }

        const stanzaId = contextInfo?.stanzaId;
        let quotedRaw = contextInfo?.quotedMessage;

        // If not quoting a message, check if current message itself contains media (direct .f caption)
        if (!quotedRaw && !stanzaId) {
            if (unwrappedSource?.imageMessage || unwrappedSource?.videoMessage || unwrappedSource?.audioMessage || unwrappedSource?.documentMessage || unwrappedSource?.stickerMessage) {
                quotedRaw = unwrappedSource;
            }
        }

        if (!quotedRaw && !stanzaId) {
            return await sock.sendMessage(chatId, {
                text: '❌ *Please reply to a message, photo, video, voice note, sticker, poll, document, or text with `.f` to forward it.*'
            }, { quoted: message });
        }

        // Determine sender and chat context
        let senderJid = contextInfo?.participant || contextInfo?.remoteJid || (quotedRaw === unwrappedSource ? (message.key.participant || message.key.remoteJid) : chatId);
        const isGroup = chatId.endsWith('@g.us');
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

        // 1. Unwrap target message
        let target = quotedRaw ? unwrapMessage(quotedRaw) : null;
        let mediaType = null;
        let mediaNode = null;
        let isViewOnce = false;
        let memoryBuffer = null;
        let tempDiskPath = null;

        if (target) {
            if (target.audioMessage) {
                mediaType = 'audio';
                mediaNode = target.audioMessage;
                if (target.audioMessage.viewOnce) isViewOnce = true;
            } else if (target.imageMessage) {
                mediaType = 'image';
                mediaNode = target.imageMessage;
                if (target.imageMessage.viewOnce) isViewOnce = true;
            } else if (target.videoMessage) {
                mediaType = 'video';
                mediaNode = target.videoMessage;
                if (target.videoMessage.viewOnce) isViewOnce = true;
            } else if (target.ptvMessage) {
                mediaType = 'video';
                mediaNode = target.ptvMessage;
            } else if (target.stickerMessage) {
                mediaType = 'sticker';
                mediaNode = target.stickerMessage;
            } else if (target.documentMessage) {
                mediaType = 'document';
                mediaNode = target.documentMessage;
            } else if (target.pollCreationMessage || target.pollCreationMessageV2 || target.pollCreationMessageV3) {
                mediaType = 'poll';
            } else if (target.contactMessage || target.contactsArrayMessage) {
                mediaType = 'contact';
            } else if (target.locationMessage || target.liveLocationMessage) {
                mediaType = 'location';
            } else if (target.conversation || target.extendedTextMessage?.text) {
                mediaType = 'text';
            }
        }

        // 2. Check ViewOnce in-memory cache if mediaNode is missing or view-once
        if ((!mediaNode || isViewOnce) && stanzaId) {
            const cached = getCachedViewOnce(stanzaId);
            if (cached) {
                if (cached.mediaNode) mediaNode = cached.mediaNode;
                if (cached.mediaType) mediaType = cached.mediaType;
                if (cached.buffer) memoryBuffer = cached.buffer;
                if (cached.filePath && fs.existsSync(cached.filePath)) tempDiskPath = cached.filePath;
                if (cached.sender) senderJid = cached.sender;
                isViewOnce = true;
            }
        }

        // 3. Check Antidelete store
        if (!mediaNode && stanzaId) {
            const stored = getStoredMessage(stanzaId);
            if (stored) {
                if (stored.sender) senderJid = stored.sender;
                if (stored.mediaType) mediaType = stored.mediaType;
                if (stored.mediaPath && fs.existsSync(stored.mediaPath)) {
                    tempDiskPath = stored.mediaPath;
                }
                if (stored.innerMsg) {
                    const unwrappedStored = unwrapMessage(stored.innerMsg);
                    if (unwrappedStored.audioMessage) {
                        mediaType = 'audio';
                        mediaNode = unwrappedStored.audioMessage;
                    } else if (unwrappedStored.imageMessage) {
                        mediaType = 'image';
                        mediaNode = unwrappedStored.imageMessage;
                    } else if (unwrappedStored.videoMessage) {
                        mediaType = 'video';
                        mediaNode = unwrappedStored.videoMessage;
                    } else if (unwrappedStored.documentMessage) {
                        mediaType = 'document';
                        mediaNode = unwrappedStored.documentMessage;
                    } else if (unwrappedStored.stickerMessage) {
                        mediaType = 'sticker';
                        mediaNode = unwrappedStored.stickerMessage;
                    } else if (unwrappedStored.pollCreationMessage || unwrappedStored.pollCreationMessageV2 || unwrappedStored.pollCreationMessageV3) {
                        mediaType = 'poll';
                        target = unwrappedStored;
                    } else if (unwrappedStored.contactMessage || unwrappedStored.contactsArrayMessage) {
                        mediaType = 'contact';
                        target = unwrappedStored;
                    } else if (unwrappedStored.locationMessage || unwrappedStored.liveLocationMessage) {
                        mediaType = 'location';
                        target = unwrappedStored;
                    }
                }
            }
        }

        // 4. Check Baileys store
        if (!mediaNode && !target && stanzaId && store) {
            const loaded = await store.loadMessage(chatId, stanzaId);
            if (loaded && loaded.message) {
                target = unwrapMessage(loaded.message);
                if (target.audioMessage) {
                    mediaType = 'audio';
                    mediaNode = target.audioMessage;
                } else if (target.imageMessage) {
                    mediaType = 'image';
                    mediaNode = target.imageMessage;
                } else if (target.videoMessage) {
                    mediaType = 'video';
                    mediaNode = target.videoMessage;
                } else if (target.documentMessage) {
                    mediaType = 'document';
                    mediaNode = target.documentMessage;
                } else if (target.stickerMessage) {
                    mediaType = 'sticker';
                    mediaNode = target.stickerMessage;
                } else if (target.pollCreationMessage || target.pollCreationMessageV2 || target.pollCreationMessageV3) {
                    mediaType = 'poll';
                } else if (target.contactMessage || target.contactsArrayMessage) {
                    mediaType = 'contact';
                } else if (target.locationMessage || target.liveLocationMessage) {
                    mediaType = 'location';
                }
            }
        }

        // 5. Check temporary disk cache
        if (!mediaNode && !memoryBuffer && !tempDiskPath && stanzaId) {
            const tempDir = path.join(__dirname, '../tmp');
            const possibleExts = [
                { ext: '.opus', type: 'audio' },
                { ext: '.ogg', type: 'audio' },
                { ext: '.mp3', type: 'audio' },
                { ext: '.jpg', type: 'image' },
                { ext: '.jpeg', type: 'image' },
                { ext: '.png', type: 'image' },
                { ext: '.mp4', type: 'video' },
                { ext: '.webp', type: 'sticker' }
            ];

            for (const item of possibleExts) {
                const voPath = path.join(tempDir, `vo_${stanzaId}${item.ext}`);
                const directPath = path.join(tempDir, `${stanzaId}${item.ext}`);
                const antideletePath = path.join(tempDir, `antidelete_${stanzaId}${item.ext}`);
                const recoveryPath = path.join(tempDir, 'recovery', `${stanzaId}${item.ext}`);

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
        }

        const { cleanNumber, mentionJid, displayName } = await resolveSenderDetails(sock, chatId, senderJid, message.pushName || '');
        const nameDisplay = displayName ? `${displayName} ` : '';
        const senderHeader = `👤 *From:* ${nameDisplay}@${cleanNumber} (+${cleanNumber})`;
        const formattedNote = parsedNote ? `\n📝 *Note:* ${parsedNote}` : '';

        // Handle Audio / Voice Notes (PTT)
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

            const header = `╔══════════════════════════╗\n` +
                `║ 🎙️ *FORWARDED VOICE NOTE*   ║\n` +
                `╚══════════════════════════╝\n\n` +
                `${senderHeader}\n` +
                `💬 *Chat:* ${chatTitle}\n` +
                `🕒 *Time:* ${timeStr}` +
                formattedNote + `\n\n` +
                `_🔒 Forwarded via .f command_`;

            await sock.sendMessage(targetDestination, {
                text: header,
                mentions: mentionJid ? [mentionJid] : []
            });

            await sock.sendMessage(targetDestination, {
                audio: buffer,
                mimetype: mimetype,
                ptt: isPtt
            });

            return;
        }

        // Handle Image / Photo
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
            const caption = `╔══════════════════════════╗\n` +
                `║ 📸 *FORWARDED PHOTO*       ║\n` +
                `╚══════════════════════════╝\n\n` +
                `${senderHeader}\n` +
                `💬 *Chat:* ${chatTitle}\n` +
                `🕒 *Time:* ${timeStr}` +
                originalCaption +
                formattedNote + `\n\n` +
                `_🔒 Forwarded via .f command_`;

            await sock.sendMessage(targetDestination, {
                image: buffer,
                caption: caption,
                mentions: mentionJid ? [mentionJid] : []
            });

            return;
        }

        // Handle Video
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
            const caption = `╔══════════════════════════╗\n` +
                `║ 🎥 *FORWARDED VIDEO*       ║\n` +
                `╚══════════════════════════╝\n\n` +
                `${senderHeader}\n` +
                `💬 *Chat:* ${chatTitle}\n` +
                `🕒 *Time:* ${timeStr}` +
                originalCaption +
                formattedNote + `\n\n` +
                `_🔒 Forwarded via .f command_`;

            await sock.sendMessage(targetDestination, {
                video: buffer,
                caption: caption,
                mimetype: mediaNode?.mimetype || 'video/mp4',
                mentions: mentionJid ? [mentionJid] : []
            });

            return;
        }

        // Handle Sticker
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
                formattedNote;

            await sock.sendMessage(targetDestination, {
                text: header,
                mentions: mentionJid ? [mentionJid] : []
            });

            await sock.sendMessage(targetDestination, {
                sticker: buffer
            });

            return;
        }

        // Handle Document
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
                formattedNote;

            await sock.sendMessage(targetDestination, {
                document: buffer,
                fileName: fileName,
                mimetype: mimetype,
                caption: caption,
                mentions: mentionJid ? [mentionJid] : []
            });

            return;
        }

        // Handle Polls
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
                (formattedNote ? `\n\n${formattedNote}` : '') + `\n\n` +
                `_🔒 Forwarded via .f command_`;

            await sock.sendMessage(targetDestination, {
                text: header,
                mentions: mentionJid ? [mentionJid] : []
            });

            try {
                await sock.sendMessage(targetDestination, {
                    poll: {
                        name: pollName,
                        values: options,
                        selectableCount: selectableCount
                    }
                });
            } catch (e) {}

            return;
        }

        // Handle Contacts
        if (target && (target.contactMessage || target.contactsArrayMessage)) {
            const contacts = target.contactsArrayMessage?.contacts || [target.contactMessage];
            const header = `╔══════════════════════════╗\n` +
                `║ 📇 *FORWARDED CONTACT*     ║\n` +
                `╚══════════════════════════╝\n\n` +
                `${senderHeader}\n` +
                `💬 *Chat:* ${chatTitle}\n` +
                `🕒 *Time:* ${timeStr}` +
                formattedNote + `\n\n` +
                `_🔒 Forwarded via .f command_`;

            await sock.sendMessage(targetDestination, {
                text: header,
                mentions: mentionJid ? [mentionJid] : []
            });

            for (const c of contacts) {
                if (c && c.vcard) {
                    await sock.sendMessage(targetDestination, {
                        contacts: {
                            displayName: c.displayName || 'Contact',
                            contacts: [{ vcard: c.vcard }]
                        }
                    });
                }
            }
            return;
        }

        // Handle Locations
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
                formattedNote + `\n\n` +
                `_🔒 Forwarded via .f command_`;

            await sock.sendMessage(targetDestination, {
                text: header,
                mentions: mentionJid ? [mentionJid] : []
            });

            try {
                await sock.sendMessage(targetDestination, {
                    location: {
                        degreesLatitude: loc.degreesLatitude,
                        degreesLongitude: loc.degreesLongitude,
                        name: loc.name || '',
                        address: loc.address || ''
                    }
                });
            } catch (e) {}
            return;
        }

        // Handle Text / Fallback
        const textContent = target?.conversation
            || target?.extendedTextMessage?.text
            || (typeof target === 'string' ? target : null);

        if (textContent) {
            const report = `╔══════════════════════════╗\n` +
                `║ 💬 *FORWARDED MESSAGE*     ║\n` +
                `╚══════════════════════════╝\n\n` +
                `${senderHeader}\n` +
                `💬 *Chat:* ${chatTitle}\n` +
                `🕒 *Time:* ${timeStr}\n\n` +
                `📝 *Message Content:*\n${textContent}` +
                (parsedNote ? `\n\n📌 *Note:* ${parsedNote}` : '') + `\n\n` +
                `_🔒 Forwarded via .f command_`;

            await sock.sendMessage(targetDestination, {
                text: report,
                mentions: mentionJid ? [mentionJid] : []
            });

            return;
        }

        // If nothing could be extracted
        if (defaultSelfJid) {
            await sock.sendMessage(defaultSelfJid, {
                text: '❌ *Failed to forward to yourself number:* Could not extract media or content from replied message.'
            });
        }

    } catch (err) {
        console.error('Error in forwardToSelfCommand (.f):', err);
        const errMsg = err?.message || 'Unknown error';
        if (defaultSelfJid) {
            try {
                await sock.sendMessage(defaultSelfJid, {
                    text: `❌ *Failed to forward to yourself number:* ${errMsg}`
                });
            } catch (e) {
                console.error('Failed to send error notice to self number:', e);
            }
        }
    }
}

module.exports = forwardToSelfCommand;
