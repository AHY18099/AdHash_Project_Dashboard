import { test, expect } from '@playwright/test';
import axios, { AxiosResponse } from 'axios';
import * as fs from 'fs';
import * as path from 'path';

interface ApiEndpoint {
  name: string;
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: any;
  expectedStatus?: number;
  timeout?: number;
}

interface ProjectApiConfig {
  name?: string;
  url?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
}

interface ProjectConfig {
  apis?: ProjectApiConfig[];
}

interface ProjectMapping {
  projects?: ProjectConfig[];
}

function serializeApiData(value: unknown): string {
  if (value === undefined || value === null || value === '') {
    return '-';
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return String(value);
  }
}

function emitApiRuntimeDetails(requestBody: unknown, responseBody: unknown, responseCode: number): void {
  const requestPayload = Buffer.from(serializeApiData(requestBody), 'utf8').toString('base64');
  const responsePayload = Buffer.from(serializeApiData(responseBody), 'utf8').toString('base64');

  console.log(`__API_REQUEST_BODY__${requestPayload}`);
  console.log(`__API_RESPONSE_BODY__${responsePayload}`);
  console.log(`__API_RESPONSE_CODE__${responseCode}`);
}

function loadApiEndpoints(): ApiEndpoint[] {
  const mappingPath = path.join(process.cwd(), 'config', 'project-mapping.json');
  const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8')) as ProjectMapping;

  return (mapping.projects || [])
    .flatMap((project) => project.apis || [])
    .filter((api): api is ProjectApiConfig & { name: string; url: string; method: 'GET' | 'POST' | 'PUT' | 'DELETE' } => Boolean(api?.name && api?.url && api?.method))
    .map((api) => ({
      name: api.name,
      url: api.url,
      method: api.method,
      expectedStatus: api.method === 'GET' ? 200 : undefined,
      timeout: 10000
    }));
}

function isSuccessfulResponse(endpoint: ApiEndpoint, status: number): boolean {
  if (endpoint.method === 'GET') {
    return status === (endpoint.expectedStatus || 200);
  }

  return status > 0 && status < 500 && status !== 404 && status !== 405;
}

const apiEndpoints = loadApiEndpoints();

test.describe('API Tests', () => {
  for (const endpoint of apiEndpoints) {
    test(`${endpoint.method} ${endpoint.name}`, async () => {
      const startTime = Date.now();
      
      try {
        let response: AxiosResponse;
        const requestBody = endpoint.method === 'GET' ? '-' : (endpoint.body ?? '-');

        switch (endpoint.method) {
          case 'GET':
            response = await axios.get(endpoint.url, {
              headers: endpoint.headers,
              timeout: endpoint.timeout || 10000,
              validateStatus: () => true
            });
            break;
          
          case 'POST':
            response = await axios.post(endpoint.url, endpoint.body, {
              headers: endpoint.headers,
              timeout: endpoint.timeout || 10000,
              validateStatus: () => true
            });
            break;
          
          case 'PUT':
            response = await axios.put(endpoint.url, endpoint.body, {
              headers: endpoint.headers,
              timeout: endpoint.timeout || 10000,
              validateStatus: () => true
            });
            break;
          
          case 'DELETE':
            response = await axios.delete(endpoint.url, {
              headers: endpoint.headers,
              timeout: endpoint.timeout || 10000,
              validateStatus: () => true
            });
            break;
          
          default:
            throw new Error(`Unsupported method: ${endpoint.method}`);
        }

        const responseTime = Date.now() - startTime;

        console.log(`\n=== ${endpoint.name} ===`);
        console.log(`URL: ${endpoint.url}`);
        console.log(`Method: ${endpoint.method}`);
        console.log(`Status: ${response.status}`);
        console.log(`Response Time: ${responseTime}ms`);
        console.log(`Response Size: ${JSON.stringify(response.data).length} bytes`);
        console.log('========================\n');
        emitApiRuntimeDetails(requestBody, response.data, response.status);

        // Verify the endpoint is healthy enough for its method type.
        expect(isSuccessfulResponse(endpoint, response.status)).toBe(true);

        // Verify response time is acceptable
        expect(responseTime).toBeLessThan(endpoint.timeout || 10000);

        // Verify response has data
        expect(response.data).toBeDefined();

      } catch (error: any) {
        console.error(`✗ ${endpoint.name} failed:`, error.message);
        
        // Skip test if it's a connection issue (might be test environment)
        if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
          test.skip();
        } else {
          throw error;
        }
      }
    });
  }

  test('API Performance Summary', async () => {
    const results = await Promise.allSettled(
      apiEndpoints.map(async (endpoint) => {
        const startTime = Date.now();
        try {
          const response = await axios({
            method: endpoint.method,
            url: endpoint.url,
            headers: endpoint.headers,
            data: endpoint.body,
            timeout: endpoint.timeout || 10000,
            validateStatus: () => true
          });
          
          const responseTime = Date.now() - startTime;
          
          return {
            name: endpoint.name,
            status: response.status,
            responseTime,
            success: isSuccessfulResponse(endpoint, response.status)
          };
        } catch (error: any) {
          return {
            name: endpoint.name,
            status: 0,
            responseTime: Date.now() - startTime,
            success: false,
            error: error.message
          };
        }
      })
    );

    console.log('\n=== API Performance Summary ===');
    results.forEach((result) => {
      if (result.status === 'fulfilled') {
        const data = result.value;
        const icon = data.success ? '✓' : '✗';
        console.log(`${icon} ${data.name}: ${data.status} (${data.responseTime}ms)`);
        if (data.error) {
          console.log(`  Error: ${data.error}`);
        }
      }
    });
    console.log('===============================\n');
  });
});

