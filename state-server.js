// state-server.js — Persistent auto-save for arc-viz takes
// + Waterfall posting: platform-cascade posts (LI → FB → IG → YT)
//   direct API posting — no Postiz needed.
// Run: node state-server.js
// Endpoints:
//   POST /save           — arc-viz auto-saves state
//   GET  /latest         — most recent save
//   GET  /list           — all snapshots
//   GET  /ready          — posts marked ready with linkedinTake
//   GET  /sync-status    — which posts have been synced (legacy)
//   POST /upload-image   — drag-drop image upload
//   POST /post-platform  — post directly to LI/FB via direct-poster.js

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const poster = require('./direct-poster');
const sandbox = require('./sandbox-publisher');

const SAVE_DIR = path.join('C:', 'Users', 'steve', 'MeWorld', 'game', 'linkedin', 'state-autosave');
const LATEST_FILE = path.join(SAVE_DIR, 'latest.json');
const ARC_HTML = path.join('C:', 'Users', 'steve', 'MeWorld', 'game', 'linkedin', 'arc-viz.html');
const LINKEDIN_DIR = path.join('C:', 'Users', 'steve', 'MeWorld', 'game', 'linkedin');
const MAX_SNAPSHOTS = 50;

// ── Postiz config ──
const POSTIZ_API = 'http://localhost:3000';
const POSTIZ_INTEGRATION_ID = 'cmquj5fvl00011t1w3auhpuqb';
const POSTIZ_EMAIL = 'steven.oppong@gmail.com';
const POSTIZ_PASSWORD = 'inauthenticReadytoSchedule21?';

// Cached Postiz auth token + expiry
let postizToken = null;
let postizTokenTime = 0;
const TOKEN_TTL = 6 * 60 * 60 * 1000; // 6 hours — re-login if older

// Track in-flight syncs to avoid double-pushing
const syncingNow = new Set();

// Ensure save directory exists
if (!fs.existsSync(SAVE_DIR)) fs.mkdirSync(SAVE_DIR, { recursive: true });

// ── Helpers ──

function timestamp() {
  const d = new Date();
  return d.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function pruneSnapshots() {
  const files = fs.readdirSync(SAVE_DIR)
    .filter(f => f.startsWith('state-') && f.endsWith('.json'))
    .sort()
    .reverse();
  for (let i = MAX_SNAPSHOTS; i < files.length; i++) {
    try { fs.unlinkSync(path.join(SAVE_DIR, files[i])); } catch (e) { /* ok */ }
  }
}

// Parse arc-viz.html posts array → array of { date, act, spine, image, video, body }
function parseArcPosts() {
  try {
    const html = fs.readFileSync(ARC_HTML, 'utf-8');
    const blockMatch = html.match(/const posts = \[([\s\S]*?)\];/);
    if (!blockMatch) return [];
    
    const raw = blockMatch[1];
    // Match each post object — handles optional image/video/body fields
    const postRe = /\{\s*date:\s*"([^"]+)",\s*act:\s*"([^"]+)",\s*spineIdx:\s*\d+,\s*spine:\s*"[^"]+"(?:\s*,\s*(image|video):\s*"([^"]+)")?(?:\s*,\s*body:\s*"((?:[^"\\]|\\.)*)")?\s*\}/g;
    
    const posts = [];
    let m;
    while ((m = postRe.exec(raw)) !== null) {
      const bodyRaw = m[5];
      const body = bodyRaw
        ? bodyRaw.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\u2019/g, '\u2019').replace(/\\u2014/g, '\u2014').replace(/\\u2018/g, '\u2018').replace(/\\u201c/g, '\u201c').replace(/\\u201d/g, '\u201d')
        : '';
      posts.push({
        date: m[1],
        act: m[2],
        mediaType: m[3] || null,  // 'image' or 'video'
        mediaFile: m[4] || null,
        body: body
      });
    }
    return posts;
  } catch (e) {
    console.error('parseArcPosts error:', e.message);
    return [];
  }
}

// Convert "Thu Jul 2" → "2026-07-02T11:00:00.000Z"  (7 AM ET = 11:00 UTC)
function parseArcDate(dateStr) {
  const months = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
                   Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
  const parts = dateStr.split(' ');
  if (parts.length < 3) return null;
  const month = months[parts[1]];
  const day = String(parseInt(parts[2])).padStart(2, '0');
  if (!month || !day) return null;
  const year = (month >= '07') ? '2026' : '2026';
  return `${year}-${month}-${day}T11:00:00.000Z`;
}

// ── Postiz API ──

function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(options.url || POSTIZ_API + options.path);
    const mod = url.protocol === 'https:' ? https : http;
    const reqOpts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: {
        ...(options.headers || {}),
        'Content-Type': options.contentType || 'application/json'
      }
    };
    
    const req = mod.request(reqOpts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const result = {
          status: res.statusCode,
          headers: res.headers,
          body: data
        };
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(result);
        } else {
          reject(Object.assign(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`), result));
        }
      });
    });
    
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function postizLogin() {
  const now = Date.now();
  if (postizToken && (now - postizTokenTime) < TOKEN_TTL) return postizToken;
  
  console.log('[Postiz] Logging in...');
  const body = JSON.stringify({
    email: POSTIZ_EMAIL,
    password: POSTIZ_PASSWORD,
    provider: 'LOCAL'
  });
  
  const res = await httpRequest({
    path: '/auth/login',
    method: 'POST'
  }, body);
  
  // Extract auth cookie
  const setCookie = res.headers['set-cookie'];
  if (setCookie) {
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const c of cookies) {
      const m = c.match(/auth=([^;]+)/);
      if (m) {
        postizToken = m[1];
        postizTokenTime = now;
        console.log('[Postiz] Auth OK');
        return postizToken;
      }
    }
  }
  throw new Error('No auth cookie in login response');
}

async function postizUploadMedia(filePath) {
  const token = await postizLogin();
  const fname = path.basename(filePath);
  const fileData = fs.readFileSync(filePath);
  
  // Build multipart form data manually
  const boundary = '----ArcVizSync' + Date.now();
  let body = '';
  body += '--' + boundary + '\r\n';
  body += 'Content-Disposition: form-data; name="file"; filename="' + fname + '"\r\n';
  body += 'Content-Type: ' + (fname.endsWith('.mp4') ? 'video/mp4' : 'image/png') + '\r\n';
  body += '\r\n';
  // Multipart needs both string (boundaries) and binary (file data) — use Buffer
  const head = Buffer.from(body, 'utf-8');
  const foot = Buffer.from('\r\n--' + boundary + '--\r\n', 'utf-8');
  const fullBody = Buffer.concat([head, fileData, foot]);
  
  const url = new URL(POSTIZ_API + '/media/upload-simple');
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': fullBody.length,
        'auth': token
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed);
          } catch (e) {
            reject(new Error('Upload response not JSON: ' + data.substring(0, 100)));
          }
        } else {
          reject(new Error(`Upload failed ${res.statusCode}: ${data.substring(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(fullBody);
    req.end();
  });
}

async function postizCreatePost(dateIso, bodyText, mediaArray) {
  const token = await postizLogin();
  
  const value = { content: bodyText };
  if (mediaArray && mediaArray.length > 0) {
    value.image = mediaArray;
  }
  
  const payload = {
    type: 'schedule',
    shortLink: false,
    date: dateIso,
    tags: [],
    posts: [{
      integration: { id: POSTIZ_INTEGRATION_ID },
      value: [value],
      settings: { '__type': 'linkedin' }
    }]
  };
  
  const res = await httpRequest({
    path: '/posts',
    method: 'POST',
    headers: { 'auth': token }
  }, JSON.stringify(payload));
  
  let result;
  try { result = JSON.parse(res.body); } catch (e) { result = { raw: res.body }; }
  return result;
}

// ── Sync bridge: detect newly-ready posts and push to Postiz ──

async function syncToPostiz(state) {
  const posts = parseArcPosts();
  const statuses = state.statuses || {};
  const linkedinReadyTakeIdx = state.linkedinReadyTakeIdx || {};
  const synced = state._syncedToPostiz || {};
  
  const toSync = [];
  
  for (const [idxStr, status] of Object.entries(statuses)) {
    const idx = parseInt(idxStr);
    if (status !== 'ready') continue;
    if (synced[idxStr]) continue;          // already pushed
    if (syncingNow.has(idxStr)) continue;  // in flight
    
    const takeVal = linkedinReadyTakeIdx[idxStr];
    // linkedinReadyTakeIdx format: undefined=not set, null=original body, number=index into speechTakes
    if (takeVal === undefined) continue;  // no LI take selected
    if (!state.speechTakes && takeVal !== null) continue;  // no takes data
    
    const post = posts[idx];
    if (!post) {
      console.log(`[Sync] Post ${idx} not found in arc-viz — skipping`);
      continue;
    }
    
    const isoDate = parseArcDate(post.date);
    if (!isoDate) {
      console.log(`[Sync] Post ${idx} bad date "${post.date}" — skipping`);
      continue;
    }
    
    // Determine the body text based on linkedinReadyTakeIdx selection
    let bodyText = post.body;  // default: original body
    if (takeVal === null) {
      bodyText = post.body;  // explicit: original
    } else if (typeof takeVal === 'number') {
      const takes = state.speechTakes[idxStr];
      if (takes && takeVal < takes.length) {
        const selectedTake = takes[takeVal];
        bodyText = selectedTake.transcript || post.body;
        console.log(`[Sync]   Post ${idx}: using take #${takeVal} (${selectedTake.type || 'raw'})`);
      } else {
        console.log(`[Sync]   Post ${idx}: LI index ${takeVal} out of range (${takes ? takes.length : 0} takes) — falling back to original`);
      }
    }
    
    toSync.push({ idx: idxStr, post, isoDate, bodyText });
  }
  
  if (toSync.length === 0) return;
  
  console.log(`[Sync] ${toSync.length} new ready+LI post(s) to push...`);
  
  for (const item of toSync) {
    syncingNow.add(item.idx);
    
    try {
      // Ensure token is fresh
      await postizLogin();
      
      // Upload media if present
      let mediaArray = [];
      if (item.post.mediaFile) {
        const mediaPath = path.join(LINKEDIN_DIR, item.post.mediaFile);
        if (fs.existsSync(mediaPath)) {
          console.log(`[Sync]   Uploading media: ${item.post.mediaFile} (${item.post.mediaType})`);
          const uploadResult = await postizUploadMedia(mediaPath);
          const apiPath = (uploadResult.path || '').replace('/uploads/', '/api/uploads/');
          mediaArray = [{ id: uploadResult.id, path: apiPath }];
          console.log(`[Sync]   Media uploaded: ${uploadResult.id}`);
        } else {
          console.log(`[Sync]   Media file not found: ${mediaPath} — posting text-only`);
        }
      }
      
      // Create the post
      console.log(`[Sync]   Creating post ${item.idx} for ${item.isoDate}: "${item.post.act}"`);
      const result = await postizCreatePost(item.isoDate, item.bodyText, mediaArray);
      console.log(`[Sync]   Post ${item.idx} created: ${JSON.stringify(result).substring(0, 200)}`);
      
      // Mark as synced
      synced[item.idx] = {
        at: new Date().toISOString(),
        postizId: Array.isArray(result) ? result[0]?.i || result[0] : result.i || 'ok',
        date: item.isoDate,
        hasMedia: mediaArray.length > 0
      };

      // Also schedule directly via LinkedIn's native API (machine-off safety net)
      try {
        console.log(`[Sync]   Scheduling directly via LinkedIn for ${item.isoDate}...`);
        const liResult = await poster.post({
          text: item.bodyText,
          dateIso: item.isoDate,
          platforms: ['linkedin']
        });
        console.log(`[Sync]   LinkedIn schedule: ${JSON.stringify(liResult)}`);
      } catch (liErr) {
        console.error(`[Sync]   LinkedIn direct schedule failed (Postiz is the fallback): ${liErr.message}`);
      }
      
    } catch (e) {
      console.error(`[Sync]   FAILED post ${item.idx}: ${e.message}`);
      // Don't mark as synced — will retry next save
    } finally {
      syncingNow.delete(item.idx);
    }
  }
  
  // Update the synced tracker
  state._syncedToPostiz = synced;
  
  // Re-save with synced info
  const json = JSON.stringify(state, null, 2);
  fs.writeFileSync(LATEST_FILE, json, 'utf-8');
}

// ── HTTP Server ──

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── /save ──
  if (req.method === 'POST' && req.url === '/save') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const state = JSON.parse(body);
        const ts = timestamp();
        const snapshotFile = path.join(SAVE_DIR, `state-${ts}.json`);

        // Add metadata
        state._saved = new Date().toISOString();
        state._takesCount = Object.values(state.speechTakes || {}).reduce((c, arr) => c + (arr ? arr.length : 0), 0);
        state._postsWithTakes = Object.keys(state.speechTakes || {}).filter(k => state.speechTakes[k] && state.speechTakes[k].length > 0).length;

        // Carry forward synced info from existing latest
        try {
          if (fs.existsSync(LATEST_FILE)) {
            const prev = JSON.parse(fs.readFileSync(LATEST_FILE, 'utf-8'));
            if (prev._syncedToPostiz) state._syncedToPostiz = prev._syncedToPostiz;
          }
        } catch (e) { /* ok */ }

        const json = JSON.stringify(state, null, 2);

        // Write snapshot
        fs.writeFileSync(snapshotFile, json, 'utf-8');
        // Update latest
        fs.writeFileSync(LATEST_FILE, json, 'utf-8');
        // Prune old
        pruneSnapshots();

        console.log(`[${ts}] SAVED — ${state._takesCount} takes across ${state._postsWithTakes} posts → ${snapshotFile}`);
        
        // Respond immediately, then sync in background
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, file: path.basename(snapshotFile), takes: state._takesCount }));

        // Postiz sync disabled — GitHub Actions is the sole publisher now
        // syncToPostiz(state).catch(e => console.error('[Sync] Background sync error:', e.message));
        
      } catch (e) {
        console.error('Save error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── /latest ──
  if (req.method === 'GET' && req.url === '/latest') {
    try {
      if (fs.existsSync(LATEST_FILE)) {
        const json = fs.readFileSync(LATEST_FILE, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(json);
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ ok: false, error: 'no saved state' }));
      }
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── /list ──
  if (req.method === 'GET' && req.url === '/list') {
    try {
      const files = fs.readdirSync(SAVE_DIR)
        .filter(f => f.startsWith('state-') && f.endsWith('.json'))
        .sort()
        .reverse();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ files }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── /ready — returns posts marked "ready" with their spines ──
  if (req.method === 'GET' && req.url === '/ready') {
    try {
      if (!fs.existsSync(LATEST_FILE)) {
        res.writeHead(404);
        res.end(JSON.stringify({ ok: false, error: 'no saved state yet' }));
        return;
      }
      const state = JSON.parse(fs.readFileSync(LATEST_FILE, 'utf-8'));
      const s = state.statuses || {};
      const synced = state._syncedToPostiz || {};
      const posts = parseArcPosts();
      const readyIndices = Object.entries(s).filter(([_, v]) => v === 'ready').map(([k]) => parseInt(k));
      const ready = readyIndices.map(i => ({
        index: i,
        spine: posts[i] ? posts[i].act : `Post ${i}`,
        status: 'ready',
        linkedinTake: (state.linkedinTake || {})[String(i)] || null,
        syncedToPostiz: !!synced[String(i)]
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ready, total: ready.length, _saved: state._saved }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── /sync-status — which posts have been pushed to Postiz ──
  if (req.method === 'GET' && req.url === '/sync-status') {
    try {
      if (!fs.existsSync(LATEST_FILE)) {
        res.writeHead(404);
        res.end(JSON.stringify({ ok: false, error: 'no saved state yet' }));
        return;
      }
      const state = JSON.parse(fs.readFileSync(LATEST_FILE, 'utf-8'));
      const synced = state._syncedToPostiz || {};
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, synced, count: Object.keys(synced).length }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── /update-posts — write reordered posts back to arc-viz.html ──
  if (req.method === 'POST' && req.url === '/update-posts') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const postsJson = JSON.stringify(body.posts, null, 2);
        const html = fs.readFileSync(ARC_HTML, 'utf-8');
        // Replace const posts = [...] with new array
        const newHtml = html.replace(/const posts = \[[\s\S]*?\];/, `const posts = ${postsJson};`);
        if (newHtml !== html) {
          fs.writeFileSync(ARC_HTML, newHtml, 'utf-8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, count: body.posts.length }));
          console.log(`[Posts] Updated ${ARC_HTML} with ${body.posts.length} reordered posts`);
        } else {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: 'could not find posts array in HTML' }));
        }
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── /sandbox/mode — GET current mode ──
  if (req.method === 'GET' && req.url === '/sandbox/mode') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ mode: sandbox.getMode() }));
    return;
  }

  // ── /sandbox/mode — POST toggle mode ──
  if (req.method === 'POST' && req.url === '/sandbox/mode') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { mode } = JSON.parse(body);
        const newMode = sandbox.setMode(mode);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, mode: newMode }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── /sandbox/posts — GET all sandboxed posts ──
  if (req.method === 'GET' && req.url === '/sandbox/posts') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sandbox.listSandboxedPosts()));
    return;
  }

  // ── /sandbox/preview — serve the preview HTML page ──
  if (req.method === 'GET' && req.url === '/sandbox/preview') {
    const previewPath = path.join(__dirname, 'sandbox-preview.html');
    if (fs.existsSync(previewPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(previewPath, 'utf-8'));
    } else {
      res.writeHead(404);
      res.end('preview page not found');
    }
    return;
  }

  // ── /sync-now — DISABLED (GitHub Actions is the publisher) ──
  if (req.method === 'POST' && req.url === '/sync-now') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'sync disabled — GitHub Actions handles publishing' }));
    return;
  }

  // ── /upload-image ──
  if (req.method === 'POST' && req.url === '/upload-image') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks);
        const contentType = req.headers['content-type'] || '';
        const boundaryMatch = contentType.match(/boundary=(.+)/);
        if (!boundaryMatch) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: 'no boundary' }));
          return;
        }
        const boundary = boundaryMatch[1];
        const parts = raw.toString('binary').split('--' + boundary);

        let filename = '';
        let filedata = null;

        for (const part of parts) {
          if (part.includes('Content-Disposition')) {
            const fnMatch = part.match(/filename="([^"]+)"/);
            if (fnMatch) {
              filename = fnMatch[1];
              const headerEnd = part.indexOf('\r\n\r\n');
              if (headerEnd !== -1) {
                const dataStart = headerEnd + 4;
                let dataEnd = part.length;
                if (part.endsWith('\r\n')) dataEnd -= 2;
                filedata = Buffer.from(part.substring(dataStart, dataEnd), 'binary');
              }
            }
          }
        }

        if (!filedata) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: 'no file data' }));
          return;
        }

        const droppedDir = path.join(LINKEDIN_DIR, 'dropped');
        if (!fs.existsSync(droppedDir)) fs.mkdirSync(droppedDir, { recursive: true });

        const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
        const outPath = path.join(droppedDir, safeName);
        fs.writeFileSync(outPath, filedata);

        console.log(`[UPLOAD] ${safeName} -> ${outPath}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: 'dropped/' + safeName, name: safeName }));
      } catch (e) {
        console.error('Upload error:', e.message);
        res.writeHead(500);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── /post-platform — post directly to LI/FB via direct-poster.js ──
  // GUARDED: checks posted-dates.json before allowing the post through
  if (req.method === 'POST' && req.url === '/post-platform') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const { index, platform, text, image, video, dateIso } = data;
        
        console.log(`[Post] /post-platform called: platform=${platform} index=${index}`);
        
        // ── Pre-flight guard: check posted-dates.json ──
        if (platform === 'linkedin') {
          try {
            const already = await poster.checkAlreadyPosted('auto'); // actual date check
            if (already) {
              console.log('[Post] BLOCKED by guard — already posted today');
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, skipped: true, reason: 'already posted today (check posted-dates.json)' }));
              return;
            }
          } catch (guardErr) {
            console.log(`[Post] Guard check failed: ${guardErr.message} — proceeding anyway`);
          }
        }
        
        // Resolve media paths relative to the linkedin directory
        const LINKEDIN_DIR = path.join('C:', 'Users', 'steve', 'MeWorld', 'game', 'linkedin');
        let imagePath = null;
        let videoPath = null;
        
        if (image && typeof image === 'string') {
          const fullPath = path.join(LINKEDIN_DIR, image);
          if (fs.existsSync(fullPath)) imagePath = fullPath;
        }
        if (video && typeof video === 'string') {
          const fullPath = path.join(LINKEDIN_DIR, video);
          if (fs.existsSync(fullPath)) videoPath = fullPath;
        }
        
        if (!text) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'no text provided' }));
          return;
        }
        
        let result;
        if (platform === 'linkedin') {
          // ── Sandbox gate ──
          if (!sandbox.isLive()) {
            console.log('[Post] SANDBOX MODE — saving locally');
            result = await sandbox.publishToSandbox(text, {
              platform: 'linkedin',
              source: `arc-viz:/post-platform (post ${index})`
            });
          } else {
            result = await poster.postToLinkedIn(text, null);
          }
        } else if (platform === 'facebook') {
          result = await poster.postToFacebook(text, imagePath, videoPath);
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `unsupported platform: ${platform}` }));
          return;
        }
        
        console.log(`[Post] Result: ${JSON.stringify(result)}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: result.ok, platform, result }));
        
      } catch (e) {
        console.error('[Post] Error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

const PORT = 9801;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`State server listening on http://127.0.0.1:${PORT}`);
  console.log(`Saves to: ${SAVE_DIR}`);
  console.log(`LI token: ${poster.status().linkedin.tokenValid ? 'valid' : 'MISSING — run get-linkedin-token.js'}`);
  console.log(`Sandbox mode: ${sandbox.getMode().toUpperCase()} — preview at http://127.0.0.1:${PORT}/sandbox/preview`);

  // ── Daily backup poster: 7:15 AM ET (11:15 UTC), Mon-Fri ──
  // Runs 15 min after GitHub Actions. Guarded by posted-dates.json.
  // Posts go through sandbox gate — only hits LinkedIn in "live" mode.
  const backup = require('./post-backup.js');
  
  function scheduleNextBackup() {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 11, 15, 0));
    
    // If today's 11:15 UTC already passed, schedule for tomorrow
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    
    // Skip weekends — Mon=1, Fri=5
    const day = next.getUTCDay();
    if (day === 0) next.setUTCDate(next.getUTCDate() + 1); // Sun → Mon
    if (day === 6) next.setUTCDate(next.getUTCDate() + 2); // Sat → Mon
    
    const delayMs = next.getTime() - now.getTime();
    console.log(`[Backup] Next check: ${next.toISOString()} (in ${Math.round(delayMs/60000)} min)`);
    
    setTimeout(async () => {
      try {
        await backup.runBackup();
      } catch (e) {
        console.error('[Backup] Error:', e.message);
      }
      scheduleNextBackup(); // Schedule tomorrow's
    }, delayMs);
  }
  
  scheduleNextBackup();

  // Postiz sync disabled — GitHub Actions is the primary, state-server backup at 7:15 AM
  // try {
  //   if (fs.existsSync(LATEST_FILE)) {
  //     const state = JSON.parse(fs.readFileSync(LATEST_FILE, 'utf-8'));
  //     setTimeout(() => {
  //       syncToPostiz(state).then(() => {
  //         console.log('[Sync] Startup sync complete');
  //       }).catch(e => {
  //         console.error('[Sync] Startup sync error:', e.message);
  //       });
  //     }, 2000);
  //   }
  // } catch (e) { /* ok */ }
});
