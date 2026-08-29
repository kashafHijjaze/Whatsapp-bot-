const { getGroupMetadataSafe } = require('../lib/groupMetadataCache');

async function shipCommand(sock, chatId, msg, groupMetadata) {
    try {
        // Get all participants from the group
        const metadata = await getGroupMetadataSafe(sock, chatId);
        if (!metadata || !Array.isArray(metadata.participants) || metadata.participants.length < 2) {
            await sock.sendMessage(chatId, { text: '❌ Not enough members in the group to ship!' });
            return;
        }
        const ps = metadata.participants.map(v => v.id);
        
        // Get two random participants
        let firstUser, secondUser;
        
        // Select first random user
        firstUser = ps[Math.floor(Math.random() * ps.length)];
        
        // Select second random user (different from first)
        do {
            secondUser = ps[Math.floor(Math.random() * ps.length)];
        } while (secondUser === firstUser);

        // Format the mentions
        const formatMention = id => '@' + id.split('@')[0];

        // Create and send the ship message
        await sock.sendMessage(chatId, {
            text: `${formatMention(firstUser)} ❤️ ${formatMention(secondUser)}\nCongratulations 💖🍻`,
            mentions: [firstUser, secondUser]
        });

    } catch (error) {
        console.error('Error in ship command:', error);
        await sock.sendMessage(chatId, { text: '❌ Failed to ship! Make sure this is a group.' });
    }
}

module.exports = shipCommand; 