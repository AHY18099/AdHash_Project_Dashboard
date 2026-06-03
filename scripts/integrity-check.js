'use strict';
/**
 * Data integrity check — run after every major deployment.
 * Verifies all projects have correct field types and no duplicates.
 * Usage: node scripts/integrity-check.js
 * Exit code 0 = pass, 1 = issues found.
 */
require('dotenv').config();
const { connectDB } = require('../db/connection');
const Project       = require('../db/models/Project');

const ARRAY_FIELDS = [
    'apps','servers','domains','sslCerts','apis','workflowDocs',
    'credentials','smokeTests','prodChecklist','pendingTasks',
    'releaseNotes','clientFeedback','thirdParty','swagger','taskChecklist'
];

async function integrityCheck() {
    await connectDB();
    const projects = await Project.find({}).lean();
    const issues   = [];

    for (const p of projects) {
        const label = p.name || p.id || String(p._id);

        // Required fields
        if (!p.id)   issues.push({ project: label, issue: 'Missing id field' });
        if (!p.name) issues.push({ project: label, issue: 'Missing name field' });

        // Array fields must be arrays
        ARRAY_FIELDS.forEach(f => {
            if (p[f] !== undefined && !Array.isArray(p[f])) {
                issues.push({ project: label, issue: `${f} is not an array (type: ${typeof p[f]})` });
            }
        });

        // environments structure
        if (p.environments) {
            if (p.environments.production !== undefined && !Array.isArray(p.environments.production)) {
                issues.push({ project: label, issue: 'environments.production is not an array' });
            }
            if (p.environments.staging !== undefined && !Array.isArray(p.environments.staging)) {
                issues.push({ project: label, issue: 'environments.staging is not an array' });
            }
        }

        // Duplicate workflowDocs check
        const docs = p.workflowDocs || [];
        const seen = new Set();
        docs.forEach(d => {
            const key = `${d.name}__${d.size || 0}`;
            if (seen.has(key)) issues.push({ project: label, issue: `Duplicate workflowDoc: ${d.name}` });
            else seen.add(key);
        });
    }

    if (issues.length === 0) {
        console.log(`✅ Integrity check passed — ${projects.length} projects, zero issues`);
    } else {
        console.warn(`⚠️  ${issues.length} issue(s) found across ${projects.length} projects:`);
        issues.forEach(i => console.warn(`  [${i.project}] ${i.issue}`));
    }

    process.exit(issues.length > 0 ? 1 : 0);
}

integrityCheck().catch(e => { console.error('[IntegrityCheck] Fatal:', e.message); process.exit(1); });
