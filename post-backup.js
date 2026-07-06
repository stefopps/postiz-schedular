// post-backup.js — Postiz fallback: runs at 7:15 AM ET (11:15 UTC), checks posted-dates.json first
// Loaded by state-server on spawn and via cron-like timer
const https = require('https');
const fs = require('fs');
const path = require('path');

const LI_TOKEN = process.env.LINKEDIN_ACCESS_TOKEN;
const LI_URN = process.env.LINKEDIN_PERSON_URN;
const POSTED_DATES_RAW = 'https://raw.githubusercontent.com/stefopps/postiz-schedular/master/posted-dates.json';
const LI_HASHTAGS = '\n\n#MedEd #ClinicalSimulation #MedicalEducation #AIinMedicine #Immersa #FutureOfMedicine';
const ARC_VIZ = 'C:/Users/steve/MeWorld/game/linkedin/arc-viz.html';
const LOCAL_POSTED = path.join(__dirname, 'posted-dates.json');

// ── Check posted-dates.json from GitHub ──
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'post-backup/1.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    }).on('error', reject);
  });
}

async function checkAlreadyPosted(edtDateStr) {
  // Check local copy first (faster, no network)
  try {
    if (fs.existsSync(LOCAL_POSTED)) {
      const local = JSON.parse(fs.readFileSync(LOCAL_POSTED, 'utf-8'));
      if (Array.isArray(local) && local.includes(edtDateStr)) {
        console.log(`[Backup] ${edtDateStr} in local posted-dates.json — SKIPPING`);
        return true;
      }
    }
  } catch (e) { /* ok */ }

  // Check GitHub as source of truth
  try {
    console.log(`[Backup] Fetching posted-dates.json from GitHub...`);
    const res = await httpsGet(POSTED_DATES_RAW);
    if (res.status === 200 && Array.isArray(res.body) && res.body.includes(edtDateStr)) {
      console.log(`[Backup] ${edtDateStr} already posted by GitHub Actions — SKIPPING`);
      return true;
    }
  } catch (e) {
    console.log(`[Backup] GitHub check failed: ${e.message} — proceeding (guard is permissive)`);
  }

  console.log(`[Backup] ${edtDateStr} not yet posted — POSTING NOW`);
  return false;
}

// ── Parse arc-viz.html ──
function parsePosts() {
  const html = fs.readFileSync(ARC_VIZ, 'utf-8');
  const startMarker = 'const posts = [';
  const startIdx = html.indexOf(startMarker);
  if (startIdx === -1) throw new Error('posts array not found');

  let depth = 0, inStr = false, inTpl = false, esc = false, endIdx = -1;
  for (let i = startIdx + startMarker.length; i < html.length; i++) {
    const ch = html[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (!inTpl && ch === '"') { inStr = !inStr; continue; }
    if (!inStr && ch === '`') { inTpl = !inTpl; continue; }
    if (inStr || inTpl) continue;
    if (ch === '[') { depth++; continue; }
    if (ch === ']') { if (depth === 0) { endIdx = i; break; } depth--; }
  }
  if (endIdx === -1) throw new Error('matching ] not found');

  let code = html.substring(startIdx + startMarker.length, endIdx);
  // Fix literal newlines in strings
  let fixed = '', iStr = false, iTpl = false, e = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (e) { fixed += ch; e = false; continue; }
    if (ch === '\\') { fixed += ch; e = true; continue; }
    if (!iTpl && ch === '"') { iStr = !iStr; fixed += ch; continue; }
    if (!iStr && ch === '`') { iTpl = !iTpl; fixed += ch; continue; }
    if ((iStr || iTpl) && (ch === '\n' || ch === '\r')) {
      if (ch === '\n') fixed += '\\n';
      continue;
    }
    fixed += ch;
  }
  return new Function('return [' + fixed + ']')();
}

// ── Post to LinkedIn ──
function httpsPost(hostname, pathname, headers, body) {
  return new Promise((resolve, reject) => {
    const opts = { hostname, path: pathname, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } };
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ ok: false, status: res.statusCode, body: data }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    if (body) req.write(body);
    req.end();
  });
}

async function postToLinkedIn(text) {
  const MAX_LENGTH = 3000;
  if (text.length > MAX_LENGTH) {
    console.log(`[Backup] Text too long (${text.length}) — truncating to ${MAX_LENGTH}`);
    text = text.substring(0, MAX_LENGTH - 3) + '...';
  }
  text += LI_HASHTAGS;

  const body = JSON.stringify({
    author: LI_URN,
    commentary: text,
    visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false
  });

  console.log(`[Backup] Posting (${text.length} chars)...`);
  return await httpsPost('api.linkedin.com', '/v2/posts',
    { Authorization: `Bearer ${LI_TOKEN}`, 'LinkedIn-Version': '202505' }, body);
}

// ── Main ──
async function runBackup() {
  if (!LI_TOKEN || !LI_URN) {
    // Try loading from .env
    try {
      const envPath = path.join(__dirname, '.linkedin-token.env');
      if (fs.existsSync(envPath)) {
        const raw = fs.readFileSync(envPath, 'utf-8');
        const tokenMatch = raw.match(/LINKEDIN_ACCESS_TOKEN=(.+)/);
        const urnMatch = raw.match(/LINKEDIN_PERSON_URN=(.+)/);
        if (tokenMatch) process.env.LINKEDIN_ACCESS_TOKEN = tokenMatch[1].trim();
        if (urnMatch) process.env.LINKEDIN_PERSON_URN = urnMatch[1].trim();
      }
    } catch (e) {
      console.error('[Backup] Cannot load token:', e.message);
      return;
    }
  }
  // Re-read after env load
  const token = process.env.LINKEDIN_ACCESS_TOKEN || LI_TOKEN;
  const urn = process.env.LINKEDIN_PERSON_URN || LI_URN;

  const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const now = new Date();
  const edtNow = new Date(now.getTime() - 4 * 3600000);
  const edtTodayStr = `${DAYS[edtNow.getUTCDay()]} ${MONTHS[edtNow.getUTCMonth()]} ${edtNow.getUTCDate()}`;

  console.log(`\n=== Postiz Backup Check: ${new Date().toISOString()} ===`);
  console.log(`[Backup] EDT today: ${edtTodayStr}`);

  // Step 1: Check if already posted
  const already = await checkAlreadyPosted(edtTodayStr);
  if (already) {
    console.log('[Backup] Post already live — exiting');
    return { skipped: true, reason: `${edtTodayStr} already posted` };
  }

  // Step 2: Find today's post
  const posts = parsePosts();
  let todayPost = posts.find(p => p.date === edtTodayStr);
  if (!todayPost) {
    const utcTodayStr = `${DAYS[now.getUTCDay()]} ${MONTHS[now.getUTCMonth()]} ${now.getUTCDate()}`;
    todayPost = posts.find(p => p.date === utcTodayStr);
  }

  if (!todayPost) {
    console.log(`[Backup] No post for ${edtTodayStr} — nothing to post`);
    return { skipped: true, reason: 'no post for today' };
  }

  console.log(`[Backup] Found: ${todayPost.date} — "${todayPost.act}"`);

  // Step 3: Post through sandbox gate
  let result;
  try {
    const sandboxLib = require('./sandbox-publisher');
    if (!sandboxLib.isLive()) {
      console.log(`[Backup] SANDBOX MODE — saving locally, not posting to LinkedIn`);
      result = await sandboxLib.publishToSandbox(todayPost.body, {
        act: todayPost.act,
        date: todayPost.date,
        source: 'state-server-backup-7:15am'
      });
    } else {
      console.log(`[Backup] LIVE MODE — posting to LinkedIn`);
      result = await postToLinkedIn(todayPost.body);
    }
  } catch (e) {
    console.error(`[Backup] Error: ${e.message}`);
    result = { ok: false, error: e.message };
  }

  if (result.ok) {
    console.log(`[Backup] SUCCESS — posted "${todayPost.act}"`);

    // Mark locally so we don't re-fire on restart
    try {
      let posted = [];
      if (fs.existsSync(LOCAL_POSTED)) {
        posted = JSON.parse(fs.readFileSync(LOCAL_POSTED, 'utf-8'));
      }
      if (!Array.isArray(posted)) posted = [];
      if (!posted.includes(edtTodayStr)) {
        posted.push(edtTodayStr);
        fs.writeFileSync(LOCAL_POSTED, JSON.stringify(posted, null, 2) + '\n', 'utf-8');
        console.log(`[Backup] Marked ${edtTodayStr} in local posted-dates.json`);
      }
    } catch (e) {
      console.log(`[Backup] Could not update local posted-dates: ${e.message}`);
    }
  } else {
    console.error(`[Backup] FAILED: ${JSON.stringify(result.body || result)}`);
  }

  return result;
}

// Export for state-server
module.exports = { runBackup, checkAlreadyPosted };

// Run directly if called as script
if (require.main === module) {
  runBackup().then(r => {
    console.log('[Backup] Done:', JSON.stringify(r));
    process.exit((r && r.ok) ? 0 : 0); // never fail — backup is best-effort
  }).catch(e => {
    console.error('[Backup] Error:', e.message);
    process.exit(0);
  });
}
