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
  headers?: Record<string, string>;
  body?: any;
  expectedStatus?: number;
  timeout?: number;
}

interface ProjectConfig {
  apis?: ProjectApiConfig[];
}

interface ProjectMapping {
  projects?: ProjectConfig[];
}

function serializeApiData(value: unknown): string {
  if (value === undefined || value === null || value === '') {
    return 'No response body';
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

function getRequestBodyFallback(method: ApiEndpoint['method']): string {
  return method === 'GET' || method === 'DELETE' ? 'No request body' : 'Payload not provided';
}

function formatRequestBody(method: ApiEndpoint['method'], value: unknown): string {
  if (value === undefined || value === null || value === '') {
    return getRequestBodyFallback(method);
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

function isJsonPayload(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
  }

  return typeof value === 'object';
}

function buildRequestHeaders(headers: Record<string, string> | undefined, body: unknown): Record<string, string> | undefined {
  const nextHeaders = { ...(headers || {}) };
  const hasContentType = Object.keys(nextHeaders).some((key) => key.toLowerCase() === 'content-type');

  if (!hasContentType && isJsonPayload(body)) {
    nextHeaders['Content-Type'] = 'application/json';
  }

  return Object.keys(nextHeaders).length > 0 ? nextHeaders : undefined;
}

function buildAxiosRequestConfig(endpoint: ApiEndpoint) {
  const headers = buildRequestHeaders(endpoint.headers, endpoint.body);
  const config = {
    method: endpoint.method,
    url: endpoint.url,
    headers,
    timeout: endpoint.timeout || 10000,
    validateStatus: () => true
  } as {
    method: ApiEndpoint['method'];
    url: string;
    headers?: Record<string, string>;
    timeout: number;
    validateStatus: () => boolean;
    data?: unknown;
  };

  if (endpoint.method !== 'GET' && endpoint.method !== 'DELETE' && endpoint.body !== undefined) {
    config.data = endpoint.body;
  }

  return config;
}

function getApiClassification(endpoint: ApiEndpoint, status: number): 'passed' | 'warning' | 'failed' {
  if (typeof endpoint.expectedStatus === 'number') {
    if (status !== endpoint.expectedStatus) {
      return 'failed';
    }

    if (status >= 300 && status < 400) {
      return 'warning';
    }

    return 'passed';
  }

  if (status >= 200 && status < 300) {
    return 'passed';
  }

  if (status >= 300 && status < 400) {
    return 'warning';
  }

  return 'failed';
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
      headers: api.headers,
      body: api.body,
      expectedStatus: api.expectedStatus,
      timeout: api.timeout || 10000
    }));
}

const apiEndpoints = loadApiEndpoints();

test.describe('API Tests', () => {
  for (const endpoint of apiEndpoints) {
    test(`${endpoint.method} ${endpoint.name}`, async () => {
      const startTime = Date.now();
      
      try {
        const requestConfig = buildAxiosRequestConfig(endpoint);
        const requestBody = formatRequestBody(endpoint.method, requestConfig.data);
        const response: AxiosResponse = await axios(requestConfig);

        const responseTime = Date.now() - startTime;

        console.log(`\n=== ${endpoint.name} ===`);
        console.log(`URL: ${endpoint.url}`);
        console.log(`Method: ${endpoint.method}`);
        console.log(`Status: ${response.status}`);
        console.log(`Response Time: ${responseTime}ms`);
        console.log(`Response Size: ${JSON.stringify(response.data).length} bytes`);
        console.log('========================\n');
        emitApiRuntimeDetails(requestBody, response.data, response.status);

        const classification = getApiClassification(endpoint, response.status);

        // Unexpected 4xx/5xx responses fail the test. Expected negative statuses must be explicit.
        expect(classification).not.toBe('failed');

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
          const response = await axios(buildAxiosRequestConfig(endpoint));
          
          const responseTime = Date.now() - startTime;
          
          return {
            name: endpoint.name,
            status: response.status,
            responseTime,
            success: getApiClassification(endpoint, response.status) !== 'failed'
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

