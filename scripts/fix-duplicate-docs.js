'use strict';
/**
 * One-time migration: remove duplicate workflow docs from MongoDB for all projects.
 * Duplicates defined as: same name AND same size.
 * Run: node scripts/fix-duplicate-docs.js
 */
require('dotenv').config();
const { connectDB } = require('../src/db');
const { getDB }     = require('../src/db');

async function fixDuplicateDocs() {
    await connectDB();
    const db = getDB();
    const projects = await db.collection('projects').find({}).toArray();
    let totalFixed = 0;

    for (const project of projects) {
        const pid  = project.id || project._id?.toString();
        const name = project.name || pid;
        const wfdocs = await db.collection('workflow_docs').find({ projectId: pid }).toArray();
        if (!wfdocs.length) continue;

        const seen    = new Set();
        const keepIds = [];
        const dropIds = [];

        for (const doc of wfdocs) {
            const key = `${doc.name}__${doc.size || 0}`;
            if (seen.has(key)) {
                dropIds.push(doc._id);
            } else {
                seen.add(key);
                keepIds.push(doc._id);
            }
        }

        if (dropIds.length) {
            await db.collection('workflow_docs').deleteMany({ _id: { $in: dropIds } });
            console.log(`[Fix] ${name} (${pid}): removed ${dropIds.length} duplicate(s), kept ${keepIds.length}`);
            totalFixed += dropIds.length;
        }
    }

    console.log(`\n[Fix] Done. Total duplicates removed: ${totalFixed}`);
    process.exit(0);
}

fixDuplicateDocs().catch(e => { console.error('[Fix] Error:', e.message); process.exit(1); });
