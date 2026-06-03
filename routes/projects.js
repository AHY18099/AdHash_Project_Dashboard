'use strict';
const express        = require('express');
const router         = express.Router();
const fs             = require('fs');
const path           = require('path');
const Project        = require('../db/models/Project');
const { requireAuth } = require('../middleware/auth');

// GET all projects
router.get('/', requireAuth, async (req, res) => {
    try {
        const projects = await Project.find({}).lean();
        return res.json(projects);
    } catch (err) {
        console.error('[Projects] GET / error:', err.message);
        // Graceful fallback to JSON file — dashboard never shows blank
        try {
            const raw  = fs.readFileSync(path.join(__dirname, '..', 'config', 'project-mapping.json'), 'utf8');
            const data = JSON.parse(raw);
            return res.json(Array.isArray(data) ? data : (data.projects || []));
        } catch {
            return res.status(500).json({ error: 'Failed to load projects' });
        }
    }
});

// GET single project by id
router.get('/:id', requireAuth, async (req, res) => {
    try {
        const project = await Project.findOne({ id: req.params.id }).lean();
        if (!project) return res.status(404).json({ error: 'Project not found' });
        return res.json(project);
    } catch (err) {
        console.error('[Projects] GET /:id error:', err.message);
        return res.status(500).json({ error: 'Failed to load project' });
    }
});

// POST — create new project
router.post('/', requireAuth, async (req, res) => {
    try {
        const b = req.body || {};
        if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'Project name is required' });
        const doc = new Project({
            id:              b.id || `proj_${Date.now()}`,
            name:            String(b.name).trim(),
            description:     b.description     || '',
            color:           b.color           || '#3b82f6',
            projectUrl:      b.projectUrl      || '',
            taskDescription: b.taskDescription || '',
            status:          b.status          || 'active',
            apps:     Array.isArray(b.apps)     ? b.apps     : [],
            servers:  Array.isArray(b.servers)  ? b.servers  : [],
            domains:  Array.isArray(b.domains)  ? b.domains  : [],
            sslCerts: Array.isArray(b.sslCerts) ? b.sslCerts : [],
            apis:     Array.isArray(b.apis)     ? b.apis     : [],
        });
        const saved = await doc.save();
        return res.status(201).json({ success: true, project: saved.toObject() });
    } catch (err) {
        if (err.code === 11000) return res.status(409).json({ error: 'A project with this ID already exists' });
        console.error('[Projects] POST / error:', err.message);
        return res.status(500).json({ error: 'Failed to create project' });
    }
});

// PUT — update project (field-level $set — zero data loss)
router.put('/:id', requireAuth, async (req, res) => {
    try {
        const updates = { ...req.body };
        // Never overwrite immutable fields
        delete updates._id; delete updates.id; delete updates.createdAt; delete updates.__v;
        const updated = await Project.findOneAndUpdate(
            { id: req.params.id },
            { $set: updates },
            { new: true, runValidators: false, lean: true }
        );
        if (!updated) return res.status(404).json({ error: 'Project not found' });
        return res.json({ success: true, project: updated });
    } catch (err) {
        console.error('[Projects] PUT /:id error:', err.message);
        return res.status(500).json({ error: 'Failed to update project' });
    }
});

// DELETE
router.delete('/:id', requireAuth, async (req, res) => {
    try {
        const deleted = await Project.findOneAndDelete({ id: req.params.id });
        if (!deleted) return res.status(404).json({ error: 'Project not found' });
        return res.json({ success: true, deletedId: req.params.id });
    } catch (err) {
        console.error('[Projects] DELETE /:id error:', err.message);
        return res.status(500).json({ error: 'Failed to delete project' });
    }
});

module.exports = router;
