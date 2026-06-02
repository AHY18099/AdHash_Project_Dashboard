'use strict';
/**
 * src/services/broadcast.service.js — SSE client registry and broadcast.
 * Single source of truth for all connected SSE clients.
 * server.js's _sseClients is the live map; this module wraps it so
 * future routes can import broadcast() without importing server internals.
 *
 * NOTE: server.js passes its _sseClients map in via init() at startup
 * so both the legacy /api/events handler and any new routes share one map.
 */

let _clients = null; // set by init()

function init(sseClientsMap) {
    _clients = sseClientsMap;
}

function broadcast(eventName, data, sourceClientId) {
    if (!_clients || !_clients.size) return;
    const payload = JSON.stringify({ ...data, sourceClientId: sourceClientId || null });
    const message = `event: ${eventName}\ndata: ${payload}\n\n`;
    const dead = [];
    for (const [id, client] of _clients) {
        try { client.res.write(message); }
        catch (_) { dead.push(id); }
    }
    dead.forEach(id => _clients.delete(id));
}

function getActiveUsers() {
    if (!_clients) return [];
    const seen = new Set();
    return Array.from(_clients.values())
        .filter(c => { if (seen.has(c.userId)) return false; seen.add(c.userId); return true; })
        .map(c => ({ userId: c.userId, userName: c.userName, connectedAt: c.connectedAt }));
}

function getConnectionCount() {
    return _clients ? _clients.size : 0;
}

module.exports = { init, broadcast, getActiveUsers, getConnectionCount };
