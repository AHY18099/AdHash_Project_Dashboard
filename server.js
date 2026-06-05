require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { readLatestApiResultsPayload } = require('./utils/latest-api-results.js');
const { sendZohoMail } = require('./utils/zoho-mail');
const { sendSlackNotification } = require('./utils/slack-notify');

// ── Required env vars — crash loudly on startup if missing ──
(function checkRequiredEnvVars() {
    const required = ['MONGODB_URI'];
    const missing  = required.filter(k => !process.env[k]);
    if (missing.length) {
        console.error('❌ Missing required environment variables:', missing.join(', '));
        console.error('   Set them in Railway → Variables and redeploy.');
        process.exit(1);
    }
    console.log('[startup] ✅ Required env vars present');
})();

// ── MongoDB data layer ──
const { connectDB, pingDB, readKey, writeKey, deleteKey, readAllData } = require('./src/db');

// ── Audit + error logging helpers ──
const { auditLog } = require('./src/utils/auditLog');
const { logError  } = require('./src/utils/errorLog');

// ── In-memory cache — loaded from MongoDB on startup ──
// All synchronous readQaData() calls read from this cache.
// All writes update the cache and persist to MongoDB.
let _qaCache = {};

// Write lock: prevents concurrent writes from clobbering each other in the cache.
let _writeQueue = Promise.resolve();
function _withWriteLock(fn) {
    _writeQueue = _writeQueue.then(fn).catch(e => {
        console.error('[writeLock] error:', e.message);
    });
    return _writeQueue;
}

function readQaData() { return _qaCache; }

// Serialized write queue — prevents race conditions on rapid successive writes.
// Writes to the same key are coalesced: only the latest value is persisted.
let _writeLockQueue  = Promise.resolve();
let _pendingWrites   = {};

function writeQaData(data) {
    // Merge into in-memory cache immediately (synchronous, instant reads)
    _qaCache = { ..._qaCache, ...data };
    // Coalesce: later write for same key overwrites earlier pending write
    _pendingWrites = { ..._pendingWrites, ...data };
    // Chain onto the lock — writes are sequential, never concurrent
    _writeLockQueue = _writeLockQueue.then(async () => {
        if (!Object.keys(_pendingWrites).length) return;
        const toWrite   = { ..._pendingWrites };
        _pendingWrites  = {};
        for (const [key, value] of Object.entries(toWrite)) {
            try { await writeKey(key, value); }
            catch (e) {
                console.error('[mongo] writeQaData key failed:', key, e.message);
                // Re-queue failed write so it retries on next call
                _pendingWrites[key] = value;
            }
        }
    }).catch(e => console.error('[mongo] write queue error:', e.message));
}

// ── MongoDB is now the single source of truth — GitHub file sync removed ──
// _ghRequest and GH_API_REPO are kept ONLY for workflow-doc file uploads to GitHub Releases.
const GH_API_REPO = 'AHY18099/AdHash_Project_Dashboard';
function _ghRequest(method, ghPath, body, token) {
    return new Promise((resolve, reject) => {
        const https = require('https');
        const payload = body ? JSON.stringify(body) : null;
        const req = https.request({
            hostname: 'api.github.com', path: ghPath, method,
            headers: {
                'Authorization': `token ${token}`, 'User-Agent': 'AdHash-Dashboard',
                'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json',
                ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
            }
        }, res => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch (_) { resolve({ status: res.statusCode, body: data }); } });
        });
        req.on('error', reject);
        req.setTimeout(12000, () => { req.destroy(); reject(new Error('GitHub API timeout')); });
        if (payload) req.write(payload);
        req.end();
    });
}


let compression;
try { compression = require('compression'); } catch (_) {
    console.warn('[startup] compression module not found — responses will not be compressed');
    compression = null;
}
const app = express();
const PORT = Number(process.env.PORT) || 7777;
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;

// Compress all responses except SSE streams (event-stream must not be compressed/buffered)
if (compression) {
    app.use(compression({
        filter: (req, res) => {
            if (req.path === '/api/events') return false; // never compress SSE
            return compression.filter(req, res);
        }
    }));
}

// ── Real-time SSE broadcast ──
// Map: clientId → { res, userId, userName, connectedAt }
const _sseClients = new Map();
// Wire broadcast.service so new modules can import it without circular deps
require('./src/services/broadcast.service').init(_sseClients);

function broadcastSseEvent(eventName, data, sourceClientId) {
    if (!_sseClients.size) return;
    const payload = `event: ${eventName}\ndata: ${JSON.stringify({ ...data, sourceClientId: sourceClientId || null })}\n\n`;
    const dead = [];
    for (const [clientId, client] of _sseClients) {
        try { client.res.write(payload); } catch (_) { dead.push(clientId); }
    }
    dead.forEach(id => _sseClients.delete(id));
}
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');

const SUPER_ADMIN_EMAIL    = process.env.QA_ADMIN_EMAIL    || 'thenilavan@adhashtech.com';
const SUPER_ADMIN_PASSWORD = process.env.QA_ADMIN_PASSWORD || 'Qateam@123';
const JWT_SECRET = process.env.JWT_SECRET || 'adhash-qa-jwt-secret-change-in-production-2026';

// Apply defaults so all features work on Railway without manual env var setup
// GITHUB_TOKEN must be set as a Railway environment variable — no hardcoded fallback
if (!process.env.ZOHO_MAIL_ENABLED)    process.env.ZOHO_MAIL_ENABLED    = 'true';
if (!process.env.ZOHO_MAIL_FROM)       process.env.ZOHO_MAIL_FROM       = 'thenilavan@adhashtech.com';
if (!process.env.ZOHO_MAIL_TO)         process.env.ZOHO_MAIL_TO         = 'qateam@adhashtech.com';
if (!process.env.ZOHO_MAIL_CC)         process.env.ZOHO_MAIL_CC         = 'qateam@adhashtech.com';
// Zoho REST API OAuth2 credentials (replaces SMTP — Railway blocks all SMTP ports)
if (!process.env.ZOHO_CLIENT_ID)       process.env.ZOHO_CLIENT_ID       = '1000.DVQEG5BEQDFQ0ULRWVPY77ZMFWC77S';
if (!process.env.ZOHO_CLIENT_SECRET)   process.env.ZOHO_CLIENT_SECRET   = 'b297abaa2202667173c98f59fd3ac8185fcdd71969';
if (!process.env.ZOHO_REFRESH_TOKEN)   process.env.ZOHO_REFRESH_TOKEN   = '1000.df711cadb21bd11351c2127e4e6ded37.6367f4b9c445fb1f42e5625479cb5a29';
if (!process.env.ZOHO_ACCOUNT_ID)      process.env.ZOHO_ACCOUNT_ID      = '8370649000000008002';
if (!process.env.SLACK_BOT_TOKEN)    process.env.SLACK_BOT_TOKEN    = process.env.SLACK_BOT_TOKEN || '';
if (!process.env.SLACK_CHANNEL)      process.env.SLACK_CHANNEL      = '#testing-team';
if (!process.env.SLACK_ENABLED)      process.env.SLACK_ENABLED      = 'true';
const SUPER_ADMIN_ROLE = 'super-admin';
const AUTH_COOKIE_NAME = 'adhash_auth';
const AUTH_COOKIE_VALUE = Buffer.from(`${SUPER_ADMIN_EMAIL}:${SUPER_ADMIN_PASSWORD}`).toString('base64url');

// Parse JSON bodies
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// Security headers on every response
app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    // Allow SAMEORIGIN for report endpoints so they can be embedded in iframes
    // on the same domain (project-dashboard uses an iframe to show the report).
    // All other routes keep DENY.
    const isSameOriginOk = req.path === '/api/latest-run-report' ||
        req.path.startsWith('/email-preview/') ||
        req.path.startsWith('/suite-reports/');
    res.set('X-Frame-Options', isSameOriginOk ? 'SAMEORIGIN' : 'DENY');
    res.set('X-XSS-Protection', '1; mode=block');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (IS_PROD) {
        res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
});

function parseCookies(req) {
    const header = req.headers.cookie || '';
    return header.split(';').reduce((cookies, part) => {
        const [rawKey, ...rest] = part.trim().split('=');
        if (!rawKey) return cookies;
        cookies[rawKey] = decodeURIComponent(rest.join('='));
        return cookies;
    }, {});
}

function setAuthCookie(res) {
    const secure = IS_PROD ? '; Secure' : '';
    res.setHeader(
        'Set-Cookie',
        `${AUTH_COOKIE_NAME}=${encodeURIComponent(AUTH_COOKIE_VALUE)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${secure}`
    );
}

function clearAuthCookie(res) {
    const secure = IS_PROD ? '; Secure' : '';
    res.setHeader(
        'Set-Cookie',
        `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`
    );
}

app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
});

// Routes that don't require authentication
const PUBLIC_API_ROUTES = new Set(['/api/auth/login', '/api/auth/session', '/api/auth/logout', '/api/health', '/api/db-diag']);

// Guard all non-public API routes
app.use('/api', (req, res, next) => {
    const route = req.path === '/' ? '/api' : '/api' + req.path;
    // Allow auth routes through
    if (PUBLIC_API_ROUTES.has('/api' + req.path)) return next();
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
    next();
});

// ── ProjectBackup model — snapshot before destructive operations ──────────
let _ProjectBackup = null;
try {
    const mongoose = require('mongoose');
    const BackupSchema = new mongoose.Schema({
        projectId:   String, projectName: String,
        snapshot:    mongoose.Schema.Types.Mixed, reason: String,
        createdAt:   { type: Date, default: Date.now }
    }, { strict: false });
    _ProjectBackup = mongoose.models.ProjectBackup || mongoose.model('ProjectBackup', BackupSchema);
} catch (_) {}

async function backupProject(projectId, reason = 'pre-update') {
    if (!_ProjectBackup) return;
    try {
        const Project = require('./db/models/Project');
        const project = await Project.findOne({ id: projectId }).lean();
        if (!project) return;
        await _ProjectBackup.create({ projectId: project.id, projectName: project.name, snapshot: project, reason });
        console.log(`[Backup] Snapshot saved for ${project.name} — reason: ${reason}`);
    } catch (e) { console.error('[Backup] Failed:', e.message); }
}

// NOTE: /api/projects backup routes are added via routes/projects.js router below.
// They are NOT mounted here directly to avoid route conflicts with the router.

// ── NEW: Mongoose-backed route modules (mounted before legacy file-based routes) ──
// These handle /api/projects CRUD and /api/qa-state — mounted early so Express matches them first.
try {
    app.use('/api/projects', require('./routes/projects'));
    app.use('/api/qa-state', require('./routes/qaState'));
    console.log('[startup] ✅ Mongoose route modules mounted (/api/projects, /api/qa-state)');
} catch (e) {
    console.warn('[startup] ⚠️  Mongoose route modules failed to load:', e.message, '— falling back to legacy routes');
}

// Cookie value encodes email:password for super admin, or email:role:member for members
const MEMBER_COOKIE_PREFIX = 'member:';

function isMemberAuthenticated(req) {
    const cookies = parseCookies(req);
    const val = cookies[AUTH_COOKIE_NAME] || '';
    try {
        const decoded = Buffer.from(val, 'base64url').toString('utf8');
        return decoded.startsWith(MEMBER_COOKIE_PREFIX);
    } catch (_) { return false; }
}

function getSessionFromCookie(req) {
    const cookies = parseCookies(req);
    const val = cookies[AUTH_COOKIE_NAME] || '';
    if (val === AUTH_COOKIE_VALUE) return { role: SUPER_ADMIN_ROLE, email: SUPER_ADMIN_EMAIL };
    try {
        const decoded = Buffer.from(val, 'base64url').toString('utf8');
        if (decoded.startsWith(MEMBER_COOKIE_PREFIX)) {
            const parts = decoded.slice(MEMBER_COOKIE_PREFIX.length).split(':');
            return { role: 'member', email: parts[0], name: parts.slice(1).join(':') };
        }
    } catch (_) {}
    return null;
}

function isAuthenticated(req) {
    // Accept JWT Bearer token (API clients, browser fetch with Authorization header)
    const bearerToken = getBearerToken(req);
    if (bearerToken) {
        const payload = verifyJwt(bearerToken);
        if (payload) return true;
    }
    // Cookie-based auth (browser sessions, SSE via cookie)
    const cookies = parseCookies(req);
    const val = cookies[AUTH_COOKIE_NAME] || '';
    if (val === AUTH_COOKIE_VALUE) return true;
    try {
        const decoded = Buffer.from(val, 'base64url').toString('utf8');
        return decoded.startsWith(MEMBER_COOKIE_PREFIX);
    } catch (_) { return false; }
}

function setMemberCookie(res, email, name) {
    const secure = IS_PROD ? '; Secure' : '';
    const cookieVal = Buffer.from(`${MEMBER_COOKIE_PREFIX}${email}:${name}`).toString('base64url');
    res.setHeader('Set-Cookie',
        `${AUTH_COOKIE_NAME}=${encodeURIComponent(cookieVal)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${secure}`
    );
}

// ── JWT helpers ──────────────────────────────────────────────────────────────
function signJwt(payload) {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}
function verifyJwt(token) {
    try { return jwt.verify(token, JWT_SECRET); } catch (_) { return null; }
}
function getBearerToken(req) {
    const auth = req.headers.authorization || '';
    return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}
// requireAdmin middleware — returns 403 if not super_admin
function requireAdmin(req, res, next) {
    const session = getSessionFromCookie(req);
    const jwtPayload = verifyJwt(getBearerToken(req));
    const role = (jwtPayload && jwtPayload.role) || (session && (session.role === SUPER_ADMIN_ROLE ? 'super_admin' : session.role));
    if (role !== 'super_admin') return res.status(403).json({ error: 'Admin access required' });
    next();
}

// ── Seed super admin in MongoDB on startup ───────────────────────────────────
async function seedSuperAdmin() {
    try {
        const { getDB } = require('./src/db');
        const db = getDB();
        const adminEmail = SUPER_ADMIN_EMAIL.toLowerCase();

        // Ensure ALL users have isActive=true if it's missing (handles legacy users without the field)
        await db.collection('users').updateMany(
            { isActive: { $exists: false } },
            { $set: { isActive: true, updatedAt: new Date() } }
        );

        // Check if super admin already exists with a valid bcrypt password
        const existing = await db.collection('users').findOne({ email: adminEmail, role: 'super_admin' });
        if (existing && existing.password && existing.password.startsWith('$2')) {
            // Already has bcrypt password — only ensure isActive=true, never overwrite password
            if (!existing.isActive) {
                await db.collection('users').updateOne({ email: adminEmail }, { $set: { isActive: true, updatedAt: new Date() } });
            }
            console.log('[auth] ✅ Super admin verified active');
            return;
        }

        // Create or fix super admin (only if no bcrypt password exists)
        const hashed = await bcrypt.hash(SUPER_ADMIN_PASSWORD, 12);
        await db.collection('users').updateOne(
            { email: adminEmail },
            {
                $set: { role: 'super_admin', isActive: true, password: hashed, updatedAt: new Date() },
                $setOnInsert: { id: 'u_sa', name: 'Super Admin', createdAt: new Date() }
            },
            { upsert: true }
        );
        console.log('[auth] ✅ Super admin created/fixed in MongoDB');
    } catch (e) { console.warn('[auth] seedSuperAdmin failed:', e.message); }
}

app.post('/api/auth/login', async (req, res) => {
    const email    = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    try {
        const { getDB } = require('./src/db');
        const db = getDB();

        // Look up in MongoDB users collection first
        const dbUser = db ? await db.collection('users').findOne({ email }) : null;
        if (dbUser) {
            // isActive defaults to true if field missing (legacy records before this field was added)
            const active = dbUser.isActive !== false; // undefined → true, false → false
            if (!active) return res.status(403).json({ error: 'Account is deactivated. Contact your admin.' });
            if (!dbUser.password) return res.status(401).json({ error: 'Password not set. Contact your admin.' });
            const isBcrypt = dbUser.password.startsWith('$2');
            const valid = isBcrypt
                ? await bcrypt.compare(password, dbUser.password).catch(() => false)
                : dbUser.password === password; // legacy plaintext fallback
            if (!valid) return res.status(401).json({ error: 'Incorrect password' });
            // Upgrade plaintext to bcrypt on first login
            if (!isBcrypt) {
                const hashed = await bcrypt.hash(password, 12);
                await db.collection('users').updateOne({ email }, { $set: { password: hashed, isActive: true, updatedAt: new Date() } });
            }
            const payload = { id: dbUser.id, name: dbUser.name, email: dbUser.email, role: dbUser.role };
            const token   = signJwt(payload);
            if (dbUser.role === 'super_admin') setAuthCookie(res);
            else setMemberCookie(res, dbUser.email, dbUser.name);
            return res.json({ success: true, token, user: payload, redirectTo: '/landing' });
        }

        // Legacy fallback: super admin env var check
        if (email === SUPER_ADMIN_EMAIL.toLowerCase() && password === SUPER_ADMIN_PASSWORD) {
            setAuthCookie(res);
            const payload = { id: 'u_sa', name: 'Super Admin', email: SUPER_ADMIN_EMAIL, role: 'super_admin' };
            return res.json({ success: true, token: signJwt(payload), user: payload, redirectTo: '/landing' });
        }

        // Legacy member check in qa_users cache
        const data  = readQaData();
        const users = Array.isArray(data['qa_users']) ? data['qa_users'] : [];
        const user  = users.find(u => u.email && u.email.toLowerCase() === email && u.password === password);
        if (user) {
            setMemberCookie(res, user.email, user.name);
            const payload = { id: user.id || user.email, name: user.name, email: user.email, role: user.role || 'member' };
            return res.json({ success: true, token: signJwt(payload), user: payload, redirectTo: '/landing' });
        }
    } catch (e) { console.error('[auth] login error:', e.message); }

    return res.status(401).json({ success: false, error: 'Invalid email or password' });
});

app.get('/api/auth/session', (req, res) => {
    // Support both JWT Bearer token and legacy cookie
    const jwtPayload = verifyJwt(getBearerToken(req));
    if (jwtPayload) {
        return res.json({ authenticated: true, role: jwtPayload.role, email: jwtPayload.email, name: jwtPayload.name, id: jwtPayload.id });
    }
    const session = getSessionFromCookie(req);
    if (session) {
        return res.json({ authenticated: true, role: session.role === SUPER_ADMIN_ROLE ? 'super_admin' : session.role, email: session.email, name: session.name });
    }
    res.json({ authenticated: false });
});

app.post('/api/auth/logout', (req, res) => {
    clearAuthCookie(res);
    res.json({ success: true });
});

// GET /api/auth/me — verify token
app.get('/api/auth/me', (req, res) => {
    const jwtPayload = verifyJwt(getBearerToken(req));
    if (jwtPayload) return res.json({ user: jwtPayload });
    const session = getSessionFromCookie(req);
    if (session) return res.json({ user: { ...session, role: session.role === SUPER_ADMIN_ROLE ? 'super_admin' : session.role } });
    res.status(401).json({ error: 'Not authenticated' });
});

// POST /api/auth/refresh — silently issue a new 7-day token before the current one expires
app.post('/api/auth/refresh', (req, res) => {
    const jwtPayload = verifyJwt(getBearerToken(req));
    if (!jwtPayload) {
        const session = getSessionFromCookie(req);
        if (!session) return res.status(401).json({ error: 'Not authenticated' });
    }
    const p = jwtPayload || {};
    const token = signJwt({ id: p.id || 'u_sa', name: p.name || 'User', email: p.email || '', role: p.role || 'member' });
    res.json({ token });
});

// ── User management routes ────────────────────────────────────────────────────
// GET /api/users — list all users (no passwords)
app.get('/api/users', async (req, res) => {
    try {
        const { getDB } = require('./src/db');
        const db = getDB();
        if (!db) return res.json([]);
        const users = await db.collection('users')
            .find({}, { projection: { password: 0, _id: 0, updatedAt: 0, createdAt: 0 } })
            .sort({ createdAt: 1 }).toArray();
        res.json(users);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/users/names — lightweight list for dropdowns (active users only)
app.get('/api/users/names', async (req, res) => {
    try {
        const { getDB } = require('./src/db');
        const db = getDB();
        if (!db) {
            // Fallback to qa_users cache
            const data = readQaData();
            const users = Array.isArray(data['qa_users']) ? data['qa_users'] : [];
            return res.json(users.map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role || 'member' })));
        }
        const users = await db.collection('users')
            .find({ isActive: true }, { projection: { id: 1, name: 1, email: 1, role: 1, _id: 0 } })
            .sort({ name: 1 }).toArray();
        res.json(users);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/users — add new user (admin only)
app.post('/api/users', requireAdmin, async (req, res) => {
    try {
        const { name, email, password, role } = req.body || {};
        if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password required' });
        if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
        const { getDB } = require('./src/db');
        const db = getDB();
        const existing = db ? await db.collection('users').findOne({ email: email.toLowerCase() }) : null;
        if (existing) return res.status(400).json({ error: 'Email already exists' });
        const hashed = await bcrypt.hash(password, 12);
        const user = {
            id: 'u_' + Date.now().toString(36),
            name: name.trim(),
            email: email.trim().toLowerCase(),
            password: hashed,
            role: (role === 'super_admin') ? 'super_admin' : 'member',
            isActive: true,
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        if (db) await db.collection('users').insertOne(user);
        // Also sync to qa_users cache so legacy getTeamMembers() still works
        const data = readQaData();
        const users = Array.isArray(data['qa_users']) ? data['qa_users'] : [];
        users.push({ id: user.id, name: user.name, email: user.email, role: user.role, password });
        _qaCache['qa_users'] = users;
        await require('./src/db').writeKey('qa_users', users).catch(() => {});
        broadcastSseEvent('qa-users-update', { action: 'add', user: { id: user.id, name: user.name, email: user.email, role: user.role, isActive: true } });
        res.json({ id: user.id, name: user.name, email: user.email, role: user.role, isActive: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/users/:id — edit user (admin only)
app.put('/api/users/:id', requireAdmin, async (req, res) => {
    try {
        const { name, email, password, role, isActive } = req.body || {};
        const updates = { updatedAt: new Date() };
        if (name     !== undefined) updates.name     = name.trim();
        if (email    !== undefined) updates.email    = email.trim().toLowerCase();
        if (role     !== undefined) updates.role     = role === 'super_admin' ? 'super_admin' : 'member';
        if (isActive !== undefined) updates.isActive = !!isActive;
        if (password) updates.password = await bcrypt.hash(password, 12);
        const { getDB } = require('./src/db');
        const db = getDB();
        if (db) await db.collection('users').updateOne({ id: req.params.id }, { $set: updates });
        // Sync to qa_users cache
        const data = readQaData();
        const users = Array.isArray(data['qa_users']) ? data['qa_users'] : [];
        const idx = users.findIndex(u => u.id === req.params.id);
        if (idx >= 0) {
            if (updates.name)     users[idx].name     = updates.name;
            if (updates.email)    users[idx].email    = updates.email;
            if (updates.role)     users[idx].role     = updates.role;
            if (updates.isActive !== undefined) users[idx].isActive = updates.isActive;
            if (password)         users[idx].password = password; // plaintext for legacy fallback
            _qaCache['qa_users'] = users;
        }
        broadcastSseEvent('qa-users-update', { action: 'update', userId: req.params.id, updates: { name: updates.name, email: updates.email, role: updates.role, isActive: updates.isActive } });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/users/:id — deactivate (admin only, never hard-delete)
app.delete('/api/users/:id', requireAdmin, async (req, res) => {
    try {
        const { getDB } = require('./src/db');
        const db = getDB();
        if (db) await db.collection('users').updateOne({ id: req.params.id }, { $set: { isActive: false, updatedAt: new Date() } });
        broadcastSseEvent('qa-users-update', { action: 'deactivate', userId: req.params.id });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/users/:id/reset-password — admin resets a user's password
app.put('/api/users/:id/reset-password', requireAdmin, async (req, res) => {
    try {
        const { password } = req.body || {};
        if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
        const { getDB } = require('./src/db');
        const db = getDB();
        const hashed = await bcrypt.hash(password, 12);
        if (db) await db.collection('users').updateOne({ id: req.params.id }, { $set: { password: hashed, isActive: true, updatedAt: new Date() } });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Store test execution status
let testRunning = false;
let testResults = null;
let testLogs = [];
let currentSuite = null;
let testProcessPid = null;
let testProcessRef = null;
let lastMailDispatchKey = null;

// Store server logs
const serverLogs = [];
const MAX_LOGS = 100;
const DASHBOARD_STATE_PATH = path.join(__dirname, 'test-results', 'dashboard-state.json');
const DOMAIN_REPORT_OUTPUT_PATH = path.join(__dirname, 'godaddy', 'report.html');
const CERTIFICATE_REPORT_OUTPUT_PATH = path.join(__dirname, 'suite-reports', 'AdHash_Projects_Certificate_Expiry_Test.html');
const DOMAIN_MODULE_REPORT_PATH = path.join(__dirname, 'final-dashboard-bundle', 'module-reports', 'domain.html');
const SSL_MODULE_REPORT_PATH = path.join(__dirname, 'final-dashboard-bundle', 'module-reports', 'ssl.html');
const EXPIRY_WARNING_DAYS = 30;
const WORKSPACE_SUITES = {
    app: {
        id: 'app',
        name: 'App Status Verification',
        repository: 'Adhash_App_Status',
        specPath: 'tests/app-status/playstore.spec.ts',
        countKey: 'appStatus',
        countPattern: /test\(/g
    },
    server: {
        id: 'server',
        name: 'Server Health Monitoring',
        repository: 'Adhash_AllProjects_Server',
        specPath: 'tests/server-health/server-check.spec.ts',
        countKey: 'serverHealth',
        countPattern: /\{\s*name:/g
    },
    cert: {
        id: 'cert',
        name: 'SSL Certificate Monitoring',
        repository: 'AdHash-Projects-Certificate-Expiry-Test',
        specPath: 'tests/certificate/cert-expiry.spec.ts',
        countKey: 'sslCertificate',
        countPattern: /\{\s*name:/g
    },
    api: {
        id: 'api',
        name: 'API Endpoint Testing',
        repository: 'AdHash-API-Test',
        specPath: 'tests/api/api-tests.spec.ts',
        countKey: 'apiEndpoint',
        countPattern: /\{\s*name:/g
    },
    domain: {
  id: 'domain',
  name: 'Domain Expiry Monitoring',
  repository: 'AdHash_Domain_Report',
  specPath: '__external__',
  countKey: 'domainExpiry',
  countPattern: /Checking\s+([^(]+)\s+\(([^)]+)\)\.\.\./g
}
};

function isSuiteConfigured(config) {
  if (!config) return false;

  if (config.id === 'domain') {
    return fs.existsSync(path.join(__dirname, 'godaddy', 'package.json'));
  }

  return !!(config.specPath && fs.existsSync(path.join(__dirname, config.specPath)));
}

function countSuiteTests(config) {
    if (!config || !config.specPath || !config.countPattern) {
        return 0;
    }

    const suiteFilePath = path.join(__dirname, config.specPath);
    if (!fs.existsSync(suiteFilePath)) {
        return 0;
    }

    const content = fs.readFileSync(suiteFilePath, 'utf8');
    const matches = content.match(config.countPattern);
    return matches ? matches.length : 0;
}

function createDefaultDetailedResults() {
    return {
        app: { status: 'not-run', passed: 0, failed: 0, warning: 0, total: 0, details: [] },
        server: { status: 'not-run', passed: 0, failed: 0, warning: 0, total: 0, details: [] },
        cert: { status: 'not-run', passed: 0, failed: 0, warning: 0, total: 0, details: [] },
        api: { status: 'not-run', passed: 0, failed: 0, warning: 0, total: 0, details: [] },
        domain: {
            status: 'unavailable',
            passed: 0,
            failed: 0,
            warning: 0,
            total: 0,
            details: [],
            message: WORKSPACE_SUITES.domain.unavailableMessage
        }
    };
}

function readDashboardState() {
    if (!fs.existsSync(DASHBOARD_STATE_PATH)) {
        return null;
    }

    try {
        return JSON.parse(fs.readFileSync(DASHBOARD_STATE_PATH, 'utf8'));
    } catch (error) {
        console.error('Error reading dashboard state:', error);
        return null;
    }
}

// Helper function to log messages to array
function logToArray(level, message) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        level: level,
        message: message
    };
    serverLogs.push(logEntry);

    // Keep only last MAX_LOGS entries
    if (serverLogs.length > MAX_LOGS) {
        serverLogs.shift();
    }

    // Also log to console
    console.log(`[${level.toUpperCase()}] ${message}`);
}

// API endpoint to get test suite counts WITHOUT running tests
app.get('/api/test-counts', (req, res) => {
    const counts = {
        appStatus: 0,
        serverHealth: 0,
        sslCertificate: 0,
        apiEndpoint: 0,
        domainExpiry: 0,
        total: 0
    };

    try {
        Object.values(WORKSPACE_SUITES).forEach((config) => {
            counts[config.countKey] = isSuiteConfigured(config) ? countSuiteTests(config) : 0;
        });

        counts.total = counts.appStatus + counts.serverHealth + counts.sslCertificate + counts.apiEndpoint + counts.domainExpiry;

        res.json({
            status: 'success',
            counts: counts
        });
    } catch (error) {
        console.error('Error counting tests:', error);
        res.json({
            status: 'error',
            message: error.message,
            counts: counts
        });
    }
});

// Helper function to check if a process is actually running
function isProcessRunning(pid) {
    if (!pid) return false;
    try {
        // Sending signal 0 checks if process exists without killing it
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return false;
    }
}

function buildMailDispatchKey(state) {
    if (!state || !state.summary) {
        return null;
    }

    const summary = state.summary;
    return [
        state.generatedAt || '',
        summary.passedSuites || 0,
        summary.failedSuites || 0,
        summary.skippedSuites || 0,
        summary.totalSuites || 0
    ].join('|');
}

function escapeHtml(value) {
        return String(value || '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
}

function normalizeSuiteStatus(value) {
    const status = String(value || '').toLowerCase();
    if (status === 'passed' || status === 'failed' || status === 'warning') {
        return status;
    }
    if (status === 'unavailable' || status === 'not-run') {
        return 'skipped';
    }
    return 'skipped';
}

function getSuiteDisplayLabel(key) {
    const suiteLabels = {
        app: 'App Status Verification',
        server: 'Server Health Monitoring',
        cert: 'SSL Certificate Monitoring',
        api: 'API Endpoint Testing',
        domain: 'Domain Expiry Monitoring'
    };

    return suiteLabels[key] || key;
}

// Builds a single chip badge for the email template dark-card style
function buildTemplateChip(count, label, color) {
    return `<table role="presentation" cellpadding="0" cellspacing="0" style="display:inline-table;margin-right:8px;margin-bottom:6px;border-collapse:separate;"><tr><td style="background-color:#f0f0f0;border:2px solid ${color};border-radius:18px;padding:5px 12px;font-size:12px;line-height:14px;font-weight:700;color:${color};font-family:Arial,'Segoe UI',sans-serif;white-space:nowrap;">${escapeHtml(label)} ${count}</td></tr></table>`;
}

// Builds failed item rows matching the email template dark-card style
function buildTemplateFailedItemsHtml(failedItems) {
    const rows = failedItems.map((item) => {
        const name = item.name || item.domain || item.url || 'Unknown';
        const projectLine = item.projectName ? `<div style="margin-top:6px;font-size:13px;color:#d1d5db;"><strong style="color:#ffffff;">Project:</strong> ${escapeHtml(item.projectName)}</div>` : '';
        const urlLine = item.url ? `<div style="margin-top:6px;font-size:13px;color:#d1d5db;"><strong style="color:#ffffff;">URL:</strong> ${escapeHtml(item.url)}</div>` : '';
        const durationLine = item.duration ? `<div style="margin-top:6px;font-size:13px;color:#d1d5db;"><strong style="color:#ffffff;">Duration:</strong> ${escapeHtml(String(item.duration))}</div>` : '';
        const reason = item.reason || item.message || (item.responseCode ? `Response code: ${item.responseCode}` : '') || 'Failed during execution';
        const reasonLine = `<div style="margin-top:6px;font-size:13px;color:#fca5a5;"><strong style="color:#ffffff;">Error Reason:</strong> ${escapeHtml(reason)}</div>`;
        return `<tr><td style="padding:0 0 12px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#2a1114" style="background-color:#2a1114;border:1px solid #ef4444;border-collapse:separate;border-radius:14px;"><tr><td style="padding:14px 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="font-size:14px;line-height:18px;font-weight:700;color:#ffffff;font-family:Arial,'Segoe UI',sans-serif;padding-right:12px;vertical-align:top;">&#x2717; ${escapeHtml(name)}</td><td width="92" align="right" style="vertical-align:top;"><table role="presentation" cellpadding="0" cellspacing="0" align="right"><tr><td bgcolor="#ef4444" style="background-color:#ef4444;border-radius:999px;padding:4px 10px;font-size:11px;line-height:13px;font-weight:800;letter-spacing:0.7px;color:#ffffff;font-family:Arial,'Segoe UI',sans-serif;white-space:nowrap;">FAILED</td></tr></table></td></tr><tr><td colspan="2" style="padding-top:4px;">${projectLine}${urlLine}${durationLine}${reasonLine}</td></tr></table></td></tr></table></td></tr>`;
    });
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows.join('')}</table>`;
}

// Builds all failed-module section cards for injection into the locked email template
function buildFailedModulesHtmlForTemplate(state) {
    const suites = (state && state.suites) || {};
    const moduleConfig = [
        { key: 'app',    label: 'App Status' },
        { key: 'server', label: 'Server Health' },
        { key: 'cert',   label: 'SSL Certificate Status' },
        { key: 'api',    label: 'API Status' },
        { key: 'domain', label: 'Domain Status' }
    ];

    let mapping;
    try { mapping = getProjectMapping(); } catch (e) { mapping = { projects: [] }; }
    const projects = mapping.projects || [];

    return moduleConfig.map(({ key, label }) => {
        let total = 0, failed = 0, skipped = 0;
        let failedItems = [];

        if (key === 'api' || key === 'server' || key === 'app') {
            // Use per-project results — suite-level details array may be empty for these types
            const getResults = key === 'api' ? getAPITestResults
                             : key === 'server' ? getServerTestResults
                             : getAppTestResults;
            projects.forEach((project) => {
                const result = getResults(project.id);
                total += result.total;
                failed += result.failed;
                skipped += result.skipped;
                (result.tests || []).forEach((test) => {
                    if ((test.status || '').toLowerCase() === 'failed') {
                        failedItems.push({ ...test, projectName: project.name });
                    }
                });
            });
        } else {
            const suite = suites[key] || {};
            total = Number(suite.total || 0);
            failed = Number(suite.failed || 0);
            skipped = Number(suite.skipped || 0);
            const details = Array.isArray(suite.details) ? suite.details : [];
            failedItems = details.filter((d) => {
                const s = String((d && d.status) || '').toLowerCase();
                return s === 'failed' || s === 'error';
            });
        }

        const headerBg = failed > 0 ? '#7f1d1d' : '#065f46';
        let chips = buildTemplateChip(total, 'TOTAL', '#3b82f6');
        if (skipped > 0) chips += buildTemplateChip(skipped, 'SKIP', '#6b7280');
        if (failed > 0) chips += buildTemplateChip(failed, 'FAIL', '#ef4444');

        const bodyContent = failedItems.length === 0
            ? '<div style="padding:16px 14px;border-radius:14px;background:#0b1524;border:1px dashed rgba(148,163,184,0.3);font-size:13px;line-height:18px;color:#94a3b8;text-align:center;">No failed or warning checks in this module.</div>'
            : buildTemplateFailedItemsHtml(failedItems);

        return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#050b17" style="margin-top:20px;background-color:#050b17;border:1px solid #1f2937;border-collapse:separate;border-radius:18px;overflow:hidden;"><tr><td style="padding:18px 20px;background:${headerBg};font-family:Arial,'Segoe UI',sans-serif;"><div style="font-size:18px;line-height:22px;font-weight:800;color:#ffffff;">${escapeHtml(label)} <span style="color:#cbd5e1;">(${total})</span></div><div style="padding-top:10px;">${chips}</div></td></tr><tr><td style="padding:18px 20px;font-family:Arial,'Segoe UI',sans-serif;">${bodyContent}</td></tr></table>`;
    }).join('');
}

function buildSuiteRowsHtml(state) {
        const suites = (state && state.suites) || {};
        const orderedSuiteKeys = ['app', 'server', 'cert', 'api', 'domain'];

        return orderedSuiteKeys
                .map((key) => {
                        const suite = suites[key] || {};
                        const normalizedStatus = normalizeSuiteStatus(suite.status);
                        const badgeBg = normalizedStatus === 'passed'
                                ? '#e8f7ee'
                                : normalizedStatus === 'failed'
                                        ? '#fdecea'
                                        : '#fff8e6';
                        const badgeColor = normalizedStatus === 'passed'
                                ? '#146c43'
                                : normalizedStatus === 'failed'
                                        ? '#b42318'
                                        : '#8a6d3b';

                        return `<tr>
                            <td style="padding:10px;border:1px solid #e5e7eb;font-size:13px;color:#111827;">${escapeHtml(getSuiteDisplayLabel(key))}</td>
                                <td style="padding:10px;border:1px solid #e5e7eb;text-align:center;">
                                        <span style="display:inline-block;padding:3px 8px;border-radius:999px;background:${badgeBg};color:${badgeColor};font-size:12px;font-weight:600;text-transform:uppercase;">${escapeHtml(normalizedStatus)}</span>
                                </td>
                                <td style="padding:10px;border:1px solid #e5e7eb;text-align:center;font-size:13px;">${Number(suite.total || 0)}</td>
                                <td style="padding:10px;border:1px solid #e5e7eb;text-align:center;font-size:13px;color:#146c43;">${Number(suite.passed || 0)}</td>
                                <td style="padding:10px;border:1px solid #e5e7eb;text-align:center;font-size:13px;color:#b42318;">${Number(suite.failed || 0)}</td>
                                <td style="padding:10px;border:1px solid #e5e7eb;text-align:center;font-size:13px;color:#8a6d3b;">${Number(suite.warning || 0)}</td>
                                <td style="padding:10px;border:1px solid #e5e7eb;text-align:center;font-size:13px;color:#6b7280;">${Number(suite.skipped || 0)}</td>
                        </tr>`;
                })
                .join('');
}

        function buildFailedDetailsRowsHtml(state) {
            const suites = (state && state.suites) || {};
            const orderedSuiteKeys = ['app', 'server', 'cert', 'api', 'domain'];
            const rows = [];

            orderedSuiteKeys.forEach((suiteKey) => {
                const suite = suites[suiteKey] || {};
                const failedCount = Number(suite.failed || 0);
                if (failedCount <= 0) {
                    return;
                }

                const details = Array.isArray(suite.details) ? suite.details : [];
                const failedDetails = details.filter((detail) => {
                    const status = String((detail && detail.status) || '').toLowerCase();
                    return status === 'failed' || status === 'error';
                });

                if (failedDetails.length === 0) {
                    rows.push(`<tr>
                        <td style="padding:10px;border:1px solid #e5e7eb;font-size:13px;">${escapeHtml(getSuiteDisplayLabel(suiteKey))}</td>
                        <td style="padding:10px;border:1px solid #e5e7eb;font-size:13px;">${escapeHtml('Failed checks summary')}</td>
                        <td style="padding:10px;border:1px solid #e5e7eb;font-size:13px;color:#b42318;">${escapeHtml(`Total failed checks: ${failedCount}`)}</td>
                    </tr>`);
                    return;
                }

                failedDetails.forEach((detail) => {
                    const itemName = detail.name || detail.domain || detail.url || 'Unknown check';
                    const reason = detail.reason
                        || detail.message
                        || (detail.responseCode ? `Response code: ${detail.responseCode}` : '')
                        || (detail.expiryDate ? `Expiry: ${detail.expiryDate}` : '')
                        || 'Failed during execution';

                    rows.push(`<tr>
                        <td style="padding:10px;border:1px solid #e5e7eb;font-size:13px;">${escapeHtml(getSuiteDisplayLabel(suiteKey))}</td>
                        <td style="padding:10px;border:1px solid #e5e7eb;font-size:13px;">${escapeHtml(itemName)}</td>
                        <td style="padding:10px;border:1px solid #e5e7eb;font-size:13px;color:#b42318;">${escapeHtml(reason)}</td>
                    </tr>`);
                });
            });

            if (rows.length === 0) {
                return `<tr>
                    <td colspan="3" style="padding:12px;border:1px solid #e5e7eb;font-size:13px;color:#146c43;text-align:center;">No failed checks in this run.</td>
                </tr>`;
            }

            return rows.join('');
        }

        function buildProjectViewRowsHtml() {
            let mapping;
            try {
                mapping = getProjectMapping();
            } catch (error) {
                return `<tr><td colspan="7" style="padding:12px;border:1px solid #e5e7eb;color:#b42318;">Unable to load project mapping for project view.</td></tr>`;
            }

            const projects = Array.isArray(mapping && mapping.projects) ? mapping.projects : [];
            if (projects.length === 0) {
                return `<tr><td colspan="7" style="padding:12px;border:1px solid #e5e7eb;color:#6b7280;">No projects configured.</td></tr>`;
            }

            const rows = projects.map((project) => {
                const app = getAppTestResults(project.id);
                const server = getServerTestResults(project.id);
                const ssl = getSSLTestResults(project.id);
                const domain = getDomainTestResults(project.id);
                const api = getAPITestResults(project.id);

                const total = Number(app.total || 0) + Number(server.total || 0) + Number(ssl.total || 0) + Number(domain.total || 0) + Number(api.total || 0);
                const passed = Number(app.passed || 0) + Number(server.passed || 0) + Number(ssl.passed || 0) + Number(domain.passed || 0) + Number(api.passed || 0);
                const failed = Number(app.failed || 0) + Number(server.failed || 0) + Number(ssl.failed || 0) + Number(domain.failed || 0) + Number(api.failed || 0);
                const warning = Number(app.warning || 0) + Number(server.warning || 0) + Number(ssl.warning || 0) + Number(domain.warning || 0) + Number(api.warning || 0);
                const skipped = Number(app.skipped || 0) + Number(server.skipped || 0) + Number(ssl.skipped || 0) + Number(domain.skipped || 0) + Number(api.skipped || 0);

                const status = failed > 0 ? 'failed' : (warning > 0 ? 'warning' : (skipped > 0 ? 'skipped' : 'passed'));
                const badgeBg = status === 'passed' ? '#e8f7ee' : status === 'failed' ? '#fdecea' : '#fff8e6';
                const badgeColor = status === 'passed' ? '#146c43' : status === 'failed' ? '#b42318' : '#8a6d3b';

                return {
                    sortWeight: failed * 100000 + warning * 1000 + skipped * 100 + total,
                    html: `<tr>
                        <td style="padding:10px;border:1px solid #e5e7eb;font-size:13px;">${escapeHtml(project.name || project.id)}</td>
                        <td style="padding:10px;border:1px solid #e5e7eb;text-align:center;"><span style="display:inline-block;padding:3px 8px;border-radius:999px;background:${badgeBg};color:${badgeColor};font-size:12px;font-weight:600;text-transform:uppercase;">${escapeHtml(status)}</span></td>
                        <td style="padding:10px;border:1px solid #e5e7eb;text-align:center;font-size:13px;">${total}</td>
                        <td style="padding:10px;border:1px solid #e5e7eb;text-align:center;font-size:13px;color:#146c43;">${passed}</td>
                        <td style="padding:10px;border:1px solid #e5e7eb;text-align:center;font-size:13px;color:#b42318;">${failed}</td>
                        <td style="padding:10px;border:1px solid #e5e7eb;text-align:center;font-size:13px;color:#8a6d3b;">${warning}</td>
                        <td style="padding:10px;border:1px solid #e5e7eb;text-align:center;font-size:13px;color:#6b7280;">${skipped}</td>
                    </tr>`
                };
            });

            return rows
                .sort((a, b) => b.sortWeight - a.sortWeight)
                .map((entry) => entry.html)
                .join('');
        }

function buildSummaryEmailHtml(summary, state) {
        const generatedAt = escapeHtml(state && state.generatedAt ? state.generatedAt : new Date().toISOString());
        const passed = Number(summary.passedSuites || 0);
        const failed = Number(summary.failedSuites || 0);
        const warning = Number(summary.warningSuites || 0);
        const skipped = Number(summary.skippedSuites || 0);
        const total = Number(summary.totalSuites || 0);

        return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#111827;">
    <div style="max-width:900px;margin:0 auto;padding:24px;">
        <div style="background:#111827;color:#ffffff;border-radius:12px;padding:20px;">
            <h2 style="margin:0 0 8px 0;font-size:22px;">AdHash QA Summary Report</h2>
            <div style="font-size:13px;opacity:0.9;">Generated: ${generatedAt}</div>
        </div>

        <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;margin-top:14px;padding:16px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
                <tr>
                    <td style="padding:10px;border:1px solid #e5e7eb;text-align:center;"><div style="font-size:12px;color:#6b7280;">Total Suites</div><div style="font-size:24px;font-weight:700;">${total}</div></td>
                    <td style="padding:10px;border:1px solid #e5e7eb;text-align:center;"><div style="font-size:12px;color:#6b7280;">Passed</div><div style="font-size:24px;font-weight:700;color:#146c43;">${passed}</div></td>
                    <td style="padding:10px;border:1px solid #e5e7eb;text-align:center;"><div style="font-size:12px;color:#6b7280;">Failed</div><div style="font-size:24px;font-weight:700;color:#b42318;">${failed}</div></td>
                    <td style="padding:10px;border:1px solid #e5e7eb;text-align:center;"><div style="font-size:12px;color:#6b7280;">Warning</div><div style="font-size:24px;font-weight:700;color:#8a6d3b;">${warning}</div></td>
                    <td style="padding:10px;border:1px solid #e5e7eb;text-align:center;"><div style="font-size:12px;color:#6b7280;">Skipped</div><div style="font-size:24px;font-weight:700;color:#6b7280;">${skipped}</div></td>
                </tr>
            </table>
        </div>

        <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;margin-top:14px;padding:16px;">
            <h3 style="margin:0 0 12px 0;font-size:18px;">Suite Breakdown</h3>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
                <thead>
                    <tr>
                        <th style="padding:10px;border:1px solid #e5e7eb;background:#f9fafb;text-align:left;font-size:12px;color:#374151;">Suite</th>
                        <th style="padding:10px;border:1px solid #e5e7eb;background:#f9fafb;text-align:center;font-size:12px;color:#374151;">Status</th>
                        <th style="padding:10px;border:1px solid #e5e7eb;background:#f9fafb;text-align:center;font-size:12px;color:#374151;">Total</th>
                        <th style="padding:10px;border:1px solid #e5e7eb;background:#f9fafb;text-align:center;font-size:12px;color:#374151;">Passed</th>
                        <th style="padding:10px;border:1px solid #e5e7eb;background:#f9fafb;text-align:center;font-size:12px;color:#374151;">Failed</th>
                        <th style="padding:10px;border:1px solid #e5e7eb;background:#f9fafb;text-align:center;font-size:12px;color:#374151;">Warning</th>
                        <th style="padding:10px;border:1px solid #e5e7eb;background:#f9fafb;text-align:center;font-size:12px;color:#374151;">Skipped</th>
                    </tr>
                </thead>
                <tbody>
                    ${buildSuiteRowsHtml(state)}
                </tbody>
            </table>
        </div>

        <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;margin-top:14px;padding:16px;">
            <h3 style="margin:0 0 12px 0;font-size:18px;color:#b42318;">Failed Details</h3>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
                <thead>
                    <tr>
                        <th style="padding:10px;border:1px solid #e5e7eb;background:#fef2f2;text-align:left;font-size:12px;color:#7f1d1d;">Suite</th>
                        <th style="padding:10px;border:1px solid #e5e7eb;background:#fef2f2;text-align:left;font-size:12px;color:#7f1d1d;">Item</th>
                        <th style="padding:10px;border:1px solid #e5e7eb;background:#fef2f2;text-align:left;font-size:12px;color:#7f1d1d;">Reason</th>
                    </tr>
                </thead>
                <tbody>
                    ${buildFailedDetailsRowsHtml(state)}
                </tbody>
            </table>
        </div>

        <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;margin-top:14px;padding:16px;">
            <h3 style="margin:0 0 12px 0;font-size:18px;">Project View</h3>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
                <thead>
                    <tr>
                        <th style="padding:10px;border:1px solid #e5e7eb;background:#f9fafb;text-align:left;font-size:12px;color:#374151;">Project</th>
                        <th style="padding:10px;border:1px solid #e5e7eb;background:#f9fafb;text-align:center;font-size:12px;color:#374151;">Status</th>
                        <th style="padding:10px;border:1px solid #e5e7eb;background:#f9fafb;text-align:center;font-size:12px;color:#374151;">Total</th>
                        <th style="padding:10px;border:1px solid #e5e7eb;background:#f9fafb;text-align:center;font-size:12px;color:#374151;">Passed</th>
                        <th style="padding:10px;border:1px solid #e5e7eb;background:#f9fafb;text-align:center;font-size:12px;color:#374151;">Failed</th>
                        <th style="padding:10px;border:1px solid #e5e7eb;background:#f9fafb;text-align:center;font-size:12px;color:#374151;">Warning</th>
                        <th style="padding:10px;border:1px solid #e5e7eb;background:#f9fafb;text-align:center;font-size:12px;color:#374151;">Skipped</th>
                    </tr>
                </thead>
                <tbody>
                    ${buildProjectViewRowsHtml()}
                </tbody>
            </table>
        </div>

        <div style="padding:10px 4px 0 4px;font-size:12px;color:#6b7280;">
            This email is optimized for mailbox rendering (no script-dependent report layout).
        </div>
    </div>
</body>
</html>`;
}

async function dispatchZohoSummaryMail(state) {
    if (!state) {
        addLog('ℹ️ Zoho mail skipped: no state available.', 'info');
        return;
    }
    if (process.env.ZOHO_MAIL_ENABLED !== 'true') {
        addLog('ℹ️ Zoho mail skipped: ZOHO_MAIL_ENABLED is not true.', 'info');
        return;
    }

    // Reconstruct summary if missing
    let summary = state.summary;
    if (!summary && state.suites) {
        // Aggregate from suite results
        const suiteKeys = Object.keys(state.suites);
        let passed = 0, failed = 0, warning = 0, skipped = 0, total = 0;
        suiteKeys.forEach(k => {
            const s = state.suites[k];
            if (!s) return;
            passed += s.passed || 0;
            failed += s.failed || 0;
            warning += s.warning || 0;
            skipped += s.skipped || 0;
            total += s.total || 0;
        });
        summary = {
            passedSuites: passed,
            failedSuites: failed,
            warningSuites: warning,
            skippedSuites: skipped,
            totalSuites: total
        };
        addLog('⚠️ Summary missing in dashboard state, reconstructed for mail send.', 'warning');
    }
    if (!summary) {
        addLog('❌ Zoho mail not sent: summary missing and could not reconstruct.', 'error');
        return;
    }

    // Use timestamp + counts as dedup key; always include a wall-clock component so
    // repeated runs with the same counts still send (generatedAt changes each run).
    const runTs = state.generatedAt || new Date().toISOString();
    const mailDispatchKey = [runTs, summary.passedSuites || 0, summary.failedSuites || 0, summary.skippedSuites || 0, summary.totalSuites || 0].join('|');
    if (mailDispatchKey === lastMailDispatchKey) {
        addLog('ℹ️ Zoho mail not sent: already sent for this exact run.', 'info');
        return;
    }

    addLog(`📧 Preparing email report (passed:${summary.passedSuites} failed:${summary.failedSuites} total:${summary.totalSuites})...`, 'info');

    // Permanently locked to Email Preview style. Inject live failed-module data at placeholder.
    const emailPreviewCandidates = [
        path.join(__dirname, 'email-preview', 'AdHash-Projects-Dashboard.html'),
        path.join(__dirname, 'email-preview', 'index.html')
    ];
    const emailPreviewPath = emailPreviewCandidates.find((candidate) => fs.existsSync(candidate));

    let html;
    if (emailPreviewPath) {
        addLog(`📄 Using email template: ${emailPreviewPath}`, 'info');
        html = fs.readFileSync(emailPreviewPath, 'utf8');
        if (html.includes('<!--LIVE_FAILED_MODULES-->')) {
            html = html.replace('<!--LIVE_FAILED_MODULES-->', buildFailedModulesHtmlForTemplate(state));
        }
    } else {
        addLog('ℹ️ Email template not found — generating inline summary email.', 'info');
        const dateStr = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        const suites = (state && state.suites) || {};
        const suiteRows = ['app','server','cert','api','domain'].map(k => {
            const s = suites[k] || {};
            const st = String(s.status||'').toLowerCase();
            const color = st.includes('pass') ? '#059669' : st.includes('fail') ? '#dc2626' : '#d97706';
            return `<tr><td style="padding:8px 12px;border:1px solid #e5e7eb;font-size:13px">${k.toUpperCase()}</td><td style="padding:8px 12px;border:1px solid #e5e7eb;text-align:center;font-weight:700;color:${color}">${s.status||'—'}</td><td style="padding:8px 12px;border:1px solid #e5e7eb;text-align:center">${s.total||0}</td><td style="padding:8px 12px;border:1px solid #e5e7eb;text-align:center;color:#059669">${s.passed||s.pass||0}</td><td style="padding:8px 12px;border:1px solid #e5e7eb;text-align:center;color:#dc2626">${s.failed||s.fail||0}</td></tr>`;
        }).join('');
        html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family:Arial,sans-serif;background:#f1f5f9;margin:0;padding:32px">
<div style="max-width:680px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.1)">
  <div style="background:linear-gradient(135deg,#1e3a5f 0%,#0f172a 100%);padding:28px 32px;color:#fff">
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;opacity:.6;margin-bottom:8px">AdHash QA Dashboard</div>
    <div style="font-size:24px;font-weight:800;margin-bottom:6px">Test Run Complete</div>
    <div style="font-size:13px;opacity:.7">${dateStr}</div>
  </div>
  <div style="padding:28px 32px">
    <div style="display:flex;gap:12px;margin-bottom:24px;flex-wrap:wrap">
      <div style="flex:1;min-width:120px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:16px;text-align:center"><div style="font-size:28px;font-weight:800;color:#059669">${summary.passedSuites||0}</div><div style="font-size:11px;color:#059669;font-weight:700;text-transform:uppercase">Passed</div></div>
      <div style="flex:1;min-width:120px;background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:16px;text-align:center"><div style="font-size:28px;font-weight:800;color:#dc2626">${summary.failedSuites||0}</div><div style="font-size:11px;color:#dc2626;font-weight:700;text-transform:uppercase">Failed</div></div>
      <div style="flex:1;min-width:120px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px;text-align:center"><div style="font-size:28px;font-weight:800;color:#475569">${summary.totalSuites||0}</div><div style="font-size:11px;color:#475569;font-weight:700;text-transform:uppercase">Total</div></div>
    </div>
    <table width="100%" style="border-collapse:collapse;font-size:13px;margin-top:8px">
      <thead><tr style="background:#f8fafc"><th style="padding:10px 12px;border:1px solid #e5e7eb;text-align:left;font-size:11px;text-transform:uppercase;color:#64748b">Suite</th><th style="padding:10px 12px;border:1px solid #e5e7eb;text-align:center;font-size:11px;text-transform:uppercase;color:#64748b">Status</th><th style="padding:10px 12px;border:1px solid #e5e7eb;text-align:center;font-size:11px;text-transform:uppercase;color:#64748b">Total</th><th style="padding:10px 12px;border:1px solid #e5e7eb;text-align:center;font-size:11px;text-transform:uppercase;color:#059669">Pass</th><th style="padding:10px 12px;border:1px solid #e5e7eb;text-align:center;font-size:11px;text-transform:uppercase;color:#dc2626">Fail</th></tr></thead>
      <tbody>${suiteRows}</tbody>
    </table>
    ${buildFailedModulesHtmlForTemplate(state)}
  </div>
  <div style="padding:14px 32px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:11px;color:#94a3b8;text-align:center">Generated by AdHash QA Dashboard &nbsp;·&nbsp; ${dateStr}</div>
</div></body></html>`;
    }

    addLog(`📤 Sending via Zoho SMTP to ${process.env.ZOHO_MAIL_TO} from ${process.env.ZOHO_MAIL_FROM}...`, 'info');
    try {
        await sendZohoMail({
            subject: `AdHash QA Report — ${summary.passedSuites} Passed, ${summary.failedSuites} Failed | ${new Date().toLocaleDateString('en-IN')}`,
            html
        });
        lastMailDispatchKey = mailDispatchKey;
        addLog(`✅ Test report email sent to ${process.env.ZOHO_MAIL_TO}`, 'success');
    } catch (err) {
        addLog('❌ Failed to send Zoho Mail: ' + (err && err.message), 'error');
        console.error('Failed to send Zoho Mail:', err);
    }
}

async function recoverCompletedRunFromState() {
    const state = readDashboardState();
    if (!state || !state.summary) {
        return false;
    }

    testResults = {
        status: 'completed',
        totalTests: state.summary.totalSuites,
        passed: state.summary.passedSuites,
        failed: state.summary.failedSuites,
        timestamp: state.generatedAt || new Date().toISOString()
    };

    try {
        await dispatchZohoSummaryMail(state);
    } catch (mailErr) {
        addLog('❌ Failed to send Zoho Mail: ' + (mailErr && mailErr.message), 'error');
        console.error('Failed to send Zoho Mail:', mailErr);
    }

    return true;
}

// API endpoint to check if tests are running
app.get('/api/test-status', async (req, res) => {
    const trackedProcessAlive = Boolean(testProcessRef && testProcessRef.exitCode === null && !testProcessRef.killed);

    // Auto-recover from stuck state: if testRunning is true but process is dead, reset state
    if (testRunning && !trackedProcessAlive && !isProcessRunning(testProcessPid)) {
        console.log('⚠️ Test process is dead but flag is stuck. Auto-resetting state...');
        testRunning = false;
        testProcessPid = null;
        testProcessRef = null;
        currentSuite = null;
        await recoverCompletedRunFromState();
    }

    const persistedState = readDashboardState();
    const hasPersistedResults = !!(persistedState && persistedState.summary);
    const persistedResults = hasPersistedResults ? {
        status: 'completed',
        totalTests: persistedState.summary.totalSuites,
        passed: persistedState.summary.passedSuites,
        failed: persistedState.summary.failedSuites,
        timestamp: persistedState.generatedAt || new Date().toISOString()
    } : null;

    res.json({
        status: testRunning ? 'running' : ((testResults || hasPersistedResults) ? 'completed' : 'idle'),
        running: testRunning,
        hasResults: testResults !== null || hasPersistedResults,
        currentSuite: currentSuite,
        results: testResults || persistedResults
    });
});

// API endpoint to get test results
app.get('/api/test-results', (req, res) => {
    try {
        const state = readDashboardState();
        if (!state || !state.summary) {
            return res.json({ status: 'no-results', message: 'No test results available yet' });
        }
        res.json({
            status: 'completed',
            passedSuites: state.summary.passedSuites,
            failedSuites: state.summary.failedSuites,
            warningSuites: state.summary.warningSuites,
            skippedSuites: state.summary.skippedSuites,
            totalSuites: state.summary.totalSuites
        });
    } catch (error) {
        console.error('Error getting test results:', error);
        res.json({ status: 'error', message: error.message });
    }
});

// API endpoint to get detailed test results per suite
app.get('/api/detailed-results', (req, res) => {
    const detailedResults = createDefaultDetailedResults();

    try {
        const state = readDashboardState();
        if (state && state.suites) {
            Object.assign(detailedResults, state.suites);
        }

        res.json({
            status: 'success',
            results: detailedResults
        });
    } catch (error) {
        console.error('Error parsing detailed results:', error);
        res.json({
            status: 'error',
            message: error.message,
            results: detailedResults
        });
    }
});

// API endpoint to get embedded HTML report for a specific suite
app.get('/api/embedded-report/:suite', (req, res) => {
    const suite = req.params.suite;

    // Map suite names to repository IDs (as they appear in unified dashboard)
    const suiteMapping = {
        'app': 'Adhash_App_Status',
        'server': 'Adhash_AllProjects_Server',
        'cert': 'AdHash_Projects_Certificate_Expiry_Test',
        'api': 'AdHash_API_Test',
        'domain': 'AdHash_Domain_Report'
    };

    const repoName = suiteMapping[suite];
    if (!repoName) {
        return res.status(400).json({ status: 'error', message: 'Invalid suite name' });
    }

    try {
        const unifiedDashboard = path.join(__dirname, 'unified-dashboard', 'index.html');
        if (!fs.existsSync(unifiedDashboard)) {
            return res.status(404).json({ status: 'error', message: 'Unified dashboard not found' });
        }

        const html = fs.readFileSync(unifiedDashboard, 'utf8');

        // Extract the iframe content for this suite
        const iframeRegex = new RegExp(`<div class="detailed-report-container" id="report-${repoName}">[\\s\\S]*?<iframe src="data:text/html;base64,([^"]+)"[\\s\\S]*?<\\/iframe>`, 'i');
        const match = html.match(iframeRegex);

        if (match && match[1]) {
            // Decode the base64 content
            const decodedHtml = Buffer.from(match[1], 'base64').toString('utf8');
            res.send(decodedHtml);
        } else {
            res.status(404).json({ status: 'error', message: 'Report not found for this suite' });
        }
    } catch (error) {
        console.error('Error getting embedded report:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Helper function to add log
function addLog(message, type = 'info') {
    const logEntry = {
        message,
        type,
        timestamp: new Date().toISOString()
    };

    // Add to testLogs for backward compatibility
    testLogs.push(logEntry);

    // Also add to serverLogs so it appears in the UI
    serverLogs.push({
        timestamp: logEntry.timestamp,
        level: type,
        message: message
    });

    // Keep only last MAX_LOGS entries in serverLogs
    if (serverLogs.length > MAX_LOGS) {
        serverLogs.shift();
    }

    console.log(`[${type.toUpperCase()}] ${message}`);
}

// API endpoint to get test logs
app.get('/api/test-logs', (req, res) => {
    const fromIndex = parseInt(req.query.from) || 0;
    const newLogs = testLogs.slice(fromIndex);

    res.json({
        status: 'success',
        logs: newLogs,
        nextIndex: testLogs.length,
        currentSuite: currentSuite
    });
});

// API endpoint to reset test state (for debugging)
app.post('/api/reset-state', (req, res) => {
    console.log('🔄 Resetting test state...');
    testRunning = false;
    testResults = null;
    testLogs = [];
    currentSuite = null;
    testProcessPid = null;
    testProcessRef = null;
    res.json({ status: 'reset', message: 'Test state has been reset' });
});

// API endpoint to run a single test suite
app.post('/api/run-single-suite/:suite', (req, res) => {
    const { exec } = require('child_process');
    const suite = req.params.suite;

    const suiteConfig = WORKSPACE_SUITES[suite];
    if (!suiteConfig) {
        return res.status(400).json({ status: 'error', message: 'Invalid suite name' });
    }

    if (!isSuiteConfigured(suiteConfig)) {
        const message = suiteConfig.unavailableMessage || 'Not configured in current workspace';
        addLog(`⚠️ ${suiteConfig.name}: ${message}`, 'warning');
        return res.status(400).json({ status: 'error', message });
    }

    console.log(`\n🚀 Running ${suiteConfig.name}...`);
    addLog(`🚀 Running ${suiteConfig.name}...`, 'info');

    res.json({ status: 'success', message: `Running ${suiteConfig.name}...` });

    // Regenerate spec files before running this suite
    try { regenerateSpecFiles(); } catch (e) { addLog('⚠️ Spec regeneration warning: ' + e.message, 'warn'); }

    // Run the suite through the workspace-root runner
    const testProcess = exec(`"${process.execPath}" -r ts-node/register run-all-tests.ts --suite ${suite}`, { cwd: __dirname });

    testProcess.stdout.on('data', (data) => {
        console.log(data.toString());
    });

    testProcess.stderr.on('data', (data) => {
        console.error(data.toString());
    });

    testProcess.on('exit', (code) => {
        console.log(`✅ ${suiteConfig.name} completed with code ${code}`);
        addLog(`✅ ${suiteConfig.name} completed`, code === 0 ? 'success' : 'error');
    });
});

// Per-project run state
const projectRunState = {};
// In-memory override: after a per-project run, store live results here so card
// counters update immediately without waiting for a full pipeline run.
// Shape: { [projectId]: { apps, servers, ssl, domains, apis } } — each is a suiteResult
const projectResultOverride = {};
// When true, all get*TestResults functions return empty — set by /api/clear-results
let resultsCleared = false;

// Start tests for a single project
app.post('/api/run-project/:projectId', async (req, res) => {
    const { spawn } = require('child_process');
    const { projectId } = req.params;

    // Load project config: prefer MongoDB (survives redeploys), fall back to disk
    let project = null;
    try {
        const { getDB } = require('./src/db');
        const db = getDB();
        if (db) project = await db.collection('projects').findOne({ id: projectId });
    } catch (_) {}
    if (!project) {
        // Fall back to project-mapping.json on disk
        const mappingPath = path.join(__dirname, 'config', 'project-mapping.json');
        if (!fs.existsSync(mappingPath)) return res.status(404).json({ error: 'project-mapping.json not found' });
        const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
        project = (Array.isArray(mapping) ? mapping : (mapping.projects || [])).find(p => p.id === projectId);
    }
    if (!project) return res.status(404).json({ error: 'Project not found' });

    if (projectRunState[projectId] && projectRunState[projectId].running) {
        return res.json({ status: 'already-running', message: 'Tests already running for this project' });
    }

    // Determine which suites have config for this project
    const hasApps    = project.apps    && project.apps.length    > 0;
    const hasServers = project.servers && project.servers.length > 0;
    const hasSsl     = (project.ssl    && project.ssl.length    > 0) || (project.sslCerts && project.sslCerts.length > 0);
    const hasDomains = project.domains && project.domains.length > 0;
    const hasApis    = project.apis    && project.apis.length    > 0;

    const suitesToRun = [
        hasApis    && { label: 'API',    spec: 'tests/api/api-tests.spec.ts',               category: 'apis'    },
        hasServers && { label: 'Server', spec: 'tests/server-health/server-check.spec.ts',  category: 'servers' },
        hasSsl     && { label: 'SSL',    spec: 'tests/certificate/cert-expiry.spec.ts',     category: 'ssl'     },
        hasApps    && { label: 'App',    spec: 'tests/app-status/playstore.spec.ts',        category: 'apps'    },
    ].filter(Boolean);

    // Domain is checked via server-check or a separate check — skip for now if no spec
    const totalSuites = suitesToRun.length || 1;
    resultsCleared = false;
    projectRunState[projectId] = { running: true, message: `Starting tests for ${project.name}…`, passed: 0, failed: 0, warning: 0, skipped: 0, suitesDone: 0, totalSuites };
    res.json({ status: 'started' });

    addLog(`🚀 [${project.name}] Running ${totalSuites} suite(s): ${suitesToRun.map(s=>s.label).join(', ') || 'none'}`, 'info');

    const grepPattern = project.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const suiteResults = {}; // category -> { total, passed, failed, warning, skipped, tests:[] }

    function makeEmptySuiteResult() { return { total: 0, passed: 0, failed: 0, warning: 0, skipped: 0, tests: [] }; }

    // Collect API details for dashboard-state update
    let currentApi = null;
    const collectedApiDetails = [];
    const collectedAppResults = []; // parsed from __APP_RESULT__ markers

    function parseApiLine(line) {
        const apiNameMatch = line.match(/^=== (.+) ===$/);
        const urlMatch     = line.match(/^URL: (.+)$/);
        const methodMatch  = line.match(/^Method: (.+)$/);
        const codeMatch    = line.match(/__API_RESPONSE_CODE__(\d+)/);
        const reqMatch     = line.match(/__API_REQUEST_BODY__(.+)/);
        const respMatch    = line.match(/__API_RESPONSE_BODY__(.+)/);
        if (apiNameMatch) {
            if (currentApi) collectedApiDetails.push(currentApi);
            currentApi = { name: apiNameMatch[1].trim(), url: '', method: 'GET', responseCode: null, requestBody: '', responseBody: '' };
        }
        if (currentApi) {
            if (urlMatch)    currentApi.url    = urlMatch[1].trim();
            if (methodMatch) currentApi.method = methodMatch[1].trim().toUpperCase();
            if (codeMatch)   currentApi.responseCode = parseInt(codeMatch[1]);
            if (reqMatch)  { try { currentApi.requestBody  = Buffer.from(reqMatch[1].trim(),  'base64').toString('utf8'); } catch(_) {} }
            if (respMatch) { try { currentApi.responseBody = Buffer.from(respMatch[1].trim(), 'base64').toString('utf8'); } catch(_) {} }
        }
    }

    function runSuite(suiteIndex) {
        if (suiteIndex >= suitesToRun.length) {
            // All done — finalise
            onAllSuitesDone();
            return;
        }

        const suite = suitesToRun[suiteIndex];
        addLog(`[${project.name}] ▶ Running ${suite.label} suite (${suiteIndex + 1}/${suitesToRun.length})…`, 'info');
        projectRunState[projectId].message = `Running ${suite.label} suite (${suiteIndex + 1}/${suitesToRun.length})…`;

        const suiteResult = makeEmptySuiteResult();
        suiteResults[suite.category] = suiteResult;

        const proc = spawn('npx', [
            'playwright', 'test', suite.spec,
            '--reporter', 'list'
        ], { cwd: __dirname, shell: true, env: { ...process.env, PROJECT_FILTER: projectId } });

        function parseLine(line) {
            const passMatch = line.match(/(\d+)\s+passed/);
            const failMatch = line.match(/(\d+)\s+failed/);
            const skipMatch = line.match(/(\d+)\s+skipped/);
            if (passMatch) suiteResult.passed = parseInt(passMatch[1]);
            if (failMatch) suiteResult.failed = parseInt(failMatch[1]);
            if (skipMatch) suiteResult.skipped = parseInt(skipMatch[1]);
            suiteResult.total = suiteResult.passed + suiteResult.failed + suiteResult.skipped;
            if (suite.category === 'apis') parseApiLine(line);
            if (suite.category === 'apps') {
                const appResultMatch = line.match(/__APP_RESULT__(.+)/);
                if (appResultMatch) {
                    try { collectedAppResults.push(JSON.parse(appResultMatch[1])); } catch(_) {}
                }
            }

            // Parse individual test results from Playwright list reporter lines
            // Format after trim: "✓  1 [chromium] › Describe › Test title  123ms"
            const testLineMatch = line.match(/^(✓|✘|×|✗|-|–)\s+\d+\s+(.*?)(?:\s+\d+(?:\.\d+)?(?:ms|s))?$/);
            if (testLineMatch) {
                const icon = testLineMatch[1];
                // Strip browser tag and describe prefix: "[chromium] › Describe › title" → "title"
                let testTitle = testLineMatch[2].replace(/^\[.*?\]\s*›\s*/, '').trim();
                const lastArrow = testTitle.lastIndexOf(' › ');
                if (lastArrow >= 0) testTitle = testTitle.slice(lastArrow + 3).trim();
                const testStatus = (icon === '✓') ? 'passed' : (icon === '-' || icon === '–') ? 'skipped' : 'failed';
                suiteResult.tests.push({ _title: testTitle, _status: testStatus });
            }
        }

        proc.stdout.on('data', (data) => {
            data.toString().split('\n').filter(l => l.trim()).forEach(line => {
                addLog(`[${project.name}][${suite.label}] ${line}`, 'info');
                if (!line.startsWith('  ') && !line.startsWith('·')) projectRunState[projectId].message = `${suite.label}: ${line.trim().slice(0, 60)}`;
                parseLine(line.trim());
            });
        });
        proc.stderr.on('data', (data) => {
            data.toString().split('\n').filter(l => l.trim()).forEach(line => {
                addLog(`[${project.name}][${suite.label}] ${line}`, 'info');
                parseLine(line.trim());
            });
        });
        proc.on('exit', () => {
            addLog(`[${project.name}] ${suite.label} done — ✅${suiteResult.passed} ❌${suiteResult.failed} ⏭${suiteResult.skipped}`, suiteResult.failed > 0 ? 'error' : 'success');
            projectRunState[projectId].suitesDone = suiteIndex + 1;
            // Update totals incrementally
            projectRunState[projectId].passed  += suiteResult.passed;
            projectRunState[projectId].failed  += suiteResult.failed;
            projectRunState[projectId].skipped += suiteResult.skipped;
            runSuite(suiteIndex + 1);
        });
    }

    function onAllSuitesDone() {
        if (currentApi) collectedApiDetails.push(currentApi);

        // Classify API details
        collectedApiDetails.forEach(d => {
            const code = d.responseCode;
            if (code === null) { d.status = 'failed'; return; }
            d.status = code >= 200 && code < 300 ? 'passed' : code >= 300 && code < 400 ? 'warning' : 'failed';
        });

        // Update dashboard-state.json with fresh API details
        if (collectedApiDetails.length > 0) {
            try {
                const state = fs.existsSync(DASHBOARD_STATE_PATH) ? JSON.parse(fs.readFileSync(DASHBOARD_STATE_PATH, 'utf8')) : { suites: {} };
                if (!state.suites) state.suites = {};
                if (!state.suites.api) state.suites.api = { details: [] };
                if (!Array.isArray(state.suites.api.details)) state.suites.api.details = [];
                const projectApiNames = new Set((project.apis || []).map(a => String(a.name || '').toLowerCase().trim()));
                state.suites.api.details = state.suites.api.details.filter(d => !projectApiNames.has(String(d.name || '').toLowerCase().trim()));
                state.suites.api.details.push(...collectedApiDetails);
                // Do NOT update generatedAt — that would bust the shared SSL/domain cache for all projects
                fs.mkdirSync(path.dirname(DASHBOARD_STATE_PATH), { recursive: true });
                fs.writeFileSync(DASHBOARD_STATE_PATH, JSON.stringify(state, null, 2));
            } catch (e) {
                addLog(`⚠️ [${project.name}] Could not update dashboard state: ${e.message}`, 'warn');
            }
        }

        // Enrich parsed tests[] with structured data from project config
        function enrichSuiteTests() {
            // Servers
            if (suiteResults['servers']) {
                const rawTests = suiteResults['servers'].tests || [];
                suiteResults['servers'].tests = (project.servers || []).map((srv) => {
                    const name = srv.name || '';
                    const matched = rawTests.find(t => t._title && t._title.toLowerCase().includes(name.toLowerCase()));
                    const status = matched ? matched._status : (suiteResults['servers'].failed > 0 ? 'failed' : 'passed');
                    return { name, url: srv.url || '', status, type: srv.type || 'service' };
                });
            }
            // SSL — cert data populated separately in fetchSslCertData()
            if (suiteResults['ssl'] && !suiteResults['ssl']._certEnriched) {
                const rawTests = suiteResults['ssl'].tests || [];
                const sslList = (project.ssl && project.ssl.length > 0) ? project.ssl : (project.sslCerts || []);
                suiteResults['ssl'].tests = sslList.map((entry) => {
                    const hostname = String(entry).replace(/^https?:\/\//i,'').split('/')[0].toLowerCase();
                    const matched = rawTests.find(t => t._title && t._title.toLowerCase().includes(hostname));
                    const status = matched ? matched._status : (suiteResults['ssl'].failed > 0 ? 'failed' : 'passed');
                    return { name: hostname, url: `https://${hostname}`, status, daysRemaining: null, expiryDate: null, expiryDateIST: null };
                });
            }
            // Apps — build full store URLs, use per-test status from Playwright output
            if (suiteResults['apps']) {
                suiteResults['apps'].tests = (project.apps || []).flatMap((app) => {
                    const items = [];
                    if (app.playStore) {
                        const raw = String(app.playStore).trim();
                        const url = /^https?:\/\//i.test(raw) ? raw : `https://play.google.com/store/apps/details?id=${raw}`;
                        const result = collectedAppResults.find(r =>
                            r.appName === app.name && r.platform === 'Play Store');
                        items.push({ name: app.name, url, status: result ? result.status : 'skipped', platform: 'Play Store' });
                    }
                    if (app.appStore) {
                        const raw = String(app.appStore).trim();
                        const url = /^https?:\/\//i.test(raw) ? raw : `https://apps.apple.com/app/${raw.startsWith('id') ? raw : 'id' + raw}`;
                        const result = collectedAppResults.find(r =>
                            r.appName === app.name && r.platform === 'App Store');
                        items.push({ name: app.name, url, status: result ? result.status : 'skipped', platform: 'App Store' });
                    }
                    return items;
                });
            }
            // APIs — populate from collectedApiDetails (parsed from spec stdout)
            if (suiteResults['apis']) {
                if (collectedApiDetails.length > 0) {
                    suiteResults['apis'].tests = collectedApiDetails.map(d => ({
                        name: d.name,
                        url: d.url,
                        method: d.method || 'GET',
                        status: d.status || 'failed',
                        responseCode: d.responseCode,
                        requestBody: d.requestBody || '',
                        responseBody: d.responseBody || ''
                    }));
                } else {
                    // No stdout markers parsed — synthesize from project config with overall pass/fail
                    suiteResults['apis'].tests = (project.apis || []).map(api => ({
                        name: api.name || '',
                        url: api.url || '',
                        method: (api.method || 'GET').toUpperCase(),
                        status: suiteResults['apis'].failed > 0 ? 'failed' : 'passed',
                        responseCode: null,
                        requestBody: '',
                        responseBody: ''
                    }));
                }
            }
        }

        // Fetch SSL certificate expiry data inline using raw tls.connect
        function fetchSslCertData(callback) {
            if (!suiteResults['ssl']) { callback(); return; }
            const tlsMod = require('tls');
            const sslList = (project.ssl && project.ssl.length > 0) ? project.ssl : (project.sslCerts || []);

            function parseCertFields(cert) {
                if (!cert || !cert.valid_to) return { daysRemaining: null, expiryDate: null, expiryDateIST: null, certStatus: 'failed' };
                const validTo = new Date(cert.valid_to);
                const daysRemaining = Math.ceil((validTo.getTime() - Date.now()) / 86400000);
                const expiryDate = validTo.toUTCString();
                const istOffset = 5.5 * 60 * 60000;
                const expiryDateIST = new Date(validTo.getTime() + istOffset).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' IST');
                const certStatus = daysRemaining > 7 ? 'passed' : daysRemaining > 0 ? 'warning' : 'failed';
                return { daysRemaining, expiryDate, expiryDateIST, certStatus };
            }

            // Pre-build tests array
            suiteResults['ssl'].tests = sslList.map(e => {
                const h = String(e).replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
                return { name: h, url: `https://${h}`, status: 'passed', daysRemaining: null, expiryDate: null, expiryDateIST: null };
            });

            function checkCert(index) {
                if (index >= sslList.length) {
                    suiteResults['ssl']._certEnriched = true;
                    callback();
                    return;
                }
                const hostname = String(sslList[index]).replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
                let done = false;

                const tlsSocket = tlsMod.connect(
                    { host: hostname, port: 443, rejectUnauthorized: false, servername: hostname },
                    () => {
                        if (done) return;
                        done = true;
                        const cert = tlsSocket.getPeerCertificate();
                        tlsSocket.destroy();
                        const { daysRemaining, expiryDate, expiryDateIST, certStatus } = parseCertFields(cert);
                        const idx = suiteResults['ssl'].tests.findIndex(t => t.name === hostname);
                        const entry = { name: hostname, url: `https://${hostname}`, status: certStatus, daysRemaining, expiryDate, expiryDateIST };
                        if (idx >= 0) suiteResults['ssl'].tests[idx] = entry; else suiteResults['ssl'].tests.push(entry);
                        checkCert(index + 1);
                    }
                );
                tlsSocket.setTimeout(8000, () => {
                    if (done) return;
                    done = true;
                    tlsSocket.destroy();
                    const idx = suiteResults['ssl'].tests.findIndex(t => t.name === hostname);
                    const entry = { name: hostname, url: `https://${hostname}`, status: 'warning', daysRemaining: null, expiryDate: null, expiryDateIST: null, reason: 'Unreachable from this machine (TCP timeout)' };
                    if (idx >= 0) suiteResults['ssl'].tests[idx] = entry; else suiteResults['ssl'].tests.push(entry);
                    checkCert(index + 1);
                });
                tlsSocket.on('error', (err) => {
                    if (done) return;
                    done = true;
                    tlsSocket.destroy();
                    const idx = suiteResults['ssl'].tests.findIndex(t => t.name === hostname);
                    const entry = { name: hostname, url: `https://${hostname}`, status: 'warning', daysRemaining: null, expiryDate: null, expiryDateIST: null, reason: `Unreachable: ${err.message}` };
                    if (idx >= 0) suiteResults['ssl'].tests[idx] = entry; else suiteResults['ssl'].tests.push(entry);
                    checkCert(index + 1);
                });
            }
            checkCert(0);
        }

        // Inline domain availability check (no Playwright spec exists for domains)
        function finalizeSuites() {
            enrichSuiteTests();
            // Build override results for each category so card counters update immediately
            const override = {};
            for (const [category, result] of Object.entries(suiteResults)) {
                override[category] = result;
            }
            projectResultOverride[projectId] = { ...projectResultOverride[projectId], ...override };

            const { passed, failed, skipped } = projectRunState[projectId];
            projectRunState[projectId] = { running: false, passed, failed, warning: 0, skipped };
            addLog(`✅ [${project.name}] All suites complete — Passed: ${passed}, Failed: ${failed}, Skipped: ${skipped}`, failed > 0 ? 'error' : 'success');
        }

        // Fetch SSL cert expiry data, then proceed to domain check / finalize
        fetchSslCertData(() => {
            if (!hasDomains) {
                finalizeSuites();
                return;
            }

        const tlsNode = require('tls');
        const domainList = project.domains || [];
        addLog(`[${project.name}] ▶ Running Domain check for ${domainList.length} domain(s)…`, 'info');
        projectRunState[projectId].message = `Running Domain check…`;

        const domainResult = { total: domainList.length, passed: 0, failed: 0, warning: 0, skipped: 0, tests: [] };

        function parseCertExpiry(cert) {
            if (!cert || !cert.valid_to) return { daysRemaining: null, expiryDate: null, expiryDateIST: null };
            const validTo = new Date(cert.valid_to);
            const daysRemaining = Math.ceil((validTo.getTime() - Date.now()) / 86400000);
            const expiryDate = validTo.toUTCString();
            const istOffset = 5.5 * 60 * 60000;
            const expiryDateIST = new Date(validTo.getTime() + istOffset).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' IST');
            return { daysRemaining, expiryDate, expiryDateIST };
        }

        // HTTP fallback: check if domain is reachable on port 80 when HTTPS/TLS unavailable
        function httpReachabilityCheck(hostname, url, onResult) {
            const httpMod = require('http');
            let done = false;
            const req = httpMod.request({ host: hostname, port: 80, method: 'HEAD', path: '/', timeout: 8000 }, (res) => {
                if (done) return; done = true; req.destroy();
                const reachable = res.statusCode >= 200 && res.statusCode < 600;
                onResult(reachable);
            });
            req.on('timeout', () => { if (done) return; done = true; req.destroy(); onResult(false); });
            req.on('error', () => { if (done) return; done = true; onResult(false); });
            req.end();
        }

        function checkDomain(index) {
            if (index >= domainList.length) {
                suiteResults['domains'] = domainResult;
                projectRunState[projectId].passed += domainResult.passed;
                projectRunState[projectId].failed += domainResult.failed;
                addLog(`[${project.name}] Domain done — ✅${domainResult.passed} ❌${domainResult.failed}`, domainResult.failed > 0 ? 'error' : 'success');
                finalizeSuites();
                return;
            }

            const rawDomain = domainList[index];
            const hostname = rawDomain.replace(/^https?:\/\//i, '').split('/')[0].split(':')[0].toLowerCase();
            const url = `https://${hostname}`;
            let done = false;

            function onTlsFail(reason) {
                // Try www.{hostname} as fallback — many bare domains have cert on www
                const wwwHost = hostname.startsWith('www.') ? null : `www.${hostname}`;
                if (wwwHost) {
                    let wwwDone = false;
                    const wwwSocket = tlsNode.connect(
                        { host: wwwHost, port: 443, rejectUnauthorized: false, servername: wwwHost },
                        () => {
                            if (wwwDone) return; wwwDone = true;
                            const cert = wwwSocket.getPeerCertificate();
                            wwwSocket.destroy();
                            const { daysRemaining, expiryDate, expiryDateIST } = parseCertExpiry(cert);
                            const certStatus = daysRemaining === null ? 'passed' : daysRemaining > 7 ? 'passed' : daysRemaining > 0 ? 'warning' : 'failed';
                            if (certStatus === 'passed') domainResult.passed++;
                            else if (certStatus === 'warning') { domainResult.warning++; domainResult.passed++; }
                            else domainResult.failed++;
                            domainResult.tests.push({ name: hostname, url, status: certStatus, daysRemaining, expiryDate, expiryDateIST });
                            addLog(`[${project.name}][Domain] ${hostname} (via ${wwwHost}) cert ${daysRemaining !== null ? daysRemaining + 'd' : 'unknown'} ✅`, 'info');
                            checkDomain(index + 1);
                        }
                    );
                    wwwSocket.setTimeout(6000, () => {
                        if (wwwDone) return; wwwDone = true; wwwSocket.destroy();
                        // www also failed — fall back to HTTP reachability, no cert dates
                        httpReachabilityCheck(hostname, url, (reachable) => {
                            if (reachable) {
                                domainResult.passed++;
                                domainResult.tests.push({ name: hostname, url: `http://${hostname}`, status: 'passed', daysRemaining: null, expiryDate: null, expiryDateIST: null });
                                addLog(`[${project.name}][Domain] ${hostname} → reachable via HTTP only ✅`, 'info');
                            } else {
                                domainResult.failed++;
                                domainResult.tests.push({ name: hostname, url, status: 'failed', daysRemaining: null, expiryDate: null, expiryDateIST: null, error: reason });
                                addLog(`[${project.name}][Domain] ${hostname} → unreachable ❌`, 'error');
                            }
                            checkDomain(index + 1);
                        });
                    });
                    wwwSocket.on('error', () => {
                        if (wwwDone) return; wwwDone = true; wwwSocket.destroy();
                        httpReachabilityCheck(hostname, url, (reachable) => {
                            if (reachable) {
                                domainResult.passed++;
                                domainResult.tests.push({ name: hostname, url: `http://${hostname}`, status: 'passed', daysRemaining: null, expiryDate: null, expiryDateIST: null });
                                addLog(`[${project.name}][Domain] ${hostname} → reachable via HTTP only ✅`, 'info');
                            } else {
                                domainResult.failed++;
                                domainResult.tests.push({ name: hostname, url, status: 'failed', daysRemaining: null, expiryDate: null, expiryDateIST: null, error: reason });
                                addLog(`[${project.name}][Domain] ${hostname} → unreachable ❌`, 'error');
                            }
                            checkDomain(index + 1);
                        });
                    });
                } else {
                    // Already a www domain — go straight to HTTP fallback
                    httpReachabilityCheck(hostname, url, (reachable) => {
                        if (reachable) {
                            domainResult.passed++;
                            domainResult.tests.push({ name: hostname, url: `http://${hostname}`, status: 'passed', daysRemaining: null, expiryDate: null, expiryDateIST: null });
                            addLog(`[${project.name}][Domain] ${hostname} → reachable via HTTP only ✅`, 'info');
                        } else {
                            domainResult.failed++;
                            domainResult.tests.push({ name: hostname, url, status: 'failed', daysRemaining: null, expiryDate: null, expiryDateIST: null, error: reason });
                            addLog(`[${project.name}][Domain] ${hostname} → unreachable ❌`, 'error');
                        }
                        checkDomain(index + 1);
                    });
                }
            }

            // Use raw tls.connect to reliably get the peer certificate
            const tlsSocket = tlsNode.connect(
                { host: hostname, port: 443, rejectUnauthorized: false, servername: hostname },
                () => {
                    if (done) return;
                    done = true;
                    const cert = tlsSocket.getPeerCertificate();
                    tlsSocket.destroy();
                    const { daysRemaining, expiryDate, expiryDateIST } = parseCertExpiry(cert);
                    const certStatus = daysRemaining === null ? 'passed' : daysRemaining > 7 ? 'passed' : daysRemaining > 0 ? 'warning' : 'failed';
                    if (certStatus === 'passed') domainResult.passed++;
                    else if (certStatus === 'warning') { domainResult.warning++; domainResult.passed++; }
                    else domainResult.failed++;
                    domainResult.tests.push({ name: hostname, url, status: certStatus, daysRemaining, expiryDate, expiryDateIST });
                    addLog(`[${project.name}][Domain] ${hostname} cert ${daysRemaining !== null ? daysRemaining + 'd' : 'unknown'} ${certStatus === 'failed' ? '❌' : certStatus === 'warning' ? '⚠️' : '✅'}`, certStatus === 'failed' ? 'error' : 'info');
                    checkDomain(index + 1);
                }
            );
            tlsSocket.setTimeout(8000, () => {
                if (done) return;
                done = true;
                tlsSocket.destroy();
                onTlsFail('TLS timeout');
            });
            tlsSocket.on('error', (err) => {
                if (done) return;
                done = true;
                tlsSocket.destroy();
                onTlsFail(err.message);
            });
        }

        checkDomain(0);
        }); // end fetchSslCertData callback
    }

    // ── Inline API runner — uses axios directly (no playwright needed) ──────────
    // Runs BEFORE playwright suites so results are always available even if
    // playwright binary is not executable (Railway permission issue).
    async function runApiSuiteInline() {
        if (!hasApis) return;
        const axios = require('axios');
        const apis = project.apis || [];
        const result = makeEmptySuiteResult();
        suiteResults['apis'] = result;
        addLog(`[${project.name}] ▶ Running API suite inline (${apis.length} endpoints)…`, 'info');
        for (const api of apis) {
            try {
                const method = (api.method || 'GET').toUpperCase();
                const start = Date.now();
                const resp = await axios({
                    url: api.url, method,
                    headers: api.headers || {},
                    data: method !== 'GET' && method !== 'DELETE' ? (api.body || undefined) : undefined,
                    timeout: 15000, validateStatus: () => true
                });
                const elapsed = Date.now() - start;
                const code = resp.status;
                const status = code >= 200 && code < 300 ? 'passed' : code >= 300 && code < 400 ? 'warning' : 'failed';
                const responseBody = typeof resp.data === 'string' ? resp.data.slice(0, 500) : JSON.stringify(resp.data || '').slice(0, 500);
                collectedApiDetails.push({ name: api.name, url: api.url, method, responseCode: code, status, requestBody: '', responseBody, elapsed });
                result.tests.push({ _title: api.name, _status: status });
                if (status === 'passed') result.passed++;
                else if (status === 'warning') { result.warning = (result.warning||0)+1; }
                else result.failed++;
                result.total++;
                addLog(`[${project.name}][API] ${api.name} → ${code} ${status} (${elapsed}ms)`, status === 'failed' ? 'error' : 'success');
            } catch (e) {
                collectedApiDetails.push({ name: api.name, url: api.url, method: api.method||'GET', responseCode: null, status: 'failed', requestBody: '', responseBody: e.message||'Error' });
                result.tests.push({ _title: api.name, _status: 'failed' });
                result.failed++; result.total++;
                addLog(`[${project.name}][API] ${api.name} → ERROR: ${e.message}`, 'error');
            }
        }
        projectRunState[projectId].passed  += result.passed;
        projectRunState[projectId].failed  += result.failed;
        addLog(`[${project.name}] API done — ✅${result.passed} ❌${result.failed}`, result.failed > 0 ? 'error' : 'success');
    }

    // ── Inline App checker — uses public APIs (not scraping) ─────────────────
    // Play Store: checks via undocumented-but-reliable fdfe API endpoint
    // App Store: uses iTunes lookup API (https://itunes.apple.com/lookup)
    // Both are public JSON APIs that work from server IPs unlike page scraping
    async function runAppSuiteInline() {
        if (!hasApps) return;
        const axios = require('axios');
        const apps = project.apps || [];
        const result = makeEmptySuiteResult();
        suiteResults['apps'] = result;
        addLog(`[${project.name}] ▶ Running App suite inline (${apps.length} apps)…`, 'info');

        for (const app of apps) {
            // ── Play Store check via Google Play unofficial JSON API ──
            // Uses the internal fdfe endpoint which returns JSON and works from server IPs
            // unlike the HTML page which is bot-blocked from Railway data-center IPs.
            if (app.playStore) {
                const pkgId = app.playStore.startsWith('http')
                    ? (new URL(app.playStore).searchParams.get('id') || app.playStore)
                    : app.playStore;
                let psStatus = 'failed', psReason = '';
                try {
                    // Google Play Store API endpoint — returns 200 with JSON if app exists,
                    // 404 if not found. Works from server IPs unlike the HTML page endpoint.
                    const r = await axios.get(
                        `https://play.google.com/store/apps/details?id=${pkgId}&hl=en&gl=US`,
                        {
                            timeout: 15000, validateStatus: () => true,
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
                                'Accept': 'text/html,application/xhtml+xml',
                                'Accept-Language': 'en-US,en;q=0.9'
                            }
                        }
                    );
                    if (r.status === 200) {
                        const body = (r.data || '').toString();
                        const found = body.includes(pkgId) || body.toLowerCase().includes((app.name||'').toLowerCase().slice(0,4));
                        psStatus = found ? 'passed' : 'warning';
                        psReason = found ? `App found on Play Store (${pkgId})` : `Page loaded but app name not confirmed`;
                    } else if (r.status === 404) {
                        psStatus = 'failed'; psReason = `App not found on Play Store (${pkgId})`;
                    } else {
                        psStatus = 'warning'; psReason = `HTTP ${r.status} — may be rate limited`;
                    }
                } catch (e) { psStatus = 'failed'; psReason = e.message; }
                collectedAppResults.push({ appName: app.name||project.name, platform: 'Play Store', status: psStatus, reason: psReason });
                result.tests.push({ _title: `${app.name||project.name} (Play Store)`, _status: psStatus });
                if (psStatus === 'passed') result.passed++;
                else if (psStatus === 'warning') { result.warning = (result.warning||0)+1; }
                else result.failed++;
                result.total++;
                addLog(`[${project.name}][App] Play Store (${pkgId}) → ${psStatus}: ${psReason}`, psStatus === 'failed' ? 'error' : 'success');
            }

            // ── App Store check via iTunes lookup API ──
            if (app.appStore) {
                const asUrl = app.appStore.startsWith('http') ? app.appStore : '';
                const appIdMatch = asUrl.match(/id(\d+)/i);
                const appId = appIdMatch ? appIdMatch[1] : '';
                let asStatus = 'failed', asReason = '';
                try {
                    if (appId) {
                        // iTunes Lookup API — public, works from server IPs
                        const r = await axios.get(`https://itunes.apple.com/lookup?id=${appId}&country=in`, {
                            timeout: 15000, validateStatus: () => true
                        });
                        const results = r.data?.results || [];
                        if (results.length > 0) {
                            const appData = results[0];
                            asStatus = 'passed';
                            asReason = `${appData.trackName || app.name} v${appData.version || '?'} — Rating: ${appData.averageUserRating?.toFixed(1) || 'N/A'}`;
                        } else {
                            asStatus = 'failed'; asReason = 'App not found on App Store';
                        }
                    } else if (asUrl) {
                        // No ID, check URL reachability
                        const r = await axios.get(asUrl, { timeout: 15000, validateStatus: () => true, headers: {'User-Agent':'curl/7.68.0'} });
                        asStatus = r.status >= 200 && r.status < 400 ? 'passed' : 'failed';
                        asReason = `HTTP ${r.status}`;
                    } else {
                        asStatus = 'warning'; asReason = 'No App Store ID in URL';
                    }
                } catch (e) { asStatus = 'failed'; asReason = e.message; }
                collectedAppResults.push({ appName: app.name||project.name, platform: 'App Store', status: asStatus, reason: asReason });
                result.tests.push({ _title: `${app.name||project.name} (App Store)`, _status: asStatus });
                if (asStatus === 'passed') result.passed++;
                else if (asStatus === 'warning') { result.warning = (result.warning||0)+1; }
                else result.failed++;
                result.total++;
                addLog(`[${project.name}][App] App Store (id:${appId||asUrl}) → ${asStatus}: ${asReason}`, asStatus === 'failed' ? 'error' : 'success');
            }
        }
        projectRunState[projectId].passed  += result.passed;
        projectRunState[projectId].failed  += result.failed;
        addLog(`[${project.name}] App done — ✅${result.passed} ❌${result.failed}`, result.failed > 0 ? 'error' : 'success');
    }

    // Remove API and App from playwright suites — now run inline
    const playwrightSuites = suitesToRun.filter(s => s.category !== 'apis' && s.category !== 'apps');

    if (suitesToRun.length === 0) {
        projectRunState[projectId] = { running: false, passed: 0, failed: 0, warning: 0, skipped: 0 };
        addLog(`⚠️ [${project.name}] No testable suites configured`, 'warn');
        return;
    }

    // Run inline suites first (no playwright), then playwright suites
    Promise.all([runApiSuiteInline(), runAppSuiteInline()]).then(() => {
        projectRunState[projectId].totalSuites = playwrightSuites.length + (hasApis?1:0) + (hasApps?1:0);
        if (playwrightSuites.length > 0) {
            // Re-index suitesToRun to only playwright suites
            suitesToRun.length = 0;
            playwrightSuites.forEach(s => suitesToRun.push(s));
            runSuite(0);
        } else {
            onAllSuitesDone();
        }
    }).catch(e => {
        addLog(`[${project.name}] Inline suite error: ${e.message}`, 'error');
        if (playwrightSuites.length > 0) {
            suitesToRun.length = 0;
            playwrightSuites.forEach(s => suitesToRun.push(s));
            runSuite(0);
        } else {
            onAllSuitesDone();
        }
    });
});

// Protected keys that must never be exposed or overwritten via the secrets UI
const PROTECTED_ENV_KEYS = new Set(['GITHUB_TOKEN','ZOHO_MAIL_PASS','ZOHO_MAIL_USER','ZOHO_MAIL_FROM','ZOHO_MAIL_TO','ZOHO_MAIL_ENABLED','ZOHO_MAIL_CC','ZOHO_CLIENT_ID','ZOHO_CLIENT_SECRET','ZOHO_REFRESH_TOKEN','ZOHO_ACCOUNT_ID','SLACK_BOT_TOKEN','SLACK_CHANNEL','SLACK_ENABLED']);

function readEnvFile() {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return {};
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    const result = {};
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq < 0) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
        result[key] = val;
    }
    return result;
}

function writeEnvFile(vars) {
    const envPath = path.join(__dirname, '.env');
    const lines = Object.entries(vars).map(([k, v]) => {
        const needsQuotes = /[\s#"']/.test(v);
        return `${k}=${needsQuotes ? `"${v.replace(/"/g, '\\"')}"` : v}`;
    });
    fs.writeFileSync(envPath, lines.join('\n') + '\n');
}

// GET /api/env-secrets — return non-protected env vars
app.get('/api/env-secrets', (req, res) => {
    const all = readEnvFile();
    const secrets = {};
    for (const [k, v] of Object.entries(all)) {
        if (!PROTECTED_ENV_KEYS.has(k)) secrets[k] = v;
    }
    res.json({ secrets });
});

// POST /api/env-secrets — merge new values into .env (protected keys untouched)
app.post('/api/env-secrets', (req, res) => {
    const { secrets } = req.body || {};
    if (!secrets || typeof secrets !== 'object') return res.status(400).json({ error: 'Invalid payload' });
    const existing = readEnvFile();
    // Merge: keep protected keys, overwrite/add rest
    const merged = { ...existing };
    for (const [k, v] of Object.entries(secrets)) {
        if (PROTECTED_ENV_KEYS.has(k)) continue; // silently skip protected keys
        if (k) merged[k] = v;
    }
    try {
        writeEnvFile(merged);
        // Reload into current process.env so next test run picks them up immediately
        for (const [k, v] of Object.entries(merged)) {
            if (!PROTECTED_ENV_KEYS.has(k)) process.env[k] = v;
        }
        addLog('⚙️ .env secrets updated', 'info');
        res.json({ status: 'saved' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/admin/snapshots — list available deployment snapshots (super_admin only)
app.get('/api/admin/snapshots', requireAdmin, async (req, res) => {
    try {
        const { getDB } = require('./src/db');
        const db = getDB();
        const snaps = await db.collection('deployment_snapshots')
            .find({}, { projection: { _id: 1, ts: 1, keys: 1 } })
            .sort({ ts: -1 }).limit(10).toArray();
        res.json({ snapshots: snaps.map(s => ({ id: s._id, ts: s.ts, keys: s.keys })) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/snapshots/restore — restore all qa3_ keys from a snapshot (super_admin only)
app.post('/api/admin/snapshots/restore', requireAdmin, async (req, res) => {
    try {
        const { getDB } = require('./src/db');
        const db = getDB();
        const { snapshotId } = req.body || {};
        // Use latest if no id provided
        const snap = snapshotId
            ? await db.collection('deployment_snapshots').findOne({ _id: require('mongodb').ObjectId(snapshotId) })
            : await db.collection('deployment_snapshots').findOne({}, { sort: { ts: -1 } });
        if (!snap) return res.status(404).json({ error: 'No snapshot found' });
        const data = snap.data || {};
        const { writeKey } = require('./src/db');
        let restored = 0;
        for (const [key, value] of Object.entries(data)) {
            if (!key.startsWith('qa3_') || !value) continue;
            await writeKey(key, value);
            _qaCache[key] = value;
            restored++;
        }
        console.log(`[snapshot] ✅ Restored ${restored} keys from snapshot ${snap.ts}`);
        res.json({ success: true, restored, snapshotTs: snap.ts });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/dedup-reports — super_admin only, deduplicates saved_reports by datetime per project
app.post('/api/admin/dedup-reports', requireAdmin, async (req, res) => {
    try {
        const { getDB } = require('./src/db');
        const db = getDB();
        const projectIds = req.body.projectIds || (await db.collection('saved_reports').distinct('projectId'));
        const results = {};
        for (const pid of projectIds) {
            const all = await db.collection('saved_reports').find({ projectId: pid }).sort({ createdAt: 1 }).toArray();
            const seenDt = new Map();
            const toDelete = [];
            for (const doc of all) {
                const key = doc.datetime || String(doc._id);
                // Keep new-format rpt_ ids always (they are genuinely unique)
                if (doc.id && String(doc.id).startsWith('rpt_')) { seenDt.set(doc.id, doc); continue; }
                if (seenDt.has(key)) { toDelete.push(doc._id); }
                else seenDt.set(key, doc);
            }
            if (toDelete.length > 0) {
                await db.collection('saved_reports').deleteMany({ _id: { $in: toDelete } });
                // Rebuild _qaCache for this project
                const { readKey } = require('./src/db');
                _qaCache['qa3_' + pid] = await readKey('qa3_' + pid);
                // Broadcast to ALL clients so browsers replace their stale STORE
                broadcastSseEvent('qa-data-update', { key: 'qa3_' + pid, value: _qaCache['qa3_' + pid] });
            }
            results[pid] = { before: all.length, deleted: toDelete.length, after: all.length - toDelete.length };
        }
        res.json({ success: true, results });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/set-slack-token — super_admin only, persists token to MongoDB (survives redeploys)
app.post('/api/admin/set-slack-token', requireAdmin, async (req, res) => {
    const { token } = req.body || {};
    if (!token || !String(token).startsWith('xoxb-')) return res.status(400).json({ error: 'Invalid Slack bot token' });
    process.env.SLACK_BOT_TOKEN = String(token).trim();
    try {
        const { getDB } = require('./src/db');
        const db = getDB();
        if (db) await db.collection('app_config').updateOne(
            { namespace: '_system' },
            { $set: { 'data.SLACK_BOT_TOKEN': _encryptVal(process.env.SLACK_BOT_TOKEN), updatedAt: new Date() } },
            { upsert: true }
        );
        console.log('[slack] ✅ SLACK_BOT_TOKEN saved to MongoDB');
    } catch (e) { console.warn('[slack] MongoDB save failed:', e.message); }
    res.json({ success: true });
});

// Clear all cached per-project run results
app.post('/api/clear-results', (req, res) => {
    // Wipe in-memory override cache
    for (const key of Object.keys(projectResultOverride)) delete projectResultOverride[key];
    for (const key of Object.keys(projectRunState)) delete projectRunState[key];
    // Wipe suite row cache so HTML report data is not served from memory
    suiteConfigCache.apps = null;
    suiteConfigCache.certificates = null;
    suiteConfigCache.apis = null;
    suiteConfigCache.domains = null;
    suiteConfigCache.domainsCacheKey = null;
    suiteConfigCache.ssl = null;
    suiteConfigCache.sslCacheKey = null;
    suiteConfigCache.suiteRows = {};
    suiteConfigCache.suiteRowMtimes = {};
    // Clear dashboard-state.json
    try {
        fs.mkdirSync(path.dirname(DASHBOARD_STATE_PATH), { recursive: true });
        fs.writeFileSync(DASHBOARD_STATE_PATH, JSON.stringify({ suites: {}, generatedAt: new Date().toISOString() }, null, 2));
    } catch (e) { /* ignore */ }
    // Delete suite HTML report files so readSuiteRows returns empty
    const suiteReportsDir = path.join(__dirname, 'suite-reports');
    try {
        if (fs.existsSync(suiteReportsDir)) {
            fs.readdirSync(suiteReportsDir).forEach(f => {
                try { fs.unlinkSync(path.join(suiteReportsDir, f)); } catch (_) {}
            });
        }
    } catch (e) { /* ignore */ }
    resultsCleared = true;
    addLog('🗑️ All project results cleared', 'info');
    res.json({ status: 'cleared' });
});

// Poll status for a single project run
app.get('/api/run-project/:projectId/status', (req, res) => {
    const { projectId } = req.params;
    const state = projectRunState[projectId];
    if (!state) return res.json({ running: false, passed: 0, failed: 0, warning: 0, skipped: 0 });
    res.json(state);
});

// API endpoint to trigger test run
app.post('/api/run-tests', (req, res) => {
    const { spawn } = require('child_process');

    if (testRunning) {
        return res.json({ status: 'already-running', message: 'Tests are already running' });
    }

    console.log('\n🚀 Starting test execution...');
    resultsCleared = false;
    testRunning = true;
    testResults = null;
    testLogs = [];
    currentSuite = null;
    testProcessPid = null;
    testProcessRef = null;

    res.json({ status: 'started', message: 'Tests are running in the background...' });

    // Regenerate spec files from latest project-mapping.json before running
    try { regenerateSpecFiles(); } catch (e) { addLog('⚠️ Spec regeneration warning: ' + e.message, 'warn'); }

    addLog('🚀 Starting sequential test execution...', 'info');
    addLog('📋 Running configured suites, including external domain monitoring...', 'info');
    // Run the unified test framework with streaming output (no exec buffer cap)
    const testProcess = spawn(process.execPath, ['-r', 'ts-node/register', 'run-all-tests.ts'], {
        cwd: __dirname,
        shell: false
    });

    // Store the process PID for state recovery
    testProcessPid = testProcess.pid;
    testProcessRef = testProcess;
    console.log(`📌 Test process started with PID: ${testProcessPid}`);

    // Capture stdout in real-time
    testProcess.stdout.on('data', (data) => {
        const output = data.toString();
        console.log(output);

        // Parse output to detect which suite is running
        if (output.includes('Running App Status Tests')) {
            currentSuite = 'app-status';
            addLog('🚀 Starting App Status Verification tests...', 'running');
        } else if (output.includes('Running Server Health Tests')) {
            currentSuite = 'server-health';
            addLog('🚀 Starting Server Health Monitoring tests...', 'running');
        } else if (output.includes('Running Certificate Expiry Tests')) {
            currentSuite = 'ssl-cert';
            addLog('🚀 Starting SSL Certificate Monitoring tests...', 'running');
        } else if (output.includes('Running API Tests')) {
            currentSuite = 'api-test';
            addLog('🚀 Starting API Endpoint Testing tests...', 'running');
        } else if (output.includes('Domain Expiry Monitoring is not configured in current workspace')) {
            addLog('⚠️ Domain Expiry Monitoring is not configured in current workspace', 'warning');
        }

        // Log npm install progress
        if (output.includes('npm install') || output.includes('added') || output.includes('packages')) {
            addLog(`📦 Installing dependencies (using cache)...`, 'info');
        }

        // Log test progress
        if (output.includes('PASS') || output.includes('✓') || output.includes('✅')) {
            addLog(`✅ ${output.trim()}`, 'success');
        } else if (output.includes('FAIL') || output.includes('✗') || output.includes('❌')) {
            addLog(`❌ ${output.trim()}`, 'error');
        } else if (output.trim().length > 0 && !output.includes('[') && !output.includes('npm WARN')) {
            addLog(output.trim(), 'info');
        }
    });

    // Capture stderr
    testProcess.stderr.on('data', (data) => {
        const error = data.toString();
        if (error.trim().length > 0) {
            addLog(`⚠️ ${error.trim()}`, 'warning');
        }
    });

    // Function to parse and finalize results
    const finalizeResults = async (code) => {
        if (!testRunning) return; // Already finalized

        testRunning = false;
        currentSuite = null;
        testProcessPid = null;
        testProcessRef = null;

        // Clear stale suite-row and suite-config caches so next API read uses fresh data
        suiteConfigCache.apps = null;
        suiteConfigCache.certificates = null;
        suiteConfigCache.apis = null;
        suiteConfigCache.domains = null;
        suiteConfigCache.domainsCacheKey = null;
        suiteConfigCache.ssl = null;
        suiteConfigCache.sslCacheKey = null;
        suiteConfigCache.suiteRows = {};
        suiteConfigCache.suiteRowMtimes = {};

        if (code !== 0) {
            addLog(`⚠️ Test process exited with code ${code}`, 'warning');
        } else {
            addLog('✅ All tests completed successfully!', 'success');
        }

        addLog('📊 Parsing test results...', 'info');

        let state = readDashboardState();
        if (!state || !state.summary) {
            // Allow state writer a few extra seconds after child process close.
            for (let attempt = 0; attempt < 5; attempt++) {
                await new Promise((resolve) => setTimeout(resolve, 1000));
                state = readDashboardState();
                if (state && state.summary) {
                    break;
                }
            }
        }
        if (state && state.summary) {
            try {
                testResults = {
                    status: 'completed',
                    totalTests: state.summary.totalSuites,
                    passed: state.summary.passedSuites,
                    failed: state.summary.failedSuites,
                    timestamp: new Date().toISOString()
                };

                addLog(`📊 Results: ${state.summary.passedSuites} passed, ${state.summary.failedSuites} failed, ${state.summary.skippedSuites} skipped`, state.summary.failedSuites === 0 ? 'success' : 'warning');
                console.log('✅ Test results parsed and stored:', testResults);

                // --- Generate email-preview HTML (needed for View Report button and Zoho mail) ---
                try {
                    addLog('📄 Generating email report preview...', 'info');
                    await new Promise((resolve, reject) => {
                        const { spawn: spawnChild } = require('child_process');
                        const regen = spawnChild(process.execPath, ['-r', 'ts-node/register', 'regenerate-dashboard.ts'], {
                            cwd: __dirname,
                            shell: false,
                            env: { ...process.env, ZOHO_MAIL_ENABLED: 'false' }
                        });
                        regen.stdout.on('data', (d) => console.log('[regen]', d.toString().trim()));
                        regen.stderr.on('data', (d) => console.error('[regen-err]', d.toString().trim()));
                        regen.on('close', (code) => {
                            if (code === 0) {
                                addLog('✅ Email report preview generated.', 'success');
                                resolve();
                            } else {
                                addLog('⚠️ Email preview generation exited with code ' + code, 'warning');
                                resolve(); // don't block mail send on this
                            }
                        });
                        regen.on('error', (err) => {
                            addLog('⚠️ Could not run regenerate-dashboard: ' + err.message, 'warning');
                            resolve();
                        });
                    });
                } catch (regenErr) {
                    addLog('⚠️ Email preview generation error: ' + (regenErr && regenErr.message), 'warning');
                }
                // --- Persist HTML report to MongoDB so it survives Railway redeploys ---
                try {
                    const reportPath = path.join(__dirname, 'email-preview', 'AdHash-Projects-Dashboard.html');
                    if (fs.existsSync(reportPath)) {
                        const htmlContent = fs.readFileSync(reportPath, 'utf8');
                        const { getDB } = require('./src/db');
                        const db = getDB();
                        if (db && htmlContent) {
                            await db.collection('run_reports').updateOne(
                                { key: 'latest' },
                                { $set: { key: 'latest', html: htmlContent, generatedAt: new Date() } },
                                { upsert: true }
                            );
                            addLog('💾 Run report saved to MongoDB (survives redeploys)', 'info');
                        }
                    }
                } catch (dbErr) {
                    console.warn('[run-report] MongoDB save failed:', dbErr.message);
                }
                // --- End MongoDB persist ---

                // --- Send Zoho Mail if enabled ---
                try {
                    // Re-read state after regeneration in case it was updated
                    const freshState = readDashboardState() || state;
                    await dispatchZohoSummaryMail(freshState);
                } catch (mailErr) {
                    addLog('❌ Failed to send Zoho Mail: ' + (mailErr && mailErr.message), 'error');
                    console.error('Failed to send Zoho Mail:', mailErr);
                }
                // --- End Zoho Mail ---

            } catch (parseError) {
                console.error('Error parsing results:', parseError);
                addLog('⚠️ Could not parse test results', 'warning');
                testResults = {
                    status: 'completed',
                    message: 'Tests completed but could not parse results',
                    timestamp: new Date().toISOString()
                };
            }
        } else {
            addLog('❌ Dashboard file not found', 'error');
            testResults = {
                status: 'error',
                message: 'Dashboard file not generated',
                timestamp: new Date().toISOString()
            };
        }
    };

    // Handle exit event (fires when process exits, before streams close)
    testProcess.on('exit', (code) => {
        console.log(`📤 Test process exited with code ${code}`);
        // Wait a bit for streams to flush, then finalize
        setTimeout(() => finalizeResults(code), 2000);
    });

    // Handle close event (fires when all streams are closed)
    testProcess.on('close', (code) => {
        console.log(`🔒 Test process closed with code ${code}`);
        finalizeResults(code);
    });

    testProcess.on('error', (err) => {
        addLog(`❌ Test process spawn error: ${err.message}`, 'error');
        finalizeResults(1);
    });
});

// API endpoint to get all projects
app.get('/api/projects', (req, res) => {
    try {
        const projectMappingPath = path.join(__dirname, 'config', 'project-mapping.json');
        if (!fs.existsSync(projectMappingPath)) {
            return res.status(404).json({ projects: [], error: 'Project mapping not found' });
        }

        const projectData = JSON.parse(fs.readFileSync(projectMappingPath, 'utf8'));
        attachProjectDomainStatuses(projectData.projects || [], readDashboardState());
        attachProjectSslDetails(projectData.projects || [], readDashboardState());
        attachProjectServerStatuses(projectData.projects || []);
        attachLatestProjectApiResults(projectData.projects || []);
        res.json({ projects: projectData.projects || [] });
    } catch (error) {
        console.error('Error loading projects:', error);
        res.status(500).json({ projects: [], error: 'Failed to load projects' });
    }
});

// API endpoint to get a specific project
app.get('/api/project/:id', (req, res) => {
    try {
        const projectMappingPath = path.join(__dirname, 'config', 'project-mapping.json');
        if (!fs.existsSync(projectMappingPath)) {
            return res.status(404).json({ error: 'Project mapping not found' });
        }

        const projectData = JSON.parse(fs.readFileSync(projectMappingPath, 'utf8'));
        attachProjectDomainStatuses(projectData.projects || [], readDashboardState());
        attachProjectSslDetails(projectData.projects || [], readDashboardState());
        attachProjectServerStatuses(projectData.projects || []);
        attachLatestProjectApiResults(projectData.projects || []);
        const project = projectData.projects.find(p => p.id === req.params.id);

        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        res.json(project);
    } catch (error) {
        console.error('Error loading project:', error);
        res.status(500).json({ error: 'Failed to load project' });
    }
});

// API endpoint to get server logs
app.get('/api/logs', (req, res) => {
    try {
        // Return last 50 logs
        const recentLogs = serverLogs.slice(-50);
        res.json({
            logs: recentLogs,
            message: recentLogs.length > 0 ? 'Logs loaded successfully' : 'No logs available'
        });
    } catch (error) {
        console.error('Error fetching logs:', error);
        res.status(500).json({ logs: [], message: 'No logs available', error: 'Failed to fetch logs' });
    }
});

// API endpoint to get project details
app.get('/api/project/:id', (req, res) => {
    try {
        const projectId = req.params.id;
        const projectMapping = JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'project-mapping.json'), 'utf8'));
        attachProjectDomainStatuses(projectMapping.projects || [], readDashboardState());
        attachProjectSslDetails(projectMapping.projects || [], readDashboardState());
        attachLatestProjectApiResults(projectMapping.projects || []);
        const project = projectMapping.projects.find(p => p.id === projectId);

        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        res.json(project);
    } catch (error) {
        console.error('Error fetching project details:', error);
        res.status(500).json({ error: 'Failed to fetch project details' });
    }
});

// Load project mapping
function getProjectMapping() {
    try {
        const mappingPath = path.join(__dirname, 'config', 'project-mapping.json');
        const data = fs.readFileSync(mappingPath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error loading project mapping:', error);
        return { projects: [] };
    }
}

function attachLatestProjectApiResults(projects) {
    const latestApiResults = readLatestApiResultsPayload(__dirname);
    const apiResultByProjectId = new Map(((latestApiResults && latestApiResults.projects) || []).map((project) => [project.id, project.results && project.results.apis]));

    (projects || []).forEach((project) => {
        const latestApiSummary = apiResultByProjectId.get(project.id);
        if (!latestApiSummary) {
            return;
        }

        project.results = {
            ...(project.results || {}),
            apis: {
                total: latestApiSummary.total,
                passed: latestApiSummary.passed,
                failed: latestApiSummary.failed,
                warning: latestApiSummary.warning,
                skipped: latestApiSummary.skipped,
                source: latestApiSummary.source || 'latest-run'
            }
        };
    });
}

const suiteConfigCache = {
    apps: null,
    certificates: null,
    apis: null,
    domains: null,
    domainsCacheKey: null,
    ssl: null,
    sslCacheKey: null,
    suiteRows: {},
    suiteRowMtimes: {}
};

const SKIPPED_SERVER_URL_FRAGMENT = '20.62.109.239';
const SKIPPED_SERVER_NAME = 'AutoChecker - PartSouq';
const SKIPPED_SERVER_MESSAGE = 'Skipped by QA (known issue / external dependency)';

function normalizeText(value) {
    return (value || '').toString().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function normalizeUrl(value) {
    return (value || '').toString().trim().replace(/\/+$/, '').toLowerCase();
}

function normalizeApiMethod(value) {
    return (value || 'GET').toString().trim().toUpperCase();
}

function normalizeApiName(value) {
    return normalizeText((value || '').toString().trim());
}

function buildApiStableKey(method, url, name) {
    return `${normalizeApiMethod(method)}::${normalizeUrl(url)}::${normalizeApiName(name)}`;
}

function isSkippedServerDefinition(server) {
    return Boolean(server && ((server.name || '') === SKIPPED_SERVER_NAME || String(server.url || '').includes(SKIPPED_SERVER_URL_FRAGMENT)));
}

function buildSkippedServerResult(server) {
    return {
        name: server.name,
        url: server.url || '#',
        type: 'server',
        status: 'skipped',
        message: SKIPPED_SERVER_MESSAGE,
        responseTime: 0,
        duration: '0s'
    };
}

function dedupeApiResults(details) {
    const deduped = new Map();

    (details || []).forEach((detail) => {
        if (!detail) {
            return;
        }

        deduped.set(buildApiStableKey(detail.method, detail.url, detail.name), detail);
    });

    return Array.from(deduped.values());
}

function classifyApiStatus(responseCode, expectedStatus) {
    const parsedResponseCode = typeof responseCode === 'number'
        ? responseCode
        : (/^\d+$/.test(String(responseCode || '').trim()) ? parseInt(String(responseCode).trim(), 10) : null);
    const parsedExpectedStatus = typeof expectedStatus === 'number'
        ? expectedStatus
        : (/^\d+$/.test(String(expectedStatus || '').trim()) ? parseInt(String(expectedStatus).trim(), 10) : undefined);

    if (typeof parsedExpectedStatus === 'number') {
        if (parsedResponseCode !== parsedExpectedStatus) {
            return 'failed';
        }

        if (parsedExpectedStatus >= 300 && parsedExpectedStatus < 400) {
            return 'warning';
        }

        return 'passed';
    }

    if (parsedResponseCode === null) {
        return 'failed';
    }

    if (parsedResponseCode >= 200 && parsedResponseCode < 300) {
        return 'passed';
    }

    if (parsedResponseCode >= 300 && parsedResponseCode < 400) {
        return 'warning';
    }

    return 'failed';
}

function normalizeSslHost(value) {
    const trimmed = (value || '').toString().trim();
    if (!trimmed) {
        return '';
    }

    if (/^https?:\/\//i.test(trimmed)) {
        try {
            return new URL(trimmed).hostname.toLowerCase();
        } catch (error) {
            return '';
        }
    }

    return trimmed.replace(/^https?:\/\//i, '').split('/')[0].replace(/:\d+$/, '').toLowerCase();
}

function normalizeDomainValue(value) {
    return String(value || '')
        .replace(/^https?:\/\//i, '')
        .replace(/^www\./i, '')
        .replace(/\/$/, '')
        .toLowerCase();
}

function buildTrackedDetailKey(type, domain, url) {
    return `${type}::${normalizeDomainValue(domain || url || '')}`;
}

function getTrackedDetailScore(detail) {
    let score = 0;

    if (detail && detail.expiryDate) {
        score += 3;
    }

    if (detail && detail.expiryDateIST && detail.expiryDateIST !== 'N/A') {
        score += 2;
    }

    if (detail && detail.daysRemaining !== null && detail.daysRemaining !== undefined && !Number.isNaN(Number(detail.daysRemaining))) {
        score += 3;
    }

    if (detail && detail.reason) {
        score += 2;
    }

    if (detail && detail.status === 'passed') {
        score += 3;
    } else if (detail && (detail.status === 'warning' || detail.status === 'expiring')) {
        score += 2;
    } else if (detail && (detail.status === 'failed' || detail.status === 'error')) {
        score += 1;
    }

    return score;
}

function pickPreferredTrackedDetail(existing, incoming) {
    if (!existing) {
        return incoming;
    }

    const existingScore = getTrackedDetailScore(existing);
    const incomingScore = getTrackedDetailScore(incoming);

    if (incomingScore > existingScore) {
        return {
            ...existing,
            ...incoming,
            domain: incoming.domain || existing.domain,
            url: incoming.url || existing.url,
            expiryDate: incoming.expiryDate || existing.expiryDate,
            expiryDateIST: incoming.expiryDateIST && incoming.expiryDateIST !== 'N/A' ? incoming.expiryDateIST : existing.expiryDateIST,
            daysRemaining: incoming.daysRemaining ?? existing.daysRemaining,
            reason: incoming.reason || existing.reason
        };
    }

    return {
        ...incoming,
        ...existing,
        domain: existing.domain || incoming.domain,
        url: existing.url || incoming.url,
        expiryDate: existing.expiryDate || incoming.expiryDate,
        expiryDateIST: existing.expiryDateIST && existing.expiryDateIST !== 'N/A' ? existing.expiryDateIST : incoming.expiryDateIST,
        daysRemaining: existing.daysRemaining ?? incoming.daysRemaining,
        reason: existing.reason || incoming.reason
    };
}

function dedupeTrackedResults(type, details) {
    const deduped = new Map();

    (details || []).forEach((detail) => {
        if (!detail) {
            return;
        }

        const normalizedDomain = normalizeDomainValue(detail.domain || detail.url);
        if (!normalizedDomain) {
            return;
        }

        const normalizedDetail = {
            ...detail,
            domain: normalizedDomain,
            url: detail.url || `https://${normalizedDomain}`
        };
        const key = buildTrackedDetailKey(type, normalizedDetail.domain, normalizedDetail.url);
        deduped.set(key, pickPreferredTrackedDetail(deduped.get(key), normalizedDetail));
    });

    return Array.from(deduped.values());
}

function normalizeDaysRemaining(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }

    const trimmed = String(value || '').trim();
    if (!trimmed) {
        return null;
    }

    const match = trimmed.match(/-?\d+/);
    if (!match) {
        return null;
    }

    const days = parseInt(match[0], 10);
    return Number.isNaN(days) ? null : days;
}

function getExpiryStatus(daysRemaining, hasError = false) {
    const normalizedDays = normalizeDaysRemaining(daysRemaining);

    if (hasError || normalizedDays === null) {
        return 'failed';
    }

    if (normalizedDays < 0) {
        return 'failed';
    }

    if (normalizedDays <= EXPIRY_WARNING_DAYS) {
        return 'warning';
    }

    return 'passed';
}

function toDomainDetailStatus(status) {
    if (status === 'warning') {
        return 'expiring';
    }

    if (status === 'failed') {
        return 'error';
    }

    return 'active';
}

function normalizeDomainDetail(detail) {
    const daysRemaining = normalizeDaysRemaining(detail && detail.daysRemaining);
    const status = toDomainDetailStatus(
        getExpiryStatus(daysRemaining, detail && detail.status === 'error' && daysRemaining === null)
    );

    return {
        ...detail,
        url: (detail && detail.url) || (detail && detail.domain ? `https://${normalizeDomainValue(detail.domain)}` : undefined),
        domain: normalizeDomainValue(detail && detail.domain),
        daysRemaining,
        status,
        reason: detail && detail.reason ? String(detail.reason) : undefined
    };
}

function normalizeSslDetail(detail) {
    const daysRemaining = normalizeDaysRemaining(detail && detail.daysRemaining);
    const isTimeoutWarning = detail && detail.status === 'warning' && daysRemaining === null;
    const status = isTimeoutWarning
        ? 'warning'
        : getExpiryStatus(daysRemaining, detail && detail.status === 'failed' && daysRemaining === null);

    return {
        ...detail,
        domain: normalizeDomainValue(detail && detail.domain),
        url: (detail && detail.url) || (detail && detail.domain ? `https://${normalizeDomainValue(detail.domain)}` : undefined),
        daysRemaining,
        status,
        reason: detail && detail.reason ? String(detail.reason) : undefined
    };
}

function formatToIST(value) {
    if (!value) return 'N/A';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'N/A';
    return new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
    }).format(date) + ' IST';
}

function getProjectSslEntries(project) {
    const rawEntries = (project && Array.isArray(project.ssl) && project.ssl.length > 0)
        ? project.ssl
        : ((project && Array.isArray(project.sslCerts)) ? project.sslCerts : []);
    const seen = new Set();

    return rawEntries
        .map((entry) => normalizeSslHost(entry))
        .filter((entry) => {
            if (!entry || seen.has(entry)) {
                return false;
            }

            seen.add(entry);
            return true;
        });
}

function decodeHtml(value) {
    return (value || '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
}

function stripHtml(value) {
    return decodeHtml((value || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<\/pre>/gi, '\n')
        .replace(/<\/details>/gi, '\n')
        .replace(/<\/summary>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\n\s+/g, '\n')
        .replace(/[ \t]+/g, ' '));
}

function decodeBase64Value(value) {
    if (!value) {
        return undefined;
    }

    try {
        return Buffer.from(value, 'base64').toString('utf8');
    } catch (error) {
        return undefined;
    }
}

function normalizePlayStoreValue(playStore) {
    if (!playStore || typeof playStore !== 'string') {
        return null;
    }

    const trimmed = playStore.trim();
    if (!trimmed) {
        return null;
    }

    // Accept full Play Store URL — extract package id from ?id= param
    if (/^https?:\/\//i.test(trimmed)) {
        try {
            const url = new URL(trimmed);
            const packageName = url.searchParams.get('id') || '';
            if (!packageName) return null;
            return {
                packageName,
                expectedUrl: `https://play.google.com/store/apps/details?id=${packageName}`
            };
        } catch (error) {
            return null;
        }
    }

    return {
        packageName: trimmed,
        expectedUrl: `https://play.google.com/store/apps/details?id=${trimmed}`
    };
}

function normalizeAppStoreValue(appStore) {
    if (!appStore || typeof appStore !== 'string') {
        return null;
    }

    const trimmed = appStore.trim();
    if (!trimmed) return null;

    // Accept full App Store URL — preserve the original URL, just extract the id
    if (/^https?:\/\//i.test(trimmed)) {
        try {
            const url = new URL(trimmed);
            const idMatch = url.pathname.match(/\/(id\d+)/i);
            const appId = idMatch ? idMatch[1] : '';
            if (!appId) return null;
            return {
                appId,
                // Preserve the full original URL — don't normalize to /app/idXXX
                // which loses country code and app name path and may fail on Railway
                expectedUrl: trimmed
            };
        } catch (error) {
            return null;
        }
    }

    // Plain id like "id310633997" or "id6747385992"
    const idVal = trimmed.startsWith('id') ? trimmed : `id${trimmed}`;
    return {
        appId: idVal,
        expectedUrl: `https://apps.apple.com/app/${idVal}`
    };
}

function getSuiteReportPath(repository) {
    return path.join(__dirname, 'suite-reports', `${repository.replace(/[^a-zA-Z0-9]/g, '_')}.html`);
}

function readSuiteRows(repository) {
    const reportPath = getSuiteReportPath(repository);
    const reportStat = fs.existsSync(reportPath) ? fs.statSync(reportPath) : null;
    const reportMtime = reportStat ? reportStat.mtimeMs : null;

    if (suiteConfigCache.suiteRows[repository] && suiteConfigCache.suiteRowMtimes[repository] === reportMtime) {
        return suiteConfigCache.suiteRows[repository];
    }

    if (!fs.existsSync(reportPath)) {
        console.warn('Suite report not found:', reportPath);
        suiteConfigCache.suiteRows[repository] = [];
        suiteConfigCache.suiteRowMtimes[repository] = null;
        return suiteConfigCache.suiteRows[repository];
    }

    const html = fs.readFileSync(reportPath, 'utf8');
    const rowPattern = /<tr class="test-row (passed|failed|skipped)">[\s\S]*?<td class="test-name">([^<]+)<\/td>[\s\S]*?<span class="status-badge [^"]+">([^<]+)<\/span>[\s\S]*?<td class="test-duration">([^<]+)<\/td>[\s\S]*?<td class="test-details"([^>]*)>([\s\S]*?)<\/td>[\s\S]*?<\/tr>/gi;
    const rows = [];

    for (const match of html.matchAll(rowPattern)) {
        const attributes = match[5] || '';
        const requestBodyMatch = attributes.match(/data-request-body="([^"]*)"/i);
        const responseBodyMatch = attributes.match(/data-response-body="([^"]*)"/i);
        const responseCodeMatch = attributes.match(/data-response-code="([^"]*)"/i);
        const expectedStatusMatch = attributes.match(/data-expected-status="([^"]*)"/i);

        rows.push({
            status: match[1].toLowerCase(),
            title: decodeHtml(match[2]),
            badge: decodeHtml(match[3]).toLowerCase(),
            duration: decodeHtml(match[4]),
            details: stripHtml(match[6]),
            requestBody: decodeBase64Value(requestBodyMatch && requestBodyMatch[1]),
            responseBody: decodeBase64Value(responseBodyMatch && responseBodyMatch[1]),
            responseCode: decodeHtml(responseCodeMatch && responseCodeMatch[1]),
            expectedStatus: decodeHtml(expectedStatusMatch && expectedStatusMatch[1])
        });
    }

    suiteConfigCache.suiteRows[repository] = rows;
    suiteConfigCache.suiteRowMtimes[repository] = reportMtime;
    return rows;
}

function parseExpectedStatus(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }

    const trimmed = String(value || '').trim();
    if (!/^\d+$/.test(trimmed)) {
        return undefined;
    }

    const parsed = parseInt(trimmed, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
}

function findSuiteRow(rows, expectedTitle) {
    const normalizedExpected = normalizeText(expectedTitle);
    return rows.find((row) => normalizeText(row.title) === normalizedExpected);
}

function loadAppSuiteDefinitions() {
    if (suiteConfigCache.apps) {
        return suiteConfigCache.apps;
    }

    const mapping = getProjectMapping();
    const entries = [];
    (mapping.projects || []).forEach(project => {
        (project.apps || []).forEach(app => {
            if (!app || !app.name) return;
            const play = normalizePlayStoreValue(app.playStore);
            if (play) {
                entries.push({
                    appName: app.name,
                    platform: 'Play Store',
                    packageName: play.packageName,
                    expectedUrl: play.expectedUrl
                });
            }
            const ios = normalizeAppStoreValue(app.appStore);
            if (ios) {
                entries.push({
                    appName: app.name,
                    platform: 'App Store',
                    packageName: ios.appId,
                    expectedUrl: ios.expectedUrl
                });
            }
        });
    });
    suiteConfigCache.apps = entries;

    return suiteConfigCache.apps;
}

function loadCertificateSuiteDefinitions() {
    if (suiteConfigCache.certificates) {
        return suiteConfigCache.certificates;
    }

    const mapping = getProjectMapping();
    const seen = new Set();
    suiteConfigCache.certificates = (mapping.projects || [])
        .flatMap((project) => getProjectSslEntries(project).map((url) => ({
            name: url,
            url
        })))
        .filter((entry) => {
            const key = normalizeSslHost(entry.url);
            if (!key || seen.has(key)) {
                return false;
            }

            seen.add(key);
            return true;
        });

    return suiteConfigCache.certificates;
}

function loadApiSuiteDefinitions() {
    if (suiteConfigCache.apis) {
        return suiteConfigCache.apis;
    }

    const mapping = getProjectMapping();
    suiteConfigCache.apis = (mapping.projects || [])
        .flatMap((project) => project.apis || [])
        .filter((entry) => entry && entry.name && entry.url && entry.method)
        .map((entry) => ({
            name: entry.name,
            url: entry.url,
            method: entry.method,
            expectedStatus: entry.expectedStatus
        }));

    return suiteConfigCache.apis;
}

function loadDomainReportEntries() {
    const state = readDashboardState();
    const stateGeneratedAt = state && state.generatedAt ? state.generatedAt : '';

    if (suiteConfigCache.domains && suiteConfigCache.domainsCacheKey === stateGeneratedAt) {
        return suiteConfigCache.domains;
    }

    const domainDetails = state && state.suites && state.suites.domain && Array.isArray(state.suites.domain.details)
        ? state.suites.domain.details
        : [];

    const stateEntries = domainDetails
        .map((detail) => {
            const normalizedDetail = normalizeDomainDetail(detail);
            const normalizedDomain = normalizeSslHost(normalizedDetail && normalizedDetail.domain);
            if (!normalizedDomain) {
                return null;
            }

            let status = 'failed';
            if (normalizedDetail.status === 'active') {
                status = 'passed';
            } else if (normalizedDetail.status === 'expiring') {
                status = 'warning';
            } else if (normalizedDetail.status === 'error') {
                status = 'failed';
            }

            return {
                name: normalizedDomain,
                domain: normalizedDomain,
                status,
                expiryDate: normalizedDetail.expiryDate || null,
                expiryDateIST: normalizedDetail.expiryDateIST || formatToIST(normalizedDetail.expiryDate),
                daysRemaining: normalizedDetail.daysRemaining ?? null,
                details: ''
            };
        })
        .filter(Boolean);

    const htmlEntries = [];
    if (fs.existsSync(DOMAIN_REPORT_OUTPUT_PATH)) {
        const html = fs.readFileSync(DOMAIN_REPORT_OUTPUT_PATH, 'utf8');
        const cardPattern = /<div class="domain-card(?: expiring-soon| error)?"[^>]*>[\s\S]*?<div class="days-remaining(?: [^"]+)?"[^>]*>[\s\S]*?<\/div>[\s\S]*?<\/div>[\s\S]*?<\/div>/gi;

        for (const cardMatch of html.matchAll(cardPattern)) {
            const cardHtml = cardMatch[0];
            const nameMatch = cardHtml.match(/<div class="domain-name">([^<]+)<\/div>/i);
            const domainMatch = cardHtml.match(/<div class="domain-url">([^<]+)<\/div>/i);
            const badgeClassMatch = cardHtml.match(/<span class="status-badge ([^"]+)">/i);
            const expiryDateMatch = cardHtml.match(/<div class="expiry-date">([^<]+)<\/div>/i);
            const expiryDateISTMatch = cardHtml.match(/<div class="expiry-date-ist">([^<]+)<\/div>/i);
            const daysTextMatch = cardHtml.match(/<div class="days-remaining(?: [^"]+)?"[^>]*>\s*([^<]+)\s*<\/div>/i);

            if (!nameMatch || !domainMatch || !badgeClassMatch || !expiryDateMatch) {
                continue;
            }

            const badgeClass = badgeClassMatch[1] || '';
            const daysText = decodeHtml((daysTextMatch && daysTextMatch[1]) || '');
            const daysRemaining = normalizeDaysRemaining(daysText);
            const status = classifyExpiryStatus(daysRemaining, !badgeClass.includes('status-active'));

            htmlEntries.push({
                name: decodeHtml(nameMatch[1]),
                domain: decodeHtml(domainMatch[1]),
                status,
                expiryDate: decodeHtml(expiryDateMatch[1]),
                expiryDateIST: decodeHtml((expiryDateISTMatch && expiryDateISTMatch[1]) || '') || formatToIST(decodeHtml(expiryDateMatch[1])),
                daysRemaining,
                details: daysText
            });
        }
    }

    if (fs.existsSync(DOMAIN_MODULE_REPORT_PATH)) {
        const html = fs.readFileSync(DOMAIN_MODULE_REPORT_PATH, 'utf8');
        const cardPattern = /<article class="report-card [^"]+">[\s\S]*?<\/article>/gi;

        for (const cardMatch of html.matchAll(cardPattern)) {
            const cardHtml = cardMatch[0];
            const nameMatch = cardHtml.match(/<h2>([^<]+)<\/h2>/i);
            const badgeMatch = cardHtml.match(/<span class="badge [^"]+">([^<]+)<\/span>/i);
            if (!nameMatch) {
                continue;
            }

            const fields = {};
            for (const fieldMatch of cardHtml.matchAll(/<div class="field(?: [^"]+)?">\s*<div class="field-label">([^<]+)<\/div>\s*<div class="field-value">([\s\S]*?)<\/div>\s*<\/div>/gi)) {
                fields[decodeHtml(fieldMatch[1])] = stripHtml(fieldMatch[2]);
            }

            const domain = decodeHtml(nameMatch[1]);
            const statusText = decodeHtml((badgeMatch && badgeMatch[1]) || '').toLowerCase();
            htmlEntries.push({
                name: domain,
                domain,
                url: fields.URL || `https://${normalizeDomainValue(domain)}`,
                status: statusText === 'failed' ? 'failed' : statusText === 'warning' ? 'warning' : 'passed',
                expiryDate: fields['Expiry Date (UTC)'] || null,
                expiryDateIST: fields['Expiry Date (IST)'] || formatToIST(fields['Expiry Date (UTC)']),
                daysRemaining: normalizeDaysRemaining(fields['Days Remaining']),
                details: fields['Domain Status'] || statusText
            });
        }
    }

    const entries = dedupeTrackedResults('domain', [...stateEntries, ...htmlEntries].map(normalizeDomainDetail));

    suiteConfigCache.domains = entries;
    suiteConfigCache.domainsCacheKey = stateGeneratedAt;
    return suiteConfigCache.domains;
}

function loadSslReportEntries() {
    const state = readDashboardState();
    const stateGeneratedAt = state && state.generatedAt ? state.generatedAt : '';

    if (suiteConfigCache.ssl && suiteConfigCache.sslCacheKey === stateGeneratedAt) {
        return suiteConfigCache.ssl;
    }

    const stateDetails = state && state.suites && state.suites.cert && Array.isArray(state.suites.cert.details)
        ? state.suites.cert.details
        : [];

    const normalizedStateEntries = stateDetails
        .map((detail) => normalizeSslDetail(detail))
        .filter((detail) => normalizeSslHost(detail && (detail.domain || detail.url)))
        .map((detail) => ({
            domain: normalizeSslHost(detail.domain || detail.url),
            url: detail.url || `https://${normalizeSslHost(detail.domain || detail.url)}`,
            status: detail.status,
            expiryDate: detail.expiryDate || null,
            expiryDateIST: detail.expiryDateIST || formatToIST(detail.expiryDate),
            daysRemaining: detail.daysRemaining ?? null,
            reason: detail.reason || ''
        }));

    const htmlEntries = [];
    if (fs.existsSync(CERTIFICATE_REPORT_OUTPUT_PATH)) {
        const html = fs.readFileSync(CERTIFICATE_REPORT_OUTPUT_PATH, 'utf8');
        const cardPattern = /<div class="cert-card(?: expiring-soon| error)?"[^>]*>[\s\S]*?<div class="days-remaining(?: [^"]+)?"[^>]*>[\s\S]*?<\/div>[\s\S]*?<\/div>[\s\S]*?<\/div>/gi;

        for (const cardMatch of html.matchAll(cardPattern)) {
            const cardHtml = cardMatch[0];
            const nameMatch = cardHtml.match(/<div class="cert-name">([^<]+)<\/div>/i);
            const urlMatch = cardHtml.match(/<div class="cert-url">([^<]+)<\/div>/i);
            const badgeClassMatch = cardHtml.match(/<span class="status-badge ([^"]+)">/i);
            const expiryDateMatch = cardHtml.match(/<div class="expiry-date">([^<]+)<\/div>/i);
            const expiryDateISTMatch = cardHtml.match(/<div class="expiry-date-ist">([^<]+)<\/div>/i);
            const daysTextMatch = cardHtml.match(/<div class="days-remaining(?: [^"]+)?"[^>]*>\s*([^<]+)\s*<\/div>/i);
            const reasonMatch = cardHtml.match(/<div class="error-reason">(?:<strong>[^<]+<\/strong>\s*)?([^<]+)<\/div>/i);

            if (!nameMatch || !urlMatch || !badgeClassMatch || !expiryDateMatch) {
                continue;
            }

            const badgeClass = badgeClassMatch[1] || '';
            const url = decodeHtml(urlMatch[1]);
            const domain = normalizeSslHost(decodeHtml(nameMatch[1]) || url);
            const daysText = decodeHtml((daysTextMatch && daysTextMatch[1]) || '');
            const daysRemaining = normalizeDaysRemaining(daysText);
            const status = classifyExpiryStatus(daysRemaining, badgeClass.includes('status-error'));

            htmlEntries.push({
                domain,
                url: url || `https://${domain}`,
                status,
                expiryDate: decodeHtml(expiryDateMatch[1]),
                expiryDateIST: decodeHtml((expiryDateISTMatch && expiryDateISTMatch[1]) || '') || formatToIST(decodeHtml(expiryDateMatch[1])),
                daysRemaining,
                reason: decodeHtml((reasonMatch && reasonMatch[1]) || '') || daysText
            });
        }
    }

    if (fs.existsSync(SSL_MODULE_REPORT_PATH)) {
        const html = fs.readFileSync(SSL_MODULE_REPORT_PATH, 'utf8');
        const cardPattern = /<article class="report-card [^"]+">[\s\S]*?<\/article>/gi;

        for (const cardMatch of html.matchAll(cardPattern)) {
            const cardHtml = cardMatch[0];
            const nameMatch = cardHtml.match(/<h2>([^<]+)<\/h2>/i);
            const badgeMatch = cardHtml.match(/<span class="badge [^"]+">([^<]+)<\/span>/i);
            if (!nameMatch) {
                continue;
            }

            const fields = {};
            for (const fieldMatch of cardHtml.matchAll(/<div class="field(?: [^"]+)?">\s*<div class="field-label">([^<]+)<\/div>\s*<div class="field-value">([\s\S]*?)<\/div>\s*<\/div>/gi)) {
                fields[decodeHtml(fieldMatch[1])] = stripHtml(fieldMatch[2]);
            }

            const domain = normalizeSslHost(decodeHtml(nameMatch[1]) || fields.URL);
            const statusText = decodeHtml((badgeMatch && badgeMatch[1]) || '').toLowerCase();
            const reasonText = fields['Reason'] || fields['Certificate Status'] || statusText;
            const isTimeoutReason = /ETIMEDOUT|ECONNRESET|TCP.*timeout|timeout.*TCP|Unreachable.*machine/i.test(reasonText);
            const resolvedStatus = isTimeoutReason ? 'warning' : (statusText === 'failed' ? 'failed' : statusText === 'warning' ? 'warning' : 'passed');
            htmlEntries.push({
                domain,
                url: fields.URL || `https://${domain}`,
                status: resolvedStatus,
                expiryDate: fields['Expiry Date (UTC)'] || null,
                expiryDateIST: fields['Expiry Date (IST)'] || formatToIST(fields['Expiry Date (UTC)']),
                daysRemaining: normalizeDaysRemaining(fields['Days Remaining']),
                reason: isTimeoutReason ? 'Unreachable from this machine (TCP timeout)' : (fields['Certificate Status'] || statusText)
            });
        }
    }

    const mergedEntries = dedupeTrackedResults('ssl', [...normalizedStateEntries, ...htmlEntries].map(normalizeSslDetail));

    suiteConfigCache.ssl = mergedEntries;
    suiteConfigCache.sslCacheKey = stateGeneratedAt;
    return suiteConfigCache.ssl;
}

function createEmptySuiteResult() {
    return { total: 0, passed: 0, failed: 0, warning: 0, skipped: 0, tests: [] };
}

function getProjectDomainStatus(project, domainDetails) {
    const configuredDomains = new Set((project.domains || []).map((projectDomain) => normalizeDomainValue(projectDomain)).filter(Boolean));
    const matched = dedupeTrackedResults('domain', (domainDetails || []).map(normalizeDomainDetail)).filter((detail) =>
        configuredDomains.has(normalizeDomainValue(detail.domain || detail.url))
    );

    const total = matched.length;
    const passed = matched.filter((detail) => detail.status === 'active').length;
    const warning = matched.filter((detail) => detail.status === 'expiring').length;
    const failed = matched.filter((detail) => detail.status === 'error').length;

    return { total, passed, warning, failed, matched };
}

function getProjectSslDetails(project, sslDetails) {
    const sslEntries = getProjectSslEntries(project);
    const configuredSslEntries = new Set(sslEntries.map((entry) => normalizeDomainValue(entry)).filter(Boolean));
    const sslResults = dedupeTrackedResults('ssl', (sslDetails || []).map(normalizeSslDetail)).filter((detail) =>
        configuredSslEntries.has(normalizeDomainValue(detail.domain || detail.url))
    );
    return sslResults;
}

function attachProjectDomainStatuses(projects, dashboardState) {
    const domainDetails = loadDomainReportEntries().map(normalizeDomainDetail);

    projects.forEach((project) => {
        const status = getProjectDomainStatus(project, domainDetails);
        project.domainStatus = {
            total: status.total,
            passed: status.passed,
            warning: status.warning,
            failed: status.failed
        };
    });
}

function attachProjectSslDetails(projects, dashboardState) {
    const sslDetails = loadSslReportEntries().map(normalizeSslDetail);

    projects.forEach((project) => {
        project.sslDetails = getProjectSslDetails(project, sslDetails);
    });
}

function attachProjectServerStatuses(projects) {
    (projects || []).forEach((project) => {
        const serverResults = getServerTestResults(project.id);
        const serverByKey = new Map((serverResults.tests || []).map((test) => [`${normalizeText(test.name)}::${normalizeUrl(test.url)}`, test]));

        project.servers = (project.servers || []).map((server) => {
            const key = `${normalizeText(server.name)}::${normalizeUrl(server.url)}`;
            const matched = serverByKey.get(key);

            if (matched) {
                return {
                    ...server,
                    status: matched.status,
                    message: matched.message || matched.reason,
                    responseTime: matched.responseTime ?? 0
                };
            }

            if (isSkippedServerDefinition(server)) {
                return {
                    ...server,
                    status: 'skipped',
                    message: SKIPPED_SERVER_MESSAGE,
                    responseTime: 0
                };
            }

            return server;
        });
    });
}

function getAppTestResults(projectId) {
    if (resultsCleared && !projectResultOverride[projectId]?.apps) return createEmptySuiteResult();
    if (projectResultOverride[projectId] && projectResultOverride[projectId].apps) return projectResultOverride[projectId].apps;
    const state = readDashboardState();
    if (!state || !state.generatedAt) return createEmptySuiteResult();
    try {
        const mapping = getProjectMapping();
        const project = mapping.projects.find((entry) => entry.id === projectId);

        if (!project || !project.apps || project.apps.length === 0) {
            return createEmptySuiteResult();
        }

        const rows = readSuiteRows('Adhash_App_Status');
        const definitions = loadAppSuiteDefinitions();
        const result = createEmptySuiteResult();

        project.apps.forEach((app) => {
            const appDefinitions = definitions.filter((entry) => normalizeText(entry.appName) === normalizeText(app.name));
            if (!appDefinitions.length) {
                return;
            }

            appDefinitions.forEach((definition) => {
                const platform = definition.platform || 'Play Store';
                // Try both naming conventions used by different spec generators
                const row = findSuiteRow(rows, `Verify ${definition.appName} on ${platform}`) ||
                            findSuiteRow(rows, `App Status: ${definition.appName} (${platform})`) ||
                            findSuiteRow(rows, `App Status: ${app.name} (${platform})`);
                if (!row || row.status === 'skipped') {
                    return;
                }

                result.total++;
                if (row.status === 'passed') {
                    result.passed++;
                } else if (row.status === 'warning') {
                    result.warning++;
                } else {
                    result.failed++;
                }

                result.tests.push({
                    name: definition.appName,
                    platform,
                    url: definition.expectedUrl,
                    status: row.status,
                    type: 'app'
                });
            });
        });

        return result;
    } catch (error) {
        console.error('Error getting app test results:', error);
        return createEmptySuiteResult();
    }
}

function getServerTestResults(projectId) {
    if (resultsCleared && !projectResultOverride[projectId]?.servers) return createEmptySuiteResult();
    if (projectResultOverride[projectId] && projectResultOverride[projectId].servers) return projectResultOverride[projectId].servers;
    const state = readDashboardState();
    if (!state || !state.generatedAt) return createEmptySuiteResult();
    try {
        const mapping = getProjectMapping();
        const project = mapping.projects.find((entry) => entry.id === projectId);

        if (!project || !project.servers || project.servers.length === 0) {
            return createEmptySuiteResult();
        }

        const rows = readSuiteRows('Adhash_AllProjects_Server');
        const result = createEmptySuiteResult();

        project.servers.forEach((server) => {
            const row = findSuiteRow(rows, `Check ${server.name} health`);
            if (!row && !isSkippedServerDefinition(server)) {
                return;
            }

            if (isSkippedServerDefinition(server) || row.status === 'skipped') {
                result.total++;
                result.skipped++;
                result.tests.push(buildSkippedServerResult(server));
                return;
            }

            result.total++;
            if (row.status === 'passed') {
                result.passed++;
            } else {
                result.failed++;
            }

            result.tests.push({
                name: server.name,
                url: server.url || '#',
                type: 'server',
                status: row.status,
                message: row.details || row.badge,
                responseTime: 0
            });
        });

        return result;
    } catch (error) {
        console.error('Error getting server test results:', error);
        return createEmptySuiteResult();
    }
}

function getSSLTestResults(projectId) {
    if (resultsCleared && !projectResultOverride[projectId]?.ssl) return createEmptySuiteResult();
    if (projectResultOverride[projectId] && projectResultOverride[projectId].ssl) return projectResultOverride[projectId].ssl;
    // Only read shared report files if a full run has been completed (generatedAt set)
    const state = readDashboardState();
    if (!state || !state.generatedAt) return createEmptySuiteResult();
    try {
        const sslDetails = dedupeTrackedResults('ssl', loadSslReportEntries().map(normalizeSslDetail));
        const mapping = getProjectMapping();
        const project = mapping.projects.find((entry) => entry.id === projectId);

        const sslEntries = getProjectSslEntries(project);

        if (!project || sslEntries.length === 0) {
            return createEmptySuiteResult();
        }

        const result = createEmptySuiteResult();

        const matched = dedupeTrackedResults('ssl', getProjectSslDetails(project, sslDetails));

        result.total = matched.length;
        result.passed = matched.filter((detail) => detail.status === 'passed').length;
        result.warning = matched.filter((detail) => detail.status === 'warning').length;
        result.failed = matched.filter((detail) => detail.status === 'failed').length;
        result.details = matched;

        matched.forEach((detail) => {
            result.tests.push({
                name: detail.domain,
                url: detail.url,
                status: detail.status,
                type: 'ssl',
                expiryDate: detail.expiryDate,
                expiryDateIST: detail.expiryDateIST || formatToIST(detail.expiryDate),
                daysRemaining: detail.daysRemaining,
                reason: detail.reason
            });
        });

        return result;
    } catch (error) {
        console.error('Error getting SSL test results:', error);
        return createEmptySuiteResult();
    }
}

function getDomainTestResults(projectId) {
    if (resultsCleared && !projectResultOverride[projectId]?.domains) return createEmptySuiteResult();
    if (projectResultOverride[projectId] && projectResultOverride[projectId].domains) return projectResultOverride[projectId].domains;
    // Only read shared report files if a full run has been completed (generatedAt set)
    const state = readDashboardState();
    if (!state || !state.generatedAt) return createEmptySuiteResult();
    try {
        const domainDetails = dedupeTrackedResults('domain', loadDomainReportEntries().map(normalizeDomainDetail));
        const mapping = getProjectMapping();
        const project = mapping.projects.find((entry) => entry.id === projectId);

        if (!project || !project.domains || project.domains.length === 0) {
            return createEmptySuiteResult();
        }

        const result = createEmptySuiteResult();
        const status = getProjectDomainStatus(project, domainDetails);

        result.total = status.total;
        result.passed = status.passed;
        result.warning = status.warning;
        result.failed = status.failed;

        status.matched.forEach((detail) => {
            result.tests.push({
                name: detail.domain,
                url: detail.url || `https://${detail.domain}`,
                status: detail.status === 'active' ? 'passed' : detail.status === 'expiring' ? 'warning' : 'failed',
                type: 'domain',
                expiryDate: detail.expiryDate || null,
                expiryDateIST: detail.expiryDateIST || formatToIST(detail.expiryDate),
                daysRemaining: detail.daysRemaining ?? null
            });
        });

        return result;
    } catch (error) {
        console.error('Error getting domain test results:', error);
        return createEmptySuiteResult();
    }
}

function getAPITestResults(projectId) {
    if (resultsCleared && !projectResultOverride[projectId]?.apis) return createEmptySuiteResult();
    if (projectResultOverride[projectId] && projectResultOverride[projectId].apis) return projectResultOverride[projectId].apis;
    const state = readDashboardState();
    if (!state || !state.generatedAt) return createEmptySuiteResult();
    try {
        const dashboardState = state;
        const apiSuite = dashboardState && dashboardState.suites ? dashboardState.suites.api : null;
        const apiDetails = apiSuite && Array.isArray(apiSuite.details) ? apiSuite.details : [];
        const mapping = getProjectMapping();
        const project = mapping.projects.find((entry) => entry.id === projectId);

        if (!project || !project.apis || project.apis.length === 0) {
            return createEmptySuiteResult();
        }

        const result = createEmptySuiteResult();
        const projectApiKeys = new Set((project.apis || []).map((api) => buildApiStableKey(api.method, api.url, api.name)));

        const rows = readSuiteRows('AdHash_API_Test');
        const detailByKey = new Map(
            dedupeApiResults(
                apiDetails.filter((detail) => detail && projectApiKeys.has(buildApiStableKey(detail.method, detail.url, detail.name)))
            ).map((detail) => [buildApiStableKey(detail.method, detail.url, detail.name), detail])
        );
        const apiResults = [];

        project.apis.forEach((api) => {
            const stableKey = buildApiStableKey(api.method, api.url, api.name);
            const method = (api.method || 'GET').toUpperCase();
            const row = findSuiteRow(rows, `${method} ${api.name}`);
            const detail = detailByKey.get(stableKey);

            if (row) {
                if (row.status === 'skipped') {
                    // If the dashboard-state detail has a definitive status (passed/failed/warning),
                    // always prefer it over the stale suite-report row's 'skipped' classification.
                    const detailStatus = detail && String(detail.status || '').toLowerCase();
                    if (detail && (detailStatus === 'passed' || detailStatus === 'failed' || detailStatus === 'warning')) {
                        const expectedStatus = parseExpectedStatus(api.expectedStatus) ?? parseExpectedStatus(detail.expectedStatus) ?? parseExpectedStatus(row.expectedStatus);
                        apiResults.push({
                            name: api.name,
                            url: api.url,
                            method,
                            duration: detail.duration || row.duration,
                            requestBody: detail.requestBody || row.requestBody || (normalizeApiMethod(method) === 'GET' ? 'No request body' : 'Payload not provided'),
                            responseBody: detail.responseBody || row.responseBody || 'No response body',
                            responseCode: detail.responseCode || row.responseCode || null,
                            expectedStatus,
                            status: detailStatus,
                            type: 'api'
                        });
                        return;
                    }

                    const skippedReason = row.details || (detail && detail.reason) || 'Skipped by suite';
                    const normalizedSkippedReason = String(skippedReason || '').trim().toLowerCase();
                    // Only use the row's own responseBody here – falling back to detail.responseBody
                    // would incorrectly suppress tests whose detail says "No response body" but whose
                    // actual status is a real failure.
                    const normalizedRowResponseBody = String(row.responseBody || '').trim().toLowerCase();

                    // Ignore placeholder rows that are effectively "not run" rather than actionable skips.
                    if (normalizedSkippedReason === 'no response body' || normalizedRowResponseBody === 'no response body') {
                        return;
                    }

                    apiResults.push({
                        name: api.name,
                        url: api.url,
                        method,
                        duration: (detail && detail.duration) || row.duration,
                        requestBody: row.requestBody || (detail && detail.requestBody) || (normalizeApiMethod(method) === 'GET' ? 'No request body' : 'Payload not provided'),
                        responseBody: row.responseBody || (detail && detail.responseBody) || 'No response body',
                        responseCode: row.responseCode || (detail && detail.responseCode) || null,
                        expectedStatus: parseExpectedStatus(api.expectedStatus) ?? parseExpectedStatus(row.expectedStatus) ?? parseExpectedStatus(detail && detail.expectedStatus),
                        status: 'skipped',
                        type: 'api',
                        reason: skippedReason
                    });
                    return;
                }

                const expectedStatus = parseExpectedStatus(api.expectedStatus) ?? parseExpectedStatus(row.expectedStatus) ?? parseExpectedStatus(detail && detail.expectedStatus);
                const status = classifyApiStatus(row.responseCode, expectedStatus);

                apiResults.push({
                    name: api.name,
                    url: api.url,
                    method,
                    duration: (detail && detail.duration) || row.duration,
                    requestBody: row.requestBody || (detail && detail.requestBody) || (normalizeApiMethod(method) === 'GET' ? 'No request body' : 'Payload not provided'),
                    responseBody: row.responseBody || (detail && detail.responseBody) || 'No response body',
                    responseCode: row.responseCode || (detail && detail.responseCode),
                    expectedStatus,
                    status,
                    type: 'api'
                });
                return;
            }

            if (!detail) {
                return;
            }

            const detailStatus = String(detail.status || '').toLowerCase();
            const detailReason = String(detail.reason || '').toLowerCase();
            const detailResponseBody = String(detail.responseBody || '').toLowerCase();

            // Ignore synthetic placeholders when an API check never actually executed.
            if (detailStatus === 'skipped' && (detailReason === 'no response body' || detailResponseBody === 'no response body')) {
                return;
            }

            apiResults.push({
                ...detail,
                name: api.name,
                url: api.url,
                method,
                expectedStatus: parseExpectedStatus(api.expectedStatus) ?? parseExpectedStatus(detail.expectedStatus),
                requestBody: detail.requestBody || (normalizeApiMethod(method) === 'GET' ? 'No request body' : 'Payload not provided'),
                responseBody: detail.responseBody || 'No response body'
            });
        });

        result.tests = dedupeApiResults(apiResults);
        result.total = result.tests.length;
        result.passed = result.tests.filter((detail) => detail.status === 'passed').length;
        result.warning = result.tests.filter((detail) => detail.status === 'warning').length;
        result.failed = result.tests.filter((detail) => detail.status === 'failed').length;
        result.skipped = result.tests.filter((detail) => detail.status === 'skipped').length;

        return result;
    } catch (error) {
        console.error('Error getting API test results:', error);
        return createEmptySuiteResult();
    }
}

// API endpoint to get test results for a project
app.get('/api/project/:id/test-results', (req, res) => {
    try {
        const projectId = req.params.id;

        const results = {
            apps: getAppTestResults(projectId),
            servers: getServerTestResults(projectId),
            ssl: getSSLTestResults(projectId),
            domains: getDomainTestResults(projectId),
            apis: getAPITestResults(projectId)
        };

        res.json({
            projectId,
            results
        });
    } catch (error) {
        console.error('❌ Error fetching test results:', error);
        res.status(500).json({
            projectId: req.params.id,
            results: {
                apps: createEmptySuiteResult(),
                servers: createEmptySuiteResult(),
                ssl: createEmptySuiteResult(),
                domains: createEmptySuiteResult(),
                apis: createEmptySuiteResult()
            },
            error: 'Failed to fetch test results',
            message: error.message
        });
    }
});

// Main route — redirect authenticated users to landing, otherwise login
app.get('/', (req, res) => {
    if (isAuthenticated(req)) {
        return res.redirect('/landing');
    }
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    return res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Landing page — workspace selector
app.get('/landing', (req, res) => {
    if (!isAuthenticated(req)) {
        return res.redirect('/');
    }
    return res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

// QA Dashboard
app.get('/qa-dashboard', (req, res) => {
    if (!isAuthenticated(req)) {
        return res.redirect('/');
    }
    return res.sendFile(path.join(__dirname, 'public', 'qa-dashboard.html'));
});

app.get('/project-dashboard', (req, res) => {
    if (!isAuthenticated(req)) {
        return res.redirect('/');
    }
    return res.sendFile(path.join(__dirname, 'public', 'project-dashboard.html'));
});

app.get('/project-dashboard.html', (req, res) => {
    if (!isAuthenticated(req)) {
        return res.redirect('/');
    }
    return res.sendFile(path.join(__dirname, 'public', 'project-dashboard.html'));
});

app.get('/public/project-dashboard.html', (req, res) => {
    if (!isAuthenticated(req)) {
        return res.redirect('/');
    }
    return res.sendFile(path.join(__dirname, 'public', 'project-dashboard.html'));
});

// ─── PROJECT MANAGEMENT API ───────────────────────────────────────────────────

const PROJECT_MAPPING_PATH = path.join(__dirname, 'config', 'project-mapping.json');
const GH_MAPPING_FILE = 'config/project-mapping.json';

// In-memory cache of project-mapping — loaded from GitHub on startup, updated on every write.
// This survives Railway redeploys because GitHub is the source of truth, not the Railway disk.
let _projectMappingCache = null;

// Called by routes/projects.js after a project is saved — updates the in-memory cache
// so regenerateSpecFiles() immediately picks up the new apps/servers/apis without a redeploy.
function _invalidateProjectMappingCache(updatedData) {
    _projectMappingCache = updatedData || null;
    // Regenerate spec files immediately so the 5 test repos pick up new
    // servers/domains/apis/apps without requiring a separate redeploy.
    if (updatedData) {
        try { regenerateSpecFiles(); } catch (e) { console.warn('[spec-regen] failed:', e.message); }
    }
    // Push to GitHub so the new config survives future redeploys
    if (updatedData) _pushProjectMappingToGitHub(updatedData).catch(() => {});
}
module.exports._invalidateProjectMappingCache = _invalidateProjectMappingCache;

// Load project-mapping.json from GitHub API — called once on startup and after every write.
async function _loadProjectMappingFromGitHub() {
    const token = process.env.GITHUB_TOKEN || process.env.GH_PAT || '';
    if (!token) return null;
    try {
        const r = await _ghRequest('GET', `/repos/${GH_API_REPO}/contents/${GH_MAPPING_FILE}`, null, token);
        if (r.status === 200 && r.body && r.body.content) {
            const content = Buffer.from(r.body.content, 'base64').toString('utf8');
            const parsed = JSON.parse(content);
            _projectMappingCache = parsed;
            // Also write to local disk as fallback for spec regeneration
            try { fs.writeFileSync(PROJECT_MAPPING_PATH, JSON.stringify(parsed, null, 2), 'utf8'); } catch (_) {}
            console.log('[project-mapping] ✅ Loaded from GitHub —', (parsed.projects || []).length, 'projects');
            return parsed;
        }
    } catch (e) {
        console.warn('[project-mapping] GitHub load failed:', e.message);
    }
    return null;
}

function readProjectMapping() {
    // 1. In-memory cache (set on startup and after every write)
    if (_projectMappingCache) return _projectMappingCache;
    // 2. Local disk fallback (exists if GitHub load succeeded on startup)
    try {
        const parsed = JSON.parse(fs.readFileSync(PROJECT_MAPPING_PATH, 'utf8'));
        _projectMappingCache = parsed;
        return parsed;
    } catch (e) {}
    return { projects: [] };
}

// Write project-mapping: update cache + disk + GitHub in one atomic operation.
// GitHub is the source of truth — disk is just a local copy for spec regeneration.
function writeProjectMapping(data) {
    // 1. Update in-memory cache immediately (UI reads this synchronously)
    _projectMappingCache = data;
    // 2. Write to local disk (for spec file regeneration which runs synchronously)
    try { fs.writeFileSync(PROJECT_MAPPING_PATH, JSON.stringify(data, null, 2), 'utf8'); } catch (_) {}
    // 3. Push to GitHub asynchronously — this is what survives Railway redeploys
    _pushProjectMappingToGitHub(data).catch(e => console.warn('[project-mapping] GitHub push failed:', e.message));
}

// Push project-mapping.json to GitHub via API (not git CLI — works reliably on Railway).
async function _pushProjectMappingToGitHub(data) {
    const token = process.env.GITHUB_TOKEN || process.env.GH_PAT || '';
    if (!token) return;
    try {
        // Get current SHA (required for update)
        const getR = await _ghRequest('GET', `/repos/${GH_API_REPO}/contents/${GH_MAPPING_FILE}`, null, token);
        const sha = getR.status === 200 && getR.body ? getR.body.sha : undefined;
        const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
        const putR = await _ghRequest('PUT', `/repos/${GH_API_REPO}/contents/${GH_MAPPING_FILE}`, {
            message: 'chore: sync project-mapping.json from dashboard UI',
            content,
            ...(sha ? { sha } : {}),
        }, token);
        if (putR.status === 200 || putR.status === 201) {
            console.log('[project-mapping] ✅ Pushed to GitHub');
        } else {
            console.warn('[project-mapping] GitHub push returned', putR.status);
        }
    } catch (e) {
        console.warn('[project-mapping] _pushProjectMappingToGitHub error:', e.message);
    }
}

// Fire-and-forget: push updated spec files to all 5 GitHub repos in the background.
// Called after every project create / update / delete so GitHub always stays in sync.
// Commit project-mapping.json to the main AdHash_Project_Dashboard repo so GitHub
// Actions always gets the latest project list when the workflow runs.
// Then push updated spec files to all 5 sibling test repos.
// Both steps run in the background — does not block the HTTP response.
function autoPushSpecsToGitHub() {
    const token = process.env.GITHUB_TOKEN || process.env.GH_PAT || '';
    if (!token) {
        addLog('⚠️ Auto-push skipped: GITHUB_TOKEN not set in .env', 'warning');
        return;
    }

    const { execFile, spawn: spawnChild } = require('child_process');
    const gitEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: 'AdHash Dashboard',
        GIT_AUTHOR_EMAIL: 'dashboard@adhashtech.com',
        GIT_COMMITTER_NAME: 'AdHash Dashboard',
        GIT_COMMITTER_EMAIL: 'dashboard@adhashtech.com'
    };

    // Step 1 — commit + push project-mapping.json to this repo on GitHub
    function commitAndPushMapping(onDone) {
        addLog('🔄 Committing project-mapping.json to GitHub...', 'info');

        // Ensure git remote uses token for authentication (no prompt)
        const authedRemote = `https://${token}@github.com/AHY18099/AdHash_Project_Dashboard.git`;

        const gitSteps = [
            ['git', ['config', 'user.email', 'dashboard@adhashtech.com']],
            ['git', ['config', 'user.name', 'AdHash Dashboard']],
            ['git', ['remote', 'set-url', 'origin', authedRemote]],
            ['git', ['add', 'config/project-mapping.json']],
            ['git', ['commit', '-m', 'chore: sync project-mapping.json from dashboard UI', '--allow-empty']],
            ['git', ['push', 'origin', 'HEAD']]
        ];

        let idx = 0;
        function runNext() {
            if (idx >= gitSteps.length) {
                addLog('✅ project-mapping.json pushed to GitHub.', 'success');
                onDone();
                return;
            }
            const [cmd, args] = gitSteps[idx++];
            execFile(cmd, args, { cwd: __dirname, env: gitEnv }, (err, stdout, stderr) => {
                if (err) {
                    // "nothing to commit" is not a real error — continue
                    if (stderr && stderr.includes('nothing to commit')) {
                        addLog('ℹ️ project-mapping.json unchanged — no commit needed.', 'info');
                        // still push in case a previous commit wasn't pushed
                        idx = gitSteps.length - 1;
                        runNext();
                        return;
                    }
                    addLog('⚠️ git step failed: ' + (stderr || err.message), 'warning');
                    onDone(); // continue to spec push regardless
                    return;
                }
                runNext();
            });
        }
        runNext();
    }

    // Step 2 — push regenerated spec files to the 5 sibling test repos via GitHub API
    function pushSpecFiles() {
        const pushScript = path.join(__dirname, 'scripts', 'push-specs-to-github.mjs');
        if (!fs.existsSync(pushScript)) {
            addLog('⚠️ push-specs-to-github.mjs not found — spec push skipped', 'warning');
            return;
        }
        addLog('🔄 Pushing updated test specs to sibling repos...', 'info');
        const child = spawnChild('node', [pushScript], {
            cwd: __dirname, shell: false, env: process.env, stdio: ['ignore', 'pipe', 'pipe']
        });
        child.stdout.on('data', (d) => { const l = d.toString().trim(); if (l) addLog(l, 'info'); });
        child.stderr.on('data', (d) => { const l = d.toString().trim(); if (l) addLog('⚠️ ' + l, 'warning'); });
        child.on('close', (code) => {
            addLog(code === 0 ? '✅ Test specs pushed to all sibling repos.' : '⚠️ Spec push exited with code ' + code, code === 0 ? 'success' : 'warning');
        });
        child.on('error', (err) => { addLog('❌ Spec push error: ' + err.message, 'error'); });
    }

    // Run step 1, then step 2
    commitAndPushMapping(pushSpecFiles);
}

// Regenerate spec files for all 5 test repositories from current project-mapping.json
// If in-memory cache is populated it's used directly; otherwise reads from disk.
// When called after Save Project, cache has already been updated with the new data.
function regenerateSpecFiles() {
    const mapping = readProjectMapping();
    const projects = mapping.projects || [];

    // 1. Server health spec  →  Adhash_AllProjects_Server
    const serverSpecDir = path.join(__dirname, '..', 'Adhash_AllProjects_Server', 'tests', 'server-health');
    if (fs.existsSync(serverSpecDir)) {
        const servers = [];
        projects.forEach(p => {
            (p.servers || []).forEach(s => servers.push({ name: s.name, url: s.url }));
        });
        const serverSpec = `import { test, expect } from '@playwright/test';
const SERVERS = ${JSON.stringify(servers, null, 2)};
for (const server of SERVERS) {
  test(\`Server Health: \${server.name}\`, async ({ request }) => {
    const res = await request.get(server.url, { timeout: 30000 });
    expect(res.status()).toBeLessThan(500);
  });
}
`;
        fs.writeFileSync(path.join(serverSpecDir, 'server-check.spec.ts'), serverSpec, 'utf8');
        logToArray('info', `Regenerated server spec (${servers.length} servers)`);
    }

    // 2. SSL cert spec  →  AdHash-Projects-Certificate-Expiry-Test
    const certSpecDir = path.join(__dirname, '..', 'AdHash-Projects-Certificate-Expiry-Test', 'tests', 'certificate');
    if (fs.existsSync(certSpecDir)) {
        const certs = [];
        projects.forEach(p => {
            (p.sslCerts || []).forEach(domain => certs.push({ name: `${p.name} - ${domain}`, domain }));
        });
        const certSpec = `import { test, expect } from '@playwright/test';
import * as tls from 'tls';
const CERTS = ${JSON.stringify(certs, null, 2)};
for (const cert of CERTS) {
  test(\`SSL Certificate: \${cert.name}\`, async () => {
    await new Promise<void>((resolve, reject) => {
      const socket = tls.connect(443, cert.domain, { servername: cert.domain }, () => {
        const c = socket.getPeerCertificate();
        const expiry = new Date(c.valid_to);
        const daysLeft = Math.floor((expiry.getTime() - Date.now()) / 86400000);
        socket.destroy();
        if (daysLeft < 7) reject(new Error(\`Certificate expires in \${daysLeft} days\`));
        else resolve();
      });
      socket.on('error', reject);
    });
  });
}
`;
        fs.writeFileSync(path.join(certSpecDir, 'cert-expiry.spec.ts'), certSpec, 'utf8');
        logToArray('info', `Regenerated cert spec (${certs.length} certs)`);
    }

    // 3. API spec  →  AdHash-API-Test
    const apiSpecDir = path.join(__dirname, '..', 'AdHash-API-Test', 'tests', 'api');
    if (fs.existsSync(apiSpecDir)) {
        const apis = [];
        projects.forEach(p => {
            (p.apis || []).forEach(a => apis.push({
                name: a.name || a.url,
                url: a.url,
                method: (a.method || 'GET').toUpperCase(),
                headers: a.headers || {},
                body: a.body || null,
                expectedStatus: a.expectedStatus || 200
            }));
        });
        const apiSpec = `import { test, expect } from '@playwright/test';

// Auto-generated from config/project-mapping.json — do not edit manually
const APIS = ${JSON.stringify(apis, null, 2)};

for (const api of APIS) {
  test(\`API: \${api.name}\`, async ({ request }) => {
    const opts: Parameters<typeof request.get>[1] & any = {
      timeout: 30000,
      failOnStatusCode: false,
    };
    if (Object.keys(api.headers || {}).length) opts.headers = api.headers;
    if (api.body) opts.data = api.body;
    const res = await request[api.method.toLowerCase() as 'get'|'post'|'put'|'delete'|'patch'](api.url, opts);
    expect(
      res.status(),
      \`Expected \${api.expectedStatus}, got \${res.status()} for \${api.url}\`
    ).toBe(api.expectedStatus);
  });
}
`;
        fs.writeFileSync(path.join(apiSpecDir, 'api-tests.spec.ts'), apiSpec, 'utf8');
        logToArray('info', `Regenerated API spec (${apis.length} endpoints)`);
    }

    // 4. App status spec  →  Adhash_App_Status
    const appSpecDir = path.join(__dirname, '..', 'Adhash_App_Status', 'tests', 'app-status');
    if (fs.existsSync(appSpecDir)) {
        const appEntries = [];
        projects.forEach(p => {
            (p.apps || []).forEach(a => {
                const play = normalizePlayStoreValue(a.playStore);
                if (play) appEntries.push({ name: `${p.name} — ${a.name} (Play Store)`, url: play.expectedUrl });
                const ios = normalizeAppStoreValue(a.appStore);
                if (ios) appEntries.push({ name: `${p.name} — ${a.name} (App Store)`, url: ios.expectedUrl });
            });
        });
        const appSpec = `// Auto-generated from config/project-mapping.json — do not edit manually
import { test, expect } from '@playwright/test';
const APPS = ${JSON.stringify(appEntries, null, 2)};
for (const app of APPS) {
  test(\`App Status: \${app.name}\`, async ({ request }) => {
    const res = await request.get(app.url, { timeout: 30000, failOnStatusCode: false });
    expect(res.status(), \`\${app.url} returned \${res.status()}\`).toBeLessThan(400);
  });
}
`;
        fs.writeFileSync(path.join(appSpecDir, 'playstore.spec.ts'), appSpec, 'utf8');
        logToArray('info', `Regenerated app spec (${appEntries.length} apps)`);
    }

    // 5. Domain report  →  AdHash_Domain_Report (write a domains.json config file)
    const domainRepoDir = path.join(__dirname, '..', 'AdHash_Domain_Report');
    if (fs.existsSync(domainRepoDir)) {
        const domains = [];
        projects.forEach(p => {
            (p.domains || []).forEach(d => domains.push(d));
        });
        fs.writeFileSync(path.join(domainRepoDir, 'domains.json'), JSON.stringify({ domains }, null, 2), 'utf8');
        logToArray('info', `Regenerated domain list (${domains.length} domains)`);
    }

}

// POST create project
app.post('/api/projects', (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
    const data = readProjectMapping();
    const body = req.body;
    if (!body.id || !body.name) return res.status(400).json({ error: 'id and name are required' });
    if (data.projects.find(p => p.id === body.id)) return res.status(409).json({ error: 'Project id already exists' });
    const project = {
        id: body.id,
        name: body.name,
        description: body.description || '',
        color: body.color || '#3b82f6',
        apps: body.apps || [],
        servers: body.servers || [],
        domains: body.domains || [],
        sslCerts: body.sslCerts || [],
        apis: body.apis || []
    };
    data.projects.push(project);
    writeProjectMapping(data);
    regenerateSpecFiles();
    autoPushSpecsToGitHub();
    res.json({ success: true, project });
});

// PUT update project
app.put('/api/projects/:id', (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
    const data = readProjectMapping();
    const idx = data.projects.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Project not found' });
    const body = req.body;
    const existing = data.projects[idx];
    data.projects[idx] = {
        id: existing.id,
        name: body.name || existing.name,
        description: body.description !== undefined ? body.description : existing.description,
        color: body.color || existing.color,
        apps: body.apps !== undefined ? body.apps : existing.apps,
        servers: body.servers !== undefined ? body.servers : existing.servers,
        domains: body.domains !== undefined ? body.domains : existing.domains,
        sslCerts: body.sslCerts !== undefined ? body.sslCerts : existing.sslCerts,
        apis: body.apis !== undefined ? body.apis : existing.apis
    };
    writeProjectMapping(data);
    regenerateSpecFiles();
    autoPushSpecsToGitHub();
    res.json({ success: true, project: data.projects[idx] });
});

// DELETE project
app.delete('/api/projects/:id', (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
    const data = readProjectMapping();
    const idx = data.projects.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Project not found' });
    data.projects.splice(idx, 1);
    writeProjectMapping(data);
    regenerateSpecFiles();
    autoPushSpecsToGitHub();
    res.json({ success: true });
});

// POST /api/projects/:id/env — update display fields (website, dashboard, color, name) from UI edit modal
// Merges into project-mapping.json and triggers auto-push so spec files stay in sync.
app.post('/api/projects/:id/env', (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
    const data = readProjectMapping();
    const idx = data.projects.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Project not found' });
    const { website, dashboard, color, name } = req.body || {};
    const proj = data.projects[idx];
    if (name)      proj.name = name;
    if (color)     proj.color = color;
    if (website !== undefined) proj.website = website;
    if (dashboard !== undefined) proj.dashboard = dashboard;
    writeProjectMapping(data);
    autoPushSpecsToGitHub();
    res.json({ success: true });
});

// ══ SWAGGER API EXPLORER ════════════════════════════════════════════════════

// GET /api/swagger-configs/:projectId — list saved swagger URLs
app.get('/api/swagger-configs/:projectId', async (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const { getDB } = require('./src/db');
        const db = getDB();
        const configs = db
            ? await db.collection('swagger_configs').find({ projectId: req.params.projectId }).sort({ createdAt: 1 }).toArray()
            : [];
        res.json(configs.map(c => { const { _id, ...safe } = c; return safe; }));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/swagger-configs/:projectId — add swagger URL
app.post('/api/swagger-configs/:projectId', async (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const { getDB } = require('./src/db');
        const { ObjectId } = require('mongodb');
        const db = getDB();
        const session = getSessionFromCookie(req);
        const doc = {
            id: new ObjectId().toString(),
            projectId: req.params.projectId,
            name: req.body.name || 'API Docs',
            url: req.body.url,
            environment: req.body.environment || 'production',
            isActive: true,
            addedBy: session?.name || 'User',
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        if (db) await db.collection('swagger_configs').insertOne(doc);
        const { _id, ...safe } = doc;
        res.json(safe);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/swagger-configs/:id — remove swagger URL
app.delete('/api/swagger-configs/:id', async (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const { getDB } = require('./src/db');
        const db = getDB();
        if (db) await db.collection('swagger_configs').deleteOne({ id: req.params.id });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/swagger-proxy?url=... — fetch swagger spec through server to avoid CORS
app.get('/api/swagger-proxy', async (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url query param required' });
    try {
        const fetch = require('node-fetch');
        const response = await fetch(url, { headers: { Accept: 'application/json, application/yaml, text/yaml, */*' }, timeout: 15000 });
        if (!response.ok) return res.status(response.status).json({ error: `Upstream returned ${response.status}: ${response.statusText}` });
        const ct = response.headers.get('content-type') || '';
        let spec;
        if (ct.includes('yaml') || url.endsWith('.yaml') || url.endsWith('.yml')) {
            const yaml = require('js-yaml');
            spec = yaml.load(await response.text());
        } else {
            const text = await response.text();
            try { spec = JSON.parse(text); } catch (_) { spec = require('js-yaml').load(text); }
        }
        res.json(spec);
    } catch (e) { res.status(500).json({ error: 'Failed to fetch spec: ' + e.message }); }
});

// POST /api/swagger-execute — proxy API call to avoid CORS when running endpoints
app.post('/api/swagger-execute', async (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
    const { method, url, headers = {}, body, params = {} } = req.body || {};
    if (!url || !method) return res.status(400).json({ error: 'method and url required' });
    try {
        const fetch = require('node-fetch');
        let fullUrl = url;
        const qs = new URLSearchParams(params).toString();
        if (qs) fullUrl += (url.includes('?') ? '&' : '?') + qs;
        const t0 = Date.now();
        const r  = await fetch(fullUrl, {
            method: method.toUpperCase(),
            headers: { 'Content-Type': 'application/json', ...headers },
            body: ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) ? undefined : JSON.stringify(body),
            timeout: 30000,
        });
        const duration = Date.now() - t0;
        const text = await r.text();
        let responseBody;
        try { responseBody = JSON.parse(text); } catch (_) { responseBody = text; }
        res.json({ status: r.status, statusText: r.statusText, headers: Object.fromEntries(r.headers), body: responseBody, duration });
    } catch (e) { res.status(500).json({ error: 'Request failed: ' + e.message }); }
});

// POST /api/push-specs — commit & push regenerated spec files to all 5 GitHub repos
// Streams NDJSON log lines so the browser can show live progress.
// POST /api/admin/commit-and-push
// Exports all MongoDB data and pushes a timestamped backup to GitHub.
app.post('/api/admin/commit-and-push', async (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
    // Use env var — must be set in Railway → Variables
    const token = process.env.GITHUB_TOKEN || process.env.GH_PAT || '';
    if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN not set on Railway', hint: 'Add GITHUB_TOKEN in Railway → Variables' });

    try {
        const { getDB } = require('./src/db');
        const db = getDB();
        const steps = [];

        // Step A: export all collections from MongoDB
        steps.push('Fetching live data from MongoDB…');
        const COLLECTIONS = [
            'projects','credentials','smoke_tests','prod_checklist','task_checklist',
            'third_party','client_feedback','saved_reports','release_notes',
            'pending_tasks','daily_tasks','team_tasks','workflow_docs','env_details','releases',
        ];
        const backup = { exportedAt: new Date().toISOString(), version: '1.0', collections: {} };
        let totalRecords = 0;
        for (const col of COLLECTIONS) {
            try {
                backup.collections[col] = await db.collection(col).find({}).toArray();
                totalRecords += backup.collections[col].length;
            } catch (_) { backup.collections[col] = []; }
        }
        // Users without passwords
        backup.collections['users'] = await db.collection('users')
            .find({}, { projection: { password: 0 } }).toArray();
        totalRecords += backup.collections['users'].length;
        steps.push(`Exported ${totalRecords} records from ${COLLECTIONS.length + 1} collections`);

        // Step B: push backup file to GitHub
        steps.push('Pushing backup to GitHub…');
        const ts       = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filePath = `backups/data-backup-${ts}.json`;
        const content  = Buffer.from(JSON.stringify(backup, null, 2)).toString('base64');

        const ghPut = (path, body) => _ghRequest('PUT', `/repos/AHY18099/AdHash_Project_Dashboard/contents/${path}`, body, token);
        const ghGet = (path) => _ghRequest('GET', `/repos/AHY18099/AdHash_Project_Dashboard/contents/${path}`, null, token);

        // Get sha of existing file if it exists (needed for update)
        let sha;
        try { const r = await ghGet(filePath); if (r.status === 200) sha = r.body.sha; } catch (_) {}

        const putResult = await ghPut(filePath, {
            message: `backup: live data export ${ts}`,
            content,
            ...(sha ? { sha } : {}),
        });
        if (putResult.status !== 200 && putResult.status !== 201)
            throw new Error(`GitHub push failed: ${putResult.status} — ${JSON.stringify(putResult.body)}`);
        steps.push(`Pushed ${filePath}`);

        // Step C: clean old backups (keep last 20)
        steps.push('Cleaning old backups…');
        let cleaned = 0;
        try {
            const listResult = await _ghRequest('GET', `/repos/AHY18099/AdHash_Project_Dashboard/contents/backups`, null, token);
            if (listResult.status === 200 && Array.isArray(listResult.body)) {
                const old = listResult.body
                    .filter(f => f.name.startsWith('data-backup-'))
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .slice(0, -20);
                for (const f of old) {
                    await _ghRequest('DELETE', `/repos/AHY18099/AdHash_Project_Dashboard/contents/${f.path}`,
                        { message: `cleanup: remove old backup ${f.name}`, sha: f.sha }, token);
                    cleaned++;
                }
            }
        } catch (_) {}
        steps.push(`Cleaned ${cleaned} old backup(s)`);

        // Step D: get latest commit info
        const refResult = await _ghRequest('GET', `/repos/AHY18099/AdHash_Project_Dashboard/git/refs/heads/master`, null, token);
        const latestSha = refResult.status === 200 ? (refResult.body.object?.sha || '').slice(0, 7) : '?';
        steps.push('All done!');

        res.json({
            success: true, steps,
            backup: { file: filePath, records: totalRecords, exportedAt: backup.exportedAt },
            github: {
                latestCommit: latestSha,
                pushedAt: new Date().toISOString(),
                url: `https://github.com/AHY18099/AdHash_Project_Dashboard/blob/master/${filePath}`,
            },
        });
    } catch (e) {
        console.error('[commit-and-push]', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/push-specs', (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });

    const token = process.env.GITHUB_TOKEN || process.env.GH_PAT || '';
    if (!token) {
        return res.status(400).json({
            error: 'GITHUB_TOKEN not configured',
            hint: 'Add GITHUB_TOKEN=<your PAT> to your .env file and restart the server.'
        });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    function send(type, msg) {
        res.write(`data: ${JSON.stringify({ type, msg })}\n\n`);
    }

    send('log', '🔄 Regenerating spec files from project-mapping.json…');
    try { regenerateSpecFiles(); } catch (e) {
        send('error', '❌ Spec regeneration failed: ' + e.message);
        res.write('data: {"type":"done","success":false}\n\n');
        return res.end();
    }
    send('log', '✅ Spec files regenerated locally.');
    send('log', '📤 Pushing to GitHub repos…');

    const { spawn } = require('child_process');
    const pushScript = path.join(__dirname, 'scripts', 'push-specs-to-github.mjs');
    const child = spawn(process.execPath, [pushScript], {
        env: { ...process.env, GITHUB_TOKEN: token },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    child.stdout.on('data', d => {
        String(d).split('\n').filter(Boolean).forEach(line => send('log', line));
    });
    child.stderr.on('data', d => {
        String(d).split('\n').filter(Boolean).forEach(line => send('warn', line));
    });
    child.on('error', e => {
        send('error', '❌ Push script error: ' + e.message);
        res.write('data: {"type":"done","success":false}\n\n');
        res.end();
    });
    child.on('close', code => {
        if (code === 0) {
            send('log', '🎉 All repos updated! GitHub Actions will pick up the changes on next run.');
            res.write('data: {"type":"done","success":true}\n\n');
        } else {
            send('warn', `⚠️ Push script exited with code ${code}. Check your GITHUB_TOKEN permissions.`);
            res.write('data: {"type":"done","success":false}\n\n');
        }
        res.end();
    });
});

// Run report availability check
app.get('/api/run-report-status', async (req, res) => {
    // Check disk first (fast), fall back to MongoDB (survives redeploys)
    const candidates = [
        path.join(__dirname, 'email-preview', 'AdHash-Projects-Dashboard.html'),
        path.join(__dirname, 'email-preview', 'index.html')
    ];
    const found = candidates.find(f => fs.existsSync(f));
    if (found) {
        try {
            const stat = fs.statSync(found);
            const state = readDashboardState();
            return res.json({
                available: true,
                generatedAt: (state && state.generatedAt) || stat.mtime.toISOString(),
                source: 'disk'
            });
        } catch (e) { /* fall through */ }
    }
    // Not on disk — check MongoDB
    try {
        const { getDB } = require('./src/db');
        const db = getDB();
        if (db) {
            const doc = await db.collection('run_reports').findOne({ key: 'latest' }, { projection: { html: 0 } });
            if (doc) {
                return res.json({ available: true, generatedAt: doc.generatedAt, source: 'mongodb' });
            }
        }
    } catch (_) {}
    return res.json({ available: false });
});

// Serve latest run report HTML — from disk or MongoDB
// Inject iframe-safe CSS into the email HTML so it renders correctly when embedded
function _patchReportHtmlForIframe(html) {
    // Strategy: rather than fighting the UA stylesheet with attribute selectors,
    // we inject the colors directly as a data-uri stylesheet that has highest specificity.
    // We also do a string-replace approach: inject a <style> that targets every
    // color used in the template by its exact hex value, using both color and
    // -webkit-text-fill-color (which overrides color in WebKit/Blink iframes).
    const patch = `<style>
        /* Reset — no margin, black background, white text base */
        html { overflow-x: hidden; }
        html, body {
            background-color: #000000 !important;
            color: #ffffff !important;
            -webkit-text-fill-color: #ffffff !important;
            margin: 0; padding: 0;
        }
        /* Prevent horizontal scroll — the outer table must never exceed viewport */
        body > table { width: 100% !important; min-width: 0 !important; }
        table { max-width: 100%; word-break: break-word; }
        /* The inner 960px container must scale to fit */
        table[style*="max-width:960px"],
        table[style*="max-width: 960px"] {
            width: 100% !important;
            max-width: 100% !important;
        }
        /* All td cells default to white text so nothing is invisible */
        td, th { color: #ffffff !important; -webkit-text-fill-color: #ffffff !important; }
        /* All div/span/p inherit unless overridden by inline color below */
        div, span, p {
            color: inherit;
            -webkit-text-fill-color: inherit;
        }
        /* Force every exact inline color used in the template.
           Use both color and -webkit-text-fill-color to cover all browsers. */
        [style*="color:#ffffff"]  { color: #ffffff  !important; -webkit-text-fill-color: #ffffff  !important; }
        [style*="color:#cbd5e1"]  { color: #cbd5e1  !important; -webkit-text-fill-color: #cbd5e1  !important; }
        [style*="color:#9ca3af"]  { color: #9ca3af  !important; -webkit-text-fill-color: #9ca3af  !important; }
        [style*="color:#94a3b8"]  { color: #94a3b8  !important; -webkit-text-fill-color: #94a3b8  !important; }
        [style*="color:#10b981"]  { color: #10b981  !important; -webkit-text-fill-color: #10b981  !important; }
        [style*="color:#ef4444"]  { color: #ef4444  !important; -webkit-text-fill-color: #ef4444  !important; }
        [style*="color:#f59e0b"]  { color: #f59e0b  !important; -webkit-text-fill-color: #f59e0b  !important; }
        [style*="color:#3b82f6"]  { color: #3b82f6  !important; -webkit-text-fill-color: #3b82f6  !important; }
        [style*="color:#2563eb"]  { color: #2563eb  !important; -webkit-text-fill-color: #2563eb  !important; }
        [style*="color:#6366f1"]  { color: #6366f1  !important; -webkit-text-fill-color: #6366f1  !important; }
        [style*="color:#22c55e"]  { color: #22c55e  !important; -webkit-text-fill-color: #22c55e  !important; }
        [style*="color:#ff4d4f"]  { color: #ff4d4f  !important; -webkit-text-fill-color: #ff4d4f  !important; }
        [style*="color:#ffb020"]  { color: #ffb020  !important; -webkit-text-fill-color: #ffb020  !important; }
        [style*="color:#06b6d4"]  { color: #06b6d4  !important; -webkit-text-fill-color: #06b6d4  !important; }
        [style*="color:#8b5cf6"]  { color: #8b5cf6  !important; -webkit-text-fill-color: #8b5cf6  !important; }
        /* Additional colors from the project cards */
        [style*="color:#ff6b6b"]  { color: #ff6b6b  !important; -webkit-text-fill-color: #ff6b6b  !important; }
        [style*="color:#64748b"]  { color: #64748b  !important; -webkit-text-fill-color: #64748b  !important; }
        [style*="color:#e2e8f0"]  { color: #e2e8f0  !important; -webkit-text-fill-color: #e2e8f0  !important; }
        [style*="color:#f1f5f9"]  { color: #f1f5f9  !important; -webkit-text-fill-color: #f1f5f9  !important; }
        [style*="color:#1e293b"]  { color: #1e293b  !important; -webkit-text-fill-color: #1e293b  !important; }
        /* Summary cards: stay 2-col on desktop, stack on mobile */
        @media screen and (max-width: 600px) {
            td[width="50%"],
            td[style*="width:50%"] {
                display: block !important;
                width: 100% !important;
                box-sizing: border-box !important;
            }
        }
    </style>`;
    return html.includes('</head>')
        ? html.replace('</head>', patch + '</head>')
        : patch + html;
}

app.get('/api/latest-run-report', async (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).send('Unauthorized');
    res.set('Cache-Control', 'no-store');
    // Try disk first
    const candidates = [
        path.join(__dirname, 'email-preview', 'AdHash-Projects-Dashboard.html'),
        path.join(__dirname, 'email-preview', 'index.html')
    ];
    const found = candidates.find(f => fs.existsSync(f));
    if (found) {
        try {
            const html = fs.readFileSync(found, 'utf8');
            return res.set('Content-Type', 'text/html').send(_patchReportHtmlForIframe(html));
        } catch (_) { /* fall through to MongoDB */ }
    }
    // Fall back to MongoDB
    try {
        const { getDB } = require('./src/db');
        const db = getDB();
        if (db) {
            const doc = await db.collection('run_reports').findOne({ key: 'latest' });
            if (doc && doc.html) {
                return res.set('Content-Type', 'text/html').send(_patchReportHtmlForIframe(doc.html));
            }
        }
    } catch (e) { console.error('[latest-run-report]', e.message); }
    return res.status(404).send('No report available');
});

// Legacy dashboard route
app.get('/dashboard.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Data restore tool — no auth required (needs localStorage access before login)
app.get('/restore-tool', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'restore-tool.html'));
});
app.get('/restore-tool.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'restore-tool.html'));
});

app.get('/favicon.ico', (req, res) => {
    res.status(204).end();
});

// ── QA Dashboard API Proxy (bypasses browser CORS restrictions) ──
app.post('/api/qa-proxy', async (req, res) => {
    const { url, method, headers, body } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url is required' });

    const t0 = Date.now();
    try {
        const fetchOpts = {
            method: (method || 'GET').toUpperCase(),
            headers: headers || {}
        };
        const hasBody = fetchOpts.method !== 'GET' && fetchOpts.method !== 'HEAD' && body;
        if (hasBody) {
            fetchOpts.body = typeof body === 'string' ? body : JSON.stringify(body);
            if (!fetchOpts.headers['Content-Type'] && !fetchOpts.headers['content-type']) {
                fetchOpts.headers['Content-Type'] = 'application/json';
            }
        }

        // Use Node.js built-in fetch (Node 18+) or fallback to https module
        let statusCode, responseBody, responseHeaders = {};
        if (typeof fetch !== 'undefined') {
            const resp = await fetch(url, fetchOpts);
            statusCode = resp.status;
            resp.headers.forEach((v, k) => { responseHeaders[k] = v; });
            responseBody = await resp.text();
        } else {
            // Fallback: use https/http module
            const { request: nodeRequest } = require(url.startsWith('https') ? 'https' : 'http');
            const parsed = new URL(url);
            await new Promise((resolve, reject) => {
                const opts = {
                    hostname: parsed.hostname,
                    port: parsed.port || (url.startsWith('https') ? 443 : 80),
                    path: parsed.pathname + parsed.search,
                    method: fetchOpts.method,
                    headers: fetchOpts.headers,
                    timeout: 15000
                };
                const req2 = nodeRequest(opts, (r) => {
                    statusCode = r.statusCode;
                    r.headers && Object.assign(responseHeaders, r.headers);
                    const chunks = [];
                    r.on('data', d => chunks.push(d));
                    r.on('end', () => { responseBody = Buffer.concat(chunks).toString('utf8'); resolve(); });
                });
                req2.on('error', reject);
                req2.on('timeout', () => { req2.destroy(); reject(new Error('Request timed out')); });
                if (hasBody) req2.write(fetchOpts.body);
                req2.end();
            });
        }

        const elapsed = Date.now() - t0;
        // Try to pretty-print JSON response
        let prettyBody = responseBody;
        const ct = (responseHeaders['content-type'] || '');
        if (ct.includes('json')) {
            try { prettyBody = JSON.stringify(JSON.parse(responseBody), null, 2); } catch (_) {}
        }

        res.json({ statusCode, body: prettyBody, elapsed, headers: responseHeaders });
    } catch (err) {
        res.json({ statusCode: null, body: `Error: ${err.message}`, elapsed: Date.now() - t0, error: true });
    }
});

// Block direct access to sensitive files and directories
app.use((req, res, next) => {
    const blocked = [
        /^\/(\.env|server\.js|package\.json|package-lock\.json)/i,
        /^\/(data|config|utils|test-results|suite-reports|godaddy)\//i,
        /^\/data\//i,
    ];
    if (blocked.some(r => r.test(req.path))) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    next();
});

// Serve only the public/ directory as static (login page assets, etc.)
app.use(express.static(path.join(__dirname, 'public'), {
    index: false, // don't auto-serve index.html — routes above handle auth
    setHeaders: (res) => {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
    }
}));

// API proxy endpoint — forwards request to any URL and returns full response (follows redirects)
app.post('/api/proxy', async (req, res) => {
    const { url, method } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url is required' });
    const m = (method || 'GET').toUpperCase();
    const allowedMethods = ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'];
    if (!allowedMethods.includes(m)) return res.status(400).json({ error: 'Invalid method' });

    const https = require('https');
    const http  = require('http');
    const { URL } = require('url');
    const startTs = Date.now();

    function doRequest(targetUrl, redirectsLeft, callback) {
        let parsed;
        try { parsed = new URL(targetUrl); } catch(e) { return callback({ status: 0, statusText: 'Invalid URL', headers: {}, body: '', timing: Date.now() - startTs, error: e.message }); }
        const isHttps = parsed.protocol === 'https:';
        const mod = isHttps ? https : http;
        const options = {
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: (parsed.pathname || '/') + (parsed.search || ''),
            method: m,
            headers: { 'User-Agent': 'AdHash-Dashboard/1.0' },
            rejectUnauthorized: false,
            timeout: 10000
        };
        const proxyReq = mod.request(options, (proxyRes) => {
            const sc = proxyRes.statusCode;
            // Follow redirects (301, 302, 303, 307, 308) for GET/HEAD only, up to 5 hops
            if ([301,302,303,307,308].includes(sc) && redirectsLeft > 0 && (m === 'GET' || m === 'HEAD')) {
                const location = proxyRes.headers['location'];
                proxyRes.resume(); // drain
                if (location) {
                    const next = location.startsWith('http') ? location : new URL(location, targetUrl).href;
                    return doRequest(next, redirectsLeft - 1, callback);
                }
            }
            let body = '';
            proxyRes.setEncoding('utf8');
            proxyRes.on('data', chunk => { if (body.length < 50000) body += chunk; });
            proxyRes.on('end', () => callback({ status: sc, statusText: proxyRes.statusMessage || '', headers: proxyRes.headers, body, timing: Date.now() - startTs }));
        });
        proxyReq.on('timeout', () => { proxyReq.destroy(); callback({ status: 0, statusText: 'Timeout', headers: {}, body: '', timing: Date.now() - startTs, error: 'Request timed out' }); });
        proxyReq.on('error', (err) => callback({ status: 0, statusText: 'Error', headers: {}, body: '', timing: Date.now() - startTs, error: err.message }));
        proxyReq.end();
    }

    try {
        doRequest(url, 5, (result) => res.json(result));
    } catch (err) {
        res.json({ status: 0, statusText: 'Error', headers: {}, body: '', timing: Date.now() - startTs, error: err.message });
    }
});

// ── WORKFLOW DOCS FILE STORAGE — GitHub Releases backend ──
// Files are stored as GitHub Release assets (up to 2GB each, permanent, survives any redeploy).
// Railway disk is used only as a local cache; GitHub Release is the source of truth.

const WF_DOCS_DIR = path.join(__dirname, 'data', 'wfdocs');
fs.mkdirSync(WF_DOCS_DIR, { recursive: true });
const GH_WFDOC_RELEASE_TAG = 'wfdoc-storage';

// Ensure the wfdoc storage release exists, return its id
async function _ghEnsureWfDocRelease() {
    const token = process.env.GITHUB_TOKEN || process.env.GH_PAT || '';
    if (!token) return null;
    try {
        // Try to get existing release
        const get = await _ghRequest('GET', `/repos/${GH_API_REPO}/releases/tags/${GH_WFDOC_RELEASE_TAG}`, null, token);
        if (get.status === 200) return get.body.id;
        // Create it
        const create = await _ghRequest('POST', `/repos/${GH_API_REPO}/releases`, {
            tag_name: GH_WFDOC_RELEASE_TAG, name: 'Workflow Document Storage',
            body: 'Internal storage for workflow documents. Do not delete.',
            draft: false, prerelease: false
        }, token);
        if (create.status === 201) { console.log('[wfdoc] Created GitHub Release for storage, id:', create.body.id); return create.body.id; }
        console.error('[wfdoc] Could not create release:', create.status, create.body && create.body.message);
        return null;
    } catch (e) { console.error('[wfdoc] _ghEnsureWfDocRelease error:', e.message); return null; }
}

// Upload buffer to GitHub Release as an asset, return asset download_url
async function _ghUploadWfDocAsset(releaseId, assetName, buffer, mimeType) {
    const token = process.env.GITHUB_TOKEN || process.env.GH_PAT || '';
    if (!token) return null;
    return new Promise((resolve, reject) => {
        const https = require('https');
        const options = {
            hostname: 'uploads.github.com',
            path: `/repos/${GH_API_REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(assetName)}`,
            method: 'POST',
            headers: {
                'Authorization': `token ${token}`, 'User-Agent': 'AdHash-Dashboard',
                'Content-Type': mimeType || 'application/octet-stream',
                'Content-Length': buffer.length
            }
        };
        const req = https.request(options, res => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                try {
                    const r = JSON.parse(data);
                    if (res.statusCode === 201) resolve(r.browser_download_url || r.url);
                    else { console.error('[wfdoc] upload asset failed:', res.statusCode, r.message); resolve(null); }
                } catch (e) { resolve(null); }
            });
        });
        req.on('error', reject);
        req.setTimeout(120000, () => { req.destroy(); reject(new Error('upload timeout')); });
        req.write(buffer);
        req.end();
    });
}

// Delete a GitHub Release asset by asset id
async function _ghDeleteWfDocAsset(assetId) {
    const token = process.env.GITHUB_TOKEN || process.env.GH_PAT || '';
    if (!token) return;
    try {
        await _ghRequest('DELETE', `/repos/${GH_API_REPO}/releases/assets/${assetId}`, null, token);
    } catch (e) { console.error('[wfdoc] delete asset error:', e.message); }
}

// Persist wfdoc metadata into qa-shared.json (survives redeploy)
function _persistWfDocMeta(projectId, wfdocList) {
    try {
        const shared = readQaData();
        const projKey = 'qa3_' + projectId;
        if (!shared[projKey]) shared[projKey] = {};
        shared[projKey].wfdocs = wfdocList;
        writeQaData(shared);
    } catch (e) { console.error('_persistWfDocMeta error:', e.message); }
}

// POST /api/wfdocs/:projectId — upload a file, store in GitHub Release
app.post('/api/wfdocs/:projectId', async (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
    const { name, data: b64data, size } = req.body || {};
    if (!name || !b64data) return res.status(400).json({ error: 'Missing name or data' });

    // Dedup check: same filename AND same size = duplicate — reject before doing any work
    const _existingWfd = ((_qaCache['qa3_' + req.params.projectId] || {}).wfdocs || []);
    const _incomingSize = size || 0;
    const _isDuplicate = _existingWfd.some(f => f.name === name && (f.size || 0) === _incomingSize);
    if (_isDuplicate) {
        return res.status(409).json({ error: `"${name}" already exists in this project's workflow docs.` });
    }

    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const uploadedAt = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const mimeType = b64data.split(';')[0].replace('data:', '') || 'application/octet-stream';
    const base64 = b64data.replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');
    const fileId = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const assetName = fileId + '_' + name.replace(/[^a-zA-Z0-9._-]/g, '_');

    try {
        // Try GitHub Release upload first
        const token = process.env.GITHUB_TOKEN || process.env.GH_PAT || '';
        let ghAssetId = null;
        let ghUrl = null;
        if (token) {
            const releaseId = await _ghEnsureWfDocRelease();
            if (releaseId) {
                ghUrl = await _ghUploadWfDocAsset(releaseId, assetName, buffer, mimeType);
                // Get asset id for future deletion
                if (ghUrl) {
                    const rel = await _ghRequest('GET', `/repos/${GH_API_REPO}/releases/tags/${GH_WFDOC_RELEASE_TAG}`, null, token);
                    if (rel.status === 200) {
                        const asset = (rel.body.assets || []).find(a => a.name === assetName);
                        if (asset) ghAssetId = asset.id;
                    }
                }
            }
        }

        // Also write to local disk as cache
        const projectDir = path.join(WF_DOCS_DIR, req.params.projectId);
        fs.mkdirSync(projectDir, { recursive: true });
        fs.writeFileSync(path.join(projectDir, fileId + '.bin'), buffer);
        const meta = { name, size: size || buffer.length, fileId, uploadedAt, mimeType, ghAssetId, ghUrl, assetName };
        fs.writeFileSync(path.join(projectDir, fileId + '.meta.json'), JSON.stringify(meta));

        // Read current wfdocs list from qa-shared.json and append (dedup by serverId)
        const shared = readQaData();
        const projKey = 'qa3_' + req.params.projectId;
        const current = ((shared[projKey] && shared[projKey].wfdocs) || []).filter(f => f.serverId !== fileId);
        const newEntry = { name, size: size || buffer.length, uploadedAt, serverId: fileId, ghAssetId, ghUrl, assetName };
        _persistWfDocMeta(req.params.projectId, [...current, newEntry]);

        if (ghUrl) console.log(`[wfdoc] Uploaded "${name}" to GitHub Release: ${ghUrl}`);
        else console.log(`[wfdoc] Uploaded "${name}" to local disk only (no GitHub token or upload failed)`);

        res.json({ success: true, fileId });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/wfdocs/:projectId — list files
app.get('/api/wfdocs/:projectId', (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
    const shared = readQaData();
    const projKey = 'qa3_' + req.params.projectId;
    let wfdocs = (shared[projKey] && shared[projKey].wfdocs) || [];
    // Defensive dedup by name (keep entry with serverId/ghUrl preferred)
    const seenNames = new Map();
    for (const f of wfdocs) {
        const key = f.name;
        if (!seenNames.has(key)) { seenNames.set(key, f); }
        else {
            const ex = seenNames.get(key);
            if (!ex.serverId && f.serverId) seenNames.set(key, f);
            else if (ex.serverId && !ex.ghUrl && f.ghUrl) seenNames.set(key, f);
        }
    }
    wfdocs = Array.from(seenNames.values());
    // If we deduped in-memory, persist the fix so it doesn't accumulate again
    const storedCount = (shared[projKey] && shared[projKey].wfdocs) ? shared[projKey].wfdocs.length : 0;
    if (storedCount !== wfdocs.length) {
        console.log(`[wfdoc-dedup] ${req.params.projectId}: ${storedCount} → ${wfdocs.length} (fixed in GET)`);
        _persistWfDocMeta(req.params.projectId, wfdocs);
    }
    // Mark each file as available (disk or ghUrl) or unavailable
    const projectDir = path.join(WF_DOCS_DIR, req.params.projectId);
    const result = wfdocs.map(f => {
        const onDisk = fs.existsSync(path.join(projectDir, (f.serverId || '') + '.bin'));
        return { ...f, fileId: f.serverId, available: onDisk || !!f.ghUrl };
    });
    res.json(result);
});

// GET /api/wfdocs/:projectId/:fileId — download a file
app.get('/api/wfdocs/:projectId/:fileId', async (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
    const { projectId, fileId } = req.params;
    const projectDir = path.join(WF_DOCS_DIR, projectId);
    const diskPath = path.join(projectDir, fileId + '.bin');
    const metaPath = path.join(projectDir, fileId + '.meta.json');

    // Try disk first (fast)
    if (fs.existsSync(diskPath) && fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        res.setHeader('Content-Type', meta.mimeType || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(meta.name)}"`);
        return res.send(fs.readFileSync(diskPath));
    }

    // Disk miss — check qa-shared.json for GitHub URL
    const shared = readQaData();
    const projKey = 'qa3_' + projectId;
    const wfdocs = (shared[projKey] && shared[projKey].wfdocs) || [];
    const entry = wfdocs.find(f => f.serverId === fileId);

    if (entry && entry.ghUrl) {
        // Stream from GitHub Release
        try {
            const token = process.env.GITHUB_TOKEN || process.env.GH_PAT || '';
            const https = require('https');
            // GitHub release asset download requires auth redirect handling
            const dlUrl = new URL(entry.ghUrl);
            const options = {
                hostname: dlUrl.hostname, path: dlUrl.pathname + dlUrl.search,
                headers: { 'Authorization': `token ${token}`, 'User-Agent': 'AdHash-Dashboard', 'Accept': 'application/octet-stream' }
            };
            const ghReq = https.get(options, ghRes => {
                if (ghRes.statusCode === 302 || ghRes.statusCode === 301) {
                    // Follow redirect
                    https.get(ghRes.headers.location, ghRes2 => {
                        res.setHeader('Content-Type', entry.mimeType || 'application/octet-stream');
                        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(entry.name)}"`);
                        ghRes2.pipe(res);
                        // Cache to disk for next time
                        const chunks = [];
                        ghRes2.on('data', c => chunks.push(c));
                        ghRes2.on('end', () => {
                            try {
                                fs.mkdirSync(projectDir, { recursive: true });
                                fs.writeFileSync(diskPath, Buffer.concat(chunks));
                            } catch (_) {}
                        });
                    }).on('error', () => res.status(502).json({ error: 'Failed to fetch from GitHub' }));
                    return;
                }
                res.setHeader('Content-Type', entry.mimeType || 'application/octet-stream');
                res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(entry.name)}"`);
                ghRes.pipe(res);
            });
            ghReq.on('error', () => res.status(502).json({ error: 'Failed to fetch from GitHub' }));
        } catch (e) { res.status(500).json({ error: e.message }); }
    } else {
        res.status(404).json({ error: 'File not found. Please re-upload.' });
    }
});

// DELETE /api/wfdocs/:projectId/:fileId — delete a file from disk + GitHub Release
app.delete('/api/wfdocs/:projectId/:fileId', async (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
    const { projectId, fileId } = req.params;
    const projectDir = path.join(WF_DOCS_DIR, projectId);
    try {
        const diskPath = path.join(projectDir, fileId + '.bin');
        const metaPath = path.join(projectDir, fileId + '.meta.json');
        if (fs.existsSync(diskPath)) fs.unlinkSync(diskPath);
        if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);

        // Remove from qa-shared.json and delete GitHub asset
        const shared = readQaData();
        const projKey = 'qa3_' + projectId;
        const before = (shared[projKey] && shared[projKey].wfdocs) || [];
        const entry = before.find(f => f.serverId === fileId);
        const after = before.filter(f => f.serverId !== fileId);
        _persistWfDocMeta(projectId, after);

        // Delete from GitHub Release if we have the asset id
        if (entry && entry.ghAssetId) await _ghDeleteWfDocAsset(entry.ghAssetId);

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── SHARED DATA API endpoints ──

// GET /api/qa-data — return all shared keys (deduped before sending)
// _DEPLOY_VERSION is checked by client to detect stale deploys
const _DEPLOY_VERSION = 'v20260529-dedup-final';
app.get('/api/qa-data', (req, res) => {
    const raw = readQaData();
    // Apply dedup to all per-project objects before sending to client
    const out = { _deployVersion: _DEPLOY_VERSION };
    for (const [k, v] of Object.entries(raw)) {
        if (k.startsWith('qa3_') && v && typeof v === 'object' && !Array.isArray(v)) {
            out[k] = deduplicateProjectData(v);
        } else {
            out[k] = v;
        }
    }
    res.json(out);
});

// GET /api/db-diag — public diagnostic: shows MONGODB_URI prefix and connection state
app.get('/api/db-diag', (req, res) => {
    const uri = process.env.MONGODB_URI || '';
    const { getDB } = require('./src/db');
    let dbOk = false;
    try { getDB(); dbOk = true; } catch (_) {}
    res.json({
        uriSet: !!uri,
        uriProtocol: uri.split('://')[0] || '(empty)',
        uriStart: uri.substring(0, 40).replace(/:[^@]+@/, ':***@'),
        cacheKeys: Object.keys(_qaCache).length,
        dbConnected: dbOk,
        uptime: Math.floor(process.uptime())
    });
});

// GET /api/health — public status check; pings MongoDB and reports full system state
app.get('/api/health', async (req, res) => {
    try {
        const { getDB } = require('./src/db');
        const pingStart = Date.now();
        await pingDB();
        const pingMs = Date.now() - pingStart;
        const db = getDB();
        const keys = Object.keys(_qaCache);
        const projectCount = keys.filter(k => k.startsWith('qa3_') &&
            !['qa3_daily_tasks','qa3_team_tasks','qa3_releases'].includes(k) &&
            !k.includes('test') && !k.includes('heartbeat')).length;
        let storage = { usedPct: '?', status: 'unknown' };
        try { const { getStorageStats } = require('./src/gitBackup'); storage = await getStorageStats(); } catch (_) {}
        // Error count in last hour — non-fatal if error_logs collection doesn't exist yet
        let errorsLastHour = 0;
        try {
            const oneHourAgo = new Date(Date.now() - 3600000);
            errorsLastHour = await db.collection('error_logs').countDocuments({ timestamp: { $gte: oneHourAgo } });
        } catch (_) {}
        res.json({
            status:         'ok',
            database:       'connected',
            pingMs,
            dataLoaded:     keys.length > 0,
            projectCount,
            totalKeys:      keys.length,
            activeUsers:    _sseClients.size,
            deployVersion:  _DEPLOY_VERSION,
            uptime:         Math.floor(process.uptime()),
            errors:         { lastHour: errorsLastHour, status: errorsLastHour > 10 ? 'warning' : 'ok' },
            storage,
        });
    } catch (e) {
        // Return 200 so Railway health checks don't kill the container — database is just disconnected
        const uri = process.env.MONGODB_URI || '';
        res.json({
            status:      'degraded',
            database:    'disconnected',
            error:       e.message,
            uptime:      Math.floor(process.uptime()),
            uriSet:      !!uri,
            uriProtocol: uri.split('://')[0] || '(not set)',
            uriStart:    uri ? uri.substring(0, 40).replace(/:[^:@]+@/, ':***@') : '(none)',
            cacheKeys:   Object.keys(_qaCache).length
        });
    }
});

// POST /api/admin/backup — trigger full backup to GitHub now (admin only)
app.post('/api/admin/backup', async (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const { forceFullBackup } = require('./src/gitBackup');
        const filename = await forceFullBackup();
        res.json({ success: true, file: filename });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/storage — MongoDB usage stats (admin only)
app.get('/api/admin/storage', async (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const { getStorageStats } = require('./src/gitBackup');
        res.json(await getStorageStats());
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/audit-logs — last 500 audit entries (admin only)
app.get('/api/admin/audit-logs', requireAdmin, async (req, res) => {
    try {
        const { getDB } = require('./src/db');
        const db = getDB();
        const limit  = Math.min(parseInt(req.query.limit  || '500', 10), 1000);
        const action = req.query.action || null;
        const filter = action ? { action } : {};
        const logs   = await db.collection('audit_logs').find(filter).sort({ timestamp: -1 }).limit(limit).toArray();
        res.json(logs);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/error-logs — last 200 server errors (admin only)
app.get('/api/admin/error-logs', requireAdmin, async (req, res) => {
    try {
        const { getDB } = require('./src/db');
        const db   = getDB();
        const limit = Math.min(parseInt(req.query.limit || '200', 10), 500);
        const logs  = await db.collection('error_logs').find({}).sort({ timestamp: -1 }).limit(limit).toArray();
        res.json(logs);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/delete-past-releases — wipe all releases classified as 'past' from MongoDB
app.post('/api/admin/delete-past-releases', requireAdmin, async (req, res) => {
    try {
        const { getDB } = require('./src/db');
        const db = getDB();
        const all = await db.collection('releases').find({}).toArray();
        const todayStr = new Date().toISOString().slice(0, 10);
        const pastIds = all
            .filter(r => r.testingStatus === 'Ready for Client' || (r.releaseDate && r.releaseDate.slice(0, 10) < todayStr))
            .map(r => r._id);
        if (!pastIds.length) return res.json({ deleted: 0 });
        await db.collection('releases').deleteMany({ _id: { $in: pastIds } });
        // Rebuild cache
        const { readAllData } = require('./src/db');
        _qaCache = await readAllData();
        broadcastSseEvent('qa-data-update', { key: 'qa3_releases', value: _qaCache['qa3_releases'] || [] });
        res.json({ deleted: pastIds.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/fix-zaptrade — remove duplicate ZapTrade project and set defaultAssignee=Deepa
app.post('/api/admin/fix-zaptrade', requireAdmin, async (req, res) => {
    try {
        const { getDB } = require('./src/db');
        const db = getDB();
        const keepId = 'zaptrade_mpv6v89b';
        const removeId = 'zaptrade_mpvcoq7f';
        // Delete all data for the duplicate project
        const { SECTION_MAP, readAllData: _readAll } = require('./src/db');
        for (const col of Object.values(SECTION_MAP)) {
            await db.collection(col).deleteMany({ projectId: removeId });
        }
        await db.collection('env_details').deleteMany({ projectId: removeId });
        await db.collection('daily_tasks').deleteMany({ projectId: removeId });
        await db.collection('team_tasks').deleteMany({ projectId: removeId });
        await db.collection('projects').deleteOne({ id: removeId });
        // Set defaultAssignee on the kept project
        await db.collection('projects').updateOne(
            { id: keepId },
            { $set: { defaultAssignee: 'Deepa', updatedAt: new Date() } }
        );
        // Rebuild cache
        _qaCache = await _readAll();
        broadcastSseEvent('qa-data-update', { key: 'qa3_projects', value: _qaCache['qa3_projects'] || [] });
        res.json({ ok: true, removed: removeId, kept: keepId, defaultAssignee: 'Deepa' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/sync-default-projects — upsert DEFAULT_PROJ metadata (name/color/defaultAssignee/website)
// into MongoDB projects collection so all fields survive redeploys without depending on client hardcodes.
app.post('/api/admin/sync-default-projects', requireAdmin, async (req, res) => {
    try {
        const { getDB, readAllData } = require('./src/db');
        const db = getDB();
        const defaults = req.body.projects;
        if (!Array.isArray(defaults) || !defaults.length) return res.status(400).json({ error: 'projects array required' });
        let synced = 0;
        for (const p of defaults) {
            if (!p || !p.id) continue;
            const now = new Date();
            await db.collection('projects').updateOne(
                { id: p.id },
                {
                    $set: { name: p.name, color: p.color, defaultAssignee: p.defaultAssignee || '', website: p.website || '', dashboard: p.dashboard || '', releaseDate: p.releaseDate || '', updatedAt: now },
                    $setOnInsert: { createdAt: now }
                },
                { upsert: true }
            );
            synced++;
        }
        _qaCache = await readAllData();
        broadcastSseEvent('qa-data-update', { key: 'qa3_projects', value: _qaCache['qa3_projects'] || [] });
        res.json({ ok: true, synced });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/clear-default-smoke-prod — forcibly clear smoke/prod for projects that
// should not have the Humee default test cases. Clears both MongoDB and in-memory cache.
// Safe to call multiple times — only wipes if count matches default (29 smoke / 34 prod).
app.post('/api/admin/clear-default-smoke-prod', requireAdmin, async (req, res) => {
    try {
        const { getDB } = require('./src/db');
        const db = getDB();
        // Projects that must NOT have pre-filled smoke/prod (not in dedicated suite list)
        const targets = req.body.projectIds || ['adhash','sparkme','zapai','zapcrm','zaptrade_mpv6v89b','algomax','autochecker','metcalf','smc','synctrade'];
        const results = {};
        for (const pid of targets) {
            const key = 'qa3_' + pid;
            const proj = (_qaCache[key] && typeof _qaCache[key] === 'object') ? _qaCache[key] : {};
            const smokeCount = Array.isArray(proj.smoke) ? proj.smoke.length : 0;
            const prodCount  = Array.isArray(proj.prod)  ? proj.prod.length  : 0;
            if (smokeCount === 0 && prodCount === 0) { results[pid] = 'already_empty'; continue; }
            // Clear in cache
            if (!_qaCache[key]) _qaCache[key] = {};
            _qaCache[key].smoke = [];
            _qaCache[key].prod  = [];
            // Persist to MongoDB via writeKey (replaces arrays)
            const { writeKey } = require('./src/db');
            await writeKey(key, _qaCache[key]);
            // Broadcast so all connected clients clear their STORE immediately
            broadcastSseEvent('qa-data-update', { key, value: _qaCache[key] });
            results[pid] = `cleared (was smoke:${smokeCount} prod:${prodCount})`;
        }
        res.json({ ok: true, results });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── App Config API — stores shared keys/settings in MongoDB ──────────────────
// Keys are AES-256 encrypted at rest using the JWT_SECRET so raw values never
// sit in MongoDB in plaintext.
const _crypto = require('crypto');
function _encryptVal(val) {
    const key = Buffer.from(JWT_SECRET.padEnd(32, '0').slice(0, 32));
    const iv  = _crypto.randomBytes(16);
    const cipher = _crypto.createCipheriv('aes-256-cbc', key, iv);
    const enc = Buffer.concat([cipher.update(val, 'utf8'), cipher.final()]);
    return iv.toString('hex') + ':' + enc.toString('hex');
}
function _decryptVal(enc) {
    try {
        const [ivHex, dataHex] = enc.split(':');
        const key = Buffer.from(JWT_SECRET.padEnd(32, '0').slice(0, 32));
        const decipher = _crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
        return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
    } catch { return ''; }
}

// GET /api/app-config/:namespace — load config keys (authenticated)
app.get('/api/app-config/:namespace', async (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const { getDB } = require('./src/db');
        const db  = getDB();
        const doc = await db.collection('app_config').findOne({ namespace: req.params.namespace });
        if (!doc) return res.json({});
        // Decrypt all values before sending to client
        const out = {};
        for (const [k, v] of Object.entries(doc.data || {})) {
            out[k] = v ? _decryptVal(v) : '';
        }
        res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/app-config/:namespace — save config keys (admin only)
app.post('/api/app-config/:namespace', requireAdmin, async (req, res) => {
    try {
        const { getDB } = require('./src/db');
        const db   = getDB();
        const data = {};
        // Encrypt every value before storing
        for (const [k, v] of Object.entries(req.body || {})) {
            data[k] = v ? _encryptVal(String(v)) : '';
        }
        await db.collection('app_config').updateOne(
            { namespace: req.params.namespace },
            { $set: { namespace: req.params.namespace, data, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
            { upsert: true }
        );
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AutoChecker GitHub Actions API ───────────────────────────────────────────
const AC_REPO = 'AHY18099/autochecker-daily-task';
const AC_WORKFLOW_ID = '223108562'; // AdHash AutoChecker Production Tests

// POST /api/autochecker/run — trigger workflow_dispatch on the autochecker repo
app.post('/api/autochecker/run', requireAdmin, async (req, res) => {
    try {
        const token = process.env.GITHUB_TOKEN || '';
        if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN not set' });
        const r = await _ghRequest('POST', `/repos/${AC_REPO}/actions/workflows/${AC_WORKFLOW_ID}/dispatches`, { ref: 'master' }, token);
        if (r.status === 204) res.json({ ok: true, message: 'Workflow triggered successfully' });
        else res.status(r.status).json({ error: `GitHub returned ${r.status}`, body: r.body });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/autochecker/status — get latest workflow run status + steps
app.get('/api/autochecker/status', async (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const token = process.env.GITHUB_TOKEN || '';
        const runs = await _ghRequest('GET', `/repos/${AC_REPO}/actions/runs?per_page=1&workflow_id=${AC_WORKFLOW_ID}`, null, token);
        if (runs.status !== 200 || !runs.body.workflow_runs?.length) return res.json({ run: null });
        const run = runs.body.workflow_runs[0];
        // Get job steps for the run
        const jobs = await _ghRequest('GET', `/repos/${AC_REPO}/actions/runs/${run.id}/jobs`, null, token);
        const job = jobs.body?.jobs?.[0] || null;
        res.json({
            run: {
                id: run.id, status: run.status, conclusion: run.conclusion,
                created_at: run.created_at, updated_at: run.updated_at,
                html_url: run.html_url, run_number: run.run_number,
                duration_s: job ? Math.round((new Date(job.completed_at || run.updated_at) - new Date(job.started_at || run.created_at)) / 1000) : null,
            },
            steps: job ? job.steps.map(s => ({ name: s.name, status: s.status, conclusion: s.conclusion, number: s.number })) : [],
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/autochecker/report — download artifact zip, extract HTML, parse and return structured data
app.get('/api/autochecker/report', async (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
    // Never cache — always fetch latest run from GitHub
    res.set('Cache-Control', 'no-store');
    try {
        const token = process.env.GITHUB_TOKEN || '';
        const https = require('https');
        const zlib  = require('zlib');

        // Get latest completed run
        const runs = await _ghRequest('GET', `/repos/${AC_REPO}/actions/runs?per_page=5&status=completed&workflow_id=${AC_WORKFLOW_ID}`, null, token);
        const run  = runs.body?.workflow_runs?.find(r => r.conclusion === 'success') || runs.body?.workflow_runs?.[0];
        if (!run) return res.json({ data: null, runId: null });

        const arts     = await _ghRequest('GET', `/repos/${AC_REPO}/actions/runs/${run.id}/artifacts`, null, token);
        const htmlArt  = arts.body?.artifacts?.find(a => a.name === 'autochecker-html-report' && !a.expired);
        if (!htmlArt) return res.json({ data: null, runId: run.id, message: 'No HTML report artifact' });

        // Download zip — GitHub redirects to S3, so follow the redirect
        const zipUrl = await new Promise((resolve, reject) => {
            const req2 = https.request({
                hostname: 'api.github.com',
                path: `/repos/${AC_REPO}/actions/artifacts/${htmlArt.id}/zip`,
                method: 'GET',
                headers: { Authorization: `token ${token}`, 'User-Agent': 'AdHash-Dashboard', Accept: 'application/vnd.github.v3+json' }
            }, r2 => {
                if (r2.statusCode === 302 || r2.statusCode === 301) resolve(r2.headers.location);
                else reject(new Error(`Unexpected status ${r2.statusCode}`));
            });
            req2.on('error', reject);
            req2.setTimeout(10000, () => { req2.destroy(); reject(new Error('Redirect timeout')); });
            req2.end();
        });

        // Fetch the actual zip from S3
        const zipBuf = await new Promise((resolve, reject) => {
            const chunks = [];
            const u = new URL(zipUrl);
            const req3 = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers: { 'User-Agent': 'AdHash-Dashboard' } }, r3 => {
                r3.on('data', c => chunks.push(c));
                r3.on('end', () => resolve(Buffer.concat(chunks)));
                r3.on('error', reject);
            });
            req3.on('error', reject);
            req3.setTimeout(30000, () => { req3.destroy(); reject(new Error('Download timeout')); });
            req3.end();
        });

        // Parse zip in-memory — handles subdirectories, ZIP64, and data descriptors
        // (flags bit 3 set = compSize=0 in header; actual size follows the data)
        let htmlContent = '';
        let offset = 0;
        while (offset < zipBuf.length - 30) {
            const sig = zipBuf.readUInt32LE(offset);
            if (sig !== 0x04034b50) { offset++; continue; } // scan for next header
            const flags       = zipBuf.readUInt16LE(offset + 6);
            const compression = zipBuf.readUInt16LE(offset + 8);
            let   compSize    = zipBuf.readUInt32LE(offset + 18);
            let   uncompSize  = zipBuf.readUInt32LE(offset + 22);
            const nameLen     = zipBuf.readUInt16LE(offset + 26);
            const extraLen    = zipBuf.readUInt16LE(offset + 28);
            const name        = zipBuf.slice(offset + 30, offset + 30 + nameLen).toString('utf8');
            const dataOffset  = offset + 30 + nameLen + extraLen;
            // Handle ZIP64 extra field (sizes stored as 8-byte values)
            if (compSize === 0xFFFFFFFF || uncompSize === 0xFFFFFFFF) {
                let extraOff = offset + 30 + nameLen;
                const extraEnd = extraOff + extraLen;
                while (extraOff + 4 <= extraEnd) {
                    const hdrId = zipBuf.readUInt16LE(extraOff);
                    const hdrSz = zipBuf.readUInt16LE(extraOff + 2);
                    if (hdrId === 0x0001 && extraOff + 4 + hdrSz <= extraEnd) {
                        if (uncompSize === 0xFFFFFFFF) uncompSize = Number(zipBuf.readBigUInt64LE(extraOff + 4));
                        if (compSize   === 0xFFFFFFFF) compSize   = Number(zipBuf.readBigUInt64LE(extraOff + 12));
                        break;
                    }
                    extraOff += 4 + hdrSz;
                }
            }
            // Data descriptor (flags bit 3): compSize=0 in header, real sizes after data.
            // Find the actual compressed data by scanning for the data descriptor signature
            // or the next local file header, and infer size from position.
            if ((flags & 0x08) && compSize === 0 && (name.endsWith('.html') || name.endsWith('.htm'))) {
                // Scan forward from dataOffset to find end of compressed data:
                // look for data descriptor sig 0x08074b50 or next local file header 0x04034b50
                let scanEnd = dataOffset;
                while (scanEnd < zipBuf.length - 4) {
                    const s = zipBuf.readUInt32LE(scanEnd);
                    if (s === 0x08074b50 || s === 0x04034b50 || s === 0x02014b50) break;
                    scanEnd++;
                }
                compSize = scanEnd - dataOffset;
            }
            if ((name.endsWith('.html') || name.endsWith('.htm')) && compSize > 0) {
                const data = zipBuf.slice(dataOffset, dataOffset + compSize);
                try {
                    htmlContent = compression === 8 ? zlib.inflateRawSync(data).toString('utf8') : data.toString('utf8');
                    if (htmlContent.includes('<html') || htmlContent.includes('<!DOCTYPE')) break;
                    htmlContent = ''; // not valid HTML, keep scanning
                } catch (_) {}
            }
            offset = dataOffset + (compSize || 0);
        }

        if (!htmlContent) return res.json({ data: null, runId: run.id, message: 'Could not extract HTML from artifact' });

        // Parse structured data from the HTML
        const data = _parseAutoCheckerReport(htmlContent);
        data.runId      = run.id;
        data.conclusion = run.conclusion;
        data.created_at = run.created_at;
        data.run_number = run.run_number;
        data.html_url   = run.html_url;
        res.json({ data, rawHtml: htmlContent });
    } catch (e) {
        console.error('[autochecker/report]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// Parse AutoChecker HTML report into structured data
function _parseAutoCheckerReport(html) {
    const result = { reportDate: '', datePeriod: '', stats: [], summary: [], websiteScrape: [], partSouq: [], failed: [] };
    try {
        // Date badges
        const dateBadges = [...html.matchAll(/date-badge[^>]*>([^<]+)</g)].map(m => m[1].trim());
        result.reportDate = dateBadges[0]?.replace(/^[^\:]+:\s*/,'').trim() || '';
        result.datePeriod = dateBadges[1]?.replace(/^[^\:]+:\s*/,'').trim() || '';

        // Stats cards — extract h3 label, value, label
        const statMatches = [...html.matchAll(/<div class='stat-card'>[\s\S]*?<h3>([\s\S]*?)<\/h3>[\s\S]*?<div class='value'>([\s\S]*?)<\/div>[\s\S]*?<div class='label'>([\s\S]*?)<\/div>/g)];
        result.stats = statMatches.map(m => ({
            title: m[1].replace(/<[^>]+>/g,'').trim(),
            value: m[2].replace(/<[^>]+>/g,'').trim().replace(/\s+/g,' '),
            label: m[3].replace(/<[^>]+>/g,'').trim()
        }));

        // Summary table rows
        const summaryRows = [...html.matchAll(/<tr>[\s\S]*?<strong>([\s\S]*?)<\/strong>[\s\S]*?class='metric-value'>([\s\S]*?)<\/td>[\s\S]*?class='metric-value'>([\s\S]*?)<\/td>/g)];
        result.summary = summaryRows.map(m => ({
            module: m[1].replace(/<[^>]+>/g,'').trim(),
            total:  m[2].replace(/<[^>]+>/g,'').trim().replace(/\s+/g,' '),
            today:  m[3].replace(/<[^>]+>/g,'').trim()
        }));

        // Website Scrap + PartSouq — badge tables
        const tables = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/g)];
        tables.forEach(t => {
            const heading = t[1].replace(/<[^>]+>/g,'').trim();
            const rows = [...t[2].matchAll(/<strong>([\s\S]*?)<\/strong>[\s\S]*?class='metric-value'>([\s\S]*?)<\/td>[\s\S]*?badge[^']*'>([\s\S]*?)<\/span>/g)];
            const parsed = rows.map(r => ({
                status: r[1].replace(/<[^>]+>/g,'').trim(),
                count:  r[2].replace(/<[^>]+>/g,'').trim(),
                badge:  r[3].replace(/<[^>]+>/g,'').replace(/&\w+;/g,'').trim()
            }));
            if (/Website Scrap/i.test(heading)) result.websiteScrape = parsed;
            if (/PartSouq/i.test(heading)) result.partSouq = parsed;
        });

        // Failed report rows
        const failRows = [...html.matchAll(/<td>(\d+)<\/td>[\s\S]*?<strong>([\s\S]*?)<\/strong>[\s\S]*?<td>([\s\S]*?)<\/td>[\s\S]*?<td>([\s\S]*?)<\/td>[\s\S]*?badge[^>]*>([\s\S]*?)<\/span>/g)];
        result.failed = failRows.map(r => ({
            num:       r[1].trim(),
            part:      r[2].replace(/<[^>]+>/g,'').trim(),
            date:      r[3].replace(/<[^>]+>/g,'').trim(),
            brand:     r[4].replace(/<[^>]+>/g,'').trim(),
            status:    r[5].replace(/<[^>]+>/g,'').replace(/&\w+;/g,'').trim()
        }));
    } catch (e) { console.warn('[parseReport]', e.message); }
    return result;
}

// GET /api/events — SSE stream; pushes qa-data-update/delete events to all connected clients
app.get('/api/events', (req, res) => {
    // Accept JWT via query param (EventSource can't send custom headers)
    // or fall back to cookie auth for legacy clients
    let userId = 'anonymous', userName = 'User';
    const qToken = req.query.token;
    if (qToken) {
        const p = verifyJwt(qToken);
        if (!p) return res.status(401).end();
        userId = p.id || p.email || 'user';
        userName = p.name || p.email || 'User';
    } else if (!isAuthenticated(req)) {
        return res.status(401).end();
    } else {
        const s = getSessionFromCookie(req);
        if (s) { userId = s.email || 'user'; userName = s.name || s.email || 'User'; }
    }

    const clientId = 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Send client its own ID so it can skip its own broadcasts
    res.write(`event: connected\ndata: ${JSON.stringify({ ok: true, clientId, userId, userName })}\n\n`);

    _sseClients.set(clientId, { res, userId, userName, connectedAt: new Date() });
    console.log(`[SSE] ${userName} connected (${clientId}). Total: ${_sseClients.size}`);

    // Keepalive ping every 25s — prevents Railway/proxy timeouts
    const ping = setInterval(() => {
        try { res.write(': ping\n\n'); }
        catch (_) { clearInterval(ping); _sseClients.delete(clientId); }
    }, 25000);

    req.on('close', () => {
        clearInterval(ping);
        _sseClients.delete(clientId);
        console.log(`[SSE] ${userName} disconnected. Total: ${_sseClients.size}`);
    });
    req.on('error', () => { clearInterval(ping); _sseClients.delete(clientId); });
});

// GET /api/active-users — who is currently connected via SSE
app.get('/api/active-users', (req, res) => {
    if (!isAuthenticated(req) && !verifyJwt(getBearerToken(req))) return res.status(401).json({ error: 'Unauthorized' });
    const seen = new Map();
    for (const { userId, userName, connectedAt } of _sseClients.values()) {
        if (!seen.has(userId)) seen.set(userId, { userId, userName, connectedAt });
    }
    res.json(Array.from(seen.values()));
});

// GET /api/backup — download full qa-shared.json as a file (for manual backup)
app.get('/api/backup', (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const data = readQaData();
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="adhash-qa-backup-${ts}.json"`);
        res.send(JSON.stringify(data, null, 2));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/qa-data/:key — return one key (deduped before sending)
app.get('/api/qa-data/:key', (req, res) => {
    const data = readQaData();
    const key = req.params.key;
    if (!(key in data)) return res.status(404).json({ error: 'Key not found' });
    let value = data[key];
    // Apply dedup on per-project objects before returning to client
    if (key.startsWith('qa3_') && value && typeof value === 'object' && !Array.isArray(value)) {
        value = deduplicateProjectData(value);
    } else if (key === 'qa3_team_tasks' && Array.isArray(value)) {
        value = mergeTeamTasks([], value);
    } else if (key === 'qa3_daily_tasks' && Array.isArray(value)) {
        value = mergeDailyTasks([], value);
    }
    res.json({ key, value });
});

// DELETE /api/qa-data/:key — remove a key
app.delete('/api/qa-data/:key', async (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
    const key = req.params.key;
    try {
        await _withWriteLock(async () => {
            await deleteKey(key);   // persist to MongoDB FIRST
            delete _qaCache[key];   // then update cache
        });
        res.json({ status: 'deleted', key });
        broadcastSseEvent('qa-data-delete', { key });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/qa-data-bulk — restore many keys at once (used by restore tool)
app.post('/api/qa-data-bulk', async (req, res) => {
    const { records } = req.body || {};
    if (!records || typeof records !== 'object') return res.status(400).json({ error: 'Missing records' });
    let count = 0;
    try {
        await _withWriteLock(async () => {
            const data = _qaCache;
            for (const [k, v] of Object.entries(records)) {
                if (!k || v === undefined || v === null) continue;
                if (k === 'qa3_daily_tasks') data[k] = mergeDailyTasks(data[k], v);
                else if (k === 'qa3_team_tasks') data[k] = mergeTeamTasks(data[k], v);
                else if (k === 'qa3_releases') data[k] = mergeReleases(data[k], v);
                else if (k.startsWith('qa3_') && v && typeof v === 'object' && !Array.isArray(v)) data[k] = mergeProjectData(data[k], v);
                else data[k] = v;
                count++;
            }
        });
        // Persist all changed keys to MongoDB
        for (const k of Object.keys(records)) {
            try { await writeKey(k, _qaCache[k]); } catch (e) { console.error('[mongo] bulk write failed for', k, e.message); }
        }
        res.json({ status: 'saved', count, dbSaved: true });
        for (const k of Object.keys(records)) {
            if (_qaCache[k] !== undefined) broadcastSseEvent('qa-data-update', { key: k, value: _qaCache[k] });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Deleted-row registry ─────────────────────────────────────────────────────
// When a row is explicitly deleted via _replaceArrays, its id (and all normalised
// variants) are registered here for 2 hours. Any subsequent save that tries to
// bring the row back is blocked. Persisted to MongoDB so it survives redeploys.
const _deletedRowRegistry = new Map(); // key: 'qa3_pid:normId' → expiry timestamp
const DELETED_ROW_TTL = 2 * 60 * 60 * 1000; // 2 hours

// Normalise row id so PRD_40 and PRD-40 both resolve to the same key
function _normaliseRowId(id) { return String(id).replace(/[-_]/g, '_').toUpperCase(); }

async function _registerDeletedRows(qaKey, prevArray, newArray) {
    const prevIds = new Set((prevArray || []).filter(r => r && r.id).map(r => r.id));
    const newIds  = new Set((newArray  || []).filter(r => r && r.id).map(r => _normaliseRowId(r.id)));
    const now = Date.now();
    const expiry = now + DELETED_ROW_TTL;
    // Clean expired entries
    for (const [k, exp] of _deletedRowRegistry) { if (now > exp) _deletedRowRegistry.delete(k); }
    const toStore = [];
    for (const id of prevIds) {
        if (!newIds.has(_normaliseRowId(id))) {
            const key = qaKey + ':' + _normaliseRowId(id);
            _deletedRowRegistry.set(key, expiry);
            toStore.push(key);
        }
    }
    // Persist to MongoDB so registry survives redeploys
    if (toStore.length > 0) {
        try {
            const { getDB } = require('./src/db');
            const db = getDB();
            if (db) {
                await db.collection('deleted_row_registry').insertMany(
                    toStore.map(k => ({ key: k, expiry: new Date(expiry) })),
                    { ordered: false }
                );
                // Clean expired entries from DB
                await db.collection('deleted_row_registry').deleteMany({ expiry: { $lt: new Date() } });
            }
        } catch (_) {}
    }
}

async function _loadDeletedRowRegistry() {
    try {
        const { getDB } = require('./src/db');
        const db = getDB();
        if (!db) return;
        const docs = await db.collection('deleted_row_registry').find({ expiry: { $gt: new Date() } }).toArray();
        docs.forEach(d => _deletedRowRegistry.set(d.key, new Date(d.expiry).getTime()));
        if (docs.length > 0) console.log(`[delete-guard] loaded ${docs.length} registry entries from MongoDB`);
    } catch (_) {}
}

function _filterDeletedRows(qaKey, arr) {
    if (!Array.isArray(arr)) return arr;
    const now = Date.now();
    return arr.filter(r => {
        if (!r || !r.id) return true;
        const key = qaKey + ':' + _normaliseRowId(r.id);
        const exp = _deletedRowRegistry.get(key);
        if (exp && now < exp) {
            console.log(`[delete-guard] blocked resurrection of ${r.id} in ${qaKey}`);
            return false;
        }
        return true;
    });
}

// Smart merge helpers — prevent multi-user overwrite on shared arrays
// Each user's browser only has their slice of data; a full replace would clobber other users' rows.

// Merge daily tasks: keyed by (date, projectId) — each row is unique per project per day.
// Per-row merge: if incoming has a row for that key, newer _savedAt wins.
// If incoming does NOT have a row for that key, the existing row is always kept
// (it belongs to another project/date edited by a different user — never drop it).
function mergeDailyTasks(existing, incoming) {
    if (!Array.isArray(incoming)) return existing;
    const nk = r => (r.date||'') + '|' + (r.projectId||'');
    const winner = (a, b) => {
        if (!a) return b; if (!b) return a;
        return ((b._savedAt||0) >= (a._savedAt||0)) ? b : a;
    };
    // Build a set of keys that incoming explicitly covers
    const incomingKeys = new Set(incoming.map(nk));
    const map = new Map();
    // Seed from ALL existing rows — keep every row not covered by incoming
    (existing || []).forEach(r => { map.set(nk(r), r); });
    // Overlay incoming rows: per-row winner by _savedAt (newer edit wins)
    incoming.forEach(r => { map.set(nk(r), winner(map.get(nk(r)), r)); });
    return Array.from(map.values());
}

// Merge team tasks: keyed by id. Newer _savedAt wins per row.
// Rows in existing but not in incoming are kept (added by another user).
// Rows explicitly deleted must use _replaceArrays flag — not this merge path.
function mergeTeamTasks(existing, incoming) {
    if (!Array.isArray(incoming)) return existing;
    const winner = (a, b) => {
        if (!a) return b; if (!b) return a;
        return ((b._savedAt||0) >= (a._savedAt||0)) ? b : a;
    };
    const map = new Map();
    // Seed from all existing rows
    (existing || []).forEach(r => { if (r.id) map.set(r.id, r); });
    // Overlay incoming: per-row winner
    incoming.forEach(r => { if (r.id) map.set(r.id, winner(map.get(r.id), r)); });
    return Array.from(map.values());
}

// Merge releases: keyed by id
function mergeReleases(existing, incoming) {
    if (!Array.isArray(incoming)) return existing;
    // Incoming is authoritative for items it contains.
    // Existing items NOT in incoming are only kept if they were saved MORE RECENTLY than
    // the incoming array's newest _savedAt — meaning another user added them after this save.
    const incomingMaxTs = Math.max(0, ...incoming.map(r => r._savedAt || 0));
    const incomingIds = new Set(incoming.filter(r => r.id).map(r => r.id));
    const map = new Map();
    incoming.forEach(r => { if (r.id) map.set(r.id, r); });
    // Only add existing items that were created AFTER the incoming save (concurrent adds)
    (existing || []).forEach(r => {
        if (r.id && !incomingIds.has(r.id) && (r._savedAt || 0) > incomingMaxTs) {
            map.set(r.id, r);
        }
    });
    return Array.from(map.values());
}

// Merge by id: incoming is authoritative — deleted items are NOT resurrected.
// Items in incoming overwrite existing; items only in existing (not in incoming) are dropped.
// Items only in incoming (not in existing) are added.
// This ensures deletions persist correctly across concurrent saves.
function mergeById(existing, incoming) {
    if (!Array.isArray(incoming)) return existing || [];
    // Incoming is authoritative — only deduplicate within incoming itself
    const byId = new Map();
    const natKey = r => ((r && r.name) || '') + '|' + ((r && r.url) || '') + '|' + ((r && r.environment) || '');
    const byNk = new Map();
    incoming.forEach(r => {
        if (r && r.id) byId.set(r.id, r);
        else if (r) byNk.set(natKey(r), r);
    });
    return [...Array.from(byId.values()), ...Array.from(byNk.values())];
}

// Merge smoke/prod rows. Incoming is authoritative for what it contains.
// Deleted rows (in existing but NOT in incoming) are only kept if they have
// a _savedAt timestamp NEWER than the incoming batch — meaning another user
// added them after this save was created. This prevents resurrection while
// allowing concurrent adds from other users to survive.
function mergeTestRows(existing, incoming, qaKey) {
    if (!Array.isArray(incoming)) return existing || [];
    // Filter incoming: block rows that were recently deleted (in registry)
    if (qaKey) incoming = _filterDeletedRows(qaKey, incoming);
    if (!Array.isArray(existing) || existing.length === 0) return incoming;
    const nk = r => ((r&&r.module)||'') + '|' + ((r&&r.step)||'') + '|' + ((r&&r.item)||'');
    const winner = (a, b) => (!a) ? b : (!b) ? a : ((b._savedAt||0) >= (a._savedAt||0)) ? b : a;
    // The incoming batch's max timestamp — rows only added AFTER this are concurrent adds
    const incomingMaxTs = Math.max(0, ...incoming.map(r => r._savedAt || 0));
    const nkToId = new Map(existing.filter(r=>r&&r.id).map(r=>[nk(r), r.id]));
    // Start from incoming (authoritative)
    const byId  = new Map();
    const byNk  = new Map();
    incoming.forEach(r => {
        if (!r) return;
        const k = nk(r);
        if (r.id) {
            const oldId = nkToId.get(k);
            if (oldId && oldId !== r.id) byId.delete(oldId); // remove ghost on id rename
            byId.set(r.id, winner(byId.get(r.id), r));
        } else {
            byNk.set(k, winner(byNk.get(k), r));
        }
    });
    // Only add existing rows that were created AFTER this batch (concurrent adds by other users)
    existing.forEach(r => {
        if (!r || (r._savedAt||0) <= incomingMaxTs) return; // older or same — skip (deleted)
        if (r.id && !byId.has(r.id)) byId.set(r.id, r);
        else if (!r.id) { const k = nk(r); if (!byNk.has(k)) byNk.set(k, r); }
    });
    return [...Array.from(byId.values()), ...Array.from(byNk.values())];
}

// Deep merge a qa3_<projectId> project object.
// Sub-arrays that multiple users can edit concurrently are merged by row id.
// Scalar fields (env, gates) are replaced by incoming (only admin edits those).
const PROJECT_ARRAY_KEYS = ['smoke', 'prod', 'feedback', 'thirdparty', 'taskchecklist',
                            'pendingtasks', 'credentials', 'apitests', 'testdata',
                            'releaseNotes', 'reports', 'pending', 'wfdocs'];

// Fields that must never be overwritten with an empty array — preserve existing data
const NEVER_WIPE_EMPTY = new Set(['credentials', 'thirdparty', 'wfdocs', 'pendingtasks', 'apitests', 'reports']);

function mergeProjectData(existing, incoming, qaKey) {
    if (!existing || typeof existing !== 'object') return incoming;
    if (!incoming || typeof incoming !== 'object') return existing;
    // Start from existing so keys NOT present in incoming are preserved (not wiped)
    const merged = { ...existing };
    for (const key of Object.keys(incoming)) {
        const inVal = incoming[key];
        // Never clobber existing data with null/undefined
        if (inVal === null || inVal === undefined) continue;
        if (PROJECT_ARRAY_KEYS.includes(key)) {
            // Never overwrite existing non-empty data with an empty array for protected fields
            if (NEVER_WIPE_EMPTY.has(key) && Array.isArray(inVal) && inVal.length === 0 &&
                Array.isArray(merged[key]) && merged[key].length > 0) continue;
            if (key === 'smoke' || key === 'prod') {
                merged[key] = mergeTestRows(existing[key], inVal, qaKey);
            } else if (key === 'reports') {
                // Reports: incoming is authoritative when non-empty (deletions must be respected).
                // mergeById keeps deleted items alive — use incoming directly instead.
                merged[key] = inVal.length > 0 ? inVal : (merged[key] || []);
            } else {
                merged[key] = mergeById(existing[key], inVal);
            }
        } else if (key === 'envDetails' && inVal && typeof inVal === 'object') {
            const existProd = (existing[key]||{}).production || [];
            const existStag = (existing[key]||{}).staging    || [];
            const inProd    = inVal.production || [];
            const inStag    = inVal.staging    || [];
            merged[key] = {
                production: (inProd.length === 0 && existProd.length > 0) ? existProd : mergeById(existProd, inProd),
                staging:    (inStag.length === 0 && existStag.length > 0) ? existStag : mergeById(existStag, inStag),
            };
        } else {
            merged[key] = inVal;
        }
    }
    return merged;
}

// POST /api/qa-data/:key — save one key's value, serialised through write lock to prevent race.
// The write lock ensures concurrent requests read-modify-write sequentially, not in parallel.
app.post('/api/qa-data/:key', async (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
    const key = req.params.key;
    const { value, _clientId } = req.body;
    if (value === undefined) return res.status(400).json({ error: 'Missing value' });

    // qa_users is managed exclusively via /api/users routes — never via this generic route.
    // Accepting it here caused E11000 duplicate key errors due to the email unique index.
    if (key === 'qa_users') {
        return res.json({ status: 'skipped', key, reason: 'users managed via /api/users' });
    }

    // Projects that must NOT have auto-filled smoke/prod test cases.
    // If an old browser tab tries to heartbeat-save default Humee cases for these projects,
    // strip smoke/prod from the incoming value before merging — keeps them permanently empty.
    const NO_DEFAULT_SMOKE_PROD = new Set([
        'adhash','sparkme','zapai','zapcrm','zaptrade_mpv6v89b',
        'algomax','autochecker','metcalf','smc','synctrade'
    ]);
    if (key.startsWith('qa3_') && value && typeof value === 'object' && !Array.isArray(value)) {
        const pid = key.replace('qa3_', '');
        if (NO_DEFAULT_SMOKE_PROD.has(pid) && !value._replaceArrays) {
            // Only strip if the client is NOT explicitly using _replaceArrays (which is intentional)
            // and the incoming smoke/prod are non-empty (old-tab heartbeat sending defaults)
            if (Array.isArray(value.smoke) && value.smoke.length > 0) {
                value = { ...value, smoke: [] };
                console.log(`[guard] stripped default smoke for ${pid}`);
            }
            if (Array.isArray(value.prod) && value.prod.length > 0) {
                value = { ...value, prod: [] };
                console.log(`[guard] stripped default prod for ${pid}`);
            }
        }
    }

    try {
        await _withWriteLock(async () => {
            // Merge into in-memory cache (prevents concurrent writes clobbering each other)
            if (key === 'qa3_daily_tasks') {
                _qaCache[key] = mergeDailyTasks(_qaCache[key], value);
            } else if (key === 'qa3_team_tasks') {
                _qaCache[key] = mergeTeamTasks(_qaCache[key], value);
            } else if (key === 'qa3_releases') {
                _qaCache[key] = mergeReleases(_qaCache[key], value);
            } else if (key.startsWith('qa3_') && value && typeof value === 'object' && !Array.isArray(value)) {
                // If client sent _replaceArrays flag (e.g. after a delete operation),
                // replace smoke/prod/taskchecklist arrays directly — never merge deleted rows back
                if (value._replaceArrays && Array.isArray(value._replaceArrays)) {
                    // Client explicitly deleted rows — replace those arrays directly, don't merge
                    const { _replaceArrays, ...cleanValue } = value;
                    const merged = mergeProjectData(_qaCache[key], cleanValue, key);
                    for (const arrKey of _replaceArrays) {
                        if (arrKey === '_envDetails') {
                            if (cleanValue.envDetails && typeof cleanValue.envDetails === 'object') {
                                merged.envDetails = {
                                    production: Array.isArray(cleanValue.envDetails.production) ? cleanValue.envDetails.production : [],
                                    staging:    Array.isArray(cleanValue.envDetails.staging)    ? cleanValue.envDetails.staging    : []
                                };
                            }
                        } else if (Array.isArray(cleanValue[arrKey])) {
                            // Register deleted row ids BEFORE replacing — blocks resurrection for 5min
                            await _registerDeletedRows(key, (_qaCache[key] || {})[arrKey], cleanValue[arrKey]);
                            merged[arrKey] = cleanValue[arrKey];
                        }
                    }
                    _qaCache[key] = merged;
                } else {
                    // Strip _replaceArrays if present (safety)
                    const { _replaceArrays: _ra, ...cleanVal } = (typeof value === 'object' && value !== null) ? value : {};
                    _qaCache[key] = mergeProjectData(_qaCache[key], _ra ? cleanVal : value, key);
                }
                // ── DATA LOSS PREVENTION ──────────────────────────────────────────────────
                // Preserve critical arrays if incoming is missing OR empty.
                // Empty arrays from an uninitialised STORE must never wipe real data.
                const prevCache = (_qaCache[key] && typeof _qaCache[key] === 'object') ? _qaCache[key] : {};
                const incomingVal = (typeof value === 'object' && value !== null) ? value : {};
                const replaceList = Array.isArray(incomingVal._replaceArrays) ? incomingVal._replaceArrays : [];
                // Protect credentials — keep existing if incoming is missing OR empty
                if (!replaceList.includes('credentials')) {
                    const inCreds = incomingVal.credentials;
                    const prevCreds = prevCache.credentials;
                    if (Array.isArray(prevCreds) && prevCreds.length > 0 &&
                        (!Array.isArray(inCreds) || inCreds.length === 0)) {
                        _qaCache[key].credentials = prevCreds;
                    }
                }
                // Protect envDetails — keep existing if incoming is missing OR empty
                if (!replaceList.includes('_envDetails')) {
                    const prevEnv = prevCache.envDetails;
                    const inEnv = incomingVal.envDetails;
                    const prevHasData = prevEnv && (
                        (Array.isArray(prevEnv.production) && prevEnv.production.length > 0) ||
                        (Array.isArray(prevEnv.staging)    && prevEnv.staging.length    > 0));
                    const incomingIsEmpty = !inEnv ||
                        ((!Array.isArray(inEnv.production) || inEnv.production.length === 0) &&
                         (!Array.isArray(inEnv.staging)    || inEnv.staging.length    === 0));
                    if (prevHasData && incomingIsEmpty) _qaCache[key].envDetails = prevEnv;
                }
                // Protect thirdparty — keep existing if incoming is missing OR empty
                if (!replaceList.includes('thirdparty')) {
                    const inTP = incomingVal.thirdparty;
                    const prevTP = prevCache.thirdparty;
                    if (Array.isArray(prevTP) && prevTP.length > 0 &&
                        (!Array.isArray(inTP) || inTP.length === 0)) {
                        _qaCache[key].thirdparty = prevTP;
                    }
                }
            } else {
                _qaCache[key] = value;
            }
        });
        // Persist merged value to MongoDB — writeProject returns dedupedFields when
        // it collapsed duplicate reports. Apply those directly to _qaCache so mergedValue
        // and SSE broadcast send the clean deduped array, not the stale full set.
        const dedupedFields = await writeKey(key, _qaCache[key]);
        if (dedupedFields && typeof dedupedFields === 'object') {
            for (const [f, v] of Object.entries(dedupedFields)) {
                if (_qaCache[key]) _qaCache[key][f] = v;
            }
        }
        // Return merged value so client doesn't need a separate re-fetch
        res.json({ status: 'saved', key, dbSaved: true, mergedValue: _qaCache[key] });
        // Broadcast to OTHER clients only (sourceClientId lets sender skip its own echo)
        try { broadcastSseEvent('qa-data-update', { key, value: _qaCache[key] }, _clientId); } catch (_) {}
    } catch (e) {
        // E11000 = duplicate key — treat as non-fatal, return 200 with warning
        if (e.code === 11000) {
            console.warn('[save] E11000 on key', key, '— skipping:', e.message);
            return res.json({ status: 'skipped', key, reason: 'duplicate key' });
        }
        res.status(500).json({ error: e.message });
    }
});

// ── ASSIGNMENT NOTIFICATION EMAIL + SLACK ──
// POST /api/notify-assignment — respond IMMEDIATELY (202), send email+Slack in background
app.post('/api/notify-assignment', (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });

    const { type, assignedBy, assignedTo, projectName, subject: subjectOverride, details, dashboardUrl } = req.body || {};
    if (!type) return res.status(400).json({ error: 'Missing required field: type' });

    // Respond immediately so the browser never hangs
    res.json({ queued: true, type, projectName });
    console.log(`[notify] queued → type:${type} project:${projectName} assignedBy:${assignedBy||'(none)'}`);

    // Fire all notifications asynchronously in the background
    _sendNotificationsAsync({ type, assignedBy: assignedBy || 'Dashboard', assignedTo, projectName, subject: subjectOverride, details, dashboardUrl });
});

async function _sendNotificationsAsync({ type, assignedBy, assignedTo, projectName, subject: subjectOverride, details, dashboardUrl }) {
    console.log(`[notify] _sendNotificationsAsync start → ZOHO_MAIL_ENABLED=${process.env.ZOHO_MAIL_ENABLED} SLACK_ENABLED=${process.env.SLACK_ENABLED} ZOHO_MAIL_USER=${process.env.ZOHO_MAIL_USER} type=${type}`);
    if (process.env.ZOHO_MAIL_ENABLED !== 'true' && process.env.SLACK_ENABLED !== 'true') {
        console.log('[notify] both mail and slack disabled — skipping');
        return;
    }

    // Resolve name → email: MongoDB users collection is authoritative, DEFAULT_EMAILS as fallback
    let dbUsers = [];
    try {
        const { getDB } = require('./src/db');
        const db = getDB();
        if (db) dbUsers = await db.collection('users').find({}, { projection: { name: 1, email: 1 } }).toArray();
    } catch (_) {}
    const DEFAULT_EMAILS = {
        'Deepa':      'deepa@adhashtech.com',
        'Prakash Raj':'prakashraj.p@adhashtech.com',
        'Raghuram':   'raghuram@synctag.com',
        'Thenilavan': 'thenilavan@adhashtech.com',
        'Yogesh':     'yogesh@synctag.com',
    };
    const findEmail = (name) => {
        if (!name) return null;
        // Check MongoDB users first (always up to date)
        const dbU = dbUsers.find(u => u.name && u.name.toLowerCase() === name.toLowerCase());
        if (dbU && dbU.email) return dbU.email;
        // Fallback to hardcoded defaults
        for (const [k, v] of Object.entries(DEFAULT_EMAILS)) {
            if (k.toLowerCase() === name.toLowerCase()) return v;
        }
        return null;
    };

    const assignedByEmail = findEmail(assignedBy);
    const assignedToEmail = assignedTo ? findEmail(assignedTo) : null;

    // Build recipients: always notify thenilavan, and include assignedTo if resolved
    const toList = new Set(['thenilavan@adhashtech.com']);
    if (assignedByEmail && assignedByEmail !== 'thenilavan@adhashtech.com') toList.add(assignedByEmail);
    if (assignedToEmail) toList.add(assignedToEmail);
    const toAddresses = [...toList].join(', ');

    // Type labels
    const typeLabels = {
        'teamtask':     '📋 Team Task Assigned',
        'release_today':'🚀 Today\'s Release',
        'release_next': '📆 Next Release',
        'release_past': '✅ Past Release',
        'feedback_req': '📋 New Client Requirement',
        'feedback_bug': '🐛 New Bug Reported',
    };
    const typeLabel = typeLabels[type] || '📌 Dashboard Notification';
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    const dashUrl = dashboardUrl || 'https://adhashprojectdashboard-production.up.railway.app/';

    // Build detail rows HTML
    const detailRowsHtml = (details || []).map(d =>
        `<tr><td style="padding:10px 16px;font-size:13px;color:#64748b;font-weight:600;white-space:nowrap;vertical-align:top;border-bottom:1px solid #f1f5f9;width:36%">${d.label}</td><td style="padding:10px 16px;font-size:13px;color:#1e293b;vertical-align:top;border-bottom:1px solid #f1f5f9">${d.value||'—'}</td></tr>`
    ).join('');

    const subjectLine = subjectOverride || `${typeLabel} — ${projectName || 'AdHash Dashboard'} | ${dateStr}`;

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f4f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4f8;padding:32px 0">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
  <!-- Header gradient -->
  <tr><td style="background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 50%,#ec4899 100%);padding:32px 36px">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td>
          <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:rgba(255,255,255,0.7);margin-bottom:6px">AdHash QA Dashboard</div>
          <div style="font-size:22px;font-weight:800;color:#ffffff;line-height:1.2">${typeLabel}</div>
          ${projectName?`<div style="margin-top:8px;display:inline-block;background:rgba(255,255,255,0.18);border:1px solid rgba(255,255,255,0.3);border-radius:50px;padding:4px 14px;font-size:12px;font-weight:700;color:#fff">📁 ${projectName}</div>`:''}
        </td>
        <td align="right" style="vertical-align:top">
          <div style="background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.3);border-radius:10px;padding:10px 14px;text-align:right">
            <div style="font-size:11px;color:rgba(255,255,255,0.75);font-weight:600">Assigned by</div>
            <div style="font-size:15px;font-weight:800;color:#fff;margin-top:2px">${assignedBy||'—'}</div>
          </div>
        </td>
      </tr>
    </table>
  </td></tr>
  <!-- Date/time bar -->
  <tr><td style="background:#f8fafc;padding:10px 36px;border-bottom:1px solid #e2e8f0">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font-size:12px;color:#64748b;font-weight:600">📅 ${dateStr}</td>
      <td align="right" style="font-size:12px;color:#64748b;font-weight:600">🕐 ${timeStr}</td>
    </tr></table>
  </td></tr>
  <!-- Details table -->
  <tr><td style="padding:24px 36px">
    <div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:#94a3b8;margin-bottom:14px">Assignment Details</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
      ${detailRowsHtml}
    </table>
  </td></tr>
  <!-- CTA -->
  <tr><td align="center" style="padding:8px 36px 28px">
    <a href="${dashUrl}" style="display:inline-block;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;text-decoration:none;padding:14px 32px;border-radius:50px;font-size:14px;font-weight:800;letter-spacing:.3px;box-shadow:0 4px 16px rgba(99,102,241,.35)">🚀 Open Dashboard →</a>
  </td></tr>
  <!-- Footer -->
  <tr><td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:16px 36px;text-align:center">
    <div style="font-size:11px;color:#94a3b8">This is an automated notification from AdHash QA Dashboard. Do not reply to this email.</div>
    <div style="font-size:11px;color:#94a3b8;margin-top:4px">© ${now.getFullYear()} AdHash Technologies · <a href="${dashUrl}" style="color:#6366f1;text-decoration:none">adhashprojectdashboard-production.up.railway.app</a></div>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

    // ── Send Email + Slack in parallel (both non-blocking, errors logged only) ──
    const emailPromise = (process.env.ZOHO_MAIL_ENABLED === 'true')
        ? sendZohoMail({
            subject: subjectLine,
            html,
            to: toAddresses,
            cc: process.env.ZOHO_MAIL_CC || 'qateam@adhashtech.com'
          })
            .then(() => console.log(`[notify] ✅ Email → to:${toAddresses} cc:${process.env.ZOHO_MAIL_CC} | ${type} | ${projectName}`))
            .catch(e => console.error(`[notify] ❌ Email failed (${type}):`, e.message))
        : Promise.resolve();

    const slackPromise = (process.env.SLACK_ENABLED === 'true')
        ? sendSlackNotification({ type, projectName, assignedBy, assignedTo, details, dashboardUrl: dashUrl })
            .then(() => console.log(`[notify] ✅ Slack → ${process.env.SLACK_CHANNEL} | ${type} | ${projectName}`))
            .catch(e => console.error(`[notify] ❌ Slack failed (${type}):`, e.message))
        : Promise.resolve();

    // Wait for both (for logging), but this runs after response already sent
    Promise.all([emailPromise, slackPromise])
        .catch(e => console.error('[notify] unexpected error:', e.message));
}

// Deduplicate a single array: keyed by id if present, otherwise by natural key (name+url+environment).
function deduplicateArray(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return arr;
    const byId = new Map();
    const byNatKey = new Map();
    const natKey = r => ((r && r.name) || '') + '|' + ((r && r.url) || '') + '|' + ((r && r.environment) || '');
    arr.forEach(r => {
        if (r && r.id) byId.set(r.id, r);
        else byNatKey.set(natKey(r), r);
    });
    return [...Array.from(byId.values()), ...Array.from(byNatKey.values())];
}

// Dedup a single project object in memory — used by GET /api/qa-data/:key before sending to client
const PROJECT_ARRAY_KEYS_ALL = ['smoke', 'prod', 'feedback', 'thirdparty', 'taskchecklist',
    'pendingtasks', 'credentials', 'apitests', 'testdata', 'releaseNotes', 'reports', 'pending', 'wfdocs'];
function deduplicateProjectData(proj) {
    if (!proj || typeof proj !== 'object') return proj;
    const out = { ...proj };
    PROJECT_ARRAY_KEYS_ALL.forEach(k => {
        if (Array.isArray(out[k]) && out[k].length > 0) out[k] = deduplicateArray(out[k]);
    });
    if (out.envDetails) {
        if (Array.isArray(out.envDetails.production)) out.envDetails = { ...out.envDetails, production: deduplicateArray(out.envDetails.production) };
        if (Array.isArray(out.envDetails.staging))    out.envDetails = { ...out.envDetails, staging:    deduplicateArray(out.envDetails.staging)    };
    }
    if (Array.isArray(out.thirdparty)) {
        out.thirdparty = out.thirdparty.map(acct => ({
            ...acct,
            apis: Array.isArray(acct.apis) ? deduplicateArray(acct.apis) : acct.apis
        }));
    }
    return out;
}

// Deduplicate all project sub-arrays on startup.
// Uses deduplicateArray so even legacy records without an 'id' are cleaned.
async function deduplicateAllProjectData() {
    const data = readQaData();
    let changed = false;

    // Dedup top-level team tasks and daily tasks arrays
    if (Array.isArray(data['qa3_team_tasks']) && data['qa3_team_tasks'].length > 0) {
        const before = data['qa3_team_tasks'].length;
        data['qa3_team_tasks'] = mergeTeamTasks([], data['qa3_team_tasks']);
        if (data['qa3_team_tasks'].length !== before) {
            console.log(`[dedup] qa3_team_tasks: ${before} → ${data['qa3_team_tasks'].length}`);
            changed = true;
        }
    }
    if (Array.isArray(data['qa3_daily_tasks']) && data['qa3_daily_tasks'].length > 0) {
        const before = data['qa3_daily_tasks'].length;
        data['qa3_daily_tasks'] = mergeDailyTasks([], data['qa3_daily_tasks']);
        if (data['qa3_daily_tasks'].length !== before) {
            console.log(`[dedup] qa3_daily_tasks: ${before} → ${data['qa3_daily_tasks'].length}`);
            changed = true;
        }
    }

    for (const key of Object.keys(data)) {
        if (!key.startsWith('qa3_')) continue;
        const proj = data[key];
        if (!proj || typeof proj !== 'object' || Array.isArray(proj)) continue;
        for (const arrKey of PROJECT_ARRAY_KEYS) {
            if (!Array.isArray(proj[arrKey]) || proj[arrKey].length === 0) continue;
            const before = proj[arrKey].length;
            proj[arrKey] = deduplicateArray(proj[arrKey]);
            if (proj[arrKey].length !== before) {
                console.log(`[dedup] ${key}.${arrKey}: ${before} → ${proj[arrKey].length}`);
                changed = true;
            }
        }
        // Dedup thirdparty.apis nested arrays
        if (Array.isArray(proj.thirdparty)) {
            proj.thirdparty.forEach(acct => {
                if (!Array.isArray(acct.apis) || acct.apis.length === 0) return;
                const before = acct.apis.length;
                acct.apis = deduplicateArray(acct.apis);
                if (acct.apis.length !== before) {
                    console.log(`[dedup] ${key}.thirdparty[${acct.name}].apis: ${before} → ${acct.apis.length}`);
                    changed = true;
                }
            });
        }
        // Dedup envDetails
        if (proj.envDetails && typeof proj.envDetails === 'object') {
            for (const side of ['production', 'staging']) {
                if (!Array.isArray(proj.envDetails[side]) || proj.envDetails[side].length === 0) continue;
                const before = proj.envDetails[side].length;
                proj.envDetails[side] = deduplicateArray(proj.envDetails[side]);
                if (proj.envDetails[side].length !== before) {
                    console.log(`[dedup] ${key}.envDetails.${side}: ${before} → ${proj.envDetails[side].length}`);
                    changed = true;
                }
            }
        }
        // Dedup wfdocs by name — keep entry with serverId preferred over legacy entry
        if (Array.isArray(proj.wfdocs) && proj.wfdocs.length > 0) {
            const before = proj.wfdocs.length;
            const seenNames = new Map();
            proj.wfdocs.forEach(f => {
                const k = (f.name || '').trim();
                if (!seenNames.has(k)) { seenNames.set(k, f); }
                else {
                    const ex = seenNames.get(k);
                    if (!ex.serverId && f.serverId) seenNames.set(k, f);
                    else if (!ex.ghUrl && f.ghUrl) seenNames.set(k, f);
                }
            });
            proj.wfdocs = Array.from(seenNames.values());
            if (proj.wfdocs.length !== before) {
                console.log(`[dedup] ${key}.wfdocs: ${before} → ${proj.wfdocs.length}`);
                changed = true;
            }
        }
    }
    if (changed) {
        _qaCache = data;
        console.log('[dedup] cleaned duplicates — persisting to MongoDB');
        for (const [k, v] of Object.entries(data)) {
            try { await writeKey(k, v); } catch (e) { console.error('[dedup] MongoDB write failed:', k, e.message); }
        }
    } else {
        console.log('[dedup] no duplicates found');
    }
}

// On startup: migrate any local wfdoc .bin files that have no ghUrl yet to GitHub Releases.
// Also performs a full dedup pass on ALL project wfdoc lists to fix any previously accumulated duplicates.
async function migrateWfDocsToGitHub() {
    const token = process.env.GITHUB_TOKEN || process.env.GH_PAT || '';
    if (!token) return;
    const shared = readQaData();
    let anyChanged = false;

    for (const projKey of Object.keys(shared)) {
        if (!projKey.startsWith('qa3_')) continue;
        const projectId = projKey.replace('qa3_', '');
        const wfdocs = (shared[projKey] && shared[projKey].wfdocs) || [];
        if (!wfdocs.length) continue;

        // ── Always dedup by name first (defensive: fixes accumulated duplicates) ──
        const seenNames = new Map();
        for (const f of wfdocs) {
            const key = f.name;
            if (!seenNames.has(key)) { seenNames.set(key, f); }
            else {
                const ex = seenNames.get(key);
                if (!ex.serverId && f.serverId) seenNames.set(key, f);
                else if (ex.serverId && !ex.ghUrl && f.ghUrl) seenNames.set(key, f);
            }
        }
        const deduped = Array.from(seenNames.values());
        if (deduped.length !== wfdocs.length) {
            console.log(`[migrate] dedup ${projKey}: ${wfdocs.length} → ${deduped.length}`);
            shared[projKey].wfdocs = deduped;
            anyChanged = true;
        }

        // ── Migrate files that have a local .bin but no ghUrl yet ──
        const needMigration = deduped.filter(f => !f.ghUrl && f.serverId);
        if (!needMigration.length) continue;
        const projectDir = path.join(WF_DOCS_DIR, projectId);
        for (const entry of needMigration) {
            const binPath = path.join(projectDir, entry.serverId + '.bin');
            const metaPath = path.join(projectDir, entry.serverId + '.meta.json');
            if (!fs.existsSync(binPath)) { console.log(`[migrate] No bin for ${entry.name} — skipping`); continue; }
            try {
                const buffer = fs.readFileSync(binPath);
                const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};
                const mimeType = meta.mimeType || entry.mimeType || 'application/octet-stream';
                const assetName = (entry.serverId) + '_' + (entry.name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
                const releaseId = await _ghEnsureWfDocRelease();
                if (!releaseId) continue;
                const ghUrl = await _ghUploadWfDocAsset(releaseId, assetName, buffer, mimeType);
                if (ghUrl) {
                    // Get asset id
                    const rel = await _ghRequest('GET', `/repos/${GH_API_REPO}/releases/tags/${GH_WFDOC_RELEASE_TAG}`, null, token);
                    const asset = rel.status === 200 ? (rel.body.assets || []).find(a => a.name === assetName) : null;
                    entry.ghUrl = ghUrl;
                    entry.ghAssetId = asset ? asset.id : null;
                    entry.assetName = assetName;
                    anyChanged = true;
                    console.log(`[migrate] Uploaded "${entry.name}" to GitHub Release`);
                }
            } catch (e) { console.error(`[migrate] Failed for ${entry.name}:`, e.message); }
        }
    }
    if (anyChanged) { writeQaData(shared); console.log('[migrate] wfdoc dedup/migration complete, qa-shared.json updated'); }
}

// Start server — connect to MongoDB, load cache, THEN start listening
(async () => {
    // Connect to MongoDB with retries — keeps trying every 5s until it succeeds.
    // Server starts listening immediately so Railway health checks pass, even before DB is ready.
    (async function connectWithRetry(attempt) {
        try {
            await connectDB();
            _qaCache = await Promise.race([readAllData(), new Promise((_,rej)=>setTimeout(()=>rej(new Error('readAllData timeout')),20000))]).catch(e=>{console.error('[startup] readAllData failed:',e.message);return {};});
            console.log(`[startup] ✅ Loaded ${Object.keys(_qaCache).length} keys from MongoDB (attempt ${attempt})`);
            // Dedup all project data in MongoDB — removes any accumulated duplicates
            try { await deduplicateAllProjectData(); } catch (e) { console.error('[startup] dedup failed:', e.message); }
            try { await seedSuperAdmin(); } catch (e) { console.warn('[startup] seedSuperAdmin failed:', e.message); }
            // Load deleted-row registry from MongoDB — survives redeploys
            try { await _loadDeletedRowRegistry(); } catch (e) { console.warn('[startup] registry load failed:', e.message); }
            // ── Auto-snapshot: save a timestamped backup of all live data to MongoDB on every startup ──
            // This means every deployment automatically has a pre-deploy snapshot to restore from.
            try {
                const { getDB } = require('./src/db');
                const db2 = getDB();
                if (db2 && Object.keys(_qaCache).length > 0) {
                    const snap = { ts: new Date(), keys: Object.keys(_qaCache).length, data: _qaCache };
                    await db2.collection('deployment_snapshots').insertOne(snap);
                    // Keep only last 10 snapshots to avoid unbounded growth
                    const all = await db2.collection('deployment_snapshots').find({}, { projection: { _id: 1, ts: 1 } }).sort({ ts: -1 }).toArray();
                    if (all.length > 10) {
                        const toDelete = all.slice(10).map(d => d._id);
                        await db2.collection('deployment_snapshots').deleteMany({ _id: { $in: toDelete } });
                    }
                    console.log(`[startup] ✅ Deployment snapshot saved (${snap.keys} keys)`);
                }
            } catch (e) { console.warn('[startup] Deployment snapshot failed:', e.message); }
            // Load Slack token from MongoDB (survives Railway redeploys unlike .env on disk)
            try {
                const { getDB } = require('./src/db');
                const db2 = getDB();
                if (db2) {
                    const sysCfg = await db2.collection('app_config').findOne({ namespace: '_system' });
                    if (sysCfg && sysCfg.data && sysCfg.data.SLACK_BOT_TOKEN) {
                        process.env.SLACK_BOT_TOKEN = _decryptVal(sysCfg.data.SLACK_BOT_TOKEN);
                        console.log('[startup] ✅ SLACK_BOT_TOKEN loaded from MongoDB');
                    }
                }
            } catch (e) { console.warn('[startup] Slack token load failed:', e.message); }
            // ── Mongoose connection for new /api/projects and /api/qa-state routes ──
            try {
                const { connectDB: mongooseConnect } = require('./db/connection');
                const { seedProjectsIfEmpty }        = require('./db/seed');
                await mongooseConnect();
                await seedProjectsIfEmpty();
            } catch (e) { console.warn('[startup] Mongoose init failed (non-fatal):', e.message); }
            // Load project-mapping.json from GitHub so old dashboard always has latest data
            // even after Railway wipes the disk on redeploy
            try { await _loadProjectMappingFromGitHub(); } catch (e) { console.warn('[startup] project-mapping GitHub load failed:', e.message); }
            // Rebuild project-mapping from MongoDB projects collection on every startup.
            // This ensures servers/domains/apis/apps saved via Edit Project modal are always
            // reflected in the test runner even if GitHub push failed or mapping is stale.
            try {
                const { getDB } = require('./src/db');
                const db2 = getDB();
                if (db2) {
                    const mongoProjects = await db2.collection('projects').find({}).toArray();
                    if (mongoProjects.length > 0) {
                        // Use MongoDB as the single source of truth for the mapping.
                        // Build the mapping directly from MongoDB — do NOT merge with the
                        // existing mapping to avoid legacy/duplicate IDs (e.g. zaptrade vs
                        // zaptrade_mpv6v89b) creating ghost cards on the dashboard.
                        const builtProjects = mongoProjects.map(mp => ({
                            id:          mp.id || mp._id?.toString(),
                            name:        mp.name        || '',
                            description: mp.description || '',
                            color:       mp.color       || '#3b82f6',
                            apps:        mp.apps        || [],
                            servers:     mp.servers     || [],
                            domains:     mp.domains     || [],
                            sslCerts:    mp.sslCerts    || [],
                            apis:        mp.apis        || [],
                        })).filter(p => p.id);
                        const merged = { projects: builtProjects };
                        writeProjectMapping(merged);
                        console.log(`[startup] ✅ Rebuilt project-mapping from MongoDB (${builtProjects.length} projects)`);
                    }
                }
            } catch (e) { console.warn('[startup] project-mapping MongoDB rebuild failed:', e.message); }
            // Sync qa3_projects from cache to MongoDB — ensures any projects added before
            // this fix are written to the projects collection so they survive redeploys
            try {
                const { writeKey } = require('./src/db');
                const cachedProjects = _qaCache['qa3_projects'];
                if (Array.isArray(cachedProjects) && cachedProjects.length > 0) {
                    await writeKey('qa3_projects', cachedProjects);
                    console.log(`[startup] ✅ Synced ${cachedProjects.length} projects to MongoDB`);
                }
            } catch (e) { console.warn('[startup] project sync failed:', e.message); }
        } catch (e) {
            console.error(`[startup] ⚠️  MongoDB attempt ${attempt} failed: ${e.message} — retrying in 5s`);
            setTimeout(() => connectWithRetry(attempt + 1), 5000);
        }
    })(1);
    app.listen(PORT, '0.0.0.0', () => {
    testRunning = false;
    testResults = null;
    testLogs = [];
    currentSuite = null;

    console.log('\n╔════════════════════════════════════════════════════════════════════════════╗');
    console.log('║                   AdHash Unified Test Dashboard                           ║');
    console.log('║                        Running on Localhost                                ║');
    console.log('╚════════════════════════════════════════════════════════════════════════════╝\n');
    console.log(`🚀 Server is running at: http://localhost:${PORT}`);
    console.log(`📊 Unified Dashboard: http://localhost:${PORT}/`);
    console.log(`📈 Playwright Report: http://localhost:${PORT}/playwright-report`);
    console.log(`🔧 API Summary: http://localhost:${PORT}/api/test-summary`);
    console.log('\n✨ Press Ctrl+C to stop the server\n');

    // Log server startup
    logToArray('info', `Server started successfully on port ${PORT}`);
    logToArray('info', 'Project dashboard available at http://localhost:' + PORT);

    // On startup, recover persisted test results.
    (async () => {
        try {
            const recovered = await recoverCompletedRunFromState();
            if (recovered) {
                addLog('📦 Recovered persisted test results on startup.', 'info');
            } else {
                addLog('ℹ️ No persisted summary found on startup; skipped recovery mail dispatch.', 'info');
            }
        } catch (error) {
            addLog('❌ Startup recovery/mail dispatch failed: ' + (error && error.message), 'error');
            console.error('Startup recovery/mail dispatch failed:', error);
        }
    })();
    // Schedule automatic GitHub backup every 6 hours (runs if MongoDB >= 70% full)
    try {
        const { runBackupIfNeeded } = require('./src/gitBackup');
        runBackupIfNeeded().catch(e => console.warn('[backup] Startup check failed:', e.message));
        setInterval(() => runBackupIfNeeded().catch(e => console.warn('[backup]', e.message)), 6 * 60 * 60 * 1000);
    } catch (e) { console.warn('[backup] Could not schedule backup:', e.message); }
});
})(); // end startup async IIFE

// ── Global Express error handler (must be last app.use) ─────────────────────
app.use(async (err, req, res, next) => {
    console.error('[Server Error]', err.message);
    await logError(err, req, 'express-unhandled').catch(() => {});
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'Something went wrong', message: err.message });
});

// ── Unhandled promise rejections ─────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    console.error('[Unhandled Rejection]', err.message);
    logError(err, null, 'unhandledRejection').catch(() => {});
});

// Graceful shutdown — wait for in-flight writes then close MongoDB connection.
process.on('SIGTERM', async () => {
    console.log('[shutdown] SIGTERM received — waiting for write queue then closing MongoDB');
    const killTimer = setTimeout(() => { process.exit(0); }, 10000);
    killTimer.unref();
    try {
        await _writeQueue; // wait for any in-flight cache writes
        const { closeDB } = require('./src/db');
        await closeDB();
        console.log('[shutdown] MongoDB connection closed cleanly');
    } catch (e) {
        console.error('[shutdown] Error during shutdown:', e.message);
    }
    process.exit(0);
});

