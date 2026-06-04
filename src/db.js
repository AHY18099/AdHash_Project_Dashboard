'use strict';
/**
 * src/db.js — MongoDB Atlas connection + data access layer.
 *
 * All QA data is stored in adhash_qa database with one collection per section.
 * The in-memory cache in server.js is populated from here on startup and
 * updated on every write, so all existing synchronous readQaData() calls work.
 */

const { MongoClient, ObjectId } = require('mongodb');

// ── Connection singleton ─────────────────────────────────────────────────────
let _client = null;
let _db     = null;

async function connectDB() {
    if (_db) return _db;
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI environment variable is not set');
    _client = new MongoClient(uri, {
        maxPoolSize:                10,
        serverSelectionTimeoutMS:  10000,
        socketTimeoutMS:           45000,
        retryWrites:                true,
        retryReads:                 true,
    });
    await _client.connect();
    _db = _client.db(process.env.MONGODB_DB || 'adhash_qa');
    console.log('[mongodb] ✅ Connected —', _db.databaseName);
    // Ensure correct indexes: unique on (id + projectId) so projects can share logical IDs
    await _ensureIndexes(_db);
    return _db;
}

const ALL_COLLECTIONS = [
    'credentials', 'smoke_tests', 'prod_checklist', 'task_checklist',
    'third_party', 'client_feedback', 'workflow_docs', 'api_tests',
    'pending_tasks', 'saved_reports', 'release_notes', 'test_data',
    'env_details', 'daily_tasks', 'team_tasks', 'releases', 'users', 'projects',
];

async function _ensureIndexes(db) {
    for (const col of ALL_COLLECTIONS) {
        try {
            if (col === 'users') {
                // Users are global (no projectId) — use email unique index instead
                await db.collection('users').dropIndex('id_projectId_unique').catch(() => {});
                await db.collection('users').dropIndex('projectId_1').catch(() => {});
                await db.collection('users').dropIndex('id_1').catch(() => {});
                await db.collection('users').createIndex({ email: 1 }, { unique: true, sparse: true, background: true, name: 'email_unique' }).catch(() => {});
                await db.collection('users').createIndex({ id: 1 },    { unique: true, sparse: true, background: true, name: 'id_unique'    }).catch(() => {});
                continue;
            }
            // Drop the old single-field unique index on id (if it exists) — it conflicts
            // when two projects share the same logical ID (e.g. SMK-01 in DDP and AiSignPro).
            await db.collection(col).dropIndex('id_1').catch(() => {});
            // Compound unique index: (id + projectId) allows same ID in different projects.
            await db.collection(col).createIndex(
                { id: 1, projectId: 1 },
                { unique: true, sparse: true, background: true, name: 'id_projectId_unique' }
            );
            // Fast lookup by projectId
            await db.collection(col).createIndex({ projectId: 1 }, { background: true });
        } catch (e) {
            console.warn('[mongodb] Index ensure failed for', col, ':', e.message);
        }
    }
    console.log('[mongodb] ✅ Indexes verified');
}

function getDB() {
    if (!_db) throw new Error('MongoDB not connected. Call connectDB() first.');
    return _db;
}

async function closeDB() {
    if (_client) { await _client.close(); _client = null; _db = null; }
}

// ── Section → collection mapping ────────────────────────────────────────────
// Maps project data field names to their MongoDB collection names.
const SECTION_MAP = {
    smoke:          'smoke_tests',
    prod:           'prod_checklist',
    credentials:    'credentials',
    taskchecklist:  'task_checklist',
    thirdparty:     'third_party',
    feedback:       'client_feedback',
    wfdocs:         'workflow_docs',
    apitests:       'api_tests',
    pendingtasks:   'pending_tasks',
    reports:        'saved_reports',
    releaseNotes:   'release_notes',
    testdata:       'test_data',
};

// ── Core helpers ─────────────────────────────────────────────────────────────
function newId() { return new ObjectId().toString(); }

// Strip ALL MongoDB/storage metadata that must never appear in client-facing data.
// _id, updatedAt, createdAt — MongoDB adds these on every write; they make
//   JSON.stringify(STORE) differ from the hash set before the write → infinite save loop.
// projectId — stored on every item doc for querying; the client stores items inside
//   per-project STORE objects so projectId is redundant and causes hash drift.
// envType — internal field used to split env_details into production/staging; the client
//   receives them already split so envType in individual items is redundant.
// Strip MongoDB/storage metadata from a single document.
// projectId is kept — it's needed on global arrays (daily_tasks, team_tasks etc.)
// and harmless on project sub-items; removing it would break client-side filtering.
function _strip(doc) {
    if (!doc || typeof doc !== 'object') return doc;
    const { _id, updatedAt, createdAt, ...clean } = doc;
    return clean;
}
function _stripArray(arr) {
    return Array.isArray(arr) ? arr.map(_strip) : arr;
}
// Strip for project sub-items only: also removes projectId (redundant inside STORE[pid])
// and envType (internal split field for env_details already split on read).
function _stripItem(doc) {
    if (!doc || typeof doc !== 'object') return doc;
    const { _id, updatedAt, createdAt, projectId, envType, ...clean } = doc;
    return clean;
}
function _stripItemArray(arr) {
    return Array.isArray(arr) ? arr.map(_stripItem) : arr;
}

async function _upsertDoc(colName, projectId, doc) {
    if (!doc || typeof doc !== 'object') return;
    const { _id, ...safe } = doc;
    safe.id        = safe.id || newId();
    safe.projectId = projectId;
    safe.updatedAt = new Date();
    if (!safe.createdAt) safe.createdAt = new Date();
    // Filter by both id AND projectId so projects with the same logical IDs
    // (e.g. SMK-01 in DDP and SMK-01 in AiSignPro) are stored as separate docs.
    await getDB().collection(colName).updateOne(
        { id: safe.id, projectId },
        { $set: safe },
        { upsert: true }
    );
    return safe;
}

async function _upsertMany(colName, projectId, items) {
    if (!Array.isArray(items) || !items.length) return;
    await Promise.all(items.map(item => _upsertDoc(colName, projectId, item)));
}

async function _findByProject(colName, projectId) {
    const docs = await getDB().collection(colName).find({ projectId }).sort({ createdAt: 1 }).toArray();
    // Strip projectId too — it's redundant inside STORE[projectId] on the client
    return _stripItemArray(docs);
}

async function _findAll(colName) {
    const docs = await getDB().collection(colName).find({}).sort({ createdAt: 1 }).toArray();
    // Keep projectId on global arrays — client needs it for filtering (e.g. daily_tasks)
    return _stripArray(docs);
}

// ── Project assembly / disassembly ───────────────────────────────────────────
async function assembleProject(projectId) {
    const db     = getDB();
    const rawConfig = await db.collection('projects').findOne({ id: projectId }) || {};
    const config = _strip(rawConfig);
    const proj   = { env: config.env || {}, gates: config.gates || [] };

    // Each section from its collection
    for (const [field, col] of Object.entries(SECTION_MAP)) {
        proj[field] = await _findByProject(col, projectId);
    }

    // env_details: fetch raw (keep envType for split), then strip after
    const envRaw = await getDB().collection('env_details').find({ projectId }).sort({ createdAt: 1 }).toArray();
    proj.envDetails = {
        production: envRaw
            .filter(e => e.envType === 'production')
            .map(e => _stripItem(e)),
        staging: envRaw
            .filter(e => e.envType === 'staging')
            .map(e => _stripItem(e)),
    };

    return proj;
}

async function writeProject(projectId, proj) {
    if (!proj || typeof proj !== 'object') return;
    const db = getDB();

    // Save project config
    await db.collection('projects').updateOne(
        { id: projectId },
        { $set: { id: projectId, env: proj.env || {}, gates: proj.gates || [], updatedAt: new Date(), createdAt: new Date() } },
        { upsert: true }
    );

    // CRITICAL SECTIONS — never delete existing data when incoming array is empty.
    // Empty array from an uninitialised STORE must not wipe real saved data.
    // Only delete+replace when incoming array is non-empty (real save) OR when
    // the proj._replaceArrays flag explicitly lists the field (intentional clear).
    const replaceArrays = Array.isArray(proj._replaceArrays) ? new Set(proj._replaceArrays) : new Set();
    const PROTECTED = new Set(['credentials', 'thirdparty', 'pendingtasks', 'apitests', 'reports']);

    for (const [field, col] of Object.entries(SECTION_MAP)) {
        const items = proj[field];
        if (!Array.isArray(items)) continue;
        // Skip empty arrays for protected fields unless explicitly flagged for replace
        if (items.length === 0 && PROTECTED.has(field) && !replaceArrays.has(field)) continue;
        await getDB().collection(col).deleteMany({ projectId });
        if (items.length > 0) await _upsertMany(col, projectId, items);
    }

    // env_details: only write when envDetails is present AND non-empty OR explicitly replacing.
    if (Object.prototype.hasOwnProperty.call(proj, 'envDetails') && proj.envDetails) {
        const prod = (proj.envDetails.production || []).map(e => ({ ...e, envType: 'production' }));
        const stag = (proj.envDetails.staging    || []).map(e => ({ ...e, envType: 'staging' }));
        const all  = [...prod, ...stag];
        // Only wipe+replace if we have data OR if client explicitly flagged _envDetails for replace
        if (all.length > 0 || replaceArrays.has('_envDetails')) {
            await getDB().collection('env_details').deleteMany({ projectId });
            if (all.length > 0) await _upsertMany('env_details', projectId, all);
            console.log(`[writeProject] envDetails saved for ${projectId}: prod=${prod.length} stag=${stag.length}`);
        }
    }
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Read one key from MongoDB and return in the existing format. */
async function readKey(key) {
    if (key === 'qa_users')        return _findAll('users');
    if (key === 'qa3_daily_tasks') return _findAll('daily_tasks');
    if (key === 'qa3_team_tasks')  return _findAll('team_tasks');
    if (key === 'qa3_releases')    return _findAll('releases');
    if (key === 'qa3_projects')    return getDB().collection('projects').find({}).toArray();
    if (key.startsWith('qa3_'))    return assembleProject(key.replace('qa3_', ''));
    return null;
}

/** Write one key to MongoDB. Delete-then-upsert ensures removed items are never resurrected. */
async function writeKey(key, value) {
    const db = getDB();
    if (key === 'qa_users') {
        // Users are global — upsert each by email (NOT by projectId).
        // Never use _upsertMany here: it sets projectId='global' on every doc which
        // conflicts with the email unique index when multiple users share same email.
        if (Array.isArray(value) && value.length > 0) {
            for (const u of value) {
                if (!u || !u.email) continue;
                const { _id, projectId, ...safe } = u; // strip _id and projectId
                safe.id = safe.id || newId();
                safe.updatedAt = new Date();
                await db.collection('users').updateOne(
                    { email: safe.email },
                    { $set: safe, $setOnInsert: { createdAt: new Date() } },
                    { upsert: true }
                );
            }
        }
        return;
    }
    if (key === 'qa3_daily_tasks') {
        // Delete ALL existing daily_tasks (including any stale 'global' rows) then re-insert
        // using each task's own projectId — daily tasks belong to specific projects, not 'global'
        await db.collection('daily_tasks').deleteMany({});
        if (Array.isArray(value) && value.length > 0) {
            const realTasks = value.filter(t => t && t.projectId && t.projectId !== 'global');
            await Promise.all(realTasks.map(t => _upsertDoc('daily_tasks', t.projectId, t)));
        }
        return;
    }
    if (key === 'qa3_team_tasks') {
        // Team tasks have their own projectId per task — never use 'global'
        await db.collection('team_tasks').deleteMany({});
        if (Array.isArray(value) && value.length > 0) {
            // Skip tasks with no real projectId to prevent global pollution
            const realTasks = value.filter(t => t && t.projectId && t.projectId !== 'global');
            if (realTasks.length) await Promise.all(realTasks.map(t => _upsertDoc('team_tasks', t.projectId, t)));
        }
        return;
    }
    if (key === 'qa3_releases') {
        // Delete all releases (both legacy 'global' entries and project-specific ones)
        // then re-insert each release with its real projectId preserved.
        await db.collection('releases').deleteMany({});
        if (Array.isArray(value) && value.length > 0) {
            // Each release must keep its own projectId — never force 'global'
            await Promise.all(value.map(r => {
                if (!r || !r.id) return Promise.resolve();
                const pid = (r.projectId && r.projectId !== 'global') ? r.projectId : (r.projectId || 'global');
                return _upsertDoc('releases', pid, r);
            }));
        }
        return;
    }
    if (key === 'qa3_projects' && Array.isArray(value)) {
        // Project metadata array — upsert each project into the 'projects' collection
        // This ensures new/edited/deleted projects persist across Railway redeploys
        for (const proj of value) {
            if (!proj || !proj.id) continue;
            const { _id, ...safe } = proj;
            await db.collection('projects').updateOne(
                { id: safe.id },
                { $set: { ...safe, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
                { upsert: true }
            );
        }
        // Remove projects from DB that are no longer in the list
        const activeIds = value.filter(p => p && p.id).map(p => p.id);
        if (activeIds.length > 0) {
            await db.collection('projects').deleteMany({ id: { $nin: activeIds } });
        }
        return;
    }
    if (key.startsWith('qa3_') && value && typeof value === 'object' && !Array.isArray(value)) {
        await writeProject(key.replace('qa3_', ''), value);
    }
}

/** Delete one key from MongoDB. */
async function deleteKey(key) {
    const db = getDB();
    if (key === 'qa_users')        { await db.collection('users').deleteMany({});       return; }
    if (key === 'qa3_daily_tasks') { await db.collection('daily_tasks').deleteMany({}); return; }
    if (key === 'qa3_team_tasks')  { await db.collection('team_tasks').deleteMany({});  return; }
    if (key === 'qa3_releases')    { await db.collection('releases').deleteMany({});    return; }
    if (key.startsWith('qa3_')) {
        const pid = key.replace('qa3_', '');
        for (const col of Object.values(SECTION_MAP)) await db.collection(col).deleteMany({ projectId: pid });
        await db.collection('env_details').deleteMany({ projectId: pid });
        await db.collection('projects').deleteOne({ id: pid });
    }
}

/** Load ALL data from MongoDB in parallel — used to populate the in-memory cache on startup.
 *  Fetches every collection once (not once-per-project) then groups by projectId in memory.
 *  Reduces ~180 sequential queries down to ~19 parallel queries. */
async function readAllData() {
    const db = getDB();

    // Fetch all global arrays + project configs + every section collection — all in parallel
    const allCols = [...Object.values(SECTION_MAP), 'env_details'];
    const [users, daily, team, releases, projects, ...sectionResults] = await Promise.all([
        _findAll('users'),
        _findAll('daily_tasks'),
        _findAll('team_tasks'),
        _findAll('releases'),
        db.collection('projects').find({}).toArray(),
        ...allCols.map(col => db.collection(col).find({}).toArray()),
    ]);

    const cache = {};
    cache['qa_users']        = users;
    cache['qa3_daily_tasks'] = daily;
    cache['qa3_team_tasks']  = team;
    cache['qa3_releases']    = releases;
    // Return clean project metadata — strip MongoDB _id, filter ghost entries without name
    cache['qa3_projects'] = projects
        .filter(p => p.id && p.name)           // skip ghost entries (no name)
        .map(({ _id, updatedAt, createdAt, ...clean }) => clean); // strip MongoDB metadata

    if (!projects.filter(p => p.id && p.name).length) return cache;

    // Only build project data for projects that have valid names
    const validProjects = projects.filter(p => p.id && p.name);

    // Map col index back to its name
    const colDocs = {};
    allCols.forEach((col, i) => { colDocs[col] = sectionResults[i]; });

    // Build per-project skeleton
    const byProject = {};
    for (const p of validProjects) {
        byProject[p.id] = { env: p.env || {}, gates: p.gates || [], envDetails: { production: [], staging: [] } };
        for (const field of Object.keys(SECTION_MAP)) byProject[p.id][field] = [];
    }

    // Distribute section docs into their project buckets
    for (const [field, col] of Object.entries(SECTION_MAP)) {
        for (const doc of colDocs[col] || []) {
            if (byProject[doc.projectId]) byProject[doc.projectId][field].push(doc);
        }
    }

    // Distribute env_details
    for (const doc of colDocs['env_details'] || []) {
        if (!byProject[doc.projectId]) continue;
        const { envType, ...rest } = doc;
        if (envType === 'production') byProject[doc.projectId].envDetails.production.push(rest);
        else if (envType === 'staging') byProject[doc.projectId].envDetails.staging.push(rest);
    }

    for (const [pid, data] of Object.entries(byProject)) {
        cache['qa3_' + pid] = data;
    }

    return cache;
}

/** Ping the database — used by the health endpoint. */
async function pingDB() {
    await getDB().command({ ping: 1 });
}

module.exports = {
    connectDB, getDB, closeDB, pingDB,
    readKey, writeKey, deleteKey, readAllData,
    writeProject, SECTION_MAP,
};
