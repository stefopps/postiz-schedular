// state-server.js — Persistent auto-save for arc-viz takes
// Saves full state (takes metadata + positions + settings) to disk on every change.
// Run: node state-server.js
// Endpoint: POST http://localhost:9801/save

const http = require('http');
const fs = require('fs');
const path = require('path');

const SAVE_DIR = path.join('C:', 'Users', 'steve', 'MeWorld', 'game', 'linkedin', 'state-autosave');
const LATEST_FILE = path.join(SAVE_DIR, 'latest.json');
const MAX_SNAPSHOTS = 50;

// Ensure save directory exists
if (!fs.existsSync(SAVE_DIR)) fs.mkdirSync(SAVE_DIR, { recursive: true });

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
    try { fs.unlinkSync(path.join(SAVE_DIR, files[i])); } catch(e) {}
  }
}

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

  if (req.method === 'POST' && req.url === '/save') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const state = JSON.parse(body);
        const ts = timestamp();
        const snapshotFile = path.join(SAVE_DIR, `state-${ts}.json`);

        // Add metadata
        state._saved = new Date().toISOString();
        state._takesCount = Object.values(state.speechTakes || {}).reduce((c, arr) => c + (arr ? arr.length : 0), 0);
        state._postsWithTakes = Object.keys(state.speechTakes || {}).filter(k => state.speechTakes[k] && state.speechTakes[k].length > 0).length;

        const json = JSON.stringify(state, null, 2);

        // Write snapshot
        fs.writeFileSync(snapshotFile, json, 'utf-8');
        // Update latest
        fs.writeFileSync(LATEST_FILE, json, 'utf-8');
        // Prune old
        pruneSnapshots();

        console.log(`[${ts}] SAVED — ${state._takesCount} takes across ${state._postsWithTakes} posts → ${snapshotFile}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, file: path.basename(snapshotFile), takes: state._takesCount }));
      } catch(e) {
        console.error('Save error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

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
    } catch(e) {
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (req.method === 'GET' && req.url === '/list') {
    try {
      const files = fs.readdirSync(SAVE_DIR)
        .filter(f => f.startsWith('state-') && f.endsWith('.json'))
        .sort()
        .reverse();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ files }));
    } catch(e) {
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // ── /ready — returns only posts marked "ready" with their spines ──
  if (req.method === 'GET' && req.url === '/ready') {
    try {
      if (!fs.existsSync(LATEST_FILE)) {
        res.writeHead(404);
        res.end(JSON.stringify({ ok: false, error: 'no saved state yet' }));
        return;
      }
      const state = JSON.parse(fs.readFileSync(LATEST_FILE, 'utf-8'));
      const s = state.statuses || {};
      const readyIndices = Object.entries(s).filter(([_,v]) => v === 'ready').map(([k]) => parseInt(k));
      // Gather spine info from the arc-viz HTML
      const SPINES = [];
      try {
        const html = fs.readFileSync(path.join('C:', 'Users', 'steve', 'MeWorld', 'game', 'linkedin', 'arc-viz.html'), 'utf-8');
        const re = /spine\s*:\s*"([^"]+)"/g;
        let m;
        while ((m = re.exec(html)) !== null) SPINES.push(m[1].replace(/\s+/g, ' '));
      } catch(e) {}
      const ready = readyIndices.map(i => ({
        index: i,
        spine: SPINES[i] || `Post ${i}`,
        status: 'ready'
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ready, total: ready.length, _saved: state._saved || state._at }));
    } catch(e) {
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

const PORT = 9801;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`State server listening on http://127.0.0.1:${PORT}`);
  console.log(`Saves to: ${SAVE_DIR}`);
});
