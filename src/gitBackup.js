'use strict';
/**
 * src/gitBackup.js — Automatic backup of all MongoDB data to GitHub.
 *
 * Runs every 6 hours. If MongoDB usage >= 70% of the 512MB free tier,
 * exports all collections and pushes a JSON snapshot to the GitHub repo.
 * Also provides forceFullBackup() for manual on-demand backups.
 */

const https = require('https');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_PAT || '';
const GITHUB_OWNER = 'AHY18099';
const GITHUB_REPO  = 'AdHash_Project_Dashboard';
const BACKUP_DIR   = 'backups';

// ── GitHub API helper ────────────────────────────────────────────────────────
function _ghRequest(method, path, body, token) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const req = https.request({
            hostname: 'api.github.com',
            path,
            method,
            headers: {
                'User-Agent': 'AdHash-QA-Backup/1.0',
                'Authorization': `token ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
                ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
            }
        }, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
                catch (_) { resolve({ status: res.statusCode, body: data }); }
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

// ── MongoDB size check ───────────────────────────────────────────────────────
async function getMongoDBUsagePct() {
    try {
        const { getDB } = require('./db');
        const db = getDB();
        if (!db) return 0;
        const stats = await db.command({ dbStats: 1, scale: 1024 * 1024 }); // scale to MB
        const usedMB = stats.dataSize || 0;
        return (usedMB / 512) * 100; // 512MB free tier
    } catch (e) {
        console.warn('[backup] Could not get DB size:', e.message);
        return 0;
    }
}

// ── Export all collections ───────────────────────────────────────────────────
async function exportAllData() {
    const { getDB } = require('./db');
    const db = getDB();
    if (!db) throw new Error('MongoDB not connected');

    const collections = [
        'projects', 'credentials', 'smoke_tests', 'prod_checklist',
        'task_checklist', 'third_party', 'client_feedback', 'workflow_docs',
        'api_tests', 'pending_tasks', 'saved_reports', 'release_notes',
        'test_data', 'env_details', 'daily_tasks', 'team_tasks',
        'releases', 'users',
    ];

    const backup = { exportedAt: new Date().toISOString(), version: '1.0', collections: {} };
    for (const col of collections) {
        try {
            backup.collections[col] = await db.collection(col).find({}).toArray();
            console.log(`[backup] Exported ${col}: ${backup.collections[col].length} docs`);
        } catch (e) {
            console.warn(`[backup] Skipped ${col}:`, e.message);
            backup.collections[col] = [];
        }
    }
    return backup;
}

// ── Push backup to GitHub ────────────────────────────────────────────────────
async function pushBackupToGitHub(backup) {
    if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN not set');
    const ts       = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `${BACKUP_DIR}/backup-${ts}.json`;
    const content  = Buffer.from(JSON.stringify(backup, null, 2)).toString('base64');

    // Check if file exists (get sha)
    let sha;
    try {
        const existing = await _ghRequest('GET', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filename}`, null, GITHUB_TOKEN);
        if (existing.status === 200) sha = existing.body.sha;
    } catch (_) {}

    const body = { message: `Auto backup ${ts}`, content, ...(sha ? { sha } : {}) };
    const result = await _ghRequest('PUT', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filename}`, body, GITHUB_TOKEN);
    if (result.status !== 200 && result.status !== 201) {
        throw new Error(`GitHub push failed: ${result.status} ${JSON.stringify(result.body)}`);
    }
    console.log(`[backup] ✅ Pushed to GitHub: ${filename}`);
    return filename;
}

// ── Clean old backups (keep last N) ─────────────────────────────────────────
async function cleanOldBackups(keepLast = 10) {
    if (!GITHUB_TOKEN) return;
    try {
        const result = await _ghRequest('GET', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${BACKUP_DIR}`, null, GITHUB_TOKEN);
        if (result.status !== 200 || !Array.isArray(result.body)) return;
        const files = result.body
            .filter(f => f.name.startsWith('backup-'))
            .sort((a, b) => a.name.localeCompare(b.name));
        const toDelete = files.slice(0, Math.max(0, files.length - keepLast));
        for (const f of toDelete) {
            await _ghRequest('DELETE', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${f.path}`,
                { message: `Remove old backup: ${f.name}`, sha: f.sha }, GITHUB_TOKEN);
            console.log(`[backup] Deleted old backup: ${f.name}`);
        }
    } catch (e) { console.warn('[backup] Cleanup failed:', e.message); }
}

// ── Main: always backup daily; also warn when storage >= 70% ─────────────────
async function runBackupIfNeeded() {
    try {
        const usedPct = await getMongoDBUsagePct();
        console.log(`[backup] MongoDB usage: ${usedPct.toFixed(1)}% of 512MB free tier`);
        if (usedPct >= 70) {
            console.log('[backup] ⚠️ Storage >= 70% — starting GitHub backup');
        } else {
            console.log('[backup] Scheduled daily backup starting...');
        }
        const backup   = await exportAllData();
        const filename = await pushBackupToGitHub(backup);
        await cleanOldBackups(10);
        console.log(`[backup] ✅ Backup complete: ${filename} (${usedPct.toFixed(1)}% used)`);
    } catch (e) { console.error('[backup] runBackupIfNeeded failed:', e.message); }
}

// ── Force full backup (on-demand) ────────────────────────────────────────────
async function forceFullBackup() {
    console.log('[backup] Starting forced full backup...');
    const backup   = await exportAllData();
    const filename = await pushBackupToGitHub(backup);
    await cleanOldBackups(10);
    return filename;
}

// ── Get storage stats ────────────────────────────────────────────────────────
async function getStorageStats() {
    const usedPct = await getMongoDBUsagePct();
    const { getDB } = require('./db');
    const db = getDB();
    let stats = null;
    try {
        if (db) stats = await db.command({ dbStats: 1, scale: 1024 * 1024 });
    } catch (_) {}
    return {
        usedMB:  stats ? (stats.dataSize || 0).toFixed(2) : '?',
        limitMB: '512',
        usedPct: usedPct.toFixed(1),
        status:  usedPct < 70 ? 'healthy' : usedPct < 90 ? 'warning' : 'critical',
    };
}

module.exports = { runBackupIfNeeded, forceFullBackup, getStorageStats, exportAllData };
