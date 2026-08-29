const settings = require('../settings');
const { isSudo } = require('./index');
const { getGroupMetadataSafe } = require('./groupMetadataCache');
const { getOwnerSelfJid, getOwnerNumberClean } = require('./ownerHelper');

async function isOwnerOrSudo(senderId, sock = null, chatId = null) {
    if (!senderId) return false;
    
    const selfJid = getOwnerSelfJid(sock);
    const selfNumberClean = getOwnerNumberClean(sock);
    const configOwnerNumberClean = (settings?.ownerNumber ? String(settings.ownerNumber) : '').split(':')[0].split('@')[0].replace(/[^0-9]/g, '');
    
    // Direct JID match with active bot account or settings owner
    if (selfJid && senderId === selfJid) {
        return true;
    }
    if (configOwnerNumberClean && senderId === `${configOwnerNumberClean}@s.whatsapp.net`) {
        return true;
    }
    
    // Extract sender's numeric parts
    const senderIdClean = senderId.split(':')[0].split('@')[0].replace(/[^0-9]/g, '');
    const senderLidNumeric = senderId.includes('@lid') ? senderId.split('@')[0].split(':')[0].replace(/[^0-9]/g, '') : '';
    
    // Check if sender's phone number matches active bot number or configured owner number
    if (senderIdClean && selfNumberClean && senderIdClean === selfNumberClean) {
        return true;
    }
    if (senderIdClean && configOwnerNumberClean && senderIdClean === configOwnerNumberClean) {
        return true;
    }

    // Check bot's own JID / LID from session credentials
    if (sock) {
        const botId = sock.user?.id || sock.authState?.creds?.me?.id || '';
        const botIdClean = botId.split(':')[0].split('@')[0].replace(/[^0-9]/g, '');
        if (botIdClean && senderIdClean && botIdClean === senderIdClean) {
            return true;
        }

        const botLid = sock.user?.lid || sock.authState?.creds?.me?.lid || '';
        const botLidNumeric = botLid.split(':')[0].split('@')[0].replace(/[^0-9]/g, '');
        if (botLidNumeric && senderLidNumeric && botLidNumeric === senderLidNumeric) {
            return true;
        }
    }
    
    // In groups, check participant metadata for additional matching
    if (sock && chatId && chatId.endsWith('@g.us') && senderId.includes('@lid')) {
        try {
            const botLid = sock.user?.lid || sock.authState?.creds?.me?.lid || '';
            const botLidNumeric = botLid.split(':')[0].split('@')[0].replace(/[^0-9]/g, '');
            
            const metadata = await getGroupMetadataSafe(sock, chatId);
            const participants = metadata?.participants || [];
            
            const participant = participants.find(p => {
                const pLid = p.lid || '';
                const pLidNumeric = pLid.split(':')[0].split('@')[0].replace(/[^0-9]/g, '');
                const pId = p.id || '';
                const pIdClean = pId.split(':')[0].split('@')[0].replace(/[^0-9]/g, '');
                
                return (
                    p.lid === senderId || 
                    p.id === senderId ||
                    (pLidNumeric && senderLidNumeric && pLidNumeric === senderLidNumeric) ||
                    (pIdClean && senderIdClean && pIdClean === senderIdClean) ||
                    (pIdClean && selfNumberClean && pIdClean === selfNumberClean) ||
                    (pIdClean && configOwnerNumberClean && pIdClean === configOwnerNumberClean)
                );
            });
            
            if (participant) {
                const participantId = participant.id || '';
                const participantLid = participant.lid || '';
                const participantIdClean = participantId.split(':')[0].split('@')[0].replace(/[^0-9]/g, '');
                const participantLidNumeric = participantLid.split(':')[0].split('@')[0].replace(/[^0-9]/g, '');
                
                if (participantId === selfJid || 
                    (participantIdClean && selfNumberClean && participantIdClean === selfNumberClean) ||
                    (participantIdClean && configOwnerNumberClean && participantIdClean === configOwnerNumberClean) ||
                    (participantLidNumeric && botLidNumeric && participantLidNumeric === botLidNumeric)) {
                    return true;
                }
            }
        } catch (e) {
            // Silently handle error
        }
    }
    
    // Check if sender ID contains active owner number (fallback)
    if (selfNumberClean && senderId.includes(selfNumberClean)) {
        return true;
    }
    if (configOwnerNumberClean && senderId.includes(configOwnerNumberClean)) {
        return true;
    }
    
    // Check sudo status
    try {
        return await isSudo(senderId);
    } catch (e) {
        console.error('❌ [isOwner] Error checking sudo:', e);
        return false;
    }
}

module.exports = isOwnerOrSudo;