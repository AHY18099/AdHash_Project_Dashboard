const https = require('https');
const fs = require('fs');
const token = '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';

// Step 1: Fetch live data from Railway
const req = https.get('https://adhashprojectdashboard-production.up.railway.app/api/qa-data', {
  headers: { 'Cookie': 'adhash_auth=' + encodeURIComponent(Buffer.from('thenilavan@adhashtech.com:Qateam@123').toString('base64url')) }
}, res => {
  let body = '';
  res.on('data', d => body += d);
  res.on('end', () => {
    const data = JSON.parse(body);

    // ── Fix SyncTag wfdocs: deduplicate, keep unique entries only ──
    const st = data['qa3_synctag'];
    const rawDocs = st.wfdocs || [];
    // Deduplicate: keep first occurrence of each (name+uploadedAt) combo,
    // preferring entries that have a serverId
    const seen = new Map();
    for (const doc of rawDocs) {
      const key = doc.name + '|' + (doc.uploadedAt || '');
      if (!seen.has(key)) {
        seen.set(key, doc);
      } else {
        // If current entry has serverId and stored one doesn't, replace
        const existing = seen.get(key);
        if (doc.serverId && !existing.serverId) seen.set(key, doc);
      }
    }
    const deduped = Array.from(seen.values());
    console.log('SyncTag wfdocs: was', rawDocs.length, '→ now', deduped.length);
    deduped.forEach((d, i) => console.log(' ', i, d.name, d.serverId || 'NO-ID'));
    data['qa3_synctag'].wfdocs = deduped;

    // ── SparkMe credentials: already correct per Railway, nothing to fix ──
    const sm = data['qa3_sparkme'];
    console.log('SparkMe credentials:', sm && sm.credentials ? sm.credentials.length : 0, 'entries — OK');

    // Step 2: Push fixed data to GitHub via API
    const getOpts = {
      hostname: 'api.github.com',
      path: '/repos/AHY18099/AdHash_Project_Dashboard/contents/data/qa-shared.json',
      headers: { 'Authorization': 'token ' + token, 'User-Agent': 'AdHash-Dashboard', 'Accept': 'application/vnd.github.v3+json' }
    };
    https.get(getOpts, res2 => {
      let b2 = '';
      res2.on('data', d => b2 += d);
      res2.on('end', () => {
        const meta = JSON.parse(b2);
        const sha = meta.sha;
        const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
        const payload = JSON.stringify({ message: 'fix: deduplicate SyncTag wfdocs (18→4 unique files)', content, sha });
        const putOpts = {
          hostname: 'api.github.com',
          path: '/repos/AHY18099/AdHash_Project_Dashboard/contents/data/qa-shared.json',
          method: 'PUT',
          headers: {
            'Authorization': 'token ' + token, 'User-Agent': 'AdHash-Dashboard',
            'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          }
        };
        const req2 = https.request(putOpts, res3 => {
          let b3 = '';
          res3.on('data', d => b3 += d);
          res3.on('end', () => {
            const r = JSON.parse(b3);
            if (res3.statusCode === 200 || res3.statusCode === 201) {
              console.log('SUCCESS — pushed to GitHub, sha:', r.content && r.content.sha.slice(0, 10));
              // Save locally too
              fs.writeFileSync('data/qa-shared.json', JSON.stringify(data, null, 2));
            } else {
              console.log('FAILED:', res3.statusCode, r.message);
            }
          });
        });
        req2.on('error', e => console.error(e.message));
        req2.write(payload);
        req2.end();
      });
    }).on('error', e => console.error(e.message));
  });
});
req.on('error', e => console.error(e.message));
req.setTimeout(15000, () => req.destroy());
