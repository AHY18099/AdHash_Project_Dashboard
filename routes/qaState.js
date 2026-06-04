'use strict';
const express        = require('express');
const router         = express.Router();
const QAState        = require('../db/models/QAState');
const { requireAuth } = require('../middleware/auth');
const { ensureConnected } = require('../db/connection');

// GET all saved test case states (optional ?product= ?suite= filters)
// Returns empty state gracefully if mongoose isn't connected yet (non-fatal).
router.get('/', requireAuth, async (req, res) => {
    try {
        const filter = {};
        if (req.query.product) filter.product = req.query.product;
        if (req.query.suite)   filter.suite   = req.query.suite;
        const all = await QAState.find(filter).lean();
        const testCases = {};
        all.forEach(tc => { testCases[tc.caseId] = tc; });
        return res.json({ testCases, total: all.length, lastUpdated: all.length ? all[all.length - 1].updatedAt : null });
    } catch (err) {
        console.error('[QAState] GET / error:', err.message);
        // Return empty state instead of 500 — dashboard loads fine, just no saved states
        if (err.message && (err.message.includes('not connected') || err.message.includes('buffering timed out') || err.message.includes('connection') || err.name === 'MongoNotConnectedError')) {
            return res.json({ testCases: {}, total: 0, lastUpdated: null });
        }
        return res.status(500).json({ error: 'Failed to load QA state' });
    }
});

// GET summary stats by product/status
router.get('/summary', requireAuth, async (req, res) => {
    try {
        const results = await QAState.aggregate([
            { $group: { _id: { product: '$product', status: '$status' }, count: { $sum: 1 } } },
            { $sort: { '_id.product': 1 } }
        ]);
        return res.json({ summary: results });
    } catch (err) {
        console.error('[QAState] GET /summary error:', err.message);
        return res.json({ summary: [] });
    }
});

// PATCH single test case (upsert — creates if not exists)
router.patch('/:caseId', requireAuth, ensureConnected, async (req, res) => {
    try {
        const updates = { ...req.body };
        delete updates._id; delete updates.caseId; delete updates.createdAt;
        const result = await QAState.findOneAndUpdate(
            { caseId: req.params.caseId },
            { $set: updates },
            { new: true, upsert: true, runValidators: false, lean: true }
        );
        return res.json({ success: true, caseId: req.params.caseId, data: result });
    } catch (err) {
        console.error('[QAState] PATCH /:caseId error:', err.message);
        return res.status(500).json({ error: 'Failed to save QA state' });
    }
});

// POST /bulk — save many test cases in one request
router.post('/bulk', requireAuth, ensureConnected, async (req, res) => {
    try {
        const updates = req.body.testCases || {};
        const entries = Object.entries(updates);
        if (!entries.length) return res.json({ success: true, updated: 0 });
        const ops = entries.map(([caseId, fields]) => {
            const { _id, createdAt, ...rest } = fields;
            return { updateOne: { filter: { caseId }, update: { $set: rest }, upsert: true } };
        });
        const result = await QAState.bulkWrite(ops, { ordered: false });
        return res.json({ success: true, updated: result.modifiedCount + result.upsertedCount });
    } catch (err) {
        console.error('[QAState] POST /bulk error:', err.message);
        return res.status(500).json({ error: 'Failed to bulk save QA state' });
    }
});

// DELETE single test case state
router.delete('/:caseId', requireAuth, async (req, res) => {
    try {
        await QAState.findOneAndDelete({ caseId: req.params.caseId });
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to delete QA state' });
    }
});

// DELETE all for a product/suite scope (reset run)
router.delete('/', requireAuth, async (req, res) => {
    try {
        const filter = {};
        if (req.query.product) filter.product = req.query.product;
        if (req.query.suite)   filter.suite   = req.query.suite;
        if (!Object.keys(filter).length) return res.status(400).json({ error: 'Provide ?product= or ?suite= to scope the reset' });
        const result = await QAState.deleteMany(filter);
        return res.json({ success: true, deleted: result.deletedCount });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to reset QA state' });
    }
});

module.exports = router;
