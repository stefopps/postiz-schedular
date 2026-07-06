// linkedin-guard.js — Pre-flight check: has this text already been posted to LinkedIn?
// Usage: const guard = require('./linkedin-guard'); await guard.alreadyPosted(text, token, urn);
const https = require('https');

const LI_API = 'api.linkedin.com';

/**
 * Query LinkedIn for recent posts by author and check if opening text matches.
 * @param {string} text - The full body text to check
 * @param {string} accessToken - LinkedIn OAuth access token
 * @param {string} personUrn - e.g. "urn:li:person:m6uKU3VB9D"
 * @param {number} [lookback=10] - How many recent posts to check
 * @returns {Promise<{found: boolean, matchId?: string, matchedAt?: string}>}
 */
async function alreadyPosted(text, accessToken, personUrn, lookback = 10) {
  const fingerprint = text.substring(0, 100).replace(/\s+/g, ' ').trim().toLowerCase();
  
  const encodedUrn = encodeURIComponent(personUrn);
  const path = `/rest/posts?author=${encodedUrn}&q=author&count=${lookback}&sortBy=CREATED&viewContext=AUTHOR`;

  console.log(`[Guard] Checking recent LinkedIn posts for fingerprint: "${fingerprint.substring(0, 60)}..."`);

  const response = await httpsGet(LI_API, path, {
    'Authorization': `Bearer ${accessToken}`,
    'LinkedIn-Version': '202505'
  });

  if (response.status !== 200) {
    console.error(`[Guard] LinkedIn query failed: ${response.status} ${JSON.stringify(response.body).substring(0, 200)}`);
    // If we can't check, assume NOT posted (don't block on API error)
    return { found: false, error: `HTTP ${response.status}` };
  }

  const posts = response.body.elements || [];
  console.log(`[Guard] Found ${posts.length} recent posts`);

  for (const post of posts) {
    const commentary = (post.commentary || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const postFingerprint = commentary.substring(0, 100);
    
    // Check: does the opening of this post match our text?
    if (postFingerprint === fingerprint || commentary.includes(fingerprint)) {
      const created = post.createdAt ? new Date(post.createdAt).toLocaleString() : 'unknown';
      console.log(`[Guard] MATCH FOUND — post ${post.id} created ${created}`);
      console.log(`[Guard] Opening: "${commentary.substring(0, 80)}..."`);
      return { found: true, matchId: post.id, matchedAt: post.createdAt };
    }
  }

  console.log('[Guard] No match — safe to post');
  return { found: false };
}

function httpsGet(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    https.get({ hostname, path, headers }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    }).on('error', reject);
  });
}

module.exports = { alreadyPosted };
