'use strict';
/**
 * src/db.js — MongoDB Atlas connection + data access layer.
 * Updated: 2026-06-30
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
    'status_reports',
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
            // Compound (projectId, date) index for daily_tasks — used in merge queries
            if (col === 'daily_tasks') {
                await db.collection(col).createIndex({ projectId: 1, date: 1 }, { background: true, name: 'projectId_date' });
            }
            // _savedAt index for merge functions that filter by timestamp
            if (['daily_tasks', 'team_tasks', 'smoke_tests', 'prod_checklist'].includes(col)) {
                await db.collection(col).createIndex({ _savedAt: 1 }, { background: true, sparse: true, name: '_savedAt_1' });
            }
            // status_reports: index by reportDateTime descending for list queries
            if (col === 'status_reports') {
                await db.collection(col).dropIndex('id_projectId_unique').catch(() => {});
                await db.collection(col).createIndex({ id: 1 }, { unique: true, sparse: true, background: true, name: 'sr_id_unique' });
                await db.collection(col).createIndex({ reportDateTime: -1 }, { background: true, name: 'sr_reportDateTime' });
                await db.collection(col).createIndex({ overallStatus: 1 }, { background: true, name: 'sr_status' });
                await db.collection(col).createIndex({ runType: 1 }, { background: true, name: 'sr_runType' });
                continue;
            }
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
    if (!proj || typeof proj !== 'object') return {};
    // Tracks fields that were deduplicated — caller uses this to fix _qaCache
    const dedupedFields = {};
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
    // ALL section arrays are protected — never delete+replace unless:
    // (a) incoming array is non-empty (real user save with data), OR
    // (b) _replaceArrays explicitly lists the field (intentional clear/replace)
    // This prevents empty STORE arrays from wiping MongoDB on heartbeat saves.
    for (const [field, col] of Object.entries(SECTION_MAP)) {
        let items = proj[field];
        if (!Array.isArray(items)) continue;
        // Skip empty arrays unless explicitly flagged for replace
        if (items.length === 0 && !replaceArrays.has(field)) continue;
        // Deduplicate reports by datetime before writing — prevents old duplicates
        // from being re-written by stale browser heartbeats that have the full set
        if (field === 'reports' && items.length > 0) {
            const seenDt = new Map();
            const deduped = items.filter(r => {
                if (r && r.id && String(r.id).startsWith('rpt_')) {
                    seenDt.set(r.id, true); return true;
                }
                const k = (r && r.datetime) || (r && r.id) || JSON.stringify(r);
                if (seenDt.has(k)) return false;
                seenDt.set(k, true); return true;
            });
            if (deduped.length !== items.length) {
                dedupedFields.reports = deduped; // caller must update _qaCache with this
            }
            items = deduped;
        }
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
    return dedupedFields; // non-empty only when dedup changed something
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
        const incoming = Array.isArray(value) ? value.filter(t => t && t.projectId && t.projectId !== 'global') : [];
        // Safety guard: never wipe more rows than we're replacing — prevents empty browser
        // state on page load from overwriting real data saved by other users / prior sessions.
        const existingCount = await db.collection('daily_tasks').countDocuments();
        if (existingCount > 0 && incoming.length < existingCount * 0.5) {
            console.warn(`[db] qa3_daily_tasks write blocked — incoming ${incoming.length} rows would wipe ${existingCount} existing rows`);
            return;
        }
        await db.collection('daily_tasks').deleteMany({});
        if (incoming.length > 0) {
            await Promise.all(incoming.map(t => _upsertDoc('daily_tasks', t.projectId, t)));
        }
        return;
    }
    if (key === 'qa3_team_tasks') {
        const incoming = Array.isArray(value) ? value.filter(t => t && t.projectId && t.projectId !== 'global') : [];
        const existingCount = await db.collection('team_tasks').countDocuments();
        if (existingCount > 0 && incoming.length < existingCount * 0.5) {
            console.warn(`[db] qa3_team_tasks write blocked — incoming ${incoming.length} rows would wipe ${existingCount} existing rows`);
            return;
        }
        await db.collection('team_tasks').deleteMany({});
        if (incoming.length > 0) {
            await Promise.all(incoming.map(t => _upsertDoc('team_tasks', t.projectId, t)));
        }
        return;
    }
    if (key === 'qa3_releases') {
        const incoming = Array.isArray(value) ? value.filter(r => r && r.id) : [];
        const existingCount = await db.collection('releases').countDocuments();
        if (existingCount > 0 && incoming.length < existingCount * 0.5) {
            console.warn(`[db] qa3_releases write blocked — incoming ${incoming.length} rows would wipe ${existingCount} existing rows`);
            return;
        }
        await db.collection('releases').deleteMany({});
        if (incoming.length > 0) {
            await Promise.all(incoming.map(r => {
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
        return await writeProject(key.replace('qa3_', ''), value); // returns dedupedFields
    }
    return {};
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

// ── Status Reports CRUD ───────────────────────────────────────────────────────
async function createStatusReport(data) {
    const db = getDB();
    const doc = {
        id:              `sr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        title:           data.title           || 'AdHash Projects Status Dashboard',
        runType:         (data.runType        || 'manual').toLowerCase(),
        overallStatus:   (data.overallStatus  || 'unknown').toLowerCase(),
        reportDateTime:  data.reportDateTime  || new Date().toISOString(),
        totalProjects:   Number(data.totalProjects  || 0),
        passedCount:     Number(data.passedCount    || 0),
        failedCount:     Number(data.failedCount    || 0),
        warningCount:    Number(data.warningCount   || 0),
        skippedCount:    Number(data.skippedCount   || 0),
        duration:        data.duration        || '',
        htmlContent:     data.htmlContent     || '',
        source:          data.source          || 'github-action',
        createdAt:       new Date(),
        updatedAt:       new Date(),
    };
    await db.collection('status_reports').insertOne(doc);
    const { htmlContent, _id, ...meta } = doc;
    return meta;
}

async function listStatusReports({ page = 1, limit = 20, status, runType, fromDate, toDate, search } = {}) {
    const db = getDB();
    const filter = {};
    if (status)   filter.overallStatus = status.toLowerCase();
    if (runType)  filter.runType = runType.toLowerCase();
    if (fromDate || toDate) {
        filter.reportDateTime = {};
        if (fromDate) filter.reportDateTime.$gte = fromDate;
        if (toDate)   filter.reportDateTime.$lte = toDate;
    }
    if (search) filter.title = { $regex: search, $options: 'i' };

    const skip = (Math.max(1, page) - 1) * limit;
    const total = await db.collection('status_reports').countDocuments(filter);
    const docs  = await db.collection('status_reports')
        .find(filter, { projection: { htmlContent: 0 } })
        .sort({ reportDateTime: -1 })
        .skip(skip)
        .limit(limit)
        .toArray();

    return {
        total,
        page: Number(page),
        limit: Number(limit),
        pages: Math.ceil(total / limit),
        reports: docs.map(({ _id, ...d }) => d),
    };
}

async function getStatusReport(id) {
    const db = getDB();
    const doc = await db.collection('status_reports').findOne({ id });
    if (!doc) return null;
    const { _id, ...clean } = doc;
    return clean;
}

async function deleteStatusReport(id) {
    const db = getDB();
    const result = await db.collection('status_reports').deleteOne({ id });
    return result.deletedCount > 0;
}

async function getStatusReportSummary() {
    const db = getDB();
    const total = await db.collection('status_reports').countDocuments();
    const latest = await db.collection('status_reports')
        .findOne({}, { sort: { reportDateTime: -1 }, projection: { htmlContent: 0 } });
    const counts = await db.collection('status_reports').aggregate([
        { $group: { _id: '$overallStatus', count: { $sum: 1 } } }
    ]).toArray();
    const statusCounts = {};
    counts.forEach(c => { statusCounts[c._id] = c.count; });
    return { total, latest: latest ? (({ _id, ...d }) => d)(latest) : null, statusCounts };
}

module.exports = {
    connectDB, getDB, closeDB, pingDB,
    readKey, writeKey, deleteKey, readAllData,
    writeProject, SECTION_MAP,
    createStatusReport, listStatusReports, getStatusReport, deleteStatusReport, getStatusReportSummary,
};
