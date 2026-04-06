const fs = require('fs');

const html = fs.readFileSync('Adhash_AllProjects_Server/reports/server-health-report-2026-02-13.html', 'utf8');

// Test for "AutoChecker - Admin" (should be healthy with ✅)
const serverName = 'AutoChecker - Admin';
const escapedName = serverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const iconPattern = new RegExp(`<div class="server-card active"[\\s\\S]{0,200}?<span class="server-icon">([^<]+)</span>[\\s\\S]{0,200}?<div class="server-name">${escapedName}</div>`, 'i');
const match = html.match(iconPattern);

console.log('Testing:', serverName);
console.log('Match found:', match ? 'YES' : 'NO');
if (match) {
    console.log('Icon:', match[1]);
    console.log('Is warning (⚠️):', match[1].includes('⚠️'));
    console.log('Is healthy (✅):', match[1].includes('✅'));
    console.log('Status should be:', match[1].includes('⚠️') ? 'warning' : 'passed');
}

console.log('\n---\n');

// Test for "AutoChecker - Admin API" (should be unhealthy with ⚠️)
const serverName2 = 'AutoChecker - Admin API';
const escapedName2 = serverName2.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const iconPattern2 = new RegExp(`<div class="server-card active"[\\s\\S]{0,200}?<span class="server-icon">([^<]+)</span>[\\s\\S]{0,200}?<div class="server-name">${escapedName2}</div>`, 'i');
const match2 = html.match(iconPattern2);

console.log('Testing:', serverName2);
console.log('Match found:', match2 ? 'YES' : 'NO');
if (match2) {
    console.log('Icon:', match2[1]);
    console.log('Is warning (⚠️):', match2[1].includes('⚠️'));
    console.log('Is healthy (✅):', match2[1].includes('✅'));
    console.log('Status should be:', match2[1].includes('⚠️') ? 'warning' : 'passed');
}

