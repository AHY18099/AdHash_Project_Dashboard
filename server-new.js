const express = require('express');
const { exec } = require('child_process');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = 7777;

// Parse JSON bodies
app.use(express.json());

// Project-wise server organization
const projects = {
    'AutoChecker': {
        name: 'AutoChecker',
        icon: '🚗',
        servers: [
            { name: 'Auto Search', url: 'http://20.7.146.191:3000/' },
            { name: 'Manual Search', url: 'http://20.15.121.70:3000/' },
            { name: 'PartSouq', url: 'http://20.62.109.239:3000/' },
            { name: 'Admin', url: 'https://manage.autochecker.com/' },
            { name: 'Admin API', url: 'https://manageadminapi.autochecker.com/' },
            { name: 'Mobile API', url: 'https://managemobileapi.autochecker.com/' },
            { name: 'eBay API', url: 'https://ebaydev.autochecker.com/' }
        ]
    },
    'WavedIn': {
        name: 'WavedIn',
        icon: '🌊',
        servers: [
            { name: 'Mobile API', url: 'https://mobileliveapi.wavedin.app/' },
            { name: 'Super Admin', url: 'https://superadmin.wavedin.app/' }
        ]
    },
    'Zapai': {
        name: 'Zapai/ZapCRM',
        icon: '⚡',
        servers: [
            { name: 'Zapai Web', url: 'https://www.zapai.us/' },
            { name: 'ZapCRM Admin', url: 'https://zapcrm.io/' },
            { name: 'ZapCRM Lead', url: 'https://lead.zapcrm.io/' },
            { name: 'ZapCRM API', url: 'https://api.zapcrm.io/' }
        ]
    },
    'Algomax': {
        name: 'Algomax',
        icon: '📊',
        servers: [
            { name: 'GoPocket', url: 'https://gopocket.algomax.co/' }
        ]
    },
    'SMC': {
        name: 'SMC',
        icon: '🎬',
        servers: [
            { name: 'API', url: 'https://api.sendmovieclips.com/' }
        ]
    },
    'Metcalf': {
        name: 'Metcalf',
        icon: '🤖',
        servers: [
            { name: 'Web', url: 'https://metcalf.ai/' }
        ]
    },
    'AdHash': {
        name: 'AdHash',
        icon: '🚀',
        servers: [
            { name: 'Web', url: 'https://adhashtech.com/' }
        ]
    },
    'Humee': {
        name: 'Humee',
        icon: '💼',
        servers: [
            { name: 'Admin', url: 'https://humee.com/' },
            { name: 'API', url: 'https://api.humee.com/' }
        ]
    },
    'AiSignPro': {
        name: 'AiSignPro',
        icon: '✍️',
        servers: [
            { name: 'Admin', url: 'https://admin.aisignpro.com/' },
            { name: 'API', url: 'https://api.aisignpro.com/' }
        ]
    },
    'Synctag': {
        name: 'Synctag',
        icon: '🔗',
        servers: [
            { name: 'API', url: 'https://spark.synctag.com/' }
        ]
    }
};

// Flatten servers for backward compatibility
const servers = Object.values(projects).flatMap(project => 
    project.servers.map(server => ({
        ...server,
        name: `${project.name} - ${server.name}`,
        project: project.name
    }))
);

// Store SSE clients
let clients = [];

// Serve static files
app.use(express.static('public'));

// SSE endpoint for test progress
app.get('/api/test-progress', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Add client to list
    clients.push(res);

    // Remove client on disconnect
    req.on('close', () => {
        clients = clients.filter(client => client !== res);
    });
});

// Send event to all clients
function sendToClients(event, data) {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    clients.forEach(client => {
        try {
            client.write(message);
        } catch (error) {
            console.error('Error sending to client:', error);
        }
    });
}

// Test suite types
const testSuiteTypes = {
    appStatus: {
        id: 'app-status',
        name: 'App Status',
        description: 'Play Store & App Store verification',
        icon: '📱',
        command: 'npx playwright test tests/app-status/playstore.spec.ts',
        parseResults: () => ({ stats: {}, details: [], status: 'success' })
    },
    serverHealth: {
        id: 'server-health',
        name: 'Server Health',
        description: 'Production server health checks',
        icon: '🖥️',
        command: 'direct-check',
        parseResults: () => ({ stats: {}, details: [], status: 'success' })
    }
};

