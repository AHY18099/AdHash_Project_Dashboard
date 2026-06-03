'use strict';
const express           = require('express');
const router            = express.Router();
const fs                = require('fs');
const path              = require('path');
const Project           = require('../db/models/Project');
const { requireAuth }   = require('../middleware/auth');
const { ensureConnected } = require('../db/connection');
const { flattenUpdates }  = require('../utils/flatten-updates');

const ALLOWED_ARRAYS = [
    'workflowDocs','credentials','smokeTests','prodChecklist',
    'pendingTasks','releaseNotes','clientFeedback','thirdParty',
    'swagger','taskChecklist','apps','servers','apis','domains','sslCerts'
];

// ── GET all projects ──────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
    try {
        const projects = await Project.find({}).lean();
        return res.json(projects);
    } catch (err) {
        console.error('[Projects] GET / DB error:', err.message);
        try {
            const raw = fs.readFileSync(path.join(__dirname, '..', 'config', 'project-mapping.json'), 'utf8');
            const d = JSON.parse(raw);
            return res.json(Array.isArray(d) ? d : (d.projects || []));
        } catch {
            return res.status(500).json({ error: 'Failed to load projects' });
        }
    }
});

// ── GET single project ────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
    try {
        const doc = await Project.findOne({ id: req.params.id }).lean();
        if (!doc) return res.status(404).json({ error: 'Project not found' });
        return res.json(doc);
    } catch (err) {
        console.error('[Projects] GET /:id error:', err.message);
        return res.status(500).json({ error: 'Failed to load project' });
    }
});

// ── POST — create new project ─────────────────────────────────
router.post('/', requireAuth, ensureConnected, async (req, res) => {
    try {
        const b = req.body || {};
        if (!String(b.name || '').trim()) return res.status(400).json({ error: 'Project name is required' });
        const doc = new Project({
            id:              b.id              || `proj_${Date.now()}`,
            name:            String(b.name).trim(),
            description:     b.description     || '',
            color:           b.color           || '#3b82f6',
            projectUrl:      b.projectUrl      || '',
            taskDescription: b.taskDescription || '',
            status:          b.status          || 'active',
            environments:    b.environments    || { production: [], staging: [] },
            apps:            b.apps            || [],
            servers:         b.servers         || [],
            domains:         b.domains         || [],
            sslCerts:        b.sslCerts        || [],
            apis:            b.apis            || [],
            workflowDocs:    b.workflowDocs    || [],
            credentials:     b.credentials     || [],
            smokeTests:      b.smokeTests      || [],
            prodChecklist:   b.prodChecklist   || [],
            pendingTasks:    b.pendingTasks     || [],
            releaseNotes:    b.releaseNotes     || [],
            clientFeedback:  b.clientFeedback  || [],
            thirdParty:      b.thirdParty       || [],
            swagger:         b.swagger          || [],
            taskChecklist:   b.taskChecklist    || [],
        });
        const saved = await doc.save();
        return res.status(201).json({ success: true, project: saved.toObject() });
    } catch (err) {
        if (err.code === 11000) return res.status(409).json({ error: 'A project with this ID already exists' });
        console.error('[Projects] POST / error:', err.message);
        return res.status(500).json({ error: 'Failed to create project' });
    }
});

// ── PUT — field-level update, ZERO data loss ──────────────────
// Uses flattenUpdates to convert nested objects to dot-notation,
// so $set only touches the exact paths sent — siblings never wiped.
router.put('/:id', requireAuth, ensureConnected, async (req, res) => {
    try {
        const updates = { ...req.body };
        ['_id', 'id', 'createdAt', '__v'].forEach(k => delete updates[k]);
        const setPayload = flattenUpdates(updates);
        const saved = await Project.findOneAndUpdate(
            { id: req.params.id },
            { $set: setPayload },
            { new: true, runValidators: false, lean: true }
        );
        if (!saved) return res.status(404).json({ error: 'Project not found' });
        return res.json({ success: true, project: saved });
    } catch (err) {
        console.error('[Projects] PUT /:id error:', err.message);
        return res.status(500).json({ error: 'Failed to update project' });
    }
});

// ── PATCH /:id/:arrayField — atomically add one item to any array ──
router.patch('/:id/:arrayField', requireAuth, ensureConnected, async (req, res) => {
    const { id, arrayField } = req.params;
    if (!ALLOWED_ARRAYS.includes(arrayField)) {
        return res.status(400).json({ error: `Unknown array field: ${arrayField}` });
    }
    try {
        const newItem  = req.body;
        const existing = await Project.findOne({ id }).lean();
        if (!existing) return res.status(404).json({ error: 'Project not found' });
        const arr = existing[arrayField] || [];
        if (_isDup(arrayField, arr, newItem)) {
            return res.status(409).json({ error: `Duplicate entry in ${arrayField}` });
        }
        const saved = await Project.findOneAndUpdate(
            { id },
            { $push: { [arrayField]: newItem } },
            { new: true, lean: true }
        );
        return res.json({ success: true, project: saved });
    } catch (err) {
        console.error(`[Projects] PATCH /:id/${arrayField} error:`, err.message);
        return res.status(500).json({ error: `Failed to add to ${arrayField}` });
    }
});

// ── DELETE /:id/:arrayField/:itemIndex — remove one array item ──
router.delete('/:id/:arrayField/:itemIndex', requireAuth, ensureConnected, async (req, res) => {
    const { id, arrayField, itemIndex } = req.params;
    const idx = parseInt(itemIndex, 10);
    if (!ALLOWED_ARRAYS.includes(arrayField)) {
        return res.status(400).json({ error: `Unknown array field: ${arrayField}` });
    }
    try {
        const existing = await Project.findOne({ id }).lean();
        if (!existing) return res.status(404).json({ error: 'Project not found' });
        const arr = [...(existing[arrayField] || [])];
        if (idx < 0 || idx >= arr.length) return res.status(400).json({ error: 'Index out of range' });
        arr.splice(idx, 1);
        const saved = await Project.findOneAndUpdate(
            { id },
            { $set: { [arrayField]: arr } },
            { new: true, lean: true }
        );
        return res.json({ success: true, project: saved });
    } catch (err) {
        console.error('[Projects] DELETE array item error:', err.message);
        return res.status(500).json({ error: 'Failed to remove item' });
    }
});

// ── GET backup history for a project ─────────────────────────
router.get('/:id/backups', requireAuth, async (req, res) => {
    try {
        const mongoose = require('mongoose');
        const PB = mongoose.models.ProjectBackup;
        if (!PB) return res.json({ backups: [] });
        const backups = await PB.find({ projectId: req.params.id }, { snapshot: 0 }).sort({ createdAt: -1 }).limit(20).lean();
        return res.json({ backups });
    } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ── POST restore project from backup ──────────────────────────
router.post('/:id/restore/:backupId', requireAuth, ensureConnected, async (req, res) => {
    try {
        const mongoose = require('mongoose');
        const PB = mongoose.models.ProjectBackup;
        if (!PB) return res.status(503).json({ error: 'Backup service unavailable' });
        const backup = await PB.findById(req.params.backupId).lean();
        if (!backup || backup.projectId !== req.params.id) return res.status(404).json({ error: 'Backup not found' });
        const { _id, __v, createdAt, updatedAt, ...snapshot } = backup.snapshot;
        await Project.findOneAndUpdate({ id: req.params.id }, { $set: snapshot }, { new: true });
        return res.json({ success: true, message: `Restored from backup: ${backup.reason}` });
    } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ── DELETE project ────────────────────────────────────────────
router.delete('/:id', requireAuth, ensureConnected, async (req, res) => {
    try {
        const deleted = await Project.findOneAndDelete({ id: req.params.id });
        if (!deleted) return res.status(404).json({ error: 'Project not found' });
        return res.json({ success: true, deletedId: req.params.id });
    } catch (err) {
        console.error('[Projects] DELETE /:id error:', err.message);
        return res.status(500).json({ error: 'Failed to delete project' });
    }
});

// ── Dedup helper ──────────────────────────────────────────────
function _isDup(field, arr, newItem) {
    if (field === 'workflowDocs') return arr.some(d => d.name === newItem.name && (d.size || 0) === (newItem.size || 0));
    if (['servers', 'apis'].includes(field)) return arr.some(d => d.url && d.url === newItem.url);
    if (field === 'credentials') return arr.some(d => d.username === newItem.username && d.role === newItem.role);
    return false;
}

module.exports = router;
