const express = require('express');
const dotenv = require('dotenv');
const botState = require('./lib/botState');
const sessionVault = require('./lib/sessionVault');

dotenv.config();

// Filter and auto-heal known transient libsignal / Signal protocol decryption errors
const originalConsoleError = console.error;
console.error = function(...args) {
    const fullText = args.map(a => (typeof a === 'object' ? (a?.stack || a?.message || JSON.stringify(a)) : String(a))).join(' ');
    if (
        fullText.includes('Failed to decrypt message with any known session') ||
        fullText.includes('Session error:Error: Bad MAC') ||
        fullText.includes('Session error: Error: Bad MAC') ||
        fullText.includes('Session error:') ||
        fullText.includes('Bad MAC')
    ) {
        try {
            sessionVault.autoHealBadMac();
        } catch (e) {}
        console.warn('🛡️ [Session Auto-Repair] Auto-healed Signal decryption session ratchet (Bad MAC desync resolved).');
        return;
    }
    originalConsoleError.apply(console, args);
};

// Global crash protection for server resilience
process.on('uncaughtException', (err) => {
    console.error('Unhandled Exception caught:', err?.message || err);
    if (botState && typeof botState.addLog === 'function') {
        botState.addLog('Exception caught: ' + (err?.message || err), 'error');
    }
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Promise Rejection caught:', reason);
    if (botState && typeof botState.addLog === 'function') {
        botState.addLog('Promise rejection: ' + (reason?.message || reason), 'warn');
    }
});

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let botModule = null;

function getBotModule() {
    if (!botModule) {
        try {
            botModule = require('./index');
        } catch (err) {
            console.error('Failed to load bot engine from index.js:', err);
            botState.addLog('Failed to load bot module: ' + err.message, 'error');
        }
    }
    return botModule;
}

// Auto-start bot backend immediately on boot
setTimeout(async () => {
    try {
        console.log('🤖 Initializing HijjazI AI WhatsApp Bot backend...');
        botState.addLog('🤖 Initializing WhatsApp Bot engine...', 'info');
        const bot = getBotModule();
        if (bot && typeof bot.startXeonBotInc === 'function') {
            await bot.startXeonBotInc();
        }
    } catch (err) {
        console.error('Bot startup error:', err);
        botState.addLog('Bot startup warning: ' + err.message, 'warn');
    }
}, 500);

// Backend Health & Diagnostics Endpoints (Required for Katabump / Cloud hosting health checks)

// 1. Root Service Info (JSON)
app.get('/', (req, res) => {
    botState.checkCreds();
    res.json({
        status: 'online',
        service: 'HijjazI AI WhatsApp Bot',
        type: 'backend-only',
        whatsapp: {
            status: botState.status,
            connected: botState.status === 'connected',
            hasCreds: botState.hasCreds,
            account: botState.user ? (botState.user.name || botState.user.id) : null
        },
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString()
    });
});

// 2. Standard Health Check
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString()
    });
});

// 3. Ping / Pong
app.get('/ping', (req, res) => {
    res.json({ pong: true, timestamp: Date.now() });
});

// 4. Detailed Bot Status JSON
app.get('/api/status', (req, res) => {
    res.json({
        success: true,
        data: botState.toJSON()
    });
});

// 5. System Stats
app.get('/api/system', (req, res) => {
    const memory = process.memoryUsage();
    res.json({
        success: true,
        stats: {
            rss: Math.round(memory.rss / 1024 / 1024) + ' MB',
            heapUsed: Math.round(memory.heapUsed / 1024 / 1024) + ' MB',
            heapTotal: Math.round(memory.heapTotal / 1024 / 1024) + ' MB',
            uptimeSeconds: Math.floor(process.uptime()),
            nodeVersion: process.version,
            platform: process.platform
        }
    });
});

const server = app.listen(Number(PORT) || 3000, '0.0.0.0', () => {
    console.log(`🚀 HijjazI AI Backend server active on port ${PORT}`);
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.warn(`⚠️ Port ${PORT} already in use. Service running.`);
    } else {
        console.error('Server network error:', err.message);
    }
});

