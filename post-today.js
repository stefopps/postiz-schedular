// post-today.js — GitHub Actions: find today's post in arc-viz.html and post to LinkedIn
// Runs daily at 7 AM ET (11:00 UTC), Mon-Fri
const https = require('https');
const fs = require('fs');
const path = require('path');

// ── Config ──
const ARC_VIZ = process.env.ARC_VIZ_PATH || path.join(__dirname, 'arc-viz.html');
const LI_TOKEN = process.env.LINKEDIN_ACCESS_TOKEN;
const LI_URN = process.env.LINKEDIN_PERSON_URN;
const LI_HASHTAGS = '\n\n#MedEd #ClinicalSimulation #MedicalEducation #AIinMedicine #Immersa #FutureOfMedicine';

// ── Parse arc-viz.html to get posts array ──
function parsePosts() {
  const html = fs.readFileSync(ARC_VIZ, 'utf-8');
  const match = html.match(/const posts = \[([\s\S]*?)\];/);
  if (!match) throw new Error('Could not find posts array in arc-viz.html');
  
  // Evaluate the posts array (trusted source)
  const posts = eval('[' + match[1] + ']');
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

// ── Main ──
async function main() {
  if (!LI_TOKEN) throw new Error('LINKEDIN_ACCESS_TOKEN not set');
  if (!LI_URN) throw new Error('LINKEDIN_PERSON_URN not set');

  const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  const now = new Date();
  const todayStr = `${DAYS[now.getUTCDay()]} ${MONTHS[now.getUTCMonth()]} ${now.getUTCDate()}`;
  // Note: posts are in EDT (UTC-4), so for 7 AM ET (11 UTC), 
  // the day-of-week in UTC might differ from EDT on early AM runs.
  // We use the post's stored date string which is in EDT.
  // For safety, also try EDT date:
  const edtNow = new Date(now.getTime() - 4 * 3600000); // EDT is UTC-4
  const edtTodayStr = `${DAYS[edtNow.getUTCDay()]} ${MONTHS[edtNow.getUTCMonth()]} ${edtNow.getUTCDate()}`;

  console.log(`[PostToday] UTC now: ${now.toISOString()}`);
  console.log(`[PostToday] EDT date: ${edtTodayStr}`);
  console.log(`[PostToday] UTC date: ${todayStr}`);

  const posts = parsePosts();
  console.log(`[PostToday] Loaded ${posts.length} posts`);

  // Find today's post
  let todayPost = posts.find(p => p.date === edtTodayStr);
  if (!todayPost) todayPost = posts.find(p => p.date === todayStr);
  
  if (!todayPost) {
    console.log(`[PostToday] No post found for ${edtTodayStr} or ${todayStr} — nothing to post`);
    console.log('[PostToday] Available dates:');
    posts.forEach(p => console.log(`  ${p.date}: ${p.act}`));
    process.exit(0);
  }

  console.log(`[PostToday] Found: ${todayPost.date} — "${todayPost.act}"`);
  console.log(`[PostToday] Body length: ${todayPost.body.length} chars`);

  const result = await postToLinkedIn(todayPost.body);
  console.log('[PostToday] Result:', JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}

main().catch(e => { console.error('[PostToday] Error:', e.message); process.exit(1); });
