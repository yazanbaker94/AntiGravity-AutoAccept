/**
 * Conversation Guard — Detached Worker
 * =====================================
 * Runs as a standalone Node.js process (via ELECTRON_RUN_AS_NODE=1)
 * after AntiGravity exits. Rebuilds the sidebar conversation index
 * from .pb files on disk.
 *
 * Usage: spawned by extension.js with process.pid as argv[2]
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Cross-Platform Paths ─────────────────────────────────────────────
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

const DB_PATH = isWin
    ? path.join(process.env.APPDATA, 'antigravity', 'User', 'globalStorage', 'state.vscdb')
    : isMac
        ? path.join(os.homedir(), 'Library', 'Application Support', 'antigravity', 'User', 'globalStorage', 'state.vscdb')
        : path.join(os.homedir(), '.config', 'Antigravity', 'User', 'globalStorage', 'state.vscdb');

const CONVERSATIONS_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'conversations');
const BRAIN_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
const WORKSPACE_STORAGE_DIR = isWin
    ? path.join(process.env.APPDATA, 'antigravity', 'User', 'workspaceStorage')
    : isMac
        ? path.join(os.homedir(), 'Library', 'Application Support', 'antigravity', 'User', 'workspaceStorage')
        : path.join(os.homedir(), '.config', 'Antigravity', 'User', 'workspaceStorage');

const LOG_PATH = path.join(os.tmpdir(), 'aa-conversation-fix.log');

// ─── One-Shot Relaunch Guard ──────────────────────────────────────────
// Prevents zombie workers from firing a second relaunch into an active session.
let _hasRelaunched = false;

// ─── Logging ──────────────────────────────────────────────────────────
function log(msg) {
    const line = `${new Date().toISOString()} ${msg}\n`;
    try { fs.appendFileSync(LOG_PATH, line); } catch (e) { /* ignore */ }
}

// ─── ⚡ THE MISSING FILTER FIX ─────────────────────────────────────
// Actively rejects garbage generic titles so the NLP engine is forced to parse
function isGenericTitle(title) {
    if (!title) return true;
    const t = title.trim().toLowerCase();
    if (t.startsWith('conversation (') || t.startsWith('chat (')) return true;
    if (t.startsWith('conversation ') && t.length < 25) return true;
    if (t === 'new conversation' || t === 'untitled') return true;
    return false;
}

// ─── Protobuf Varint Engine ──────────────────────────────────────────
function decodeVarint(buffer, offset) {
    let result = 0, shift = 0, pos = offset || 0;
    while (pos < buffer.length) {
        const byte = buffer[pos++];
        result += (byte & 0x7F) * Math.pow(2, shift);
        if ((byte & 0x80) === 0) break;
        shift += 7;
    }
    return { value: result, pos };
}

function encodeVarint(value) {
    const bytes = [];
    if (value === 0) return Buffer.from([0]);
    while (value > 0x7F) {
        bytes.push((value & 0x7F) | 0x80);
        value = Math.floor(value / 128);
    }
    bytes.push(value & 0x7F);
    return Buffer.from(bytes);
}

function skipProtobufField(buffer, pos, wireType) {
    if (wireType === 0) {
        while (pos < buffer.length && (buffer[pos++] & 0x80) !== 0) {}
        return pos;
    }
    if (wireType === 1) return pos + 8;
    if (wireType === 2) {
        const { value: len, pos: next } = decodeVarint(buffer, pos);
        return next + len;
    }
    if (wireType === 5) return pos + 4;
    throw new Error(`Unsupported wire type: ${wireType}`);
}

function stripFieldFromProtobuf(data, targetFieldNumber) {
    const chunks = [];
    let pos = 0;
    while (pos < data.length) {
        const startPos = pos;
        let tag;
        try {
            const r = decodeVarint(data, pos);
            tag = r.value; pos = r.pos;
        } catch (e) { chunks.push(data.slice(startPos)); break; }
        const wireType = tag & 7;
        const fieldNum = Math.floor(tag / 8);
        try {
            pos = skipProtobufField(data, pos, wireType);
        } catch (e) { chunks.push(data.slice(startPos)); break; }
        if (fieldNum !== targetFieldNumber) {
            chunks.push(data.slice(startPos, pos));
        }
    }
    return Buffer.concat(chunks);
}

function encodeLengthDelimited(fieldNum, data) {
    const tag = encodeVarint(fieldNum * 8 + 2);
    const len = encodeVarint(data.length);
    return Buffer.concat([tag, len, data]);
}

function encodeStringField(fieldNum, str) {
    return encodeLengthDelimited(fieldNum, Buffer.from(str, 'utf8'));
}

function buildTimestampFields(epochSeconds) {
    const seconds = Math.floor(epochSeconds);
    const tsInner = Buffer.concat([encodeVarint(8), encodeVarint(seconds)]); 
    return Buffer.concat([
        encodeLengthDelimited(3, tsInner),
        encodeLengthDelimited(7, tsInner),
        encodeLengthDelimited(10, tsInner),
    ]);
}

function hasTimestampFields(innerBlob) {
    if (!innerBlob) return false;
    try {
        let pos = 0;
        while (pos < innerBlob.length) {
            const { value: tag, pos: next } = decodeVarint(innerBlob, pos);
            const fieldNum = Math.floor(tag / 8);
            const wireType = tag & 7;
            if (fieldNum === 3 || fieldNum === 7 || fieldNum === 10) return true;
            pos = skipProtobufField(innerBlob, next, wireType);
        }
    } catch (e) { }
    return false;
}

function pathToWorkspaceUri(folderPath) {
    if (folderPath.startsWith('vscode-remote://') || folderPath.startsWith('file:///')) {
        return folderPath;
    }
    let p = folderPath.replace(/\\/g, '/');
    if (p.length >= 2 && p[1] === ':') {
        const drive = p[0].toLowerCase();
        const rest = p.substring(2);
        const encoded = rest.split('/').map(s => encodeURIComponent(s)).join('/');
        return `file:///${drive}%3A${encoded}`;
    }
    const encoded = p.split('/').map(s => encodeURIComponent(s)).join('/');
    return `file:///${encoded.replace(/^\//, '')}`;
}

function buildWorkspaceField(folderPath) {
    const uri = pathToWorkspaceUri(folderPath);
    const subMsg = Buffer.concat([
        encodeStringField(1, uri),
        encodeStringField(2, uri),
    ]);
    return encodeLengthDelimited(9, subMsg);
}

function extractWorkspaceHint(innerBlob) {
    if (!innerBlob) return null;
    try {
        let pos = 0;
        while (pos < innerBlob.length) {
            const { value: tag, pos: next } = decodeVarint(innerBlob, pos);
            const wireType = tag & 7;
            const fieldNum = Math.floor(tag / 8);
            if (wireType === 2) {
                const { value: len, pos: dataStart } = decodeVarint(innerBlob, next);
                const content = innerBlob.slice(dataStart, dataStart + len);
                pos = dataStart + len;
                if (fieldNum > 1) {
                    try {
                        const text = content.toString('utf8');
                        if (text.includes('file:///') || text.includes('vscode-remote://')) {
                            return text;
                        }
                    } catch (e) { }
                }
            } else {
                pos = skipProtobufField(innerBlob, next, wireType);
            }
        }
    } catch (e) { }
    return null;
}

// ─── Metadata Extraction & Heuristics ────────────────────────────────

function extractTitleFromInnerBlob(innerBlob) {
    if (!innerBlob) return null;
    let fallbackText = null;
    try {
        let pos = 0;
        while (pos < innerBlob.length) {
            const { value: tag, pos: next } = decodeVarint(innerBlob, pos);
            const wireType = tag & 7;
            const fieldNum = Math.floor(tag / 8);
            if (wireType === 2) {
                const { value: len, pos: dataStart } = decodeVarint(innerBlob, next);
                const content = innerBlob.slice(dataStart, dataStart + len);
                pos = dataStart + len;
                
                try {
                    const textExtract = content.toString('utf8').trim();
                    if (textExtract && !textExtract.includes('{"workspace') && !textExtract.includes('"context"')) {
                        if (fieldNum === 1 && textExtract.length > 3) {
                            // Reject generic fallbacks so NLP kicks in
                            if (!isGenericTitle(textExtract)) return textExtract;
                            return null;
                        }
                        if (textExtract.length > 5 && textExtract.length < 150) {
                            if (!isGenericTitle(textExtract)) {
                                 const letterCount = (textExtract.match(/[a-zA-Z\s0-9]/g) ||[]).length;
                                 if (letterCount / textExtract.length > 0.8) fallbackText = textExtract;
                            }
                        }
                    }
                } catch(ign) {}
            } else if (wireType === 0) {
                pos = decodeVarint(innerBlob, next).pos;
            } else {
                pos = skipProtobufField(innerBlob, next, wireType);
            }
        }
    } catch (e) { }
    return fallbackText;
}

function extractExistingMetadata(db) {
    const titles = {};
    const innerBlobs = {};
    try {
        const rows = db.exec("SELECT value FROM ItemTable WHERE key='antigravityUnifiedStateSync.trajectorySummaries'");
        if (!rows.length || !rows[0].values.length || !rows[0].values[0][0]) return { titles, innerBlobs };

        const decoded = Buffer.from(rows[0].values[0][0], 'base64');
        let pos = 0;
        while (pos < decoded.length) {
            try {
                const { value: tag, pos: tagEnd } = decodeVarint(decoded, pos);
                if ((tag & 7) !== 2) break; 
                
                const { value: entryLen, pos: entryStart } = decodeVarint(decoded, tagEnd);
                const entry = decoded.slice(entryStart, entryStart + entryLen);
                pos = entryStart + entryLen;

                let ep = 0, uid = null, infoB64 = null;
                while (ep < entry.length) {
                    const { value: t, pos: tnext } = decodeVarint(entry, ep);
                    const fn = Math.floor(t / 8); 
                    const wt = t & 7;

                    if (wt === 2) {
                        const { value: l, pos: ds } = decodeVarint(entry, tnext);
                        const content = entry.slice(ds, ds + l);
                        ep = ds + l;

                        if (fn === 1) uid = content.toString('utf8');
                        else if (fn === 2) {
                            let sp = 0;
                            while (sp < content.length) {
                                try {
                                    const { value: subt, pos: stnext } = decodeVarint(content, sp);
                                    const swt = subt & 7;
                                    const sfn = Math.floor(subt / 8);
                                    if (swt === 2) {
                                        const { value: slen, pos: sds } = decodeVarint(content, stnext);
                                        if (sfn === 1) { 
                                            infoB64 = content.slice(sds, sds + slen).toString('utf8');
                                            break;
                                        } else { sp = sds + slen; } 
                                    } 
                                    else if (swt === 0) { sp = decodeVarint(content, stnext).pos; } 
                                    else { sp = skipProtobufField(content, stnext, swt); } 
                                } catch (innerErr) { break; }
                            }
                        }
                    } else if (wt === 0) {
                        ep = decodeVarint(entry, tnext).pos;
                    } else {
                        ep = skipProtobufField(entry, tnext, wt); 
                    }
                }

                if (uid && infoB64) {
                    try {
                        const rawInner = Buffer.from(infoB64, 'base64');
                        innerBlobs[uid] = rawInner;
                        const title = extractTitleFromInnerBlob(rawInner);
                        
                        if (title && !title.startsWith('_headers:') && !title.includes('{"workspace') && !title.includes('[{"type"')) {
                            titles[uid] = title;
                        }
                    } catch (err2) { }
                }
            } catch(outer) { break; } 
        }
    } catch (e) {}
    
    return { titles, innerBlobs };
}

// ─── Title Resolution & String Extraction Protocol ───────────────────

function getTitleFromBrain(cid) {
    const brainPath = path.join(BRAIN_DIR, cid);
    if (!fs.existsSync(brainPath) || !fs.statSync(brainPath).isDirectory()) return null;
    try {
        const files = fs.readdirSync(brainPath)
            .filter(f => f.endsWith('.md') && !f.startsWith('.'))
            .map(f => ({ name: f, stat: fs.statSync(path.join(brainPath, f)) }))
            .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);

        for (const { name } of files) {
            try {
                const content = fs.readFileSync(path.join(brainPath, name), 'utf8');
                const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
                
                for (const line of lines) {
                    if (line.startsWith('```') || line.startsWith('<') || line.startsWith('>')) continue;
                    let text = line.replace(/^#+\s*/, '').replace(/[*_~`]/g, '').trim();
                    if (isGenericTitle(text)) continue;
                    
                    if (/[a-zA-Z]/.test(text) && text.length > 3) {
                        return text.length > 55 ? text.substring(0, 52) + '...' : text;
                    }
                }
            } catch (e) {}
        }
    } catch (e) {}
    return null;
}

function getTitleFromTranscript(cid) {
    const logPath = path.join(BRAIN_DIR, cid, '.system_generated', 'logs', 'overview.txt');
    if (!fs.existsSync(logPath)) return null;

    try {
        const fd = fs.openSync(logPath, 'r');
        const buffer = Buffer.alloc(65536);
        const bytesRead = fs.readSync(fd, buffer, 0, 65536, 0);
        fs.closeSync(fd);
        const content = buffer.toString('utf8', 0, bytesRead);

        let rawPrompt = null;
        const xmlMatch = content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
        if (xmlMatch && xmlMatch[1].trim().length > 0) {
            rawPrompt = xmlMatch[1];
        } else {
            const jsonMatch = content.match(/"role"\s*:\s*"user"[\s\S]*?"content"\s*:\s*"((?:[^"\\]|\\.)*)"/i);
            if (jsonMatch) {
                try { rawPrompt = JSON.parse(`"${jsonMatch[1]}"`); } 
                catch(e) { rawPrompt = jsonMatch[1]; }
            }
        }

        if (rawPrompt) {
            let text = rawPrompt.replace(/<[^>]+>/g, '').replace(/```[\s\S]*?```/g, '').replace(/\\[nrt]/g, ' ').replace(/\s+/g, ' ').trim();
            const fillers = [/^(can you )?(please )?(help me )?(write|create|build|fix|update|explain)\s+/i, /^(ok|so|now|and),?\s+/i];
            for (const reg of fillers) text = text.replace(reg, '');
            
            if (text.length > 3 && !/^(ok|yes|no|continue|next)$/i.test(text.trim()) && !isGenericTitle(text)) {
                text = text.charAt(0).toUpperCase() + text.slice(1);
                return text.length > 55 ? text.substring(0, 52) + '...' : text;
            }
        }
        
        const toolMatch = content.match(/(?:EditFile|ReadFile).*?([a-zA-Z0-9_\-\.\/\\]+\.[a-zA-Z0-9]+)/i);
        if (toolMatch) return `Working on ${toolMatch[1].split(/[\/\\]/).pop()}`;
        
    } catch (e) { }
    return null;
}

function inferTitleFromPbContent(cid) {
    const pbPath = path.join(CONVERSATIONS_DIR, `${cid}.pb`);
    if (!fs.existsSync(pbPath)) return null;
    try {
        const buf = fs.readFileSync(pbPath);
        const chars = buf.slice(0, Math.min(buf.length, 16384)).toString('utf8'); 
        
        const segments = chars.split(/[\x00-\x1F\x7F]+/).map(s => s.trim()).filter(s => s.length >= 8 && s.length <= 150);
        const excludeTokens = /system|user|assistant|workspace|context:|schema|guid:|VS_CODE/i;

        for (let chunk of segments) {
            if (excludeTokens.test(chunk)) continue;
            if (chunk.includes('{"') || chunk.includes('[{')) continue;
            if (isGenericTitle(chunk)) continue;

            const letterCount = (chunk.match(/[a-zA-Z]/g) || []).length;
            if (letterCount < 5) continue;

            const cleanStr = chunk.replace(/^[^a-zA-Z]+/, '').trim(); 
            if (isGenericTitle(cleanStr)) continue;
            
            if (cleanStr.length >= 8 && cleanStr.includes(' ')) {
                if (/^(ok|yes|no|fix|continue|next)\b/i.test(cleanStr)) continue;
                return cleanStr.length > 55 ? cleanStr.substring(0, 52) + '...' : cleanStr;
            }
        }
    } catch(e) {}
    return null; 
}

function resolveTitle(cid, existingTitles, wsPath) {
    if (existingTitles[cid] && !isGenericTitle(existingTitles[cid])) {
        return { title: existingTitles[cid], source: 'preserved' };
    }
    
    const brain = getTitleFromBrain(cid);
    if (brain && !isGenericTitle(brain)) return { title: brain, source: 'brain' };

    const transcript = getTitleFromTranscript(cid);
    if (transcript && !isGenericTitle(transcript)) return { title: transcript, source: 'transcript' };

    const heuristic = inferTitleFromPbContent(cid);
    if (heuristic && !isGenericTitle(heuristic)) return { title: heuristic, source: 'pb_inferred' };
    
    const pbPath = path.join(CONVERSATIONS_DIR, `${cid}.pb`);
    let dateStr = '';
    if (fs.existsSync(pbPath)) {
        dateStr = ` (${fs.statSync(pbPath).mtime.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`;
    }

    if (wsPath) {
        try {
            let clean = wsPath.replace(/\/$/, '').replace(/\\/g, '/');
            const parts = clean.split('/');
            const folderName = decodeURIComponent(parts[parts.length - 1]);
            if (folderName && folderName.length > 1 && !folderName.includes('%')) {
                return { title: `[${folderName}]${dateStr}`, source: 'contextual' };
            }
        } catch (e) {}
    }
    
    return { title: `Chat${dateStr} ${cid.substring(0, 6)}`, source: 'fallback' };
}

// ─── Workspace Inference ─────────────────────────────────────────────

function loadKnownWorkspaceUris() {
    const uris =[];
    if (!fs.existsSync(WORKSPACE_STORAGE_DIR)) return uris;
    try {
        for (const name of fs.readdirSync(WORKSPACE_STORAGE_DIR)) {
            const wsJson = path.join(WORKSPACE_STORAGE_DIR, name, 'workspace.json');
            if (fs.existsSync(wsJson)) {
                try {
                    const data = JSON.parse(fs.readFileSync(wsJson, 'utf8'));
                    const uri = data.folder || data.workspace;
                    if (uri) uris.push(uri);
                } catch (e) {}
            }
        }
    } catch (e) {}
    uris.sort((a, b) => b.length - a.length);
    return uris;
}

function inferWorkspaceFromBrain(cid, knownUris) {
    const brainPath = path.join(BRAIN_DIR, cid);
    if (!fs.existsSync(brainPath)) return null;

    const localPattern = isWin
        ? /file:\/\/\/([A-Za-z](?:%3A|:)\/[^)\s"'\]>]+)/g
        : /file:\/\/\/([^)\s"'\]>]+)/g;
    const remotePattern = /(vscode-remote:\/\/[^)\s"'\]>]+)/g;

    const foundUris =[];
    const foundRemote =[];
    try {
        for (const name of fs.readdirSync(brainPath)) {
            if (!name.endsWith('.md') || name.startsWith('.')) continue;
            try {
                const content = fs.readFileSync(path.join(brainPath, name), 'utf8').substring(0, 16384);
                let m;
                while ((m = remotePattern.exec(content)) !== null) foundRemote.push(m[1]);
                while ((m = localPattern.exec(content)) !== null) foundUris.push('file:///' + m[1]);
            } catch (e) {}
        }
    } catch (e) { return null; }

    if (!foundUris.length && !foundRemote.length) return null;

    if (knownUris && knownUris.length) {
        const counts = {};
        const normalize = s => s.replace(/%3A/gi, ':').replace(/%20/g, ' ');
        for (const uri of foundUris) {
            const norm = normalize(uri);
            for (const ws of knownUris) {
                const wsNorm = normalize(ws);
                if (norm.startsWith(wsNorm + '/') || norm === wsNorm) {
                    counts[ws] = (counts[ws] || 0) + 1;
                    break;
                }
            }
        }
        for (const uri of foundRemote) {
            for (const ws of knownUris) {
                if (uri.startsWith(ws + '/') || uri === ws) {
                    counts[ws] = (counts[ws] || 0) + 1;
                    break;
                }
            }
        }
        if (Object.keys(counts).length) {
            const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
            if (best.startsWith('file:///')) {
                let raw = decodeURIComponent(best.substring(7));
                if (isWin && raw.length >= 3 && raw[0] === '/' && raw[2] === ':') raw = raw.substring(1);
                return raw;
            }
            return best;
        }
    }
    return null;
}

// ─── Entry Builder ───────────────────────────────────────────────────

function buildTrajectoryEntry(cid, title, existingInnerData, workspacePath, pbMtime) {
    let innerInfo;
    if (existingInnerData) {
        const preserved = stripFieldFromProtobuf(existingInnerData, 1);
        innerInfo = Buffer.concat([encodeStringField(1, title), preserved]);
        if (workspacePath) {
            innerInfo = stripFieldFromProtobuf(innerInfo, 9);
            innerInfo = Buffer.concat([innerInfo, buildWorkspaceField(workspacePath)]);
        }
        if (pbMtime && !hasTimestampFields(existingInnerData)) {
            innerInfo = Buffer.concat([innerInfo, buildTimestampFields(pbMtime)]);
        }
    } else {
        innerInfo = encodeStringField(1, title);
        if (workspacePath) {
            innerInfo = Buffer.concat([innerInfo, buildWorkspaceField(workspacePath)]);
        }
        if (pbMtime) {
            innerInfo = Buffer.concat([innerInfo, buildTimestampFields(pbMtime)]);
        }
    }

    const infoB64 = innerInfo.toString('base64');
    const subMessage = encodeStringField(1, infoB64);
    let entry = encodeStringField(1, cid);
    entry = Buffer.concat([entry, encodeLengthDelimited(2, subMessage)]);
    return entry;
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
    const parentPid = parseInt(process.argv[2], 10);
    let relaunchInfo = { cdpPort: 9333, workspaceFolders: [] };
    try { relaunchInfo = JSON.parse(process.argv[3] || '{}'); } catch(e) { /* ignore */ }
    const mainPid = relaunchInfo.mainPid || parentPid;

    log(`[ConvFix] Started. ExtHost PID: ${parentPid}, Main PID: ${mainPid}`);
    log(`[ConvFix] DB: ${DB_PATH}`);

    // 1. Wait for Extension Host to fully exit
    log('[ConvFix] Waiting for Extension Host to exit...');
    while (true) {
        try {
            process.kill(parentPid, 0);
            await new Promise(r => setTimeout(r, 500));
        } catch (e) {
            break; // Process is dead
        }
    }

    // 2. Wait for WAL checkpoint (Safety Valve)
    const walPath = DB_PATH + '-wal';
    let retries = 15; 
    while (fs.existsSync(walPath) && retries-- > 0) {
        log(`[ConvFix] WAL file exists, waiting for checkpoint... (${retries} retries left)`);
        await new Promise(r => setTimeout(r, 500));
    }
    if (fs.existsSync(walPath)) {
        log('[ConvFix] FATAL: WAL file persists! Another AG window is likely open. Aborting to prevent database corruption.');
        relaunchAG(relaunchInfo);
        return;
    }
    log('[ConvFix] WAL checkpointed. Safe to proceed.');

    // 3. Validate paths
    if (!fs.existsSync(DB_PATH)) {
        log(`[ConvFix] ERROR: Database not found: ${DB_PATH}`);
        relaunchAG(relaunchInfo);
        return;
    }
    if (!fs.existsSync(CONVERSATIONS_DIR)) {
        log(`[ConvFix] ERROR: Conversations dir not found: ${CONVERSATIONS_DIR}`);
        relaunchAG(relaunchInfo);
        return;
    }

    // 4. Load sql.js
    log('[ConvFix] Loading sql.js...');
    let SQL;
    try {
        const extRoot = path.resolve(__dirname, '..', '..');
        const wasmPath = path.join(extRoot, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
        const initSqlJs = require(path.join(extRoot, 'node_modules', 'sql.js'));
        SQL = await initSqlJs({ locateFile: () => wasmPath });
    } catch (e) {
        log(`[ConvFix] ERROR loading sql.js: ${e.message}`);
        try {
            const initSqlJs = require('sql.js');
            SQL = await initSqlJs();
        } catch (e2) {
            log(`[ConvFix] FATAL: Cannot load sql.js: ${e2.message}`);
            relaunchAG(relaunchInfo);
            return;
        }
    }

    // 5. Open database
    log('[ConvFix] Opening state.vscdb...');
    const dbBuffer = fs.readFileSync(DB_PATH);
    const db = new SQL.Database(dbBuffer);

    // 6. Discover conversations
    const pbFiles = fs.readdirSync(CONVERSATIONS_DIR).filter(f => f.endsWith('.pb'));
    if (!pbFiles.length) {
        log('[ConvFix] No .pb files found. Nothing to fix.');
        db.close();
        relaunchAG(relaunchInfo);
        return;
    }

    pbFiles.sort((a, b) => {
        const mtimeA = fs.statSync(path.join(CONVERSATIONS_DIR, a)).mtimeMs;
        const mtimeB = fs.statSync(path.join(CONVERSATIONS_DIR, b)).mtimeMs;
        return mtimeB - mtimeA;
    });
    const conversationIds = pbFiles.map(f => f.replace('.pb', ''));
    log(`[ConvFix] Found ${conversationIds.length} conversations on disk.`);

    // 7. Extract existing metadata
    const { titles: existingTitles, innerBlobs } = extractExistingMetadata(db);
    log(`[ConvFix] Preserved ${Object.keys(existingTitles).length} existing titles.`);

    const knownWsUris = loadKnownWorkspaceUris();

    // 8. Resolve titles & infer workspaces
    const resolved = [];
    const stats = { preserved: 0, brain: 0, transcript: 0, pb_inferred: 0, contextual: 0, fallback: 0 };
    
    for (const cid of conversationIds) {
        const innerData = innerBlobs[cid] || null;
        let wsPath = extractWorkspaceHint(innerData);
        const hasWs = !!wsPath;
        if (!wsPath) wsPath = inferWorkspaceFromBrain(cid, knownWsUris);
        
        const { title, source } = resolveTitle(cid, existingTitles, wsPath);
        resolved.push({ cid, title, source, innerData, hasWs, wsPath });
        stats[source]++;
    }
    log(`[ConvFix] Titles — Preserved: ${stats.preserved}, Brain: ${stats.brain}, Logs: ${stats.transcript}, PB: ${stats.pb_inferred}, WS: ${stats.contextual}, Fallback: ${stats.fallback}`);

    // 9. Build new index
    let resultBytes = Buffer.alloc(0);
    let wsTotal = 0, tsInjected = 0;
    for (const { cid, title, innerData, hasWs, wsPath } of resolved) {
        const pbPath = path.join(CONVERSATIONS_DIR, `${cid}.pb`);
        const pbMtime = fs.existsSync(pbPath) ? fs.statSync(pbPath).mtimeMs / 1000 : null;
        const entry = buildTrajectoryEntry(cid, title, innerData, wsPath, pbMtime);
        resultBytes = Buffer.concat([resultBytes, encodeLengthDelimited(1, entry)]);
        if (hasWs || wsPath) wsTotal++;
        if (pbMtime && (!innerData || !hasTimestampFields(innerData))) tsInjected++;
    }
    log(`[ConvFix] Index built: ${resolved.length} entries, ${wsTotal} workspaces.`);

    // 10. Backup old value
    try {
        const rows = db.exec("SELECT value FROM ItemTable WHERE key='antigravityUnifiedStateSync.trajectorySummaries'");
        if (rows.length && rows[0].values.length && rows[0].values[0][0]) {
            const backupPath = path.join(path.dirname(DB_PATH), 'trajectorySummaries_backup.txt');
            fs.writeFileSync(backupPath, rows[0].values[0][0], 'utf8');
        }
    } catch (e) { log(`[ConvFix] Backup warning: ${e.message}`); }

    // 11. Write new index
    const encoded = resultBytes.toString('base64');
    try {
        const existing = db.exec("SELECT COUNT(*) FROM ItemTable WHERE key='antigravityUnifiedStateSync.trajectorySummaries'");
        const count = existing[0].values[0][0];
        if (count > 0) {
            db.run("UPDATE ItemTable SET value=? WHERE key='antigravityUnifiedStateSync.trajectorySummaries'", [encoded]);
        } else {
            db.run("INSERT INTO ItemTable (key, value) VALUES ('antigravityUnifiedStateSync.trajectorySummaries', ?)", [encoded]);
        }
    } catch (e) {
        log(`[ConvFix] ERROR writing index: ${e.message}`);
        db.close();
        relaunchAG(relaunchInfo);
        return;
    }

    // 12. Export and save database (🚨 ATOMIC SWAP)
    const newDbData = db.export();
    db.close();
    const tmpDbPath = DB_PATH + `.${Date.now()}.tmp`;
    try {
        fs.writeFileSync(tmpDbPath, Buffer.from(newDbData));
        fs.renameSync(tmpDbPath, DB_PATH); 
        log(`[ConvFix] SUCCESS: Rebuilt index with ${resolved.length} conversations.`);
    } catch (e) {
        log(`[ConvFix] FATAL ERROR writing to DB: ${e.message}`);
        try { fs.unlinkSync(tmpDbPath); } catch(err) {} 
    }

    // 13. Relaunch AG 
    relaunchAG(relaunchInfo);
}

async function relaunchAG(info) {
    if (_hasRelaunched) {
        log('[ConvFix] GUARD: relaunchAG already fired once — ignoring duplicate call.');
        return;
    }
    _hasRelaunched = true;
    log('[ConvFix] Initiating clean restart sequence...');

    // 1. 🚨 THE SINGLE-INSTANCE LOCK GUARD 🚨
    const mainPid = info.mainPid;
    if (mainPid) {
        log(`[ConvFix] Waiting for Main Process (PID ${mainPid}) to release lock...`);
        let waitCycles = 20; 
        while (waitCycles-- > 0) {
            try {
                process.kill(mainPid, 0);
                await new Promise(r => setTimeout(r, 500));
            } catch (e) {
                log('[ConvFix] Main Process confirmed dead. Lock released.');
                break;
            }
        }
    } else {
        log('[ConvFix] WARNING: mainPid missing! Using 4-second hard wait for lock release...');
        await new Promise(r => setTimeout(r, 4000));
    }
    
    // Add a small buffer to ensure OS named pipes/sockets are fully closed
    await new Promise(r => setTimeout(r, 1000));

    // 2. Clean Environment Variables
    const cleanEnv = { ...process.env };
    delete cleanEnv.ELECTRON_RUN_AS_NODE;
    delete cleanEnv.ELECTRON_NO_ATTACH_CONSOLE; 
    for (const key of Object.keys(cleanEnv)) {
        if (key.startsWith('VSCODE_') || key.startsWith('ELECTRON_') || key.startsWith('APPLICATION_INSIGHTS_')) {
            delete cleanEnv[key];
        }
    }

    const folders = (info && info.workspaceFolders) || [];
    let launchPort = (info && info.cdpPort) || 9333;
    let launcher = process.execPath;
    const isWin = process.platform === 'win32';

    if (isWin) {
        try {
            const lnkPath = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Antigravity', 'Antigravity.lnk');
            if (fs.existsSync(lnkPath)) {
                const lnkStr = fs.readFileSync(lnkPath).toString('utf16le');
                const portMatch = lnkStr.match(/--remote-debugging-port=(\d+)/);
                if (portMatch) {
                    launchPort = parseInt(portMatch[1], 10);
                    log(`[ConvFix] Read port ${launchPort} from shortcut`);
                }
            }
        } catch (e) {
            log(`[ConvFix] Could not read shortcut: ${e.message}`);
        }
    }

    const args = [`--remote-debugging-port=${launchPort}`];
    if (folders.length > 0) args.push(folders[0]);

    log(`[ConvFix] Spawning natively: "${launcher}" ${args.join(' ')}`);
    
    try {
        const cp = require('child_process');
        
        // ⭐ NATIVE SPAWN (No cmd.exe wrapper)
        const child = cp.spawn(launcher, args, {
            detached: true,
            stdio: 'ignore',
            env: cleanEnv,
            cwd: require('os').homedir() // CRITICAL FIX for detached GUI processes
        });
        child.unref();
        
        log('[ConvFix] ✓ Restart successful. Worker terminating.');
    } catch (e) {
        log(`[ConvFix] Relaunch error: ${e.message}`);
    }
    
    setTimeout(() => process.exit(0), 500);
}

main().catch(e => {
    log(`[ConvFix] FATAL: ${e.message}\n${e.stack}`);
    relaunchAG({});
});
