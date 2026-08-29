const isAdminHelper = require('../lib/isAdmin');
const { getGroupMetadataSafe } = require('../lib/groupMetadataCache');

async function resetlinkCommand(sock, chatId, senderId) {
    try {
        const { isSenderAdmin, isBotAdmin } = await isAdminHelper(sock, chatId, senderId);

        if (!isSenderAdmin) {
            await sock.sendMessage(chatId, { text: '❌ Only admins can use this command!' });
            return;
        }

        if (!isBotAdmin) {
            await sock.sendMessage(chatId, { text: '❌ Bot must be admin to reset group link!' });
            return;
        }

        // Reset the group link
        const newCode = await sock.groupRevokeInvite(chatId);
        
        // Send the new link
        await sock.sendMessage(chatId, { 
            text: `✅ Group link has been successfully reset\n\n📌 New link:\nhttps://chat.whatsapp.com/${newCode}`
        });

    } catch (error) {
        console.error('Error in resetlink command:', error);
        await sock.sendMessage(chatId, { text: 'Failed to reset group link!' });
    }
}

module.exports = resetlinkCommand; 