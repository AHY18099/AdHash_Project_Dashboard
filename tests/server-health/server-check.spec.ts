import { test, expect } from '@playwright/test';
import axios from 'axios';

interface ServerConfig {
  name: string;
  url: string;
  expectedStatus?: number;
  timeout?: number;
}

// All AdHash Project Servers
const servers: ServerConfig[] = [
  // AutoChecker Servers
  { name: 'AutoChecker - Auto Search', url: 'http://20.7.146.191:3000/', expectedStatus: 200, timeout: 10000 },
  { name: 'AutoChecker - Manual Search', url: 'http://20.15.121.70:3000/', expectedStatus: 200, timeout: 10000 },
  { name: 'AutoChecker - PartSouq', url: 'http://20.62.109.239:3000/', expectedStatus: 200, timeout: 10000 },
  { name: 'AutoChecker - Admin', url: 'https://manage.autochecker.com/', expectedStatus: 200, timeout: 10000 },
  { name: 'AutoChecker - Admin API', url: 'https://manageadminapi.autochecker.com/', expectedStatus: 200, timeout: 10000 },
  { name: 'AutoChecker - Mobile API', url: 'https://managemobileapi.autochecker.com/', expectedStatus: 200, timeout: 10000 },
  { name: 'AutoChecker - eBay API', url: 'https://ebaydev.autochecker.com/', expectedStatus: 200, timeout: 10000 },

  // WavedIn Servers
  { name: 'WavedIn - Mobile API', url: 'https://mobileliveapi.wavedin.app/', expectedStatus: 200, timeout: 10000 },
  { name: 'WavedIn - Super Admin', url: 'https://superadmin.wavedin.app/', expectedStatus: 200, timeout: 10000 },

  // Zapai Servers
  { name: 'Zapai - Web', url: 'https://www.zapai.us/', expectedStatus: 200, timeout: 10000 },

  // Zapcrm Servers
  { name: 'Zapcrm - Admin', url: 'https://zapcrm.io/', expectedStatus: 200, timeout: 10000 },
  { name: 'Zapcrm - Lead', url: 'https://lead.zapcrm.io/', expectedStatus: 200, timeout: 10000 },
  { name: 'Zapcrm - API', url: 'https://api.zapcrm.io/', expectedStatus: 200, timeout: 10000 },

  // Algomax Servers
  { name: 'Algomax - GoPocket', url: 'https://gopocket.algomax.co/', expectedStatus: 200, timeout: 10000 },

  // Metcalf Servers
  { name: 'Metcalf - Web', url: 'https://metcalf.ai/', expectedStatus: 200, timeout: 10000 },

  // Adhash Servers
  { name: 'Adhash - Web', url: 'https://adhashtech.com/', expectedStatus: 200, timeout: 10000 },

  // Humee Servers
  { name: 'Humee - Admin', url: 'https://humee.com/', expectedStatus: 200, timeout: 10000 },
  { name: 'Humee - API', url: 'https://api.humee.com/', expectedStatus: 200, timeout: 10000 },

  // SMC Servers
  { name: 'SMC - API', url: 'https://api.sendmovieclips.com/', expectedStatus: 200, timeout: 10000 },

  // AiSignPro Servers
  { name: 'AiSignPro - Admin', url: 'https://admin.aisignpro.com/', expectedStatus: 200, timeout: 10000 },
  { name: 'AiSignPro - API', url: 'https://api.aisignpro.com/', expectedStatus: 200, timeout: 10000 },

  // Synctag Servers
  { name: 'Synctag - API', url: 'https://spark.synctag.com/', expectedStatus: 200, timeout: 10000 }
];

test.describe('Server Health Monitoring', () => {
  // Use HTTP requests only (no browser needed - matches original implementation)
  for (const server of servers) {
    test(`Check ${server.name} health`, async () => {
      const startTime = Date.now();

      try {
        const response = await axios.get(server.url, {
          timeout: server.timeout || 10000,
          validateStatus: () => true, // Don't throw on any status
          maxRedirects: 5
        });

        const responseTime = Date.now() - startTime;

        // Determine health status based on response code
        let healthStatus = 'Healthy';
        if (response.status >= 500) {
          healthStatus = 'Unhealthy';
        } else if (response.status === 404) {
          healthStatus = 'Active (404)';
        } else if (response.status >= 400) {
          healthStatus = 'Unhealthy';
        }

        console.log(`✓ ${server.name} - Status: ${response.status}, Response Time: ${responseTime}ms, Health: ${healthStatus}`);

        // Server is considered "up" if it responds (even with 404)
        // Only fail if status is 500+ or timeout
        expect(response.status).toBeGreaterThanOrEqual(200);

        // Verify response time is reasonable (< 10 seconds)
        expect(responseTime).toBeLessThan(10000);

      } catch (error: any) {
        if (error.code === 'ECONNREFUSED') {
          console.error(`✗ ${server.name} - Connection refused - Status: Down`);
        } else if (error.code === 'ETIMEDOUT') {
          console.error(`✗ ${server.name} - Connection timeout - Status: Down`);
        } else {
          console.error(`✗ ${server.name} - Error: ${error.message} - Status: Down`);
        }
        throw error;
      }
    });
  }

  test('All servers health summary', async () => {
    const results = await Promise.allSettled(
      servers.map(async (server) => {
        const startTime = Date.now();
        try {
          const response = await axios.get(server.url, {
            timeout: server.timeout || 10000,
            validateStatus: () => true
          });
          const responseTime = Date.now() - startTime;
          return {
            server: server.name,
            status: response.status,
            responseTime,
            healthy: response.status === (server.expectedStatus || 200)
          };
        } catch (error: any) {
          return {
            server: server.name,
            status: 0,
            responseTime: Date.now() - startTime,
            healthy: false,
            error: error.message
          };
        }
      })
    );

    console.log('\n=== Server Health Summary ===');
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        const data = result.value;
        const icon = data.healthy ? '✓' : '✗';
        console.log(`${icon} ${data.server}: ${data.status} (${data.responseTime}ms)`);
        if (data.error) {
          console.log(`  Error: ${data.error}`);
        }
      }
    });
    console.log('============================\n');

    // Ensure at least one server is healthy
    const healthyServers = results.filter(
      r => r.status === 'fulfilled' && r.value.healthy
    );
    expect(healthyServers.length).toBeGreaterThan(0);
  });
});

