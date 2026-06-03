'use strict';
const mongoose = require('mongoose');

const QAStateSchema = new mongoose.Schema({
    caseId:  { type: String, required: true, unique: true, index: true },
    status:  { type: String, enum: ['Pass','Fail','Blocked','NotStarted','InProgress'], default: 'NotStarted' },
    owner:   { type: String, default: '' },
    comment: { type: String, default: '' },
    product: { type: String, default: '' },
    suite:   { type: String, default: '' },
    runId:   { type: String, default: '' },
    tags:    [{ type: String }]
}, {
    timestamps: true,
    strict: false
});

module.exports = mongoose.models.QAState || mongoose.model('QAState', QAStateSchema);
