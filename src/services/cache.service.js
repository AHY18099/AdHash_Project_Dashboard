'use strict';
/**
 * src/services/cache.service.js — Lightweight in-memory cache with TTL.
 * All mutation operations (createOne, updateOne, deleteOne, bulkUpsert)
 * must call invalidate() after writing to MongoDB so reads stay fresh.
 */

const { CACHE_TTL } = require('../config');
const _store = new Map();

function get(key) {
    const entry = _store.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL) { _store.delete(key); return null; }
    return entry.data;
}

function set(key, data) {
    _store.set(key, { data, ts: Date.now() });
}

function invalidate(key) {
    _store.delete(key);
}

function invalidatePattern(prefix) {
    for (const key of _store.keys()) {
        if (key.startsWith(prefix)) _store.delete(key);
    }
}

function clear() { _store.clear(); }

function stats() {
    return { size: _store.size, keys: Array.from(_store.keys()), ttlMs: CACHE_TTL };
}

module.exports = { get, set, invalidate, invalidatePattern, clear, stats };
