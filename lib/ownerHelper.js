const settings = require('../settings');

/**
 * Resolves the authenticated / active WhatsApp owner JID (the number by which the bot is active)
 */
function getOwnerSelfJid(sock) {
    if (sock?.user?.id) {
        const clean = sock.user.id.split(':')[0].split('@')[0].replace(/[^0-9]/g, '');
        if (clean) return `${clean}@s.whatsapp.net`;
    }
    if (sock?.authState?.creds?.me?.id) {
        const clean = sock.authState.creds.me.id.split(':')[0].split('@')[0].replace(/[^0-9]/g, '');
        if (clean) return `${clean}@s.whatsapp.net`;
    }
    try {
        if (settings?.ownerNumber) {
            const clean = String(settings.ownerNumber).split(':')[0].split('@')[0].replace(/[^0-9]/g, '');
            if (clean) return `${clean}@s.whatsapp.net`;
        }
    } catch {}
    return null;
}

/**
 * Resolves the clean numeric phone number of the active bot account
 */
function getOwnerNumberClean(sock) {
    if (sock?.user?.id) {
        const clean = sock.user.id.split(':')[0].split('@')[0].replace(/[^0-9]/g, '');
        if (clean) return clean;
    }
    if (sock?.authState?.creds?.me?.id) {
        const clean = sock.authState.creds.me.id.split(':')[0].split('@')[0].replace(/[^0-9]/g, '');
        if (clean) return clean;
    }
    try {
        if (settings?.ownerNumber) {
            const clean = String(settings.ownerNumber).split(':')[0].split('@')[0].replace(/[^0-9]/g, '');
            if (clean) return clean;
        }
    } catch {}
    return '';
}

module.exports = {
    getOwnerSelfJid,
    getOwnerNumberClean
};
