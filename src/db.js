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
    return _db;
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

async function _upsertDoc(colName, projectId, doc) {
    if (!doc || typeof doc !== 'object') return;
    const { _id, ...safe } = doc;
    safe.id        = safe.id || newId();
    safe.projectId = projectId;
    safe.updatedAt = new Date();
    if (!safe.createdAt) safe.createdAt = new Date();
    await getDB().collection(colName).updateOne(
        { id: safe.id },
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
    return getDB().collection(colName).find({ projectId }).sort({ createdAt: 1 }).toArray();
}

async function _findAll(colName) {
    return getDB().collection(colName).find({}).sort({ createdAt: 1 }).toArray();
}

// ── Project assembly / disassembly ───────────────────────────────────────────
async function assembleProject(projectId) {
    const db     = getDB();
    const config = await db.collection('projects').findOne({ id: projectId }) || {};
    const proj   = { env: config.env || {}, gates: config.gates || [] };

    // Each section from its collection
    for (const [field, col] of Object.entries(SECTION_MAP)) {
        proj[field] = await _findByProject(col, projectId);
    }

    // env_details split back into { production:[], staging:[] }
    const envDocs = await _findByProject('env_details', projectId);
    proj.envDetails = {
        production: envDocs
            .filter(e => e.envType === 'production')
            .map(({ envType, ...rest }) => rest),
        staging: envDocs
            .filter(e => e.envType === 'staging')
            .map(({ envType, ...rest }) => rest),
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

    // Save each section
    for (const [field, col] of Object.entries(SECTION_MAP)) {
        const items = proj[field];
        if (Array.isArray(items) && items.length > 0) {
            await _upsertMany(col, projectId, items);
        }
    }

    // Save env_details
    if (proj.envDetails) {
        const prod = (proj.envDetails.production || []).map(e => ({ ...e, envType: 'production' }));
        const stag = (proj.envDetails.staging    || []).map(e => ({ ...e, envType: 'staging' }));
        await _upsertMany('env_details', projectId, [...prod, ...stag]);
    }
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Read one key from MongoDB and return in the existing format. */
async function readKey(key) {
    if (key === 'qa_users')        return _findAll('users');
    if (key === 'qa3_daily_tasks') return _findAll('daily_tasks');
    if (key === 'qa3_team_tasks')  return _findAll('team_tasks');
    if (key === 'qa3_releases')    return _findAll('releases');
    if (key.startsWith('qa3_'))    return assembleProject(key.replace('qa3_', ''));
    return null;
}

/** Write one key to MongoDB. */
async function writeKey(key, value) {
    if (key === 'qa_users')        { await _upsertMany('users',       'global', Array.isArray(value) ? value : []); return; }
    if (key === 'qa3_daily_tasks') { await _upsertMany('daily_tasks', 'global', Array.isArray(value) ? value : []); return; }
    if (key === 'qa3_team_tasks')  { await _upsertMany('team_tasks',  'global', Array.isArray(value) ? value : []); return; }
    if (key === 'qa3_releases')    { await _upsertMany('releases',    'global', Array.isArray(value) ? value : []); return; }
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

/** Load ALL data from MongoDB — used to populate the in-memory cache on startup. */
async function readAllData() {
    const db    = getDB();
    const cache = {};
    cache['qa_users']          = await _findAll('users');
    cache['qa3_daily_tasks']   = await _findAll('daily_tasks');
    cache['qa3_team_tasks']    = await _findAll('team_tasks');
    cache['qa3_releases']      = await _findAll('releases');
    const projects = await db.collection('projects').find({}).toArray();
    for (const p of projects) {
        cache['qa3_' + p.id] = await assembleProject(p.id);
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
