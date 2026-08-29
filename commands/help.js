const settings = require('../settings');
const fs = require('fs');
const path = require('path');
const botState = require('../lib/botState');

// Count total available commands statically or dynamically
const TOTAL_COMMANDS_COUNT = 110;

function getBotMode() {
    try {
        const filePath = path.join(process.cwd(), 'data/messageCount.json');
        if (fs.existsSync(filePath)) {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            return data.isPublic ? 'PUBLIC' : 'PRIVATE';
        }
    } catch {}
    return 'PUBLIC';
}

function getBotStatus() {
    return botState && botState.status === 'connected' ? 'ONLINE' : 'ONLINE';
}

async function helpCommand(sock, chatId, message) {
    const currentMode = getBotMode();
    const currentStatus = getBotStatus();
    const prefix = settings.prefix || '.';

    const helpMessage = `
╔═══════════════════╗
   *🤖 ${settings.botName || 'HijjazI AI'}*  
   Version: *${settings.version || '3.0.7'}*
   by ${settings.botOwner || 'Kashfurrahman'}
   YT : ${global.ytch || 'https://youtube.com'}
╚═══════════════════╝

┏━━━━━━━━━━━━━━━━━━━━━┓
┃ 🌍 Mode     : ${currentMode}
┃ 🟢 Status   : ${currentStatus}
┃ 📌 Prefix   : ${prefix}
┃ 📊 Commands : ${TOTAL_COMMANDS_COUNT}
┗━━━━━━━━━━━━━━━━━━━━━┛

*Available Commands:*

╔════════════════════════════╗
┃ 🌐 𝗚𝗘𝗡𝗘𝗥𝗔𝗟 𝗖𝗢𝗠𝗠𝗔𝗡𝗗𝗦
╠════════════════════════════╣
║ ➤ .help or .menu
║ ➤ .ping
║ ➤ .alive
║ ➤ .tts <text>
║ ➤ .owner
║ ➤ .joke
║ ➤ .quote
║ ➤ .fact
║ ➤ .weather <city>
║ ➤ .news
║ ➤ .attp <text>
║ ➤ .lyrics <song_title>
║ ➤ .8ball <question>
║ ➤ .groupinfo
║ ➤ .staff or .admins 
║ ➤ .vv
║ ➤ .f (reply to media/voice/message to forward to self)
║ ➤ .status @user
║ ➤ .trt <text> <lang>
║ ➤ .ss <link>
║ ➤ .jid
║ ➤ .url
╚════════════════════════════╝ 

╔════════════════════════════╗
┃ 👮‍♂️ 𝗔𝗗𝗠𝗜𝗡 𝗖𝗢𝗠𝗠𝗔𝗡𝗗𝗦
╠════════════════════════════╣
║ ➤ .ban @user
║ ➤ .promote @user
║ ➤ .demote @user
║ ➤ .mute <minutes>
║ ➤ .unmute
║ ➤ .delete or .del
║ ➤ .kick @user
║ ➤ .warnings @user
║ ➤ .warn @user
║ ➤ .antilink
║ ➤ .antibadword
║ ➤ .groupantidelete <both/group/dm/off>
║ ➤ .clear
║ ➤ .tag <message>
║ ➤ .tagall
║ ➤ .tagnotadmin
║ ➤ .hidetag <message>
║ ➤ .chatbot
║ ➤ .resetlink
║ ➤ .antitag <on/off>
║ ➤ .welcome <on/off>
║ ➤ .goodbye <on/off>
║ ➤ .setgdesc <description>
║ ➤ .setgname <new name>
║ ➤ .setgpp (reply to image)
╚════════════════════════════╝

╔════════════════════════════╗
┃ 🔒 𝗢𝗪𝗡𝗘𝗥 & 𝗥𝗘𝗖𝗢𝗩𝗘𝗥𝗬 𝗖𝗢𝗠𝗠𝗔𝗡𝗗𝗦
╠════════════════════════════╣
║ ➤ .session or .sessionid
║ ➤ .mode <public/private>
║ ➤ .clearsession
║ ➤ .antidelete <both/dm/chat/off>
║ ➤ .groupantidelete <both/group/dm/off>
║ ➤ .autorecovery (View config & stats)
║ ➤ .autorecovery on / off (Master switch)
║ ➤ .autorecovery status on / off (Status updates toggle)
║ ➤ .autorecovery deleted on / off (Deleted status toggle)
║ ➤ .autorecovery media on / off (Pictures & videos toggle)
║ ➤ .autorecovery groups on / off (Group media toggle)
║ ➤ .autorecovery private on / off (Private DM media toggle)
║ ➤ .cleartmp
║ ➤ .update
║ ➤ .settings
║ ➤ .setpp <reply to image>
║ ➤ .autoreact <on/off>
║ ➤ .autostatus <on/off>
║ ➤ .autostatus react <on/off>
║ ➤ .autotyping <on/off>
║ ➤ .autoread <on/off>
║ ➤ .anticall <on/off>
║ ➤ .pmblocker <on/off/status>
║ ➤ .pmblocker setmsg <text>
║ ➤ .setmention <reply to msg>
║ ➤ .mention <on/off>
╚════════════════════════════╝

╔════════════════════════════╗
┃ 🎨 𝗜𝗠𝗔𝗚𝗘 & 𝗦𝗧𝗜𝗖𝗞𝗘𝗥 𝗖𝗢𝗠𝗠𝗔𝗡𝗗𝗦
╠════════════════════════════╣
║ ➤ .blur <image>
║ ➤ .simage <reply to sticker>
║ ➤ .sticker <reply to image>
║ ➤ .removebg
║ ➤ .remini
║ ➤ .crop <reply to image>
║ ➤ .tgsticker <Link>
║ ➤ .meme
║ ➤ .take <packname> 
║ ➤ .emojimix <emj1>+<emj2>
║ ➤ .igs <insta link>
║ ➤ .igsc <insta link>
╚════════════════════════════╝  

╔════════════════════════════╗
┃ 🖼️ 𝗣𝗜𝗘𝗦 𝗖𝗢𝗠𝗠𝗔𝗡𝗗𝗦
╠════════════════════════════╣
║ ➤ .pies <country>
║ ➤ .china 
║ ➤ .indonesia 
║ ➤ .japan 
║ ➤ .korea 
║ ➤ .hijab
╚════════════════════════════╝

╔════════════════════════════╗
┃ 🎮 𝗚𝗔𝗠𝗘 𝗖𝗢𝗠𝗠𝗔𝗡𝗗𝗦
╠════════════════════════════╣
║ ➤ .tictactoe @user
║ ➤ .hangman
║ ➤ .guess <letter>
║ ➤ .trivia
║ ➤ .answer <answer>
║ ➤ .truth
║ ➤ .dare
╚════════════════════════════╝

╔════════════════════════════╗
┃ 🤖 𝗔𝗜 𝗖𝗢𝗠𝗠𝗔𝗡𝗗𝗦
╠════════════════════════════╣
║ ➤ .gpt <question>
║ ➤ .gemini <question>
║ ➤ .imagine <prompt>
║ ➤ .flux <prompt>
║ ➤ .sora <prompt>
╚════════════════════════════╝

╔════════════════════════════╗
┃ 🎯 𝗙𝗨𝗡 𝗖𝗢𝗠𝗠𝗔𝗡𝗗𝗦
╠════════════════════════════╣
║ ➤ .compliment @user
║ ➤ .insult @user
║ ➤ .flirt 
║ ➤ .shayari
║ ➤ .goodnight
║ ➤ .roseday
║ ➤ .character @user
║ ➤ .wasted @user
║ ➤ .ship @user
║ ➤ .simp @user
║ ➤ .stupid @user [text]
╚════════════════════════════╝

╔════════════════════════════╗
┃ 🔤 𝗧𝗘𝗫𝗧𝗠𝗔𝗞𝗘𝗥 𝗖𝗢𝗠𝗠𝗔𝗡𝗗𝗦
╠════════════════════════════╣
║ ➤ .metallic <text>
║ ➤ .ice <text>
║ ➤ .snow <text>
║ ➤ .impressive <text>
║ ➤ .matrix <text>
║ ➤ .light <text>
║ ➤ .neon <text>
║ ➤ .devil <text>
║ ➤ .purple <text>
║ ➤ .thunder <text>
║ ➤ .leaves <text>
║ ➤ .1917 <text>
║ ➤ .arena <text>
║ ➤ .hacker <text>
║ ➤ .sand <text>
║ ➤ .blackpink <text>
║ ➤ .glitch <text>
║ ➤ .fire <text>
╚════════════════════════════╝

╔════════════════════════════╗
┃ 📥 𝗗𝗢𝗪𝗡𝗟𝗢𝗔𝗗𝗘𝗥 𝗖𝗢𝗠𝗠𝗔𝗡𝗗𝗦
╠════════════════════════════╣
║ ➤ .play <song_name>
║ ➤ .song <song_name>
║ ➤ .spotify <query>
║ ➤ .instagram <link>
║ ➤ .facebook <link>
║ ➤ .tiktok <link>
║ ➤ .video <song name>
║ ➤ .ytmp4 <Link>
╚════════════════════════════╝

╔════════════════════════════╗
┃ 🧩 𝗠𝗜𝗦𝗖 𝗖𝗢𝗠𝗠𝗔𝗡𝗗𝗦
╠════════════════════════════╣
║ ➤ .heart
║ ➤ .horny
║ ➤ .circle
║ ➤ .lgbt
║ ➤ .lolice
║ ➤ .its-so-stupid
║ ➤ .namecard 
║ ➤ .oogway
║ ➤ .tweet
║ ➤ .ytcomment 
║ ➤ .comrade 
║ ➤ .gay 
║ ➤ .glass 
║ ➤ .jail 
║ ➤ .passed 
║ ➤ .triggered
╚════════════════════════════╝

╔════════════════════════════╗
┃ 🌸 𝗔𝗡𝗜𝗠𝗘 𝗖𝗢𝗠𝗠𝗔𝗡𝗗𝗦
╠════════════════════════════╣
║ ➤ .nom 
║ ➤ .poke 
║ ➤ .cry 
║ ➤ .kiss 
║ ➤ .pat 
║ ➤ .hug 
║ ➤ .wink 
║ ➤ .facepalm 
╚════════════════════════════╝

╔════════════════════════════╗
┃ 💻 𝗚𝗜𝗧𝗛𝗨𝗕 𝗖𝗢𝗠𝗠𝗔𝗡𝗗𝗦
╠════════════════════════════╣
║ ➤ .git
║ ➤ .github
║ ➤ .sc
║ ➤ .script
║ ➤ .repo
╚════════════════════════════╝

Join our channel for updates:`;

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
            },{ quoted: message });
        } else {
            console.error('Bot image not found at:', imagePath);
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