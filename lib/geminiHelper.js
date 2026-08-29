const { GoogleGenAI } = require('@google/genai');

let geminiClient = null;

function getGeminiClient() {
    const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
    if (!apiKey) return null;
    if (!geminiClient) {
        geminiClient = new GoogleGenAI({
            apiKey,
            httpOptions: {
                headers: {
                    'User-Agent': 'aistudio-build'
                }
            }
        });
    }
    return geminiClient;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resilient AI generation with retry, fallback models, and exponential backoff
 * handles 503 UNAVAILABLE / high-demand rate spikes smoothly
 */
async function generateAIContent(prompt, systemInstruction = '') {
    const client = getGeminiClient();
    if (!client) return null;

    // Supported models in priority order for resilience
    const modelsToTry = [
        'gemini-3.7-flash',
        'gemini-flash-latest'
    ];

    const config = {};
    if (systemInstruction) {
        config.systemInstruction = systemInstruction;
    }

    for (const model of modelsToTry) {
        // Try up to 2 attempts per model with backoff on 503 / high demand
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const response = await client.models.generateContent({
                    model,
                    contents: prompt,
                    config
                });
                if (response && response.text) {
                    return response.text.trim();
                }
            } catch (err) {
                const errMsg = err?.message || String(err);
                const is503OrUnavailable = errMsg.includes('503') || 
                                          errMsg.includes('UNAVAILABLE') || 
                                          errMsg.includes('high demand') ||
                                          errMsg.includes('Resource has been exhausted') ||
                                          errMsg.includes('429');

                if (is503OrUnavailable && attempt < 2) {
                    // Exponential backoff wait before retrying or switching model
                    await sleep(1000 * attempt);
                    continue;
                } else if (!is503OrUnavailable) {
                    // Non-transient error (e.g. invalid parameter), log and try next model
                    console.warn(`Gemini generation note (${model}):`, errMsg);
                    break;
                }
            }
        }
    }

    return null;
}

module.exports = {
    getGeminiClient,
    generateAIContent
};
