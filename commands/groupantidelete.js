const fs = require('fs');
const path = require('path');
const isOwnerOrSudo = require('../lib/isOwner');
const isAdmin = require('../lib/isAdmin');
const {
    loadGroupAntideleteConfig,
    saveGroupAntideleteConfig,
    getGroupAntideleteSetting,
    setGroupAntideleteSetting,
    getOwnerSelfJid
} = require('./antidelete');

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
 * Universal .groupantidelete command handler
 * Applies globally/universally to ALL groups
 * Syntax:
 * .groupantidelete [both|group|dm|off|on|status|admin on/off]
 */
async function groupAntideleteCommand(sock, chatId, message, args = []) {
    try {
        const isGroup = chatId.endsWith('@g.us');
        const senderId = message.key.participant || message.key.remoteJid;
        const senderIsOwner = message.key.fromMe || await isOwnerOrSudo(senderId, sock, chatId);
        const ownerSelfJid = getOwnerSelfJid(sock);
        const ownerSelfNumber = ownerSelfJid ? ownerSelfJid.split('@')[0] : 'Owner Number';

        const subCmd = (args[0] || '').toLowerCase().trim();
        const opt = (args[1] || '').toLowerCase().trim();

        // Permission check: Owner can use anywhere; in groups, group admins can also manage
        let isSenderAdmin = false;
        let isBotAdmin = false;
        if (isGroup) {
            try {
                const adminCheck = await isAdmin(sock, chatId, senderId);
                isSenderAdmin = adminCheck.isSenderAdmin;
                isBotAdmin = adminCheck.isBotAdmin;
            } catch (e) {}
        }

        if (!senderIsOwner && (!isGroup || !isSenderAdmin)) {
            return await sock.sendMessage(chatId, {
                text: '❌ *Permission Denied:* Only the bot owner or group admins can configure Universal Group Antidelete!',
                ...channelInfo
            }, { quoted: message });
        }

        const groupConfig = loadGroupAntideleteConfig();
        const currentSetting = getGroupAntideleteSetting(chatId);

        // Status overview
        if (!subCmd || subCmd === 'status' || subCmd === 'list') {
            const isEnabled = currentSetting.enabled;
            const dest = currentSetting.destination || 'dm';
            
            let modeText = '🔴 OFF (Disabled for all groups)';
            if (isEnabled) {
                if (dest === 'dm' || dest === 'owner' || dest === 'self') {
                    modeText = '🟢 DM ONLY (Default: Forwarded privately to Owner Number only)';
                } else if (dest === 'both') {
                    modeText = '🟢 BOTH (Respective Group + Owner Yourself Number)';
                } else if (dest === 'group' || dest === 'chat') {
                    modeText = '🟢 GROUP ONLY (Restored in respective group only)';
                } else {
                    modeText = `🟢 ENABLED (${dest.toUpperCase()})`;
                }
            }

            const statusText = 
`╔══════════════════════════╗
║ 👥 *UNIVERSAL GROUP ANTIDELETE* ║
╚══════════════════════════╝

📌 *Universal Status:* ${modeText}
🛡️ *Require Bot Admin:* ${groupConfig.requireAdmin ? '🟢 YES' : '🔴 NO'}
📱 *Owner Destination:* +${ownerSelfNumber} (Yourself Number)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 *Universal Commands (Applies to ALL Groups):*
• *.groupantidelete on* / *.groupantidelete dm* ➔ Enable for *ALL GROUPS* (Default: Private to Owner Number)
• *.groupantidelete both* ➔ Forward to BOTH respective *GROUP & YOUR NUMBER*
• *.groupantidelete group* ➔ Forward to respective *GROUP ONLY*
• *.groupantidelete off* ➔ Disable for *ALL GROUPS*
• *.groupantidelete admin on/off* ➔ Require bot to be admin in group to trigger

_⚡ Universal control: Deleted group messages default to your private DM._`;

            return await sock.sendMessage(chatId, {
                text: statusText,
                ...channelInfo
            }, { quoted: message });
        }

        // Toggle: ON / ENABLE
        if (subCmd === 'on' || subCmd === 'enable') {
            setGroupAntideleteSetting(chatId, {
                enabled: true,
                destination: 'dm',
                defaultMode: 'dm',
                updatedBy: senderId,
                updatedAt: new Date().toISOString()
            });

            return await sock.sendMessage(chatId, {
                text: 
`✅ *Universal Group Antidelete ENABLED (DEFAULT: PRIVATE DM)*

Deleted messages across *ALL groups* will be forwarded privately to *yourself number* (+${ownerSelfNumber}) and NOT sent into groups.

_⚡ Applied universally across all groups._`,
                ...channelInfo
            }, { quoted: message });
        }

        // Toggle: BOTH / ALL
        if (subCmd === 'both' || subCmd === 'all') {
            setGroupAntideleteSetting(chatId, {
                enabled: true,
                destination: 'both',
                defaultMode: 'both',
                updatedBy: senderId,
                updatedAt: new Date().toISOString()
            });

            return await sock.sendMessage(chatId, {
                text: 
`✅ *Universal Group Antidelete ENABLED for ALL Groups (BOTH)*

Whenever anyone deletes a message in *ANY group*, HijjazI AI will:
1️⃣ 👥 Auto-forward and restore the deleted message in that group
2️⃣ 📱 Auto-forward a private copy to *yourself number* (+${ownerSelfNumber})

_⚡ Applied universally across all groups._`,
                ...channelInfo
            }, { quoted: message });
        }

        // Toggle: GROUP ONLY
        if (subCmd === 'group' || subCmd === 'chat' || subCmd === 'same') {
            setGroupAntideleteSetting(chatId, {
                enabled: true,
                destination: 'group',
                defaultMode: 'group',
                updatedBy: senderId,
                updatedAt: new Date().toISOString()
            });

            return await sock.sendMessage(chatId, {
                text: 
`✅ *Universal Group Antidelete Set to GROUP ONLY (ALL GROUPS)*

Deleted messages in all groups will be restored right inside their respective group only.

_⚡ Applied universally across all groups._`,
                ...channelInfo
            }, { quoted: message });
        }

        // Toggle: DM ONLY (Private to Owner)
        if (subCmd === 'dm' || subCmd === 'self' || subCmd === 'owner' || subCmd === 'pm' || subCmd === 'private') {
            setGroupAntideleteSetting(chatId, {
                enabled: true,
                destination: 'dm',
                defaultMode: 'dm',
                updatedBy: senderId,
                updatedAt: new Date().toISOString()
            });

            return await sock.sendMessage(chatId, {
                text: 
`✅ *Universal Group Antidelete Set to PRIVATE DM ONLY (ALL GROUPS)*

Deleted messages across all groups will be forwarded privately to yourself number (+${ownerSelfNumber}) and NOT sent into groups.

_⚡ Applied universally across all groups._`,
                ...channelInfo
            }, { quoted: message });
        }

        // Toggle: OFF / DISABLE / STOP
        if (subCmd === 'off' || subCmd === 'disable' || subCmd === 'stop') {
            setGroupAntideleteSetting(chatId, {
                enabled: false,
                destination: 'off',
                defaultMode: 'off',
                updatedBy: senderId,
                updatedAt: new Date().toISOString()
            });

            return await sock.sendMessage(chatId, {
                text: 
`❌ *Universal Group Antidelete has been DISABLED for ALL groups.*

Deleted messages in all groups will no longer be captured or forwarded.

_⚡ Applied universally across all groups._`,
                ...channelInfo
            }, { quoted: message });
        }

        // Toggle: ADMIN REQUIREMENT
        if (subCmd === 'admin') {
            if (!senderIsOwner) {
                return await sock.sendMessage(chatId, {
                    text: '❌ *Only the bot owner can change the global admin check setting.*',
                    ...channelInfo
                }, { quoted: message });
            }
            if (opt === 'on' || opt === 'enable' || opt === 'true') {
                groupConfig.requireAdmin = true;
                saveGroupAntideleteConfig(groupConfig);
                return await sock.sendMessage(chatId, {
                    text: '✅ *Universal Group Admin Requirement Enabled:* Group antidelete will only trigger when the bot/owner is an admin in that group.',
                    ...channelInfo
                }, { quoted: message });
            } else if (opt === 'off' || opt === 'disable' || opt === 'false') {
                groupConfig.requireAdmin = false;
                saveGroupAntideleteConfig(groupConfig);
                return await sock.sendMessage(chatId, {
                    text: '✅ *Universal Group Admin Requirement Disabled:* Group antidelete will trigger for all groups regardless of bot admin status.',
                    ...channelInfo
                }, { quoted: message });
            } else {
                return await sock.sendMessage(chatId, {
                    text: `❓ *Usage:* \`.groupantidelete admin on\` or \`.groupantidelete admin off\``,
                    ...channelInfo
                }, { quoted: message });
            }
        }

        return await sock.sendMessage(chatId, {
            text: `❓ *Unknown option.* Use:\n• \`.groupantidelete on\` / \`.groupantidelete both\`\n• \`.groupantidelete group\`\n• \`.groupantidelete dm\`\n• \`.groupantidelete off\`\n• \`.groupantidelete status\``,
            ...channelInfo
        }, { quoted: message });

    } catch (err) {
        console.error('Error in groupAntideleteCommand:', err);
        await sock.sendMessage(chatId, {
            text: `❌ *Error processing group antidelete command:* ${err.message}`,
            ...channelInfo
        }, { quoted: message });
    }
}

module.exports = groupAntideleteCommand;
