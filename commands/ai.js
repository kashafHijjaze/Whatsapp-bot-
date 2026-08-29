const axios = require('axios');
const fetch = require('node-fetch');
const { generateAIContent } = require('../lib/geminiHelper');

async function aiCommand(sock, chatId, message) {
    try {
        const text = message.message?.conversation || message.message?.extendedTextMessage?.text;
        
        if (!text) {
            return await sock.sendMessage(chatId, { 
                text: "Please provide a question after .gpt or .gemini\n\nExample: .gpt write a basic html code"
            }, {
                quoted: message
            });
        }

        // Get the command and query
        const parts = text.split(' ');
        const command = parts[0].toLowerCase();
        const query = parts.slice(1).join(' ').trim();

        if (!query) {
            return await sock.sendMessage(chatId, { 
                text: "Please provide a question after .gpt or .gemini"
            }, { quoted: message });
        }

        try {
            // Show processing reaction
            await sock.sendMessage(chatId, {
                react: { text: '🤖', key: message.key }
            });

            // 1. First try Google Gemini official SDK if available
            const directAi = await generateAIContent(query, "You are HijjazI AI, an intelligent, helpful WhatsApp AI assistant. Provide concise, clear answers.");
            if (directAi) {
                return await sock.sendMessage(chatId, {
                    text: directAi
                }, {
                    quoted: message
                });
            }

            // 2. Fallback to resilient public AI endpoints
            const candidateEndpoints = [
                async () => {
                    const res = await axios.get(`https://zellapi.autos/ai/chatbot?text=${encodeURIComponent(query)}`, { timeout: 10000 });
                    if (res.data && res.data.status && res.data.result) return res.data.result;
                    throw new Error('Invalid response');
                },
                async () => {
                    const res = await fetch(`https://api.siputzx.my.id/api/ai/gemini-pro?content=${encodeURIComponent(query)}`, { timeout: 10000 });
                    const d = await res.json();
                    if (d && (d.data || d.result || d.message)) return d.data || d.result || d.message;
                    throw new Error('Invalid response');
                },
                async () => {
                    const res = await fetch(`https://vapis.my.id/api/gemini?q=${encodeURIComponent(query)}`, { timeout: 10000 });
                    const d = await res.json();
                    if (d && (d.data || d.result || d.message)) return d.data || d.result || d.message;
                    throw new Error('Invalid response');
                },
                async () => {
                    const res = await fetch(`https://api.giftedtech.my.id/api/ai/geminiai?apikey=gifted&q=${encodeURIComponent(query)}`, { timeout: 10000 });
                    const d = await res.json();
                    if (d && (d.result || d.message)) return d.result || d.message;
                    throw new Error('Invalid response');
                }
            ];

            let answer = null;
            for (const fn of candidateEndpoints) {
                try {
                    answer = await fn();
                    if (answer && typeof answer === 'string' && answer.trim()) {
                        break;
                    }
                } catch (e) {
                    continue;
                }
            }

            if (answer) {
                return await sock.sendMessage(chatId, {
                    text: answer.trim()
                }, {
                    quoted: message
                });
            } else {
                return await sock.sendMessage(chatId, {
                    text: `🤖 HijjazI AI Response:\n\nI received your query: "${query}". AI services are experiencing temporary latency. Please try again shortly or configure GEMINI_API_KEY in settings for instant official AI responses.`
                }, {
                    quoted: message
                });
            }
        } catch (error) {
            console.error('API Error in aiCommand:', error.message);
            await sock.sendMessage(chatId, {
                text: "❌ Service is temporarily busy. Please try again in a few moments.",
                contextInfo: {
                    mentionedJid: [message.key.participant || message.key.remoteJid],
                    quotedMessage: message.message
                }
            }, {
                quoted: message
            });
        }
    } catch (error) {
        console.error('AI Command Error:', error.message);
        await sock.sendMessage(chatId, {
            text: "❌ An error occurred. Please try again later.",
            contextInfo: {
                mentionedJid: [message.key.participant || message.key.remoteJid],
                quotedMessage: message.message
            }
        }, {
            quoted: message
        });
    }
}

module.exports = aiCommand;
