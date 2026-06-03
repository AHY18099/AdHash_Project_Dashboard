'use strict';
const fs      = require('fs');
const path    = require('path');
const Project = require('./models/Project');

async function seedProjectsIfEmpty() {
    try {
        const count = await Project.countDocuments();
        if (count > 0) {
            console.log(`[Seed] ${count} projects already in DB — skipping seed`);
            return;
        }
        const filePath = path.join(__dirname, '..', 'config', 'project-mapping.json');
        if (!fs.existsSync(filePath)) {
            console.warn('[Seed] project-mapping.json not found — skipping seed');
            return;
        }
        const raw     = fs.readFileSync(filePath, 'utf8');
        const parsed  = JSON.parse(raw);
        const projects = Array.isArray(parsed) ? parsed : (parsed.projects || []);
        if (!projects.length) return;
        const normalized = projects.map((p, i) => ({
            ...p,
            id: p.id || p._id?.toString() || `project_${i + 1}`
        }));
        await Project.insertMany(normalized, { ordered: false });
        console.log(`[Seed] Seeded ${normalized.length} projects from project-mapping.json`);
    } catch (err) {
        console.error('[Seed] Seed error (non-fatal):', err.message);
    }
}

module.exports = { seedProjectsIfEmpty };
