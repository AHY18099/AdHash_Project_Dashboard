'use strict';
const mongoose = require('mongoose');

const ProjectSchema = new mongoose.Schema({
    id:              { type: String, required: true, unique: true, index: true },
    name:            { type: String, required: true, trim: true },
    description:     { type: String, default: '' },
    color:           { type: String, default: '#3b82f6' },
    projectUrl:      { type: String, default: '' },
    taskDescription: { type: String, default: '' },
    status:          { type: String, default: 'active' },
    apps: [{
        _id: false,
        name:      { type: String, default: '' },
        playStore: { type: String, default: '' },
        appStore:  { type: String, default: '' }
    }],
    servers: [{
        _id: false,
        name:           { type: String, default: '' },
        url:            { type: String, default: '' },
        type:           { type: String, default: 'web' },
        expectedStatus: { type: Number, default: 200 }
    }],
    domains:  [{ type: String }],
    sslCerts: [{ type: String }],
    apis: [{
        _id: false,
        name:           { type: String, default: '' },
        url:            { type: String, default: '' },
        method:         { type: String, default: 'GET' },
        headers:        { type: mongoose.Schema.Types.Mixed, default: {} },
        body:           { type: mongoose.Schema.Types.Mixed, default: {} },
        expectedStatus: { type: Number, default: 200 },
        capture:        { type: mongoose.Schema.Types.Mixed, default: {} }
    }]
}, {
    timestamps: true,
    strict: false  // preserves any extra fields already in DB — zero data loss
});

module.exports = mongoose.models.Project || mongoose.model('Project', ProjectSchema);
