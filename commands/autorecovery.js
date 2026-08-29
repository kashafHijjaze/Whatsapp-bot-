const isOwnerOrSudo = require('../lib/isOwner');
const { loadRecoveryConfig, saveRecoveryConfig, getOwnerSelfJid } = require('../lib/mediaRecovery');

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

/**
 * .autorecovery command handler
 */
async function autoRecoveryCommand(sock, chatId, message, args = []) {
    try {
        const senderId = message.key.participant || message.key.remoteJid;
        const isOwner = await isOwnerOrSudo(senderId, sock, chatId);

        if (!message.key.fromMe && !isOwner) {
            return await sock.sendMessage(chatId, {
                text: '❌ *Permission Denied:* Only the bot owner can configure auto media recovery!',
                ...channelInfo
            }, { quoted: message });
        }

        const config = loadRecoveryConfig();
        const selfJid = getOwnerSelfJid(sock);
        const selfNumber = selfJid ? selfJid.split('@')[0] : 'Owner DM';

        const subCmd = (args[0] || '').toLowerCase().trim();
        const opt = (args[1] || '').toLowerCase().trim();

        if (!subCmd) {
            const menuText = 
`╔══════════════════════════╗
║  📥 *AUTO MEDIA RECOVERY*   ║
╚══════════════════════════╝

*Status Overview:*
• ⚡ Master Switch: *${config.enabled ? '🟢 ON' : '🔴 OFF'}*
• 📸 Status Recovery: *${config.recoverStatus ? '🟢 ON' : '🔴 OFF'}*
• 🗑️ Deleted Status Recovery: *${config.recoverDeletedStatus ? '🟢 ON' : '🔴 OFF'}*
• 🖼️ Picture & Video Recovery: *${config.recoverMedia ? '🟢 ON' : '🔴 OFF'}*
• 👥 Group Chats: *${config.includeGroups ? '🟢 ON' : '🔴 OFF'}*
• 💬 Private Chats: *${config.includePrivate ? '🟢 ON' : '🔴 OFF'}*
• 📱 Forward Destination: *+${selfNumber}* (Self Number)

*Commands:*
• \`.autorecovery on\` - Turn ON all auto recovery
• \`.autorecovery off\` - Turn OFF all auto recovery
• \`.autorecovery status on/off\` - Toggle new status recovery
• \`.autorecovery deleted on/off\` - Toggle deleted status recovery
• \`.autorecovery media on/off\` - Toggle picture & video recovery
• \`.autorecovery groups on/off\` - Toggle group media recovery
• \`.autorecovery private on/off\` - Toggle private media recovery

_💡 When enabled, every new status, deleted status/story, or incoming picture/video is instantly forwarded privately to your WhatsApp number._`;

            return await sock.sendMessage(chatId, {
                text: menuText,
                ...channelInfo
            }, { quoted: message });
        }

        if (subCmd === 'on' || subCmd === 'enable') {
            config.enabled = true;
            config.recoverStatus = true;
            config.recoverDeletedStatus = true;
            config.recoverMedia = true;
            saveRecoveryConfig(config);
            return await sock.sendMessage(chatId, {
                text: `✅ *Auto Media Recovery is now enabled!*\nAll contact statuses, deleted statuses, and incoming pictures/videos will immediately forward to +${selfNumber}.`,
                ...channelInfo
            }, { quoted: message });
        }

        if (subCmd === 'off' || subCmd === 'disable') {
            config.enabled = false;
            saveRecoveryConfig(config);
            return await sock.sendMessage(chatId, {
                text: `❌ *Auto Media Recovery has been turned OFF.*`,
                ...channelInfo
            }, { quoted: message });
        }

        if (subCmd === 'deleted' || subCmd === 'deletedstatus' || subCmd === 'delstatus') {
            if (opt === 'on' || opt === 'enable') {
                config.recoverDeletedStatus = true;
                config.enabled = true;
                saveRecoveryConfig(config);
                return await sock.sendMessage(chatId, {
                    text: `✅ *Deleted Status Recovery enabled!*\nWhenever someone deletes their WhatsApp status or story, it will be immediately forwarded directly to your number.`,
                    ...channelInfo
                }, { quoted: message });
            } else if (opt === 'off' || opt === 'disable') {
                config.recoverDeletedStatus = false;
                saveRecoveryConfig(config);
                return await sock.sendMessage(chatId, {
                    text: `❌ *Deleted Status Recovery disabled.*`,
                    ...channelInfo
                }, { quoted: message });
            } else {
                return await sock.sendMessage(chatId, {
                    text: `❓ *Usage:* \`.autorecovery deleted on\` or \`.autorecovery deleted off\``,
                    ...channelInfo
                }, { quoted: message });
            }
        }

        if (subCmd === 'status') {
            if (opt === 'on' || opt === 'enable') {
                config.recoverStatus = true;
                config.enabled = true;
                saveRecoveryConfig(config);
                return await sock.sendMessage(chatId, {
                    text: `✅ *Auto Status Recovery enabled!*\nAll contact statuses will be forwarded directly to your number.`,
                    ...channelInfo
                }, { quoted: message });
            } else if (opt === 'off' || opt === 'disable') {
                config.recoverStatus = false;
                saveRecoveryConfig(config);
                return await sock.sendMessage(chatId, {
                    text: `❌ *Auto Status Recovery disabled.*`,
                    ...channelInfo
                }, { quoted: message });
            } else {
                return await sock.sendMessage(chatId, {
                    text: `❓ *Usage:* \`.autorecovery status on\` or \`.autorecovery status off\``,
                    ...channelInfo
                }, { quoted: message });
            }
        }

        if (subCmd === 'media' || subCmd === 'pictures' || subCmd === 'videos' || subCmd === 'photo') {
            if (opt === 'on' || opt === 'enable') {
                config.recoverMedia = true;
                config.enabled = true;
                saveRecoveryConfig(config);
                return await sock.sendMessage(chatId, {
                    text: `✅ *Picture & Video Auto Recovery enabled!*\nAll pictures and videos sent in chats will be forwarded directly to your number.`,
                    ...channelInfo
                }, { quoted: message });
            } else if (opt === 'off' || opt === 'disable') {
                config.recoverMedia = false;
                saveRecoveryConfig(config);
                return await sock.sendMessage(chatId, {
                    text: `❌ *Picture & Video Auto Recovery disabled.*`,
                    ...channelInfo
                }, { quoted: message });
            } else {
                return await sock.sendMessage(chatId, {
                    text: `❓ *Usage:* \`.autorecovery media on\` or \`.autorecovery media off\``,
                    ...channelInfo
                }, { quoted: message });
            }
        }

        if (subCmd === 'groups' || subCmd === 'group') {
            config.includeGroups = (opt === 'on' || opt === 'enable');
            saveRecoveryConfig(config);
            return await sock.sendMessage(chatId, {
                text: `✅ *Group Media Auto Recovery:* ${config.includeGroups ? 'ON' : 'OFF'}`,
                ...channelInfo
            }, { quoted: message });
        }

        if (subCmd === 'private' || subCmd === 'dm') {
            config.includePrivate = (opt === 'on' || opt === 'enable');
            saveRecoveryConfig(config);
            return await sock.sendMessage(chatId, {
                text: `✅ *Private Chat Media Auto Recovery:* ${config.includePrivate ? 'ON' : 'OFF'}`,
                ...channelInfo
            }, { quoted: message });
        }

        return await sock.sendMessage(chatId, {
            text: `❓ *Unknown option.* Use \`.autorecovery\` to view current settings and usage options.`,
            ...channelInfo
        }, { quoted: message });

    } catch (err) {
        console.error('Error in autoRecoveryCommand:', err);
        await sock.sendMessage(chatId, {
            text: `❌ *Error processing auto recovery command:* ${err.message}`,
            ...channelInfo
        }, { quoted: message });
    }
}

module.exports = autoRecoveryCommand;
