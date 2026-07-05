// direct-poster.js — Posts directly to LinkedIn + Facebook (no Postiz needed)
// Usage: const poster = require('./direct-poster'); await poster.post(postData);
const https = require('https');
const fs = require('fs');
const path = require('path');

// ── LinkedIn config ──
function loadLinkedInCreds() {
  const envPath = path.join(__dirname, '.linkedin-token.env');
  if (!fs.existsSync(envPath)) return null;
  const raw = fs.readFileSync(envPath, 'utf-8');
  const result = {};
  for (const line of raw.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) result[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return result;
}

// ── Facebook config ──
const FB_CONFIG = {
  appId: '2581729785617345',
  appSecret: '88c0e01dfc74ca4a1af166b0c77c1482',
  userAccessToken: 'EAAglG32P1GwBR2ED8uMjiQqWoyTERi9WTZCR6cEJnCMb23yGeLQgTgUHvg2lTpEr4e3kyZBBfEFzhaEORY5TV2kMow8ffP8rKc6JONaFQqtxzCgqknNwq6UqgyXljY8IaaZAAA3ZBD5OMFXfbV50l6AJjpDAPObUJeiHlrNTpzAAQeKCpgLKAUxyQY55sLAR9msLmZBQARGBSwoegMjjaLoHCh7ZCH6mG2RgttdOsEDEIOZB2qXllwnVpbwM5Www2FkdcytF84XdmNJNPwMFPbZBFG0ZD',
  pageId: '1197427480118604', // Immersa
  apiVersion: 'v22.0'
};

let fbPageToken = null;
let liToken = null;
let liPersonUrn = null;

// ── HTTP helpers ──

function httpsPost(hostname, p, headers, body) {
  return new Promise((resolve, reject) => {
    const opts = { hostname, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } };
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

function httpsGet(hostname, p, headers) {
  return new Promise((resolve, reject) => {
    https.get({ hostname, path: p, headers }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    }).on('error', reject);
  });
}

// ── Facebook: exchange user token for page token ──

async function fbGetPageToken() {
  if (fbPageToken) return fbPageToken;
  
  // Exchange short-lived user token for long-lived
  console.log('[FB] Exchanging user token for long-lived...');
  const llRes = await httpsGet('graph.facebook.com',
    `/${FB_CONFIG.apiVersion}/oauth/access_token?grant_type=fb_exchange_token&client_id=${FB_CONFIG.appId}&client_secret=${FB_CONFIG.appSecret}&fb_exchange_token=${FB_CONFIG.userAccessToken}`
  );
  
  if (llRes.status !== 200) throw new Error(`FB long-lived token failed: ${JSON.stringify(llRes.body)}`);
  const llToken = llRes.body.access_token;
  console.log('[FB] Long-lived token obtained');
  
  // Get page access token
  console.log(`[FB] Getting page token for page ${FB_CONFIG.pageId}...`);
  const pagesRes = await httpsGet('graph.facebook.com',
    `/${FB_CONFIG.apiVersion}/me/accounts?access_token=${llToken}`
  );
  
  if (pagesRes.status !== 200) throw new Error(`FB pages failed: ${JSON.stringify(pagesRes.body)}`);
  
  const page = (pagesRes.body.data || []).find(p => p.id === FB_CONFIG.pageId);
  if (!page) throw new Error(`Page ${FB_CONFIG.pageId} not found in /me/accounts`);
  
  fbPageToken = page.access_token;
  console.log(`[FB] Page token obtained for: ${page.name}`);
  return fbPageToken;
}

// ── LinkedIn: initialize ──

function liInit() {
  const creds = loadLinkedInCreds();
  if (!creds) return { ready: false, reason: 'No .linkedin-token.env file. Run get-linkedin-token.js first.' };
  
  if (parseInt(creds.LINKEDIN_TOKEN_EXPIRES_AT || '0') < Date.now()) {
    return { ready: false, reason: 'LinkedIn token expired. Re-run get-linkedin-token.js.' };
  }
  
  liToken = creds.LINKEDIN_ACCESS_TOKEN;
  liPersonUrn = creds.LINKEDIN_PERSON_URN;
  return { ready: true };
}

// ── Standard LinkedIn hashtags appended to every post ──
const LI_HASHTAGS = '\n\n#MedEd #ClinicalSimulation #MedicalEducation #AIinMedicine #Immersa #FutureOfMedicine';

// ── POST TO LINKEDIN ──

async function postToLinkedIn(text, imageUrl) {
  text += LI_HASHTAGS;
  if (!liToken || !liPersonUrn) {
    const init = liInit();
    if (!init.ready) return { platform: 'linkedin', ok: false, error: init.reason };
  }
  
  // LinkedIn Posts API: POST /v2/posts
  const body = {
    author: liPersonUrn,
    commentary: text,
    visibility: 'PUBLIC',
    distribution: {
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: []
    },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false
  };
  
  // If image URL is provided, attach via content
  if (imageUrl) {
    body.content = {
      media: {
        title: { text: '' },
        id: imageUrl  // This needs to be an uploaded image URN — complex
      }
    };
    // For simplicity with images, we'd need to use the assets API first
    // For now, text-only posts work great
  }
  
  console.log('[LI] Posting to LinkedIn...');
  const res = await httpsPost('api.linkedin.com', '/v2/posts',
    { Authorization: `Bearer ${liToken}`, 'LinkedIn-Version': '202505' },
    JSON.stringify(body)
  );
  
  if (res.status >= 200 && res.status < 300) {
    console.log(`[LI] Posted! Post URN: ${res.body.id || 'ok'}`);
    return { platform: 'linkedin', ok: true, id: res.body.id };
  } else {
    console.error(`[LI] Failed: ${res.status} ${JSON.stringify(res.body)}`);
    return { platform: 'linkedin', ok: false, error: res.body };
  }
}

// ── POST TO FACEBOOK ──

async function postToFacebook(text, imagePath, videoPath) {
  try {
    const token = await fbGetPageToken();
    const pageId = FB_CONFIG.pageId;
    
    if (videoPath) {
      // Post video with description
      console.log('[FB] Posting video...');
      const res = await httpsPost('graph.facebook.com',
        `/${FB_CONFIG.apiVersion}/${pageId}/videos`,
        { Authorization: `Bearer ${token}` },
        JSON.stringify({
          file_url: videoPath,
          description: text,
          published: true
        })
      );
      if (res.status >= 200 && res.status < 300) {
        console.log(`[FB] Video posted! ID: ${res.body.id}`);
        return { platform: 'facebook', ok: true, id: res.body.id, type: 'video' };
      }
      console.error(`[FB] Video failed: ${JSON.stringify(res.body)}`);
      return { platform: 'facebook', ok: false, error: res.body };
    }
    
    if (imagePath) {
      // Post photo with message
      console.log('[FB] Posting photo...');
      const res = await httpsPost('graph.facebook.com',
        `/${FB_CONFIG.apiVersion}/${pageId}/photos`,
        { Authorization: `Bearer ${token}` },
        JSON.stringify({
          url: imagePath,
          message: text,
          published: true
        })
      );
      if (res.status >= 200 && res.status < 300) {
        console.log(`[FB] Photo posted! ID: ${res.body.id}`);
        return { platform: 'facebook', ok: true, id: res.body.id, type: 'photo' };
      }
      console.error(`[FB] Photo failed: ${JSON.stringify(res.body)}`);
      return { platform: 'facebook', ok: false, error: res.body };
    }
    
    // Text-only post
    console.log('[FB] Posting text...');
    const res = await httpsPost('graph.facebook.com',
      `/${FB_CONFIG.apiVersion}/${pageId}/feed`,
      { Authorization: `Bearer ${token}` },
      JSON.stringify({ message: text, published: true })
    );
    
    if (res.status >= 200 && res.status < 300) {
      console.log(`[FB] Text posted! ID: ${res.body.id}`);
      return { platform: 'facebook', ok: true, id: res.body.id, type: 'text' };
    }
    console.error(`[FB] Text failed: ${JSON.stringify(res.body)}`);
    return { platform: 'facebook', ok: false, error: res.body };
    
  } catch (e) {
    console.error('[FB] Exception:', e.message);
    return { platform: 'facebook', ok: false, error: e.message };
  }
}

// ── Schedule a Facebook post for a future time ──

async function scheduleToFacebook(text, imagePath, videoPath, scheduledTimeUnix) {
  try {
    const token = await fbGetPageToken();
    const pageId = FB_CONFIG.pageId;
    
    if (videoPath) {
      // Schedule video
      const res = await httpsPost('graph.facebook.com',
        `/${FB_CONFIG.apiVersion}/${pageId}/videos`,
        { Authorization: `Bearer ${token}` },
        JSON.stringify({
          file_url: videoPath,
          description: text,
          published: false,
          scheduled_publish_time: scheduledTimeUnix
        })
      );
      return { platform: 'facebook', ok: res.status < 300, id: res.body.id, scheduled: true };
    }
    
    if (imagePath) {
      const res = await httpsPost('graph.facebook.com',
        `/${FB_CONFIG.apiVersion}/${pageId}/photos`,
        { Authorization: `Bearer ${token}` },
        JSON.stringify({
          url: imagePath,
          message: text,
          published: false,
          scheduled_publish_time: scheduledTimeUnix
        })
      );
      return { platform: 'facebook', ok: res.status < 300, id: res.body.id, scheduled: true };
    }
    
    const res = await httpsPost('graph.facebook.com',
      `/${FB_CONFIG.apiVersion}/${pageId}/feed`,
      { Authorization: `Bearer ${token}` },
      JSON.stringify({
        message: text,
        published: false,
        scheduled_publish_time: scheduledTimeUnix
      })
    );
    return { platform: 'facebook', ok: res.status < 300, id: res.body.id, scheduled: true };
    
  } catch (e) {
    return { platform: 'facebook', ok: false, error: e.message };
  }
}

// ── Schedule a LinkedIn post for a future time ──
// LinkedIn uses lifecycleState: 'SCHEDULED' + scheduledPublishTime (epoch ms)

async function scheduleToLinkedIn(text, imageUrl, scheduledTimeIso) {
  text += LI_HASHTAGS;
  if (!liToken || !liPersonUrn) {
    const init = liInit();
    if (!init.ready) return { platform: 'linkedin', ok: false, error: init.reason };
  }
  
  const scheduledMs = new Date(scheduledTimeIso).getTime();
  const nowMs = Date.now();
  
  // LinkedIn requires at least 5 min in the future
  if (scheduledMs < nowMs + 300000) {
    console.log('[LI] Scheduled time too close — publishing now instead');
    return postToLinkedIn(text, imageUrl);
  }
  
  const body = {
    author: liPersonUrn,
    commentary: text,
    visibility: 'PUBLIC',
    distribution: {
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: []
    },
    lifecycleState: 'SCHEDULED',
    scheduledPublishTime: scheduledMs,
    isReshareDisabledByAuthor: false
  };
  
  console.log(`[LI] Scheduling for ${scheduledTimeIso} (${scheduledMs})...`);
  const res = await httpsPost('api.linkedin.com', '/v2/posts',
    { Authorization: `Bearer ${liToken}`, 'LinkedIn-Version': '202505' },
    JSON.stringify(body)
  );
  
  if (res.status >= 200 && res.status < 300) {
    console.log(`[LI] Scheduled! Post URN: ${res.body.id || 'ok'}, for ${new Date(scheduledMs).toLocaleString()}`);
    return { platform: 'linkedin', ok: true, id: res.body.id, scheduled: true, scheduledTime: scheduledTimeIso };
  } else {
    console.error(`[LI] Schedule failed: ${res.status} ${JSON.stringify(res.body)}`);
    return { platform: 'linkedin', ok: false, error: res.body };
  }
}

// ── Main post function called by state-server ──

async function post(postData) {
  // postData: { text, imagePath, videoPath, dateIso, postNow?, platforms: ['linkedin', 'facebook'] }
  const results = [];
  
  const platforms = postData.platforms || ['linkedin', 'facebook'];
  const imageUrl = postData.imagePath ? 
    `http://localhost:4200/api/uploads/${path.basename(postData.imagePath)}` : null;
  
  for (const platform of platforms) {
    if (platform === 'linkedin') {
      if (postData.postNow || !postData.dateIso || new Date(postData.dateIso) <= new Date()) {
        // Post now
        results.push(await postToLinkedIn(postData.text, imageUrl));
      } else {
        // Schedule for later via LinkedIn's native scheduler — fires even if machine is off
        results.push(await scheduleToLinkedIn(postData.text, imageUrl, postData.dateIso));
      }
    }
    if (platform === 'facebook') {
      if (postData.postNow || !postData.dateIso || new Date(postData.dateIso) <= new Date()) {
        // Post now
        results.push(await postToFacebook(postData.text, postData.imagePath, postData.videoPath));
      } else {
        // Schedule for later
        const unix = Math.floor(new Date(postData.dateIso).getTime() / 1000);
        results.push(await scheduleToFacebook(postData.text, postData.imagePath, postData.videoPath, unix));
      }
    }
  }
  
  return results;
}

// ── Quick status check ──

function status() {
  const li = loadLinkedInCreds();
  return {
    linkedin: {
      configured: !!li,
      tokenValid: li && parseInt(li.LINKEDIN_TOKEN_EXPIRES_AT || '0') > Date.now(),
      personUrn: li?.LINKEDIN_PERSON_URN || null
    },
    facebook: {
      configured: true,
      pageId: FB_CONFIG.pageId,
      pageName: 'Immersa'
    }
  };
}

module.exports = { post, postToLinkedIn, scheduleToLinkedIn, postToFacebook, scheduleToFacebook, status, fbGetPageToken, liInit };
