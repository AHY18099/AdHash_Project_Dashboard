'use strict';
/**
 * src/services/db.service.js — MongoDB CRUD helpers with cache integration.
 * All routes should prefer these helpers over calling connectDB() directly.
 * Every mutation invalidates the cache for (collection, projectId).
 */

const { connectDB } = require('../db');
const cache = require('./cache.service');

function _key(col, projectId) { return `${col}:${projectId}`; }

async function getAll(col, projectId, opts) {
    const k   = _key(col, projectId);
    const hit = cache.get(k);
    if (hit) return hit;
    const db   = await connectDB();
    const data = await db.collection(col)
        .find({ projectId })
        .sort((opts && opts.sort) || { createdAt: 1 })
        .toArray();
    cache.set(k, data);
    return data;
}

async function getOne(col, query) {
    const db = await connectDB();
    return db.collection(col).findOne(query);
}

async function createOne(col, projectId, data, createdBy) {
    const db = await connectDB();
    const { ObjectId } = require('mongodb');
    const doc = {
        ...data,
        id:        data.id || new ObjectId().toString(),
        projectId,
        createdBy: createdBy || 'system',
        createdAt: new Date(),
        updatedAt: new Date(),
    };
    try {
        await db.collection(col).insertOne(doc);
    } catch (err) {
        if (err.code === 11000) return db.collection(col).findOne({ id: doc.id });
        throw err;
    }
    cache.invalidate(_key(col, projectId));
    return doc;
}

async function updateOne(col, id, updates, projectId, updatedBy) {
    const db  = await connectDB();
    const res = await db.collection(col).findOneAndUpdate(
        { id },
        { $set: { ...updates, updatedAt: new Date(), updatedBy: updatedBy || 'system' } },
        { returnDocument: 'after' }
    );
    const doc = res && (res.value || res);
    if (!doc || !doc.id) throw new Error(`Record not found: ${id} in ${col}`);
    if (projectId) cache.invalidate(_key(col, projectId));
    return doc;
}

async function upsertOne(col, projectId, data, by) {
    const db = await connectDB();
    const { ObjectId } = require('mongodb');
    const id  = data.id || new ObjectId().toString();
    const now = new Date();
    await db.collection(col).updateOne(
        { id },
        {
            $set:         { ...data, id, projectId, updatedAt: now, updatedBy: by || 'system' },
            $setOnInsert: { createdAt: now, createdBy: by || 'system' }
        },
        { upsert: true }
    );
    cache.invalidate(_key(col, projectId));
    return db.collection(col).findOne({ id });
}

async function deleteOne(col, id, projectId) {
    const db = await connectDB();
    await db.collection(col).deleteOne({ id });
    if (projectId) cache.invalidate(_key(col, projectId));
}

async function bulkUpsert(col, projectId, items, by) {
    if (!items || !items.length) return;
    const db = await connectDB();
    const { ObjectId } = require('mongodb');
    const now = new Date();
    const ops = items.map(item => {
        const id = item.id || new ObjectId().toString();
        return {
            updateOne: {
                filter: { id },
                update: {
                    $set:         { ...item, id, projectId, updatedAt: now, updatedBy: by || 'system' },
                    $setOnInsert: { createdAt: now, createdBy: by || 'system' }
                },
                upsert: true
            }
        };
    });
    await db.collection(col).bulkWrite(ops, { ordered: false });
    cache.invalidate(_key(col, projectId));
}

module.exports = { getAll, getOne, createOne, updateOne, upsertOne, deleteOne, bulkUpsert };
