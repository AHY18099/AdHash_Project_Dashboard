'use strict';
/**
 * src/db/operations.js — MongoDB CRUD helpers with 30-second in-memory cache.
 * All mutation functions invalidate the cache for their (collection, projectId) pair.
 * All routes should use these helpers instead of calling getDB() directly.
 */

const { connectDB } = require('../db');

// ── In-memory cache (30s TTL, invalidated on every write) ───────────────────
const _cache = new Map();
const CACHE_TTL = 30000;

function _cacheKey(col, projectId) { return `${col}:${projectId}`; }

function invalidateCache(col, projectId) {
    _cache.delete(_cacheKey(col, projectId));
}

function _getCached(col, projectId) {
    const hit = _cache.get(_cacheKey(col, projectId));
    if (hit && (Date.now() - hit.ts) < CACHE_TTL) return hit.data;
    return null;
}

function _setCache(col, projectId, data) {
    _cache.set(_cacheKey(col, projectId), { data, ts: Date.now() });
}

// ── CRUD operations ──────────────────────────────────────────────────────────

async function getAll(col, projectId, opts = {}) {
    const cached = _getCached(col, projectId);
    if (cached) return cached;
    const db = await connectDB();
    const data = await db.collection(col)
        .find({ projectId })
        .sort(opts.sort || { createdAt: 1 })
        .toArray();
    _setCache(col, projectId, data);
    return data;
}

async function getOne(col, id) {
    const db = await connectDB();
    return db.collection(col).findOne({ id });
}

async function createOne(col, projectId, data) {
    const db = await connectDB();
    const { ObjectId } = require('mongodb');
    const doc = {
        ...data,
        id:        data.id || new ObjectId().toString(),
        projectId,
        createdAt: new Date(),
        updatedAt: new Date(),
    };
    try {
        await db.collection(col).insertOne(doc);
    } catch (err) {
        if (err.code === 11000) {
            return db.collection(col).findOne({ id: doc.id });
        }
        throw err;
    }
    invalidateCache(col, projectId);
    return doc;
}

async function updateOne(col, id, updates, projectId) {
    const db = await connectDB();
    const res = await db.collection(col).findOneAndUpdate(
        { id },
        { $set: { ...updates, updatedAt: new Date() } },
        { returnDocument: 'after' }
    );
    const doc = res && (res.value || res);
    if (!doc || !doc.id) throw new Error(`Record not found: ${id} in ${col}`);
    if (projectId) invalidateCache(col, projectId);
    return doc;
}

async function upsertOne(col, projectId, data) {
    const db = await connectDB();
    const { ObjectId } = require('mongodb');
    const id = data.id || new ObjectId().toString();
    await db.collection(col).updateOne(
        { id },
        {
            $set: { ...data, id, projectId, updatedAt: new Date() },
            $setOnInsert: { createdAt: new Date() }
        },
        { upsert: true }
    );
    invalidateCache(col, projectId);
    return db.collection(col).findOne({ id });
}

async function deleteOne(col, id, projectId) {
    const db = await connectDB();
    await db.collection(col).deleteOne({ id });
    if (projectId) invalidateCache(col, projectId);
}

async function bulkUpsert(col, projectId, items) {
    if (!items || !items.length) return;
    const db = await connectDB();
    const { ObjectId } = require('mongodb');
    const ops = items.map(item => {
        const id = item.id || new ObjectId().toString();
        return {
            updateOne: {
                filter: { id },
                update: {
                    $set: { ...item, id, projectId, updatedAt: new Date() },
                    $setOnInsert: { createdAt: new Date() }
                },
                upsert: true
            }
        };
    });
    await db.collection(col).bulkWrite(ops, { ordered: false });
    invalidateCache(col, projectId);
}

module.exports = {
    getAll, getOne, createOne, updateOne,
    upsertOne, deleteOne, bulkUpsert, invalidateCache,
};
