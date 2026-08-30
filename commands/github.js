const moment = require('moment-timezone');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const settings = require('../settings');

async function githubCommand(sock, chatId, message) {
  const repoUrl = settings.githubRepo || 'https://github.com/kashafHijjaze/Whatsapp-bot-';
  try {
    const res = await fetch('https://api.github.com/repos/kashafHijjaze/Whatsapp-bot-', {
      headers: { 'User-Agent': 'HijjazI-AI-Bot' }
    });

    let json = {};
    if (res.ok) {
      json = await res.json();
    } else {
      // Graceful fallback if GitHub API rate-limited
      json = {
        name: 'Whatsapp-bot-',
        watchers_count: 0,
        size: 1536,
        updated_at: new Date().toISOString(),
        html_url: repoUrl,
        forks_count: 0,
        stargazers_count: 0
      };
    }

    let txt = `*乂  HijjazI AI  乂*\n\n`;
    txt += `✩  *Name* : ${json.name || 'Whatsapp-bot-'}\n`;
    txt += `✩  *Owner* : KashafHijjaze\n`;
    txt += `✩  *Watchers* : ${json.watchers_count !== undefined ? json.watchers_count : 0}\n`;
    txt += `✩  *Size* : ${json.size ? (json.size / 1024).toFixed(2) : '1.50'} MB\n`;
    txt += `✩  *Last Updated* : ${moment(json.updated_at || Date.now()).format('DD/MM/YY - HH:mm:ss')}\n`;
    txt += `✩  *URL* : ${json.html_url || repoUrl}\n`;
    txt += `✩  *Forks* : ${json.forks_count !== undefined ? json.forks_count : 0}\n`;
    txt += `✩  *Stars* : ${json.stargazers_count !== undefined ? json.stargazers_count : 0}\n\n`;
    txt += `💥 *HijjazI AI*`;

    // Use the local asset image if exists
    const imgPath = path.join(__dirname, '../assets/bot_image.jpg');
    if (fs.existsSync(imgPath)) {
      const imgBuffer = fs.readFileSync(imgPath);
      await sock.sendMessage(chatId, { image: imgBuffer, caption: txt }, { quoted: message });
    } else {
      await sock.sendMessage(chatId, { text: txt }, { quoted: message });
    }
  } catch (error) {
    const fallbackTxt = `*乂  HijjazI AI  乂*\n\n✩  *Name* : Whatsapp-bot-\n✩  *Owner* : KashafHijjaze\n✩  *URL* : ${repoUrl}\n\n💥 *HijjazI AI*`;
    await sock.sendMessage(chatId, { text: fallbackTxt }, { quoted: message });
  }
}

module.exports = githubCommand; 