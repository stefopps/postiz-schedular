// post-today.js — GitHub Actions: find today's post in arc-viz.html and post to LinkedIn
// Runs daily at 7 AM ET (11:00 UTC), Mon-Fri. Idempotent via posted-dates.json.
const https = require('https');
const fs = require('fs');
const path = require('path');

// ── Config ──
const ARC_VIZ = process.env.ARC_VIZ_PATH || path.join(__dirname, 'arc-viz.html');
const LI_TOKEN = process.env.LINKEDIN_ACCESS_TOKEN;
const LI_URN = process.env.LINKEDIN_PERSON_URN;
const POSTED_DATES_FILE = path.join(__dirname, 'posted-dates.json');
const LI_HASHTAGS = '\n\n#MedEd #ClinicalSimulation #MedicalEducation #AIinMedicine #Immersa #FutureOfMedicine';

// ── Parse arc-viz.html to get posts array ──
function parsePosts() {
  const html = fs.readFileSync(ARC_VIZ, 'utf-8');
  const startMarker = 'const posts = [';
  const startIdx = html.indexOf(startMarker);
  if (startIdx === -1) throw new Error('Could not find "const posts = [" in arc-viz.html');
  
  // Find matching "]" by balancing brackets (respecting strings)
  let depth = 0, inString = false, inTemplate = false, escapeNext = false, endIdx = -1;
  for (let i = startIdx + startMarker.length; i < html.length; i++) {
    const ch = html[i];
    if (escapeNext) { escapeNext = false; continue; }
    if (ch === '\\') { escapeNext = true; continue; }
    if (!inTemplate && ch === '"') { inString = !inString; continue; }
    if (!inString && ch === '`') { inTemplate = !inTemplate; continue; }
    if (inString || inTemplate) continue;
    if (ch === '[') { depth++; continue; }
    if (ch === ']') {
      if (depth === 0) { endIdx = i; break; }
      depth--;
    }
  }
  if (endIdx === -1) throw new Error('Could not find matching ] for posts array');
  
  let postsCode = html.substring(startIdx + startMarker.length, endIdx);
  
  // Fix literal newlines in quoted strings — convert to \n
  // Strategy: walk through and replace newlines ONLY inside quoted strings
  let fixed = '';
  let inStr = false, inTpl = false, esc = false;
  for (let i = 0; i < postsCode.length; i++) {
    const ch = postsCode[i];
    if (esc) { fixed += ch; esc = false; continue; }
    if (ch === '\\') { fixed += ch; esc = true; continue; }
    if (!inTpl && ch === '"') { inStr = !inStr; fixed += ch; continue; }
    if (!inStr && ch === '`') { inTpl = !inTpl; fixed += ch; continue; }
    if ((inStr || inTpl) && (ch === '\n' || ch === '\r')) {
      // Replace literal newline with \n or skip \r
      if (ch === '\n') fixed += '\\n';
      continue;
    }
    fixed += ch;
  }
  
  const posts = new Function('return [' + fixed + ']')();
  return posts;
}

// ── LinkedIn post ──
function httpsPost(hostname, pathname, headers, body) {
  return new Promise((resolve, reject) => {
    const opts = { hostname, path: pathname, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } };
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function postToLinkedIn(text) {
  text += LI_HASHTAGS;
  const body = JSON.stringify({
    author: LI_URN,
    commentary: text,
    visibility: 'PUBLIC',
    distribution: {
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: []
    },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false
  });

  console.log('[LI] Posting to LinkedIn...');
  const res = await httpsPost('api.linkedin.com', '/v2/posts',
    { Authorization: `Bearer ${LI_TOKEN}`, 'LinkedIn-Version': '202505' },
    body
  );

  if (res.status >= 200 && res.status < 300) {
    console.log(`[LI] Success! Post ID: ${res.body.id || 'ok'}`);
    return { ok: true, id: res.body.id };
  } else {
    console.error(`[LI] Failed: ${res.status} ${JSON.stringify(res.body)}`);
    return { ok: false, error: res.body };
  }
}

// ── Idempotency: check posted-dates.json ──
function alreadyPosted(edtDateStr) {
  try {
    if (!fs.existsSync(POSTED_DATES_FILE)) return false;
    const posted = JSON.parse(fs.readFileSync(POSTED_DATES_FILE, 'utf-8'));
    return Array.isArray(posted) && posted.includes(edtDateStr);
  } catch (e) {
    return false;
  }
}

function markPosted(edtDateStr) {
  let posted = [];
  try {
    if (fs.existsSync(POSTED_DATES_FILE)) {
      posted = JSON.parse(fs.readFileSync(POSTED_DATES_FILE, 'utf-8'));
    }
  } catch (e) { /* start fresh */ }
  if (!Array.isArray(posted)) posted = [];
  if (!posted.includes(edtDateStr)) {
    posted.push(edtDateStr);
    fs.writeFileSync(POSTED_DATES_FILE, JSON.stringify(posted, null, 2) + '\n', 'utf-8');
  }
}

// ── Main ──
async function main() {
  if (!LI_TOKEN) throw new Error('LINKEDIN_ACCESS_TOKEN not set');
  if (!LI_URN) throw new Error('LINKEDIN_PERSON_URN not set');

  const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  const now = new Date();
  const edtNow = new Date(now.getTime() - 4 * 3600000);
  const edtTodayStr = `${DAYS[edtNow.getUTCDay()]} ${MONTHS[edtNow.getUTCMonth()]} ${edtNow.getUTCDate()}`;

  console.log(`[PostToday] EDT date: ${edtTodayStr}`);

  // ── Idempotency check ──
  if (alreadyPosted(edtTodayStr)) {
    console.log(`[PostToday] ${edtTodayStr} already posted — skipping`);
    process.exit(0);
  }

  const posts = parsePosts();
  console.log(`[PostToday] Loaded ${posts.length} posts`);

  let todayPost = posts.find(p => p.date === edtTodayStr);
  // Fallback: also try UTC-based date string
  if (!todayPost) {
    const utcTodayStr = `${DAYS[now.getUTCDay()]} ${MONTHS[now.getUTCMonth()]} ${now.getUTCDate()}`;
    todayPost = posts.find(p => p.date === utcTodayStr);
  }
  
  if (!todayPost) {
    console.log(`[PostToday] No post found for ${edtTodayStr} — nothing to post`);
    posts.forEach(p => console.log(`  ${p.date}: ${p.act}`));
    process.exit(0);
  }

  console.log(`[PostToday] Found: ${todayPost.date} — "${todayPost.act}"`);
  console.log(`[PostToday] Body length: ${todayPost.body.length} chars`);

  const result = await postToLinkedIn(todayPost.body);
  
  if (result.ok) {
    markPosted(edtTodayStr);
    console.log(`[PostToday] Marked ${edtTodayStr} as posted`);
  }
  
  console.log('[PostToday] Result:', JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}

main().catch(e => { console.error('[PostToday] Error:', e.message); process.exit(1); });
