// sandbox-publisher.js — In sandbox mode, stores posts locally instead of posting to LinkedIn
// When mode is toggled to "live", posts go to LinkedIn via direct-poster.js
const fs = require('fs');
const path = require('path');

const SANDBOX_DIR = path.join(__dirname, 'sandbox');
const MODE_FILE = path.join(__dirname, 'sandbox-mode.json');

// ── Mode management ──

function getMode() {
  try {
    if (fs.existsSync(MODE_FILE)) {
      const data = JSON.parse(fs.readFileSync(MODE_FILE, 'utf-8'));
      return data.mode || 'sandbox';
    }
  } catch (e) { /* fall through */ }
  // Default: sandbox mode. Never accidentally post to live LinkedIn.
  return 'sandbox';
}

function setMode(mode) {
  if (!['sandbox', 'live'].includes(mode)) {
    throw new Error(`Invalid mode: ${mode}. Must be "sandbox" or "live".`);
  }
  fs.writeFileSync(MODE_FILE, JSON.stringify({ mode, updated: new Date().toISOString() }, null, 2), 'utf-8');
  console.log(`[Sandbox] Mode set to: ${mode}`);
  return mode;
}

function isLive() {
  return getMode() === 'live';
}

// ── Sandbox publisher ──

async function publishToSandbox(text, metadata = {}) {
  // Ensure sandbox dir exists
  if (!fs.existsSync(SANDBOX_DIR)) {
    fs.mkdirSync(SANDBOX_DIR, { recursive: true });
  }

  const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const now = metadata.date ? new Date(metadata.date) : new Date();
  const edt = new Date(now.getTime() - 4 * 3600000);
  const dateStr = `${DAYS[edt.getUTCDay()]}-${MONTHS[edt.getUTCMonth()]}-${edt.getUTCDate()}`;
  
  const slug = (metadata.act || metadata.title || 'post')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 40);
  
  const filename = `${dateStr}--${slug}.json`;
  const filepath = path.join(SANDBOX_DIR, filename);

  const entry = {
    posted: new Date().toISOString(),
    mode: 'sandbox',
    platform: metadata.platform || 'linkedin',
    text: text,
    textLength: text.length,
    act: metadata.act || null,
    date: metadata.date || null,
    source: metadata.source || 'unknown',
    preview: text.substring(0, 150).replace(/\n/g, ' ')
  };

  fs.writeFileSync(filepath, JSON.stringify(entry, null, 2), 'utf-8');
  console.log(`[Sandbox] Saved: ${filename} (${text.length} chars)`);
  console.log(`[Sandbox] Preview: "${entry.preview}..."`);

  return { ok: true, sandboxed: true, file: filename, path: filepath };
}

// ── List sandboxed posts ──

function listSandboxedPosts() {
  if (!fs.existsSync(SANDBOX_DIR)) return [];
  
  return fs.readdirSync(SANDBOX_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(SANDBOX_DIR, f), 'utf-8'));
        return { file: f, ...data };
      } catch (e) {
        return { file: f, error: e.message };
      }
    })
    .sort((a, b) => new Date(b.posted) - new Date(a.posted));
}

// ── Clear sandbox ──

function clearSandbox() {
  if (!fs.existsSync(SANDBOX_DIR)) return 0;
  const files = fs.readdirSync(SANDBOX_DIR).filter(f => f.endsWith('.json'));
  files.forEach(f => fs.unlinkSync(path.join(SANDBOX_DIR, f)));
  console.log(`[Sandbox] Cleared ${files.length} posts`);
  return files.length;
}

// ── Smart publish: respects mode ──

async function smartPublish(text, metadata, livePublisher) {
  const mode = getMode();
  
  if (mode === 'sandbox') {
    console.log(`[SmartPublish] SANDWALL — saving to sandbox, not posting to LinkedIn`);
    return publishToSandbox(text, metadata);
  }
  
  // Live mode — call the actual publisher
  console.log(`[SmartPublish] LIVE — posting to LinkedIn`);
  if (!livePublisher) {
    return { ok: false, error: 'No live publisher provided' };
  }
  return livePublisher(text);
}

module.exports = { getMode, setMode, isLive, publishToSandbox, listSandboxedPosts, clearSandbox, smartPublish };
