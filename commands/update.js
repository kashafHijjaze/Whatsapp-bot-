const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const settings = require('../settings');
const isOwnerOrSudo = require('../lib/isOwner');

function run(cmd, timeoutMs = 45000) {
    return new Promise((resolve, reject) => {
        exec(cmd, { windowsHide: true, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
                const errMsg = (stderr || stdout || err.message || '').toString().trim();
                return reject(new Error(errMsg || `Command failed with code ${err.code}`));
            }
            resolve((stdout || '').toString());
        });
    });
}

async function hasGitRepo() {
    const gitDir = path.join(process.cwd(), '.git');
    if (!fs.existsSync(gitDir)) return false;
    try {
        await run('git --version', 10000);
        return true;
    } catch {
        return false;
    }
}

const DEFAULT_REPO_URL = 'https://github.com/kashafHijjaze/Whatsapp-bot-';
const DEFAULT_ZIP_MAIN = 'https://github.com/kashafHijjaze/Whatsapp-bot-/archive/refs/heads/main.zip';
const DEFAULT_ZIP_MASTER = 'https://github.com/kashafHijjaze/Whatsapp-bot-/archive/refs/heads/master.zip';

async function updateViaGit() {
    const targetRepo = (settings.githubRepo || DEFAULT_REPO_URL).replace(/\.git$/, '');
    try {
        const currentRemote = (await run('git config --get remote.origin.url', 10000).catch(() => '')).trim();
        if (!currentRemote) {
            await run(`git remote add origin ${targetRepo}.git`, 10000).catch(() => {});
        }
    } catch {}

    const oldRev = (await run('git rev-parse HEAD', 10000).catch(() => 'unknown')).trim();
    
    // Fetch with quick timeout
    await run('git fetch origin main --depth=1', 30000).catch(async () => {
        await run('git fetch origin master --depth=1', 30000).catch(async () => {
            await run('git fetch --all --prune', 30000);
        });
    });
    
    let newRev = '';
    try {
        newRev = (await run('git rev-parse origin/main', 10000)).trim();
    } catch {
        try {
            newRev = (await run('git rev-parse origin/master', 10000)).trim();
        } catch {
            newRev = (await run('git rev-parse HEAD', 10000)).trim();
        }
    }

    const alreadyUpToDate = oldRev === newRev && oldRev !== 'unknown';
    let packageChanged = false;
    
    if (newRev && !alreadyUpToDate) {
        const diffFiles = await run(`git diff --name-only ${oldRev} ${newRev}`, 15000).catch(() => '');
        packageChanged = diffFiles.includes('package.json');
        await run(`git reset --hard ${newRev}`, 20000);
        await run('git clean -fd', 15000).catch(() => {});
    }

    return { oldRev, newRev, alreadyUpToDate, packageChanged };
}

function downloadFile(url, dest, visited = new Set()) {
    return new Promise((resolve, reject) => {
        try {
            if (visited.has(url) || visited.size > 5) {
                return reject(new Error('Too many redirects'));
            }
            visited.add(url);

            const useHttps = url.startsWith('https://');
            const client = useHttps ? require('https') : require('http');
            const req = client.get(url, {
                headers: {
                    'User-Agent': 'HijjaziAI-Updater/1.0',
                    'Accept': '*/*'
                }
            }, res => {
                if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                    const location = res.headers.location;
                    if (!location) return reject(new Error(`HTTP ${res.statusCode} without Location`));
                    const nextUrl = new URL(location, url).toString();
                    res.resume();
                    return downloadFile(nextUrl, dest, visited).then(resolve).catch(reject);
                }

                if (res.statusCode !== 200) {
                    return reject(new Error(`HTTP ${res.statusCode}`));
                }

                const file = fs.createWriteStream(dest);
                res.pipe(file);
                file.on('finish', () => file.close(resolve));
                file.on('error', err => {
                    try { file.close(() => {}); } catch {}
                    fs.unlink(dest, () => reject(err));
                });
            });

            req.setTimeout(30000, () => {
                req.destroy();
                fs.unlink(dest, () => {});
                reject(new Error('Download timed out after 30 seconds'));
            });

            req.on('error', err => {
                fs.unlink(dest, () => {});
                reject(err);
            });
        } catch (e) {
            reject(e);
        }
    });
}

async function extractZip(zipPath, outDir) {
    if (process.platform === 'win32') {
        const cmd = `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${outDir.replace(/\\/g, '/')}' -Force"`;
        await run(cmd, 30000);
        return;
    }
    try {
        await run('command -v unzip', 5000);
        await run(`unzip -o -q '${zipPath}' -d '${outDir}'`, 30000);
        return;
    } catch {}
    try {
        await run('command -v 7z', 5000);
        await run(`7z x -y '${zipPath}' -o'${outDir}'`, 30000);
        return;
    } catch {}
    try {
        await run('busybox unzip -h', 5000);
        await run(`busybox unzip -o '${zipPath}' -d '${outDir}'`, 30000);
        return;
    } catch {}
    throw new Error("No system unzip tool found (unzip/7z/busybox).");
}

function copyRecursive(src, dest, ignore = [], relative = '', outList = []) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
        if (ignore.includes(entry)) continue;
        const s = path.join(src, entry);
        const d = path.join(dest, entry);
        const stat = fs.lstatSync(s);
        if (stat.isDirectory()) {
            copyRecursive(s, d, ignore, path.join(relative, entry), outList);
        } else {
            fs.copyFileSync(s, d);
            if (outList) outList.push(path.join(relative, entry).replace(/\\/g, '/'));
        }
    }
}

async function updateViaZip(zipOverride) {
    let zipUrl = (zipOverride || settings.updateZipUrl || process.env.UPDATE_ZIP_URL || DEFAULT_ZIP_MAIN).trim();
    const tmpDir = path.join(process.cwd(), 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const zipPath = path.join(tmpDir, 'update.zip');
    
    try {
        await downloadFile(zipUrl, zipPath);
    } catch (dlErr) {
        if (zipUrl.includes('/heads/main.zip')) {
            const masterZipUrl = zipUrl.replace('/heads/main.zip', '/heads/master.zip');
            await downloadFile(masterZipUrl, zipPath);
        } else {
            throw dlErr;
        }
    }

    const extractTo = path.join(tmpDir, 'update_extract');
    if (fs.existsSync(extractTo)) fs.rmSync(extractTo, { recursive: true, force: true });
    await extractZip(zipPath, extractTo);

    const [root] = fs.readdirSync(extractTo).map(n => path.join(extractTo, n));
    const srcRoot = fs.existsSync(root) && fs.lstatSync(root).isDirectory() ? root : extractTo;

    // Read new package.json to compare if dependencies changed
    let packageChanged = false;
    try {
        const oldPkg = fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8');
        const newPkg = fs.readFileSync(path.join(srcRoot, 'package.json'), 'utf8');
        packageChanged = oldPkg !== newPkg;
    } catch {}

    // Copy while preserving runtime dirs/files
    const ignore = ['node_modules', '.git', 'session', 'tmp', 'temp', 'data', 'baileys_store.json'];
    const copied = [];
    
    let preservedOwner = null;
    let preservedBotOwner = null;
    try {
        const currentSettings = require('../settings');
        preservedOwner = currentSettings && currentSettings.ownerNumber ? String(currentSettings.ownerNumber) : null;
        preservedBotOwner = currentSettings && currentSettings.botOwner ? String(currentSettings.botOwner) : null;
    } catch {}

    copyRecursive(srcRoot, process.cwd(), ignore, '', copied);

    if (preservedOwner) {
        try {
            const settingsPath = path.join(process.cwd(), 'settings.js');
            if (fs.existsSync(settingsPath)) {
                let text = fs.readFileSync(settingsPath, 'utf8');
                text = text.replace(/ownerNumber:\s*'[^']*'/, `ownerNumber: '${preservedOwner}'`);
                if (preservedBotOwner) {
                    text = text.replace(/botOwner:\s*'[^']*'/, `botOwner: '${preservedBotOwner}'`);
                }
                fs.writeFileSync(settingsPath, text);
            }
        } catch {}
    }

    try { fs.rmSync(extractTo, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(zipPath, { force: true }); } catch {}
    return { copiedFiles: copied, packageChanged };
}

function purgeRequireCache() {
    try {
        const rootDir = process.cwd();
        Object.keys(require.cache).forEach(key => {
            if (
                key.includes(path.join(rootDir, 'commands')) ||
                key.includes(path.join(rootDir, 'lib')) ||
                key.endsWith('settings.js') ||
                key.endsWith('main.js')
            ) {
                delete require.cache[key];
            }
        });
    } catch (e) {
        console.warn('Cache purge notice:', e.message);
    }
}

async function restartProcess(sock, chatId, message) {
    try {
        await sock.sendMessage(chatId, { text: '⚡ Update applied successfully! Reloading bot modules…' }, { quoted: message });
    } catch {}

    // Flush require cache so new code is loaded
    purgeRequireCache();

    // Check if PM2 supervisor is running this process
    const isPm2 = process.env.pm_id !== undefined || process.env.PM2_HOME !== undefined;

    if (isPm2) {
        try {
            await run('pm2 restart all', 10000);
            return;
        } catch {}
    }

    // In Katabump / Docker / Cloud container hosting, do NOT call process.exit(0)
    // which kills the container. Instead, seamlessly restart the socket connection in-process!
    try {
        const botEngine = require('../index');
        if (botEngine && typeof botEngine.restartBot === 'function') {
            await botEngine.restartBot();
            try {
                const freshSettings = require('../settings');
                const v = freshSettings.version ? ` v${freshSettings.version}` : '';
                await sock.sendMessage(chatId, { 
                    text: `👑 *HijjazI AI*${v} updated and reloaded successfully!\n\nType *.ping* or *.menu* to verify.` 
                });
            } catch {}
            return;
        }
    } catch (inProcessErr) {
        console.warn('[update] In-process restart fallback error:', inProcessErr.message);
    }

    // If all else fails and in a supervisor environment with exit restart
    setTimeout(() => {
        process.exit(0);
    }, 1500);
}

async function updateCommand(sock, chatId, message, zipOverride) {
    const senderId = message.key.participant || message.key.remoteJid;
    const isOwner = await isOwnerOrSudo(senderId, sock, chatId);
    
    if (!message.key.fromMe && !isOwner) {
        await sock.sendMessage(chatId, { text: '❌ Only bot owner or sudo can use .update' }, { quoted: message });
        return;
    }

    try {
        await sock.sendMessage(chatId, { text: '🔄 Checking and downloading latest updates, please wait…' }, { quoted: message });
        
        let packageChanged = false;
        let updateDone = false;

        if (await hasGitRepo()) {
            try {
                const gitRes = await updateViaGit();
                packageChanged = gitRes.packageChanged;
                updateDone = true;
                if (gitRes.alreadyUpToDate) {
                    await sock.sendMessage(chatId, { text: `✅ Bot is already running the latest version!` }, { quoted: message });
                    return;
                }
            } catch (gitErr) {
                console.warn('[update] Git update failed, falling back to direct zip extraction:', gitErr.message);
            }
        }

        if (!updateDone) {
            const zipRes = await updateViaZip(zipOverride);
            packageChanged = zipRes.packageChanged;
        }

        if (packageChanged) {
            try {
                await sock.sendMessage(chatId, { text: '📦 Installing updated dependencies…' }, { quoted: message });
                await run('npm install --prefer-offline --no-audit --no-fund --omit=dev', 60000);
            } catch (npmErr) {
                console.warn('[update] npm install warning:', npmErr.message);
            }
        }

        await restartProcess(sock, chatId, message);
    } catch (err) {
        console.error('Update failed:', err);
        await sock.sendMessage(chatId, { text: `❌ Update failed:\n${String(err.message || err)}` }, { quoted: message });
    }
}

module.exports = updateCommand;


