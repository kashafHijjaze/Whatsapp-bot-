const fetch = require('node-fetch');

const fallbackShayaris = [
    "हज़ार ग़म हैं ज़माने में मगर राहत भी है,\nज़िंदगी सिर्फ़ इम्तिहान ही नहीं, इनायत भी है। ✨",
    "खुशबू बनकर तेरी सांसों में समा जाएंगे,\nसुकून बनकर तेरे दिल में उतर जाएंगे। 🌹",
    "वक्त मिले तो कभी सोचना अपने दिल से,\nकौन था जो तुझे अपनी जान से भी ज्यादा चाहता था। 💫",
    "तमन्नाओं की महफ़िल तो हर कोई सजाता है,\nपूरी उसी की होती है जो तकदीर बनाता है। 🪄",
    "तेरी यादों का समंदर बड़ा गहरा है,\nहर लहर पर सिर्फ़ तेरा ही पहरा है। 🌊"
];

async function shayariCommand(sock, chatId, message) {
    try {
        let shayariText = null;
        try {
            const response = await fetch('https://shizoapi.onrender.com/api/texts/shayari?apikey=shizo', { timeout: 6000 });
            if (response.ok) {
                const data = await response.json();
                if (data && data.result) {
                    shayariText = data.result;
                }
            }
        } catch (apiErr) {
            // fallback gracefully
        }

        if (!shayariText) {
            shayariText = fallbackShayaris[Math.floor(Math.random() * fallbackShayaris.length)];
        }

        await sock.sendMessage(chatId, { 
            text: `📜 *Shayari of the Moment:*\n\n${shayariText}`
        }, { quoted: message });
    } catch (error) {
        console.error('Error in shayari command:', error.message);
        const fallback = fallbackShayaris[Math.floor(Math.random() * fallbackShayaris.length)];
        await sock.sendMessage(chatId, { 
            text: `📜 *Shayari:*\n\n${fallback}`
        }, { quoted: message });
    }
}

module.exports = {
    shayariCommand
};
