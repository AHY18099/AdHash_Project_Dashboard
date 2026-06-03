/**
 * Fix script:
 *  1. Dedup AutoChecker wfdocs (10 → 3 unique)
 *  2. Restore SparkMe staging URL
 *  3. Push fixed data to GitHub via Contents API
 *  4. Also save locally
 */
const https = require('https');
const fs = require('fs');
const token = process.env.GITHUB_TOKEN || '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';

function ghRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'Authorization': 'token ' + token,
        'User-Agent': 'AdHash-Dashboard',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

// Step 1: Fetch live data
const cookie = 'adhash_auth=' + encodeURIComponent(Buffer.from('thenilavan@adhashtech.com:Qateam@123').toString('base64url'));
const req = https.get('https://adhashprojectdashboard-production.up.railway.app/api/qa-data', {
  headers: { 'Cookie': cookie }
}, res => {
  let body = '';
  res.on('data', d => body += d);
  res.on('end', async () => {
    const data = JSON.parse(body);
    let changed = false;

    // ── Fix 1: Deduplicate AutoChecker wfdocs ──
    const ac = data['qa3_autochecker'];
    if (ac && ac.wfdocs) {
      const before = ac.wfdocs.length;
      // Keep unique entries: prefer entries with serverId, then ghUrl
      // Dedup by name — keep first entry with serverId or ghUrl, fallback to first occurrence
      const seen = new Map();
      for (const doc of ac.wfdocs) {
        const key = doc.name;
        if (!seen.has(key)) {
          seen.set(key, doc);
        } else {
          const existing = seen.get(key);
          // Prefer entry with serverId
          if (!existing.serverId && doc.serverId) seen.set(key, doc);
          // Among serverIds, prefer one with ghUrl
          else if (existing.serverId && !existing.ghUrl && doc.ghUrl) seen.set(key, doc);
        }
      }
      const deduped = Array.from(seen.values());
      console.log(`AutoChecker wfdocs: ${before} → ${deduped.length}`);
      deduped.forEach((d,i) => console.log(`  ${i}. ${d.name} | serverId=${d.serverId||'NONE'} | ghUrl=${d.ghUrl||'NONE'}`));
      data['qa3_autochecker'].wfdocs = deduped;
      changed = true;
    }

    // ── Fix 2: Restore SparkMe staging URL ──
    if (!data['qa3_sparkme']) data['qa3_sparkme'] = {};
    if (!data['qa3_sparkme'].envDetails) data['qa3_sparkme'].envDetails = { production: [], staging: [] };
    const staging = data['qa3_sparkme'].envDetails.staging || [];
    const hasAdmin = staging.some(e => e.name === 'Admin' || (e.url && e.url.includes('sparkanalyticsdev')));
    if (!hasAdmin) {
      staging.push({
        name: 'Admin',
        url: 'https://sparkanalyticsdev.synctag.com/',
        domain: 'STAGING',
        sslExpiry: '',
        domainExpiry: ''
      });
      data['qa3_sparkme'].envDetails.staging = staging;
      console.log('SparkMe staging URL restored: https://sparkanalyticsdev.synctag.com/');
      changed = true;
    } else {
      console.log('SparkMe staging URL already present — no change');
    }

    if (!changed) { console.log('No changes needed'); return; }

    // ── Step 2: Push to GitHub ──
    console.log('\nPushing to GitHub...');
    try {
      // Get current SHA
      const meta = await ghRequest('GET', '/repos/AHY18099/AdHash_Project_Dashboard/contents/data/qa-shared.json', null);
      if (meta.status !== 200) { console.error('Cannot get SHA:', meta.status, meta.body && meta.body.message); return; }
      const sha = meta.body.sha;
      const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
      const result = await ghRequest('PUT', '/repos/AHY18099/AdHash_Project_Dashboard/contents/data/qa-shared.json', {
        message: 'fix: dedup AutoChecker wfdocs + restore SparkMe staging URL',
        content,
        sha
      });
      if (result.status === 200 || result.status === 201) {
        console.log('SUCCESS — pushed to GitHub, sha:', result.body.content && result.body.content.sha.slice(0, 10));
        // Save locally too
        fs.writeFileSync('data/qa-shared.json', JSON.stringify(data, null, 2));
        console.log('Saved locally to data/qa-shared.json');
      } else {
        console.error('FAILED:', result.status, result.body && result.body.message);
      }
    } catch (e) {
      console.error('GitHub push error:', e.message);
    }
  });
});
req.on('error', e => console.error('Error:', e.message));
req.setTimeout(15000, () => req.destroy());
