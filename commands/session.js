const fs = require('fs');
const path = require('path');
const isOwnerOrSudo = require('../lib/isOwner');
const sessionVault = require('../lib/sessionVault');
const { generateWAMessageFromContent, proto, delay } = require('@whiskeysockets/baileys');

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

async function sessionCommand(sock, chatId, message) {
    try {
        const senderId = message.key.participant || message.key.remoteJid;
        const isOwner = await isOwnerOrSudo(senderId, sock, chatId);

        if (!message.key.fromMe && !isOwner) {
            await sock.sendMessage(chatId, {
                text: '❌ This command can only be used by the bot owner.',
                ...channelInfo
            }, { quoted: message });
            return;
        }

        const credsPath = path.join(__dirname, '../session', 'creds.json');
        let targetFile = credsPath;

        if (!fs.existsSync(targetFile) || fs.statSync(targetFile).size <= 50) {
            if (fs.existsSync(sessionVault.VAULT_CREDS) && fs.statSync(sessionVault.VAULT_CREDS).size > 50) {
                targetFile = sessionVault.VAULT_CREDS;
            } else if (fs.existsSync(sessionVault.DATA_CREDS) && fs.statSync(sessionVault.DATA_CREDS).size > 50) {
                targetFile = sessionVault.DATA_CREDS;
            }
        }

        if (!fs.existsSync(targetFile)) {
            await sock.sendMessage(chatId, {
                text: '❌ No active creds.json session file found.',
                ...channelInfo
            }, { quoted: message });
            return;
        }

        const raw = fs.readFileSync(targetFile, 'utf8');
        const base64 = Buffer.from(raw).toString('base64');
        const sessionId = 'HijjaziAI;;;' + base64;

        // 1. Overview Message
        const sessionMsg =
`╔══════════════════════════╗
║   🤖 *HIJJAZI AI SESSION*      ║
╚══════════════════════════╝

✨ *Session Backup Request:*
• Your *SESSION_ID* is sent separately below with a one-tap copy button.
• Your *creds.json* file is attached below.
• Keep these safe to restore your bot anytime on any host!`;

        await sock.sendMessage(chatId, {
            text: sessionMsg,
            ...channelInfo
        }, { quoted: message });

        // 2. Separate Session ID Message with Copy Button
        await delay(1000);
        let sentInteractive = false;
        try {
            const interactiveMsg = generateWAMessageFromContent(chatId, {
                viewOnceMessage: {
                    message: {
                        messageContextInfo: {
                            deviceListMetadata: {},
                            deviceListMetadataVersion: 2
                        },
                        interactiveMessage: proto.Message.InteractiveMessage.create({
                            header: proto.Message.InteractiveMessage.Header.create({
                                title: "🔑 *HIJJAZI AI SESSION ID*",
                                hasMediaAttachment: false
                            }),
                            body: proto.Message.InteractiveMessage.Body.create({
                                text: `\`\`\`${sessionId}\`\`\``
                            }),
                            footer: proto.Message.InteractiveMessage.Footer.create({
                                text: "Tap the button below to copy your Session ID"
                            }),
                            nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
                                buttons: [
                                    {
                                        name: "cta_copy",
                                        buttonParamsJson: JSON.stringify({
                                            display_text: "📋 Copy Session ID",
                                            id: "copy_session_id",
                                            copy_code: sessionId
                                        })
                                    }
                                ]
                            }),
                            contextInfo: {
                                forwardingScore: 999,
                                isForwarded: true,
                                forwardedNewsletterMessageInfo: {
                                    newsletterJid: '120363426834632590@newsletter',
                                    newsletterName: 'HijjazI AI',
                                    serverMessageId: -1
                                }
                            }
                        })
                    }
                }
            }, { userJid: chatId });

            await sock.relayMessage(chatId, interactiveMsg.message, { messageId: interactiveMsg.key.id });
            sentInteractive = true;
        } catch (e) {
            console.warn('Interactive button failed in sessionCommand:', e.message);
        }

        if (!sentInteractive) {
            await sock.sendMessage(chatId, {
                text: `🔑 *YOUR SESSION ID (Tap to Copy):*\n\n\`\`\`${sessionId}\`\`\``,
                ...channelInfo
            });
        }

        // 3. Send creds.json document
        await delay(1000);
        await sock.sendMessage(chatId, {
            document: Buffer.from(raw, 'utf8'),
            mimetype: 'application/json',
            fileName: 'creds.json',
            caption: '📁 *creds.json Session Backup*'
        }, { quoted: message });

    } catch (err) {
        console.error('Error in sessionCommand:', err);
        await sock.sendMessage(chatId, {
            text: '❌ Failed to export session: ' + err.message,
            ...channelInfo
        }, { quoted: message });
    }
}

module.exports = sessionCommand;
