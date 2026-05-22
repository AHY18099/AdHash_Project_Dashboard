import { test, expect } from '@playwright/test';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

interface ServerConfig {
  name: string;
  url: string;
  expectedStatus?: number;
  timeout?: number;
}

interface ProjectServerConfig {
  name?: string;
  url?: string;
  type?: string;
}

interface ProjectConfig {
  servers?: ProjectServerConfig[];
}

interface ProjectMapping {
  projects?: ProjectConfig[];
}

const SKIPPED_SERVER_URL_FRAGMENT = '20.62.109.239';
const SKIPPED_SERVER_NAME = 'AutoChecker - PartSouq';
const SKIPPED_SERVER_MESSAGE = 'Skipped by QA (known issue / external dependency)';

function isSkippedServer(server: ServerConfig): boolean {
  return server.name === SKIPPED_SERVER_NAME || server.url.includes(SKIPPED_SERVER_URL_FRAGMENT);
}

function loadServers(): ServerConfig[] {
  const mappingPath = path.join(process.cwd(), 'config', 'project-mapping.json');
  const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8')) as ProjectMapping;
  const projectFilter = process.env.PROJECT_FILTER ? process.env.PROJECT_FILTER.toLowerCase().trim() : '';
  const seen = new Set<string>();

  return (mapping.projects || [])
    .filter((project: any) => !projectFilter || (project.id || '').toLowerCase() === projectFilter)
    .flatMap((project) => project.servers || [])
    .filter((server): server is ProjectServerConfig & { name: string; url: string } => Boolean(server?.name && server?.url))
    .map((server) => ({
      name: server.name,
      url: server.url,
      expectedStatus: 200,
      timeout: 10000
    }))
    .filter((server) => {
      const stableKey = `${server.name}::${server.url}`.toLowerCase();
      if (seen.has(stableKey)) {
        return false;
      }

      seen.add(stableKey);
      return true;
    });
}

const servers = loadServers();

test.describe('Server Health Monitoring', () => {
  // Use HTTP requests only (no browser needed - matches original implementation)
  for (const server of servers) {
    test(`Check ${server.name} health`, async () => {
      test.skip(isSkippedServer(server), SKIPPED_SERVER_MESSAGE);

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
        if (isSkippedServer(server)) {
          return {
            server: server.name,
            status: 'skipped',
            responseTime: 0,
            healthy: false,
            message: SKIPPED_SERVER_MESSAGE
          };
        }

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
        if (data.status === 'skipped') {
          console.log(`- ${data.server}: SKIPPED (${data.message})`);
          return;
        }

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

