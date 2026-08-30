const settings = require('../settings');
const fs = require('fs');
const path = require('path');
const botState = require('../lib/botState');

// Total available commands count
const TOTAL_COMMANDS_COUNT = 110;

function toBoldMath(str) {
    const boldDigits = { '0': '𝟎', '1': '𝟏', '2': '𝟐', '3': '𝟑', '4': '𝟒', '5': '𝟓', '6': '𝟔', '7': '𝟕', '8': '𝟖', '9': '𝟗', '.': '.' };
    return String(str).split('').map(c => boldDigits[c] || c).join('');
}

function getBotMode() {
    try {
        const filePath = path.join(process.cwd(), 'data/messageCount.json');
        if (fs.existsSync(filePath)) {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            return data.isPublic ? 'PUBLIC' : 'PRIVATE';
        }
    } catch { }
    return 'PUBLIC';
}

function getBotStatus() {
    return botState && botState.status === 'connected' ? 'ONLINE' : 'ONLINE';
}

function renderCategory(titleEmoji, titleName, commandsList) {
    const header = `╔━━━━━━━━ ✦ 🖤 ✦ ━━━━━━━━╗
┃     ${titleEmoji} ${titleName}     ┃
╚━━━━━━━━ ✦ 🖤 ✦ ━━━━━━━━╝`;
    const inner = commandsList.map((cmd, idx) => {
        const branch = idx === 0 ? '╭─❖' : (idx === commandsList.length - 1 ? '╰─❖' : '├─❖');
        return `┃  ${branch} ${cmd}`;
    }).join('\n');
    return `${header}
╭━━━━━━━━━━━━━━━━━━━━━━╮
${inner}
╰━━━━━━━━━━━━━━━━━━━━━━╯`;
}

async function helpCommand(sock, chatId, message) {
    const currentMode = getBotMode();
    const currentStatus = getBotStatus();
    const prefix = settings.prefix || '.';
    const modeText = currentMode === 'PUBLIC' ? '𝐏𝐔𝐁𝐋𝐈𝐂' : '𝐏𝐑𝐈𝐕𝐀𝐓𝐄';
    const statusText = currentStatus === 'ONLINE' ? '𝐎𝐍𝐋𝐈𝐍𝐄' : '𝐎𝐅𝐅𝐋𝐈𝐍𝐄';
    const versionText = `𝐕${toBoldMath(settings.version || '3.0.7')}`;

    const categories = [
        renderCategory('🌐', '𝐆𝐄𝐍𝐄𝐑𝐀𝐋 𝐂𝐎𝐌𝐌𝐀𝐍𝐃𝐒', [
            `${prefix}help / ${prefix}menu`,
            `${prefix}ping`,
            `${prefix}alive`,
            `${prefix}tts <text>`,
            `${prefix}owner`,
            `${prefix}joke`,
            `${prefix}quote`,
            `${prefix}fact`,
            `${prefix}weather <city>`,
            `${prefix}news`,
            `${prefix}attp <text>`,
            `${prefix}lyrics <song_title>`,
            `${prefix}8ball <question>`,
            `${prefix}groupinfo`,
            `${prefix}staff / ${prefix}admins`,
            `${prefix}vv`,
            `${prefix}f (forward to self)`,
            `${prefix}status @user`,
            `${prefix}trt <text> <lang>`,
            `${prefix}ss <link>`,
            `${prefix}jid`,
            `${prefix}url`
        ]),
        renderCategory('👮‍♂️', '𝐀𝐃𝐌𝐈𝐍 𝐂𝐎𝐌𝐌𝐀𝐍𝐃𝐒', [
            `${prefix}ban @user`,
            `${prefix}promote @user`,
            `${prefix}demote @user`,
            `${prefix}mute <minutes>`,
            `${prefix}unmute`,
            `${prefix}delete / ${prefix}del`,
            `${prefix}kick @user`,
            `${prefix}warnings @user`,
            `${prefix}warn @user`,
            `${prefix}antilink`,
            `${prefix}antibadword`,
            `${prefix}groupantidelete <both/group/dm/off>`,
            `${prefix}clear`,
            `${prefix}tag <message>`,
            `${prefix}tagall`,
            `${prefix}tagnotadmin`,
            `${prefix}hidetag <message>`,
            `${prefix}chatbot`,
            `${prefix}resetlink`,
            `${prefix}antitag <on/off>`,
            `${prefix}welcome <on/off>`,
            `${prefix}goodbye <on/off>`,
            `${prefix}setgdesc <description>`,
            `${prefix}setgname <new name>`,
            `${prefix}setgpp (reply to image)`
        ]),
        renderCategory('🔒', '𝐎𝐖𝐍𝐄𝐑 & 𝐑𝐄𝐂𝐎𝐕𝐄𝐑𝐘', [
            `${prefix}session / ${prefix}sessionid`,
            `${prefix}mode <public/private>`,
            `${prefix}clearsession`,
            `${prefix}antidelete <both/dm/chat/off>`,
            `${prefix}groupantidelete <both/group/dm/off>`,
            `${prefix}autorecovery`,
            `${prefix}autorecovery on / off`,
            `${prefix}autorecovery status on / off`,
            `${prefix}autorecovery deleted on / off`,
            `${prefix}autorecovery media on / off`,
            `${prefix}autorecovery groups on / off`,
            `${prefix}autorecovery private on / off`,
            `${prefix}cleartmp`,
            `${prefix}update`,
            `${prefix}settings`,
            `${prefix}setpp <reply to image>`,
            `${prefix}autoreact <on/off>`,
            `${prefix}autostatus <on/off>`,
            `${prefix}autostatus react <on/off>`,
            `${prefix}autotyping <on/off>`,
            `${prefix}autoread <on/off>`,
            `${prefix}anticall <on/off>`,
            `${prefix}pmblocker <on/off/status>`,
            `${prefix}pmblocker setmsg <text>`,
            `${prefix}setmention <reply to msg>`,
            `${prefix}mention <on/off>`
        ]),
        renderCategory('🎨', '𝐈𝐌𝐀𝐆𝐄 & 𝐒𝐓𝐈𝐂𝐊𝐄𝐑 𝐂𝐎𝐌𝐌𝐀𝐍𝐃𝐒', [
            `${prefix}blur <image>`,
            `${prefix}simage <reply to sticker>`,
            `${prefix}sticker <reply to image>`,
            `${prefix}removebg`,
            `${prefix}remini`,
            `${prefix}crop <reply to image>`,
            `${prefix}tgsticker <Link>`,
            `${prefix}meme`,
            `${prefix}take <packname>`,
            `${prefix}emojimix <emj1>+<emj2>`,
            `${prefix}igs <insta link>`,
            `${prefix}igsc <insta link>`
        ]),
        renderCategory('🖼️', '𝐏𝐈𝐄𝐒 𝐂𝐎𝐌𝐌𝐀𝐍𝐃𝐒', [
            `${prefix}pies <country>`,
            `${prefix}china`,
            `${prefix}indonesia`,
            `${prefix}japan`,
            `${prefix}korea`,
            `${prefix}hijab`
        ]),
        renderCategory('🎮', '𝐆𝐀𝐌𝐄 𝐂𝐎𝐌𝐌𝐀𝐍𝐃𝐒', [
            `${prefix}tictactoe @user`,
            `${prefix}hangman`,
            `${prefix}guess <letter>`,
            `${prefix}trivia`,
            `${prefix}answer <answer>`,
            `${prefix}truth`,
            `${prefix}dare`
        ]),
        renderCategory('🤖', '𝐀𝐈 𝐂𝐎𝐌𝐌𝐀𝐍𝐃𝐒', [
            `${prefix}gpt <question>`,
            `${prefix}gemini <question>`,
            `${prefix}imagine <prompt>`,
            `${prefix}flux <prompt>`,
            `${prefix}sora <prompt>`
        ]),
        renderCategory('🎯', '𝐅𝐔𝐍 𝐂𝐎𝐌𝐌𝐀𝐍𝐃𝐒', [
            `${prefix}compliment @user`,
            `${prefix}insult @user`,
            `${prefix}flirt`,
            `${prefix}shayari`,
            `${prefix}goodnight`,
            `${prefix}roseday`,
            `${prefix}character @user`,
            `${prefix}wasted @user`,
            `${prefix}ship @user`,
            `${prefix}simp @user`,
            `${prefix}stupid @user [text]`
        ]),
        renderCategory('🔤', '𝐓𝐄𝐗𝐓𝐌𝐀𝐊𝐄𝐑 𝐂𝐎𝐌𝐌𝐀𝐍𝐃𝐒', [
            `${prefix}metallic <text>`,
            `${prefix}ice <text>`,
            `${prefix}snow <text>`,
            `${prefix}impressive <text>`,
            `${prefix}matrix <text>`,
            `${prefix}light <text>`,
            `${prefix}neon <text>`,
            `${prefix}devil <text>`,
            `${prefix}purple <text>`,
            `${prefix}thunder <text>`,
            `${prefix}leaves <text>`,
            `${prefix}1917 <text>`,
            `${prefix}arena <text>`,
            `${prefix}hacker <text>`,
            `${prefix}sand <text>`,
            `${prefix}blackpink <text>`,
            `${prefix}glitch <text>`,
            `${prefix}fire <text>`
        ]),
        renderCategory('📥', '𝐃𝐎𝐖𝐍𝐋𝐎𝐀𝐃𝐄𝐑 𝐂𝐎𝐌𝐌𝐀𝐍𝐃𝐒', [
            `${prefix}play <song_name>`,
            `${prefix}song <song_name>`,
            `${prefix}spotify <query>`,
            `${prefix}instagram <link>`,
            `${prefix}facebook <link>`,
            `${prefix}tiktok <link>`,
            `${prefix}video <song name>`,
            `${prefix}ytmp4 <Link>`
        ]),
        renderCategory('🧩', '𝐌𝐈𝐒𝐂 𝐂𝐎𝐌𝐌𝐀𝐍𝐃𝐒', [
            `${prefix}heart`,
            `${prefix}horny`,
            `${prefix}circle`,
            `${prefix}lgbt`,
            `${prefix}lolice`,
            `${prefix}its-so-stupid`,
            `${prefix}namecard`,
            `${prefix}oogway`,
            `${prefix}tweet`,
            `${prefix}ytcomment`,
            `${prefix}comrade`,
            `${prefix}gay`,
            `${prefix}glass`,
            `${prefix}jail`,
            `${prefix}passed`,
            `${prefix}triggered`
        ]),
        renderCategory('🌸', '𝐀𝐍𝐈𝐌𝐄 𝐂𝐎𝐌𝐌𝐀𝐍𝐃𝐒', [
            `${prefix}nom`,
            `${prefix}poke`,
            `${prefix}cry`,
            `${prefix}kiss`,
            `${prefix}pat`,
            `${prefix}hug`,
            `${prefix}wink`,
            `${prefix}facepalm`
        ]),
        renderCategory('💻', '𝐆𝐈𝐓𝐇𝐔𝐁 𝐂𝐎𝐌𝐌𝐀𝐍𝐃𝐒', [
            `${prefix}git`,
            `${prefix}github`,
            `${prefix}sc`,
            `${prefix}script`,
            `${prefix}repo`
        ])
    ];

    const helpMessage = `╔════════ ✦ 🖤 ✦ ════════╗
║      👑 𝐇𝐈𝐉𝐉𝐀𝐙𝐈 𝐀𝐈 👑
║          ${versionText}
╚════════ ✦ 🖤 ✦ ════════╝
│ 👑 𝐂𝐫𝐞𝐚𝐭𝐨𝐫  ── ✦ 𝐊𝐚𝐬𝐡𝐟𝐮𝐫𝐫𝐚𝐡𝐦𝐚𝐧
│ 🌐 𝐌𝐨𝐝𝐞     ── ✦ ${modeText}
│ 🟢 𝐒𝐭𝐚𝐭𝐮𝐬   ── ✦ ${statusText}
│ 📌 𝐏𝐫𝐞𝐟𝐢𝐱   ── ✦ ${prefix}
│ 📊 𝐂𝐨𝐦𝐦𝐚𝐧𝐝𝐬 ── ✦ 𝟏𝟏𝟎+
╰━━━━━━━━━━━━━━━━━━━━━━━━╯

${categories.join('\n\n')}

╔════════ ✦ 🖤 ✦ ════════╗
║       👑 𝐇𝐈𝐉𝐉𝐀𝐙𝐈 𝐀𝐈 👑
║   ✦ 𝐒𝐌𝐀𝐑𝐓 • 𝐅𝐀𝐒𝐓 • 𝐏𝐎𝐖𝐄𝐑𝐅𝐔𝐋 ✦
╚════════ ✦ 🖤 ✦ ════════╝
📢 𝐉𝐎𝐈𝐍 𝐎𝐔𝐑 𝐂𝐇𝐀𝐍𝐍𝐄𝐋
✦ 𝐅𝐎𝐑 𝐋𝐀𝐓𝐄𝐒𝐓 𝐔𝐏𝐃𝐀𝐓𝐄𝐒 ✦
🖤 𝐊𝐀𝐒𝐇𝐅𝐔𝐑𝐑𝐀𝐇𝐌𝐀𝐍 🖤`;

    try {
        const imagePath = path.join(__dirname, '../assets/bot_image.jpg');

        if (fs.existsSync(imagePath)) {
            const imageBuffer = fs.readFileSync(imagePath);

            await sock.sendMessage(chatId, {
                image: imageBuffer,
                caption: helpMessage,
                contextInfo: {
                    forwardingScore: 1,
                    isForwarded: true,
                    forwardedNewsletterMessageInfo: {
                        newsletterJid: '120363426834632590@newsletter',
                        newsletterName: 'HijjazI AI',
                        serverMessageId: -1
                    }
                }
            }, { quoted: message });
        } else {
            await sock.sendMessage(chatId, {
                text: helpMessage,
                contextInfo: {
                    forwardingScore: 1,
                    isForwarded: true,
                    forwardedNewsletterMessageInfo: {
                        newsletterJid: '120363426834632590@newsletter',
                        newsletterName: 'HijjazI AI',
                        serverMessageId: -1
                    }
                }
            });
        }
    } catch (error) {
        console.error('Error in help command:', error);
        await sock.sendMessage(chatId, { text: helpMessage });
    }
}

module.exports = helpCommand;