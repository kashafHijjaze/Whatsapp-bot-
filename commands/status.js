const settings = require('../settings');
const { findStatusesForUser, downloadStatusMedia, resolvePhoneAndLid } = require('../lib/statusCache');
const store = require('../lib/lightweight_store');
const { channelInfo } = require('../lib/messageConfig');
const { getOwnerSelfJid } = require('../lib/ownerHelper');

/**
 * Helper to safely pause between socket message dispatches
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * .status command
 * Downloads ALL active WhatsApp status(es) of a mentioned/quoted/specified user or chat.
 * If the user has multiple statuses, it downloads and forwards all of them sequentially.
 */
async function statusCommand(sock, chatId, message, args = []) {
    try {
        const isGroup = chatId.endsWith('@g.us');
        const selfJid = getOwnerSelfJid(sock);
        const selfNumber = selfJid ? selfJid.split('@')[0] : null;

        const contextInfo = message.message?.extendedTextMessage?.contextInfo
            || message.message?.imageMessage?.contextInfo
            || message.message?.videoMessage?.contextInfo
            || message.message?.audioMessage?.contextInfo
            || message.message?.documentMessage?.contextInfo
            || message.message?.conversation?.contextInfo;

        let targetJid = null;
        let targetPhone = null;
        let isAllRequest = false;

        // Check if user requested all statuses across all contacts
        const firstArg = (args[0] || '').trim().toLowerCase();
        if (firstArg === 'all' || firstArg === 'everyone' || firstArg === '*') {
            isAllRequest = true;
        }

        // 1. Check mentioned JIDs in message
        if (!isAllRequest && contextInfo?.mentionedJid && contextInfo.mentionedJid.length > 0) {
            targetJid = contextInfo.mentionedJid[0];
        }

        // 2. Check quoted message sender
        if (!isAllRequest && !targetJid && (contextInfo?.participant || contextInfo?.remoteJid)) {
            targetJid = contextInfo.participant || contextInfo.remoteJid;
        }

        // 3. Check arguments for @mention or digits or name
        if (!isAllRequest && !targetJid && args.length > 0) {
            const rawArg = args.join(' ').trim();
            const extracted = rawArg.replace(/[^0-9]/g, '');
            if (extracted && extracted.length >= 6) {
                targetPhone = extracted;
                targetJid = `${extracted}@s.whatsapp.net`;
            } else {
                targetPhone = rawArg;
            }
        }

        // 4. If in a 1-on-1 private chat and no args/quotes provided, target the DM contact automatically
        if (!isAllRequest && !targetJid && !targetPhone && !isGroup && chatId.endsWith('@s.whatsapp.net')) {
            targetJid = chatId;
        }

        // If still no target, show command usage help
        if (!isAllRequest && !targetJid && !targetPhone) {
            const helpText = `╔═══════════════════╗
   *📥 STATUS DOWNLOADER*
╚═══════════════════╝

*Commands:*
• \`.status @user\` (Mention a user)
• \`.status <phone_number>\` (e.g. .status 923001234567)
• Reply to any message with \`.status\`
• \`.status all\` (Download all statuses from all contacts)

_💡 If the user has multiple statuses, all of them will be automatically downloaded and forwarded to your WhatsApp number._`;

            return await sock.sendMessage(chatId, {
                text: helpText,
                ...channelInfo
            }, { quoted: message });
        }

        if (!isAllRequest && !targetPhone && targetJid) {
            const { phone } = resolvePhoneAndLid(targetJid, null);
            targetPhone = phone || targetJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
        }

        // React with ⏳ loading indicator
        try {
            await sock.sendMessage(chatId, { react: { text: '⏳', key: message.key } });
        } catch (e) {}

        // Find all statuses for target (or all)
        const statuses = findStatusesForUser(isAllRequest ? 'all' : (targetPhone || targetJid), store);

        if (!statuses || statuses.length === 0) {
            // React with ❌
            try {
                await sock.sendMessage(chatId, { react: { text: '❌', key: message.key } });
            } catch (e) {}

            return await sock.sendMessage(chatId, {
                text: `❌ *No active status found for ${isAllRequest ? 'any contact' : `@${targetPhone || targetJid}`}*\n\n` +
                      `_💡 Note: WhatsApp statuses can only be captured if they were posted while the bot was connected._`,
                mentions: targetJid ? [targetJid] : [],
                ...channelInfo
            }, { quoted: message });
        }

        // Build list of unique target destinations to forward to
        const destinationJids = new Set();
        if (selfJid) destinationJids.add(selfJid);

        const ownerNumber = settings.ownerNumber ? settings.ownerNumber.replace(/[^0-9]/g, '') : null;
        const ownerJid = ownerNumber ? `${ownerNumber}@s.whatsapp.net` : null;
        if (ownerJid) destinationJids.add(ownerJid);

        // Fallback: If neither yourself nor owner is reachable, send to current chat
        if (destinationJids.size === 0) {
            destinationJids.add(chatId);
        }

        const totalCount = statuses.length;
        let successCount = 0;

        // If multiple statuses found, notify user
        if (totalCount > 1 && chatId !== selfJid) {
            try {
                await sock.sendMessage(chatId, {
                    text: `⏳ *Found ${totalCount} statuses for @${targetPhone || 'user'}. Downloading all...*`,
                    mentions: targetJid ? [targetJid] : [],
                    ...channelInfo
                }, { quoted: message });
            } catch (e) {}
        }

        for (let i = 0; i < statuses.length; i++) {
            const st = statuses[i];
            const itemSenderPhone = st.phone || (st.participant ? st.participant.split('@')[0].split(':')[0].replace(/[^0-9]/g, '') : targetPhone);
            const itemSenderJid = itemSenderPhone ? `${itemSenderPhone}@s.whatsapp.net` : targetJid;

            const timeStr = st.timestamp ? new Date(st.timestamp).toLocaleString('en-US', {
                hour12: true,
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                day: '2-digit',
                month: '2-digit',
                year: 'numeric'
            }) : 'Recent';

            try {
                const downloaded = await downloadStatusMedia(st);
                const captionHeader = `╔══════════════════════════╗\n` +
                    `║ 📱 *DOWNLOADED STATUS [${i + 1}/${totalCount}]* ║\n` +
                    `╚══════════════════════════╝\n\n` +
                    `👤 *User:* @${itemSenderPhone} (+${itemSenderPhone})\n` +
                    `📛 *Name:* ${st.pushName || 'WhatsApp Contact'}\n` +
                    `🕒 *Posted:* ${timeStr}\n` +
                    (st.caption ? `📝 *Caption:* ${st.caption}\n\n` : '\n') +
                    `_🔒 Forwarded privately by HijjazI AI_`;

                for (const dest of destinationJids) {
                    try {
                        if (downloaded.type === 'image') {
                            await sock.sendMessage(dest, {
                                image: downloaded.buffer,
                                caption: captionHeader,
                                mentions: itemSenderJid ? [itemSenderJid] : [],
                                ...channelInfo
                            });
                        } else if (downloaded.type === 'video') {
                            await sock.sendMessage(dest, {
                                video: downloaded.buffer,
                                mimetype: downloaded.mimetype || 'video/mp4',
                                caption: captionHeader,
                                mentions: itemSenderJid ? [itemSenderJid] : [],
                                ...channelInfo
                            });
                        } else if (downloaded.type === 'audio') {
                            await sock.sendMessage(dest, {
                                text: captionHeader,
                                mentions: itemSenderJid ? [itemSenderJid] : [],
                                ...channelInfo
                            });
                            await sleep(400);
                            await sock.sendMessage(dest, {
                                audio: downloaded.buffer,
                                mimetype: downloaded.mimetype || 'audio/ogg; codecs=opus',
                                ptt: downloaded.ptt !== undefined ? downloaded.ptt : true,
                                ...channelInfo
                            });
                        } else if (downloaded.type === 'text') {
                            const textBody = `╔══════════════════════════╗\n` +
                                `║ 📱 *DOWNLOADED TEXT STATUS [${i + 1}/${totalCount}]* ║\n` +
                                `╚══════════════════════════╝\n\n` +
                                `👤 *User:* @${itemSenderPhone} (+${itemSenderPhone})\n` +
                                `📛 *Name:* ${st.pushName || 'WhatsApp Contact'}\n` +
                                `🕒 *Posted:* ${timeStr}\n\n` +
                                `💬 *Text Content:*\n${downloaded.text}\n\n` +
                                `_🔒 Forwarded privately by HijjazI AI_`;

                            await sock.sendMessage(dest, {
                                text: textBody,
                                mentions: itemSenderJid ? [itemSenderJid] : [],
                                ...channelInfo
                            });
                        }
                        // Gentle throttle between messages to avoid stream pressure
                        await sleep(500);
                    } catch (destErr) {
                        console.error(`⚠️ Could not send to destination ${dest}:`, destErr.message);
                    }
                }
                successCount++;
            } catch (err) {
                console.error(`❌ Failed to forward status #${i + 1}:`, err.message);
            }
        }

        // React with ✅ on completion
        try {
            await sock.sendMessage(chatId, { react: { text: successCount > 0 ? '✅' : '❌', key: message.key } });
        } catch (e) {}

        // Send confirmation in the current chat
        const destSummary = selfNumber ? `yourself (+${selfNumber})` : `your private number`;

        const confirmationText = successCount > 0
            ? `✅ *Successfully downloaded all ${successCount}/${totalCount} status(es) of @${targetPhone || 'user'}!*\n` +
              `📥 *All statuses have been forwarded privately to ${destSummary}.*`
            : `❌ *Could not download media for @${targetPhone}'s status(es).*`;

        try {
            await sock.sendMessage(chatId, {
                text: confirmationText,
                mentions: targetJid ? [targetJid] : [],
                ...channelInfo
            }, { quoted: message });
        } catch (e) {}

    } catch (error) {
        console.error('❌ Error in status command:', error.message);
        try {
            await sock.sendMessage(chatId, { react: { text: '❌', key: message.key } });
            await sock.sendMessage(chatId, {
                text: '❌ *Failed to download statuses due to an error.*',
                ...channelInfo
            }, { quoted: message });
        } catch (e) {}
    }
}

module.exports = {
    statusCommand
};
