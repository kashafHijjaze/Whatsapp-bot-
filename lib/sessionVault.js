const fs = require('fs-extra');
const path = require('path');

// Storage Directories and File Paths
const SESSION_DIR = path.resolve(__dirname, '../session');
const PRIMARY_CREDS = path.join(SESSION_DIR, 'creds.json');
const DATA_DIR = path.resolve(__dirname, '../data');
const VAULT_DIR = path.join(DATA_DIR, 'session_vault');
const VAULT_CREDS = path.join(VAULT_DIR, 'creds_vault.json');
const DATA_CREDS = path.join(DATA_DIR, 'creds.json');
const BACKUP_KEYS_DIR = path.join(VAULT_DIR, 'keys_backup');
const VAULT_META = path.join(VAULT_DIR, 'vault_meta.json');
const REVOKED_SESSIONS_FILE = path.join(DATA_DIR, 'revoked_sessions.json');

/**
 * Ensures all necessary directories exist
 */
function ensureDirectories() {
    try {
        fs.ensureDirSync(SESSION_DIR);
        fs.ensureDirSync(DATA_DIR);
        fs.ensureDirSync(VAULT_DIR);
        fs.ensureDirSync(BACKUP_KEYS_DIR);
    } catch (e) {
        console.error('Error creating session vault directories:', e.message);
    }
}

/**
 * Computes a unique signature for a credentials object
 */
function getCredsSignature(creds) {
    if (!creds) return null;
    try {
        let obj = typeof creds === 'string' ? JSON.parse(creds) : creds;
        if (!obj || typeof obj !== 'object') return null;
        const id = obj.me?.id || obj.me?.jid || '';
        const regId = obj.registrationId !== undefined ? String(obj.registrationId) : '';
        const pubKey = obj.signedIdentityKey?.public?.data || obj.signedIdentityKey?.public || '';
        const rawKey = typeof pubKey === 'object' ? JSON.stringify(pubKey) : String(pubKey);
        return `${id}::${regId}::${rawKey.slice(0, 40)}`;
    } catch {
        return null;
    }
}

/**
 * Checks if a session has been recorded as revoked / logged out from WhatsApp
 */
function isSessionRevoked(creds) {
    try {
        if (!fs.existsSync(REVOKED_SESSIONS_FILE)) return false;
        const sig = getCredsSignature(creds);
        if (!sig) return false;
        const list = fs.readJsonSync(REVOKED_SESSIONS_FILE);
        if (Array.isArray(list)) {
            return list.some(item => (typeof item === 'string' ? item === sig : item.signature === sig));
        }
        return false;
    } catch {
        return false;
    }
}

/**
 * Marks a session signature as revoked / logged out by WhatsApp server
 */
function markSessionRevoked(creds, reason = 'Logged out by WhatsApp mobile client') {
    try {
        ensureDirectories();
        const sig = getCredsSignature(creds);
        if (!sig) return false;
        let list = [];
        if (fs.existsSync(REVOKED_SESSIONS_FILE)) {
            try { list = fs.readJsonSync(REVOKED_SESSIONS_FILE); } catch {}
            if (!Array.isArray(list)) list = [];
        }
        const existing = list.find(item => (typeof item === 'string' ? item === sig : item.signature === sig));
        if (!existing) {
            list.push({
                signature: sig,
                reason,
                revokedAt: new Date().toISOString(),
                user: (typeof creds === 'object' && creds?.me) ? creds.me : null
            });
            fs.writeJsonSync(REVOKED_SESSIONS_FILE, list, { spaces: 2 });
            console.log(`⚠️ [Vault] Recorded revoked/logged-out session signature: ${sig}`);
        }
        return true;
    } catch (e) {
        console.error('Error marking session revoked:', e.message);
        return false;
    }
}

/**
 * Clears all recorded revoked sessions (allows manual unblock/retry)
 */
function clearRevokedSessions() {
    try {
        if (fs.existsSync(REVOKED_SESSIONS_FILE)) {
            fs.unlinkSync(REVOKED_SESSIONS_FILE);
        }
        return true;
    } catch {
        return false;
    }
}

/**
 * Reads the current primary creds if existing
 */
function readCurrentCreds() {
    try {
        if (fs.existsSync(PRIMARY_CREDS)) {
            const raw = fs.readFileSync(PRIMARY_CREDS, 'utf8');
            if (isValidCreds(raw)) return JSON.parse(raw);
        }
        if (fs.existsSync(VAULT_CREDS)) {
            const raw = fs.readFileSync(VAULT_CREDS, 'utf8');
            if (isValidCreds(raw)) return JSON.parse(raw);
        }
    } catch {}
    return null;
}

/**
 * Validates whether the given data or file is a valid Baileys creds object
 */
function isValidCreds(data) {
    if (!data) return false;
    try {
        let obj = data;
        if (typeof data === 'string') {
            obj = JSON.parse(data);
        }
        if (typeof obj !== 'object' || obj === null) return false;
        // Must contain standard Baileys creds fields
        return !!(
            obj.noiseKey ||
            obj.signedIdentityKey ||
            obj.signedPreKey ||
            obj.registrationId !== undefined ||
            obj.me ||
            obj.registered !== undefined ||
            obj.account ||
            obj.processedHistoryMessages
        );
    } catch {
        return false;
    }
}

/**
 * Universally parses session input from strings, base64, JSON, or prefixed formats
 * Accepts:
 * - SESSION_ID (Base64 or prefixed like HijjazI AI;;;..., KnightBot;;;..., etc.)
 * - CREDS_JSON (Raw JSON, escaped JSON, or Base64 JSON)
 * - Raw JavaScript Object
 */
function parseSessionInput(input) {
    if (!input) return null;
    if (typeof input === 'object' && input !== null) {
        return isValidCreds(input) ? input : null;
    }
    if (typeof input !== 'string') return null;

    let str = input.trim();
    if (!str) return null;

    // 1. Remove surrounding wrapping quotes if copied with quotes
    if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
        str = str.slice(1, -1).trim();
    }

    // 2. Strip common session prefixes if present (e.g. HijjaziAI;;;, KnightBot;;;, XeonBotInc;;;, Session;;;, session_id=)
    if (str.includes(';;;')) {
        str = str.split(';;;')[1].trim();
    } else if (str.includes(';;')) {
        str = str.split(';;')[1].trim();
    } else if (str.startsWith('session_id=')) {
        str = str.replace('session_id=', '').trim();
    } else if (str.startsWith('SESSION_ID=')) {
        str = str.replace('SESSION_ID=', '').trim();
    } else if (str.startsWith('CREDS_JSON=')) {
        str = str.replace('CREDS_JSON=', '').trim();
    }

    // 3. Try parsing directly as JSON
    try {
        const directJson = JSON.parse(str);
        if (isValidCreds(directJson)) return directJson;
    } catch {}

    // 4. Try unescaping escaped JSON (e.g. {\"noiseKey\":...})
    try {
        if (str.includes('\\"') || str.includes('\\n')) {
            const unescaped = str.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
            const unescJson = JSON.parse(unescaped);
            if (isValidCreds(unescJson)) return unescJson;
        }
    } catch {}

    // 5. Try Base64 decoding (standard and URL-safe)
    try {
        let base64Clean = str.replace(/\s+/g, '');
        // Convert URL-safe base64 to standard
        base64Clean = base64Clean.replace(/-/g, '+').replace(/_/g, '/');
        while (base64Clean.length % 4 !== 0) {
            base64Clean += '=';
        }

        const decoded = Buffer.from(base64Clean, 'base64').toString('utf8');
        try {
            const parsed = JSON.parse(decoded);
            if (isValidCreds(parsed)) return parsed;
        } catch {
            // Check if nested base64 or unescaping needed
            if (decoded.includes('\\"')) {
                const unesc = decoded.replace(/\\"/g, '"');
                const p = JSON.parse(unesc);
                if (isValidCreds(p)) return p;
            }
        }
    } catch {}

    return null;
}

/**
 * Detects and extracts WhatsApp credentials from environmental variables
 * Checks in order: SESSION_ID, CREDS_JSON, SESSION_DATA, WA_SESSION, SESSION, CREDS, BAILEYS_CREDS
 */
function detectSessionFromEnvironment() {
    const candidateVars = [
        'SESSION_ID',
        'CREDS_JSON',
        'SESSION_DATA',
        'WA_SESSION',
        'SESSION',
        'CREDS',
        'BAILEYS_CREDS',
        'WHATSAPP_SESSION',
        'WHATSAPP_CREDS',
        'SESSION_JSON'
    ];

    for (const varName of candidateVars) {
        const val = process.env[varName];
        if (val && typeof val === 'string' && val.trim().length > 10) {
            const parsed = parseSessionInput(val);
            if (parsed && isValidCreds(parsed)) {
                const isRevoked = isSessionRevoked(parsed);
                if (isRevoked) {
                    return {
                        detected: false,
                        isRevoked: true,
                        source: varName,
                        creds: parsed,
                        isRegistered: false,
                        user: parsed.me || null,
                        rawSnippet: val.trim().slice(0, 16) + '...',
                        revocationReason: 'Session in environment variable was logged out from WhatsApp. Re-link with QR or pairing code.'
                    };
                }
                return {
                    detected: true,
                    isRevoked: false,
                    source: varName,
                    creds: parsed,
                    isRegistered: isRegisteredCreds(parsed),
                    user: parsed.me || null,
                    rawSnippet: val.trim().slice(0, 16) + '...'
                };
            }
        }
    }

    return {
        detected: false,
        isRevoked: false,
        source: null,
        creds: null,
        isRegistered: false,
        user: null,
        rawSnippet: null
    };
}

/**
 * Get comprehensive environment variable diagnostic summary
 */
function getEnvSessionStatus() {
    const detected = detectSessionFromEnvironment();
    const envStatus = {
        detected: detected.detected,
        isRevoked: detected.isRevoked || false,
        revocationReason: detected.revocationReason || null,
        activeSource: detected.source,
        accountUser: detected.user,
        isRegistered: detected.isRegistered,
        supportedVariables: [
            { name: 'SESSION_ID', description: 'Base64 or prefixed session string (e.g. HijjazI AI;;;base64...)', isSet: !!(process.env.SESSION_ID && process.env.SESSION_ID.trim()) },
            { name: 'CREDS_JSON', description: 'Raw JSON or Base64 creds.json content', isSet: !!(process.env.CREDS_JSON && process.env.CREDS_JSON.trim()) },
            { name: 'SESSION_DATA', description: 'Alternative session payload string', isSet: !!(process.env.SESSION_DATA && process.env.SESSION_DATA.trim()) },
            { name: 'WA_SESSION', description: 'Alternative WhatsApp session variable', isSet: !!(process.env.WA_SESSION && process.env.WA_SESSION.trim()) }
        ]
    };
    return envStatus;
}

/**
 * Validates whether the credentials represent an actively registered WhatsApp account
 */
function isRegisteredCreds(data) {
    if (!data) return false;
    try {
        let obj = data;
        if (typeof data === 'string') {
            obj = JSON.parse(data);
        }
        if (typeof obj !== 'object' || obj === null) return false;
        return !!(obj.registered === true && (obj.me || obj.noiseKey || obj.signedIdentityKey));
    } catch {
        return false;
    }
}

/**
 * Safely writes a file atomically using a temporary file
 */
function safeWriteJson(targetPath, data) {
    try {
        const dir = path.dirname(targetPath);
        fs.ensureDirSync(dir);
        const tempPath = `${targetPath}.${Date.now()}.tmp`;
        const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
        fs.writeFileSync(tempPath, content, 'utf8');
        fs.moveSync(tempPath, targetPath, { overwrite: true });
        return true;
    } catch (err) {
        try {
            // Fallback direct write
            const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
            fs.writeFileSync(targetPath, content, 'utf8');
            return true;
        } catch (e) {
            console.error(`Failed to write to ${targetPath}:`, e.message);
            return false;
        }
    }
}

/**
 * Persists and permanently saves current creds and keys into the vault
 * Call this whenever creds are updated, on saveCreds, or when socket connects
 */
function persistCreds(customCreds = null) {
    try {
        ensureDirectories();
        let credsObj = null;

        if (customCreds) {
            if (isValidCreds(customCreds)) {
                credsObj = typeof customCreds === 'string' ? JSON.parse(customCreds) : customCreds;
            }
        } else if (fs.existsSync(PRIMARY_CREDS)) {
            try {
                const raw = fs.readFileSync(PRIMARY_CREDS, 'utf8');
                if (isValidCreds(raw)) {
                    credsObj = JSON.parse(raw);
                }
            } catch (e) {}
        }

        if (!credsObj) return false;

        // 1. Write to primary session path
        safeWriteJson(PRIMARY_CREDS, credsObj);

        // Only lock into permanent vault if credentials are fully registered to a real WhatsApp account
        if (isRegisteredCreds(credsObj)) {
            // 2. Write to permanent vault copy
            safeWriteJson(VAULT_CREDS, credsObj);

            // 3. Write to root data folder creds copy
            safeWriteJson(DATA_CREDS, credsObj);

            // 4. Update metadata
            const meta = {
                lastSaved: new Date().toISOString(),
                timestamp: Date.now(),
                registered: true,
                me: credsObj.me || null,
                accountSyncCounter: credsObj.accountSyncCounter || 0,
                hasNoiseKey: !!credsObj.noiseKey
            };
            safeWriteJson(VAULT_META, meta);

            // 5. Sync companion keys from session folder to backup keys directory
            backupSessionKeys();
        }

        return true;
    } catch (err) {
        console.error('Error persisting creds in sessionVault:', err.message);
        return false;
    }
}

/**
 * Backs up companion session key files (only essential non-transient files)
 */
function backupSessionKeys() {
    // Note: Transient session ratchets and pre-keys should NOT be persisted to backup
    // to avoid Signal ratchet desynchronization (Bad MAC / decryption failure).
}

/**
 * Restores companion keys from backup to session folder
 */
function restoreSessionKeys() {
    // Intentionally no-op to prevent restoring stale pre-keys or out-of-sync ratchets.
}

/**
 * Automatically restores creds.json from environmental variables or vault if missing or corrupted
 * Returns true if valid registered creds are present or restored
 */
function restoreCredsIfNeeded() {
    try {
        ensureDirectories();

        // 1. Priority: Check Environmental Variables (SESSION_ID or CREDS_JSON or SESSION_DATA, etc.)
        const envResult = detectSessionFromEnvironment();
        if (envResult.detected && envResult.creds && !isSessionRevoked(envResult.creds)) {
            persistCreds(envResult.creds);
            console.log(`🔒 [Vault] Restored and activated creds.json from environment variable: ${envResult.source}`);
            return true;
        }

        // 2. Check if primary creds.json is already present and valid (and not revoked)
        if (fs.existsSync(PRIMARY_CREDS)) {
            try {
                const raw = fs.readFileSync(PRIMARY_CREDS, 'utf8');
                if (isValidCreds(raw)) {
                    if (isSessionRevoked(raw)) {
                        console.log('⚠️ [Vault] Primary creds.json was revoked. Removing.');
                        try { fs.rmSync(PRIMARY_CREDS, { force: true }); } catch (e) {}
                    } else {
                        if (isRegisteredCreds(raw)) {
                            persistCreds(JSON.parse(raw));
                        }
                        return true;
                    }
                } else {
                    console.log('⚠️ [Vault] Invalid or corrupted creds.json detected in session. Purging.');
                    try { fs.rmSync(PRIMARY_CREDS, { force: true }); } catch (e) {}
                }
            } catch (e) {
                try { fs.rmSync(PRIMARY_CREDS, { force: true }); } catch (e) {}
            }
        }

        // 3. Check Vault backup creds
        if (fs.existsSync(VAULT_CREDS)) {
            try {
                const raw = fs.readFileSync(VAULT_CREDS, 'utf8');
                if (isRegisteredCreds(raw)) {
                    if (isSessionRevoked(raw)) {
                        console.log('⚠️ [Vault] Vault creds was revoked. Removing.');
                        try { fs.rmSync(VAULT_CREDS, { force: true }); } catch (e) {}
                    } else {
                        const parsed = JSON.parse(raw);
                        safeWriteJson(PRIMARY_CREDS, parsed);
                        safeWriteJson(DATA_CREDS, parsed);
                        console.log('🔒 [Vault] Restored creds.json forever from session_vault');
                        return true;
                    }
                }
            } catch (e) {}
        }

        // 4. Check data/creds.json backup
        if (fs.existsSync(DATA_CREDS)) {
            try {
                const raw = fs.readFileSync(DATA_CREDS, 'utf8');
                if (isRegisteredCreds(raw)) {
                    if (isSessionRevoked(raw)) {
                        console.log('⚠️ [Vault] Data creds was revoked. Removing.');
                        try { fs.rmSync(DATA_CREDS, { force: true }); } catch (e) {}
                    } else {
                        const parsed = JSON.parse(raw);
                        safeWriteJson(PRIMARY_CREDS, parsed);
                        safeWriteJson(VAULT_CREDS, parsed);
                        console.log('🔒 [Vault] Restored creds.json forever from data/creds.json');
                        return true;
                    }
                }
            } catch (e) {}
        }

        return false;
    } catch (err) {
        console.error('Error restoring creds in restoreCredsIfNeeded:', err.message);
        return false;
    }
}

const DELIVERY_RECORD_FILE = path.join(DATA_DIR, 'session_delivery.json');

/**
 * Checks if credentials have already been delivered to the user for the current session
 */
function isSessionDelivered(userNumber, credsSignature = null) {
    try {
        if (!fs.existsSync(DELIVERY_RECORD_FILE)) return false;
        const data = fs.readJsonSync(DELIVERY_RECORD_FILE);
        if (!data || !data.delivered) return false;
        if (userNumber && data.userNumber && String(data.userNumber) !== String(userNumber)) return false;
        if (credsSignature && data.credsSignature && data.credsSignature !== credsSignature) return false;
        return true;
    } catch {
        return false;
    }
}

/**
 * Marks session credentials as successfully delivered
 */
function markSessionDelivered(userNumber, credsSignature = null) {
    try {
        ensureDirectories();
        const record = {
            delivered: true,
            userNumber: userNumber ? String(userNumber).replace(/[^0-9]/g, '') : null,
            credsSignature: credsSignature || null,
            deliveredAt: new Date().toISOString(),
            timestamp: Date.now()
        };
        safeWriteJson(DELIVERY_RECORD_FILE, record);
        return true;
    } catch (e) {
        console.error('Error marking session delivered:', e);
        return false;
    }
}

/**
 * Clears the session delivery record (e.g. on hard reset or account replacement)
 */
function clearDeliveryRecord() {
    try {
        if (fs.existsSync(DELIVERY_RECORD_FILE)) {
            fs.unlinkSync(DELIVERY_RECORD_FILE);
        }
    } catch (e) {}
}

/**
 * Replaces credentials when a user connects a NEW WhatsApp account
 * Overwrites vault and session files cleanly with the new account's creds
 */
function replaceWithNewCreds(newCreds) {
    try {
        ensureDirectories();
        if (!isValidCreds(newCreds)) {
            throw new Error('Invalid WhatsApp credentials format provided');
        }

        const credsObj = typeof newCreds === 'string' ? JSON.parse(newCreds) : newCreds;

        // Clear old companion keys and delivery record so they do not conflict with the new account
        clearSessionKeysOnly();
        clearDeliveryRecord();

        // Save new credentials across all storage locations
        safeWriteJson(PRIMARY_CREDS, credsObj);
        safeWriteJson(VAULT_CREDS, credsObj);
        safeWriteJson(DATA_CREDS, credsObj);

        const meta = {
            lastSaved: new Date().toISOString(),
            timestamp: Date.now(),
            registered: !!credsObj.registered,
            me: credsObj.me || null,
            accountSyncCounter: credsObj.accountSyncCounter || 0,
            replacedAt: new Date().toISOString()
        };
        safeWriteJson(VAULT_META, meta);

        console.log('✨ [Vault] Successfully replaced credentials with new WhatsApp account!');
        return true;
    } catch (err) {
        console.error('Failed to replace credentials:', err.message);
        throw err;
    }
}

/**
 * Clears old session keys without deleting credentials unless explicitly commanded
 */
function clearSessionKeysOnly() {
    try {
        if (fs.existsSync(SESSION_DIR)) {
            const files = fs.readdirSync(SESSION_DIR);
            for (const f of files) {
                if (f === 'creds.json' || f === 'upload creds file here') continue;
                try { fs.rmSync(path.join(SESSION_DIR, f), { recursive: true, force: true }); } catch (e) {}
            }
        }
        if (fs.existsSync(BACKUP_KEYS_DIR)) {
            const bfiles = fs.readdirSync(BACKUP_KEYS_DIR);
            for (const f of bfiles) {
                try { fs.rmSync(path.join(BACKUP_KEYS_DIR, f), { recursive: true, force: true }); } catch (e) {}
            }
        }
    } catch (e) {}
}

/**
 * Total reset of all sessions and vault (when user explicitly requests reset)
 */
function hardResetAll() {
    try {
        ensureDirectories();
        clearSessionKeysOnly();
        clearDeliveryRecord();
        try { fs.rmSync(PRIMARY_CREDS, { force: true }); } catch (e) {}
        try { fs.rmSync(VAULT_CREDS, { force: true }); } catch (e) {}
        try { fs.rmSync(DATA_CREDS, { force: true }); } catch (e) {}
        try { fs.rmSync(VAULT_META, { force: true }); } catch (e) {}
        console.log('🧹 [Vault] All session files and vault cleared for fresh connection');
        return true;
    } catch (err) {
        console.error('Error during hardResetAll:', err.message);
        return false;
    }
}

/**
 * Purges corrupted or bad MAC session files for a specific JID or all sessions
 * without dropping primary creds.json
 */
function purgeCorruptedSession(pattern = null) {
    try {
        ensureDirectories();
        let cleaned = 0;
        const targetDirs = [SESSION_DIR, BACKUP_KEYS_DIR];
        for (const dir of targetDirs) {
            if (!fs.existsSync(dir)) continue;
            const files = fs.readdirSync(dir);
            for (const file of files) {
                // NEVER delete creds.json or upload placeholder
                if (file === 'creds.json' || file.endsWith('.tmp') || file === 'upload creds file here') continue;
                
                const isSessionKey = (
                    file.startsWith('session-') ||
                    file.startsWith('sender-key-') ||
                    file.startsWith('sender-key-memory-') ||
                    file.startsWith('pre-key-') ||
                    file.startsWith('device-list-') ||
                    file.startsWith('identity-key-') ||
                    file.startsWith('tctoken-') ||
                    file.startsWith('lid-mapping-')
                );

                if (isSessionKey) {
                    if (!pattern || file.includes(pattern)) {
                        try {
                            fs.unlinkSync(path.join(dir, file));
                            cleaned++;
                        } catch {}
                    }
                }
            }
        }
        return cleaned;
    } catch {
        return 0;
    }
}

/**
 * Specifically auto-heals Bad MAC by purging out-of-sync session ratchets
 * while preserving primary WhatsApp account credentials
 */
let lastBadMacHeal = 0;
function autoHealBadMac(specificJidOrId = null) {
    const now = Date.now();
    // Debounce healing calls to avoid disk thrashing (max once every 2 seconds)
    if (now - lastBadMacHeal < 2000 && !specificJidOrId) {
        return 0;
    }
    lastBadMacHeal = now;

    try {
        let cleaned = 0;
        if (specificJidOrId) {
            // Extract the core user/group number or ID (e.g. 90160507162869 from 90160507162869:1@s.whatsapp.net)
            const raw = String(specificJidOrId);
            const userPart = raw.split('@')[0].split(':')[0].replace(/[^a-zA-Z0-9_-]/g, '');
            if (userPart && userPart.length > 2) {
                cleaned = purgeCorruptedSession(userPart);
            }
            if (cleaned === 0 && raw.includes('-')) {
                const groupPart = raw.split('@')[0].replace(/[^a-zA-Z0-9_-]/g, '');
                cleaned = purgeCorruptedSession(groupPart);
            }
        }
        
        // If no specific ID cleaned or none found, purge stale session & sender-key ratchets
        if (cleaned === 0) {
            cleaned = purgeCorruptedSession('session-') + purgeCorruptedSession('sender-key-');
        }

        console.log(`🛡️ [Vault Auto-Healer] Bad MAC resolved: Purged ${cleaned} out-of-sync session ratchets.`);
        return cleaned;
    } catch (e) {
        console.error('Error in autoHealBadMac:', e.message);
        return 0;
    }
}

/**
 * Sanitizes all json files in session directory to prevent Baileys startup crashes
 */
function sanitizeSessionFolder() {
    try {
        ensureDirectories();
        if (!fs.existsSync(SESSION_DIR)) return;
        const files = fs.readdirSync(SESSION_DIR);
        for (const file of files) {
            if (file.endsWith('.json')) {
                const fullPath = path.join(SESSION_DIR, file);
                try {
                    const stat = fs.statSync(fullPath);
                    if (stat.size === 0) {
                        fs.unlinkSync(fullPath);
                        continue;
                    }
                    if (file !== 'creds.json') {
                        const content = fs.readFileSync(fullPath, 'utf8');
                        JSON.parse(content);
                    }
                } catch {
                    try { fs.unlinkSync(fullPath); } catch {}
                }
            }
        }
    } catch (e) {
        console.warn('Notice during session sanitize:', e.message);
    }
}

/**
 * Get current vault summary status
 */
function getVaultStatus() {
    ensureDirectories();
    const hasPrimary = fs.existsSync(PRIMARY_CREDS) && fs.statSync(PRIMARY_CREDS).size > 50;
    const hasVault = fs.existsSync(VAULT_CREDS) && fs.statSync(VAULT_CREDS).size > 50;
    const hasData = fs.existsSync(DATA_CREDS) && fs.statSync(DATA_CREDS).size > 50;

    let meta = null;
    if (fs.existsSync(VAULT_META)) {
        try { meta = fs.readJsonSync(VAULT_META); } catch (e) {}
    }

    return {
        isSecured: hasPrimary || hasVault || hasData,
        hasPrimary,
        hasVault,
        hasData,
        meta
    };
}

module.exports = {
    ensureDirectories,
    isValidCreds,
    isRegisteredCreds,
    parseSessionInput,
    detectSessionFromEnvironment,
    getEnvSessionStatus,
    getCredsSignature,
    isSessionRevoked,
    markSessionRevoked,
    clearRevokedSessions,
    readCurrentCreds,
    persistCreds,
    restoreCredsIfNeeded,
    replaceWithNewCreds,
    clearSessionKeysOnly,
    purgeCorruptedSession,
    autoHealBadMac,
    hardResetAll,
    backupSessionKeys,
    restoreSessionKeys,
    getVaultStatus,
    sanitizeSessionFolder,
    isSessionDelivered,
    markSessionDelivered,
    clearDeliveryRecord,
    PRIMARY_CREDS,
    VAULT_CREDS,
    DATA_CREDS
};
