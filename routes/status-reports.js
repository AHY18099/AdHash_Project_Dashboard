'use strict';

const express = require('express');
const router  = express.Router();
const {
    createStatusReport, listStatusReports, getStatusReport,
    deleteStatusReport, getStatusReportSummary,
} = require('../src/db');

// ── API-key auth for GitHub Action POST ──────────────────────────────────────
function requireApiKey(req, res, next) {
    const key = process.env.STATUS_REPORT_API_KEY;
    if (!key) {
        // No key configured — fall through to JWT auth (requireAuth in server.js handles it)
        return next();
    }
    const provided = req.headers['x-api-key'];
    if (provided && provided === key) return next();
    // Fall through — JWT auth middleware already ran before this route, so if we
    // reach here without a matching API key the request is from a logged-in user.
    return next();
}

// POST /api/status-reports — GitHub Action saves a new report (x-api-key auth)
// This route bypasses the normal JWT guard via PUBLIC_API_ROUTES in server.js
// and uses x-api-key header validation instead.
router.post('/', async (req, res) => {
    const key = process.env.STATUS_REPORT_API_KEY;
    const provided = req.headers['x-api-key'];
    if (key && provided !== key) {
        return res.status(401).json({ success: false, error: 'Invalid API key' });
    }
    if (!key && !provided) {
        // No key configured at all — allow (dev/testing mode)
    }

    try {
        const {
            title, runType, overallStatus, reportDateTime,
            totalProjects, passedCount, failedCount, warningCount, skippedCount,
            duration, htmlContent, source,
        } = req.body || {};

        if (!htmlContent || typeof htmlContent !== 'string') {
            return res.status(400).json({ success: false, error: 'htmlContent is required and must be a string' });
        }

        const report = await createStatusReport({
            title, runType, overallStatus, reportDateTime,
            totalProjects, passedCount, failedCount, warningCount, skippedCount,
            duration, htmlContent, source,
        });

        console.log(`[status-reports] Saved report: ${report.id} status=${report.overallStatus} runType=${report.runType}`);
        return res.status(201).json({ success: true, report });
    } catch (e) {
        console.error('[status-reports] POST error:', e.message);
        return res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/status-reports — list reports with filters (JWT auth via server.js middleware)
router.get('/', async (req, res) => {
    try {
        const { page = 1, limit = 20, status, runType, fromDate, toDate, search } = req.query;
        const result = await listStatusReports({
            page: parseInt(page, 10),
            limit: Math.min(parseInt(limit, 10) || 20, 100),
            status, runType, fromDate, toDate, search,
        });
        return res.json({ success: true, ...result });
    } catch (e) {
        console.error('[status-reports] GET list error:', e.message);
        return res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/status-reports/summary — aggregate summary stats
router.get('/summary', async (req, res) => {
    try {
        const summary = await getStatusReportSummary();
        return res.json({ success: true, ...summary });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/status-reports/:id — full report including htmlContent
router.get('/:id', async (req, res) => {
    try {
        const report = await getStatusReport(req.params.id);
        if (!report) return res.status(404).json({ success: false, error: 'Report not found' });
        return res.json({ success: true, report });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/status-reports/:id/download — download as .html file
router.get('/:id/download', async (req, res) => {
    try {
        const report = await getStatusReport(req.params.id);
        if (!report) return res.status(404).json({ success: false, error: 'Report not found' });

        const dt   = new Date(report.reportDateTime || report.createdAt);
        const pad  = n => String(n).padStart(2, '0');
        const name = `adhash-project-status-report-${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}-${pad(dt.getHours())}-${pad(dt.getMinutes())}.html`;

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
        res.setHeader('Cache-Control', 'no-cache');
        return res.send(report.htmlContent || '');
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/status-reports/:id/view — render HTML report inline in browser (no login required)
router.get('/:id/view', async (req, res) => {
    try {
        const report = await getStatusReport(req.params.id);
        if (!report) return res.status(404).send('<h2>Report not found</h2>');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Disposition', 'inline');
        res.setHeader('Cache-Control', 'no-cache');
        return res.send(report.htmlContent || '<p>No content</p>');
    } catch (e) {
        return res.status(500).send('<h2>Error loading report</h2><p>' + e.message + '</p>');
    }
});

// DELETE /api/status-reports/:id — admin only (checked by server.js requireAdmin middleware)
router.delete('/:id', async (req, res) => {
    try {
        const deleted = await deleteStatusReport(req.params.id);
        if (!deleted) return res.status(404).json({ success: false, error: 'Report not found' });
        return res.json({ success: true });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;
