'use strict';
const mongoose = require('mongoose');

const ProjectSchema = new mongoose.Schema({
    // ── Identity ─────────────────────────────────────────────────
    id:              { type: String, required: true, unique: true, index: true },
    name:            { type: String, required: true, trim: true },
    description:     { type: String, default: '' },
    color:           { type: String, default: '#3b82f6' },
    status:          { type: String, default: 'active' },

    // ── URLs & descriptions ───────────────────────────────────────
    projectUrl:      { type: String, default: '' },
    taskDescription: { type: String, default: '' },

    // ── Environments (Production + Staging URLs) ──────────────────
    environments: {
        production: [{ _id: false, name: { type: String, default: '' }, url: { type: String, default: '' }, status: { type: String, default: 'unknown' } }],
        staging:    [{ _id: false, name: { type: String, default: '' }, url: { type: String, default: '' }, status: { type: String, default: 'unknown' } }]
    },

    // ── Mobile Apps ───────────────────────────────────────────────
    apps: [{ _id: false, name: { type: String, default: '' }, playStore: { type: String, default: '' }, appStore: { type: String, default: '' } }],

    // ── Servers ───────────────────────────────────────────────────
    servers: [{ _id: false, name: { type: String, default: '' }, url: { type: String, default: '' }, type: { type: String, default: 'web' }, expectedStatus: { type: Number, default: 200 } }],

    // ── Domains & SSL ─────────────────────────────────────────────
    domains:  [{ type: String }],
    sslCerts: [{ type: String }],

    // ── API Endpoints ─────────────────────────────────────────────
    apis: [{ _id: false, name: { type: String, default: '' }, url: { type: String, default: '' }, method: { type: String, default: 'GET' }, headers: { type: mongoose.Schema.Types.Mixed, default: {} }, body: { type: mongoose.Schema.Types.Mixed, default: {} }, expectedStatus: { type: Number, default: 200 }, capture: { type: mongoose.Schema.Types.Mixed, default: {} } }],

    // ── Workflow Documents ────────────────────────────────────────
    workflowDocs: [{ _id: false, name: { type: String, required: true }, size: { type: Number, default: 0 }, url: { type: String, default: '' }, uploadedAt: { type: String, default: '' }, uploadedBy: { type: String, default: '' } }],

    // ── Credentials ───────────────────────────────────────────────
    credentials: [{ _id: false, label: { type: String, default: '' }, username: { type: String, default: '' }, password: { type: String, default: '' }, role: { type: String, default: '' }, notes: { type: String, default: '' } }],

    // ── Smoke Tests ───────────────────────────────────────────────
    smokeTests: [{ _id: false, id: { type: String, default: '' }, module: { type: String, default: '' }, action: { type: String, default: '' }, expected: { type: String, default: '' }, priority: { type: String, default: 'Medium' }, status: { type: String, default: 'NotStarted' }, owner: { type: String, default: '' }, comment: { type: String, default: '' } }],

    // ── Production Checklist ──────────────────────────────────────
    prodChecklist: [{ _id: false, id: { type: String, default: '' }, module: { type: String, default: '' }, action: { type: String, default: '' }, expected: { type: String, default: '' }, priority: { type: String, default: 'Medium' }, status: { type: String, default: 'NotStarted' }, owner: { type: String, default: '' }, comment: { type: String, default: '' } }],

    // ── Pending Tasks ─────────────────────────────────────────────
    pendingTasks: [{ _id: false, title: { type: String, default: '' }, description: { type: String, default: '' }, priority: { type: String, default: 'Medium' }, status: { type: String, default: 'Open' }, assignee: { type: String, default: '' }, dueDate: { type: String, default: '' } }],

    // ── Release Notes ─────────────────────────────────────────────
    releaseNotes: [{ _id: false, version: { type: String, default: '' }, date: { type: String, default: '' }, description: { type: String, default: '' }, author: { type: String, default: '' } }],

    // ── Client Feedback ───────────────────────────────────────────
    clientFeedback: [{ _id: false, type: { type: String, default: 'Request' }, title: { type: String, default: '' }, description: { type: String, default: '' }, status: { type: String, default: 'Open' }, priority: { type: String, default: 'Medium' }, reportedBy: { type: String, default: '' }, createdAt: { type: String, default: '' } }],

    // ── Third Party Integrations ──────────────────────────────────
    thirdParty: [{ _id: false, name: { type: String, default: '' }, url: { type: String, default: '' }, status: { type: String, default: 'unknown' }, notes: { type: String, default: '' } }],

    // ── Swagger / API Docs ────────────────────────────────────────
    swagger: [{ _id: false, name: { type: String, default: '' }, url: { type: String, default: '' } }],

    // ── Task Checklist ────────────────────────────────────────────
    taskChecklist: [{ _id: false, title: { type: String, default: '' }, done: { type: Boolean, default: false }, assignee: { type: String, default: '' }, dueDate: { type: String, default: '' } }]

}, {
    timestamps: true,
    strict: false   // preserves any extra fields not listed above — zero data loss
});

module.exports = mongoose.models.Project || mongoose.model('Project', ProjectSchema);
