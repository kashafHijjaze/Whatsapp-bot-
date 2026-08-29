const EventEmitter = require('events');
const fs = require('fs-extra');
const path = require('path');
const sessionVault = require('./sessionVault');

class BotState extends EventEmitter {
    constructor() {
        super();
        this.status = 'disconnected'; // 'disconnected' | 'connecting' | 'connected' | 'qr_ready' | 'pairing_code' | 'error'
        this.qrCode = null;
        this.pairingCode = null;
        this.user = null;
        this.logs = [];
        this.messageCount = 0;
        this.startTime = Date.now();
        this.phoneNumber = '';
        this.lastError = null;
        this.hasCreds = false;
        this.credsDetails = null;
        this.vaultStatus = null;
        this.envSessionStatus = null;
    }

    checkCreds() {
        try {
            sessionVault.ensureDirectories();
            this.envSessionStatus = sessionVault.getEnvSessionStatus();
            const credsPath = sessionVault.PRIMARY_CREDS;
            let targetPath = null;

            if (fs.existsSync(credsPath) && fs.statSync(credsPath).size > 50) {
                targetPath = credsPath;
            } else if (fs.existsSync(sessionVault.VAULT_CREDS) && fs.statSync(sessionVault.VAULT_CREDS).size > 50) {
                targetPath = sessionVault.VAULT_CREDS;
            } else if (fs.existsSync(sessionVault.DATA_CREDS) && fs.statSync(sessionVault.DATA_CREDS).size > 50) {
                targetPath = sessionVault.DATA_CREDS;
            }

            if (targetPath && fs.existsSync(targetPath)) {
                const stats = fs.statSync(targetPath);
                try {
                    const data = fs.readJsonSync(targetPath);
                    const isRevoked = sessionVault.isSessionRevoked(data);
                    const isRegistered = !isRevoked && sessionVault.isRegisteredCreds(data);
                    this.hasCreds = isRegistered;
                    this.credsDetails = {
                        size: stats.size,
                        lastModified: stats.mtime,
                        registered: isRegistered,
                        isRevoked,
                        me: data.me || null,
                        accountSyncCounter: data.accountSyncCounter || 0,
                        vaultSecured: isRegistered,
                        envDetected: this.envSessionStatus?.detected ? this.envSessionStatus.activeSource : null
                    };
                    this.vaultStatus = sessionVault.getVaultStatus();
                    return isRegistered;
                } catch (e) {
                    this.credsDetails = null;
                }
            }
            this.hasCreds = false;
            this.credsDetails = null;
            this.vaultStatus = sessionVault.getVaultStatus();
            return false;
        } catch (err) {
            this.hasCreds = false;
            this.credsDetails = null;
            this.vaultStatus = sessionVault.getVaultStatus();
            return false;
        }
    }

    setStatus(status, extra = {}) {
        this.status = status;
        if (extra.qrCode !== undefined) this.qrCode = extra.qrCode;
        if (extra.pairingCode !== undefined) this.pairingCode = extra.pairingCode;
        if (extra.user !== undefined) this.user = extra.user;
        if (extra.error !== undefined) this.lastError = extra.error;
        if (extra.phoneNumber !== undefined) this.phoneNumber = extra.phoneNumber;
        this.checkCreds();
        this.emit('update', this.toJSON());
    }

    addLog(message, type = 'info') {
        const entry = {
            id: Date.now() + Math.random().toString(36).substring(2, 6),
            time: new Date().toLocaleTimeString(),
            timestamp: Date.now(),
            message,
            type // 'info' | 'success' | 'warn' | 'error'
        };
        this.logs.unshift(entry);
        if (this.logs.length > 250) this.logs.pop();
        this.emit('log', entry);
    }

    incrementMessageCount() {
        this.messageCount++;
        this.emit('message', this.messageCount);
    }

    toJSON() {
        this.checkCreds();
        return {
            status: this.status,
            qrCode: this.qrCode,
            pairingCode: this.pairingCode,
            user: this.user,
            messageCount: this.messageCount,
            uptime: Math.floor((Date.now() - this.startTime) / 1000),
            phoneNumber: this.phoneNumber,
            lastError: this.lastError,
            hasCreds: this.hasCreds,
            credsDetails: this.credsDetails,
            vaultStatus: this.vaultStatus,
            envSessionStatus: this.envSessionStatus
        };
    }
}

const botState = new BotState();
module.exports = botState;

