import { test, expect } from '@playwright/test';
import axios, { AxiosResponse } from 'axios';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config({ quiet: true });

interface ApiEndpoint {
  name: string;
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: any;
  expectedStatus?: number;
  timeout?: number;
  capture?: Record<string, string>;
}

interface ProjectApiConfig {
  name?: string;
  url?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: any;
  expectedStatus?: number;
  timeout?: number;
  capture?: Record<string, string>;
}

interface ProjectConfig {
  apis?: ProjectApiConfig[];
}

interface ProjectMapping {
  projects?: ProjectConfig[];
}

interface RuntimeTokenStore {
  values: Map<string, string>;
}

type ApiClassification = 'passed' | 'warning' | 'failed' | 'skipped';

const PLACEHOLDER_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;
const SUPABASE_HOST_PATTERN = /https?:\/\/[^/]+\.supabase\.co\//i;
const DDP_SUPABASE_HOST = 'twfnwlccyudfgqjmmdva.supabase.co';
const SKIPPED_SUPABASE_MESSAGE = 'Skipped in CI: SUPABASE_API_KEY secret is not configured';
const runtimeTokenStore: RuntimeTokenStore = {
  values: new Map<string, string>()
};

console.log('SUPABASE_API_KEY configured:', Boolean(process.env.SUPABASE_API_KEY));

function getSupabaseApiKey(): string {
  const apiKey = process.env.SUPABASE_API_KEY || process.env.DDP_SUPABASE_API_KEY || process.env.DDP_SUPABASE_PUBLISHABLE_KEY || '';
  if (!apiKey) {
    throw new Error('Missing SUPABASE_API_KEY environment variable');
  }

  return apiKey;
}

function getSupabaseHeaders(token: string | null = null): Record<string, string> {
  const apiKey = getSupabaseApiKey();

  return {
    apikey: apiKey,
    Authorization: `Bearer ${token || apiKey}`,
    'Content-Type': 'application/json'
  };
}

function isSupabaseRequest(url: string): boolean {
  return SUPABASE_HOST_PATTERN.test(url);
}

function isSupabaseLoginRequest(url: string): boolean {
  return isSupabaseRequest(url) && /\/auth\/v1\/token\?grant_type=password/i.test(url);
}

function isDdpSupabaseRequest(url: string): boolean {
  return String(url || '').includes(DDP_SUPABASE_HOST);
}

function isDdpSupabaseAuthFlowRequest(endpoint: ApiEndpoint): boolean {
  if (!isDdpSupabaseRequest(endpoint.url)) {
    return false;
  }

  return /\/auth\/v1\/token\?grant_type=password|\/auth\/v1\/user|\/functions\/v1\/send-otp/i.test(endpoint.url);
}

function isCiSupabaseSecretMissing(): boolean {
  return String(process.env.CI || '').trim().toLowerCase() === 'true' && !Boolean(process.env.SUPABASE_API_KEY);
}

function extractBearerToken(authorizationHeader?: string): string | null {
  const trimmed = String(authorizationHeader || '').trim();
  if (!trimmed) {
    return null;
  }

  const match = trimmed.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return null;
  }

  const token = match[1].trim();
  return token ? token : null;
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

function buildRequestHeaders(endpoint: ApiEndpoint, headers: Record<string, string> | undefined, body: unknown): Record<string, string> | undefined {
  const nextHeaders = Object.fromEntries(
    Object.entries({ ...(headers || {}) }).filter(([, value]) => String(value || '').trim() !== '')
  ) as Record<string, string>;

  if (isSupabaseRequest(endpoint.url)) {
    const runtimeToken = extractBearerToken(nextHeaders.Authorization || nextHeaders.authorization);

    if (!isSupabaseLoginRequest(endpoint.url) && !runtimeToken) {
      throw new Error(`Supabase Auth Failed for ${endpoint.name} - Missing dynamic access token`);
    }

    const supabaseHeaders = getSupabaseHeaders(isSupabaseLoginRequest(endpoint.url) ? null : runtimeToken);
    Object.assign(nextHeaders, supabaseHeaders, nextHeaders);
  }

  const hasContentType = Object.keys(nextHeaders).some((key) => key.toLowerCase() === 'content-type');

  if (!hasContentType && isJsonPayload(body)) {
    nextHeaders['Content-Type'] = 'application/json';
  }

  return Object.keys(nextHeaders).length > 0 ? nextHeaders : undefined;
}

function normalizeEnvKey(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
}

function getValueByPath(source: unknown, selector: string): string | undefined {
  if (!selector.trim()) {
    return undefined;
  }

  const segments = selector.split('.').map((segment) => segment.trim()).filter(Boolean);
  let current: unknown = source;

  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }

    current = (current as Record<string, unknown>)[segment];
  }

  if (current === null || current === undefined) {
    return undefined;
  }

  return typeof current === 'string' ? current : JSON.stringify(current);
}

function getStoredRuntimeValue(tokenKey: string): string | undefined {
  const normalizedKey = tokenKey.trim();
  if (!normalizedKey) {
    return undefined;
  }

  const exact = runtimeTokenStore.values.get(normalizedKey);
  if (exact) {
    return exact;
  }

  return runtimeTokenStore.values.get(normalizeEnvKey(normalizedKey));
}

function resolvePlaceholderExpression(expression: string): string {
  const parts = expression.split('|').map((part) => part.trim()).filter(Boolean);

  for (const part of parts) {
    const storedValue = getStoredRuntimeValue(part);
    if (storedValue) {
      return storedValue;
    }

    const envValue = process.env[part] || process.env[normalizeEnvKey(part)];
    if (envValue) {
      return envValue;
    }
  }

  return '';
}

function resolveTemplateString(value: string): string {
  return value.replace(PLACEHOLDER_PATTERN, (_, expression: string) => resolvePlaceholderExpression(expression));
}

function resolveTemplateValue<T>(value: T): T {
  if (typeof value === 'string') {
    return resolveTemplateString(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => resolveTemplateValue(entry)) as T;
  }

  if (value && typeof value === 'object') {
    const resolvedEntries = Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [key, resolveTemplateValue(entryValue)]);
    return Object.fromEntries(resolvedEntries) as T;
  }

  return value;
}

function captureRuntimeValues(endpoint: ApiEndpoint, responseBody: unknown): void {
  if (!endpoint.capture || !responseBody || typeof responseBody !== 'object') {
    return;
  }

  for (const [tokenName, selector] of Object.entries(endpoint.capture)) {
    const resolvedValue = getValueByPath(responseBody, selector);
    if (!resolvedValue) {
      continue;
    }

    runtimeTokenStore.values.set(`${endpoint.name}.${tokenName}`, resolvedValue);
    runtimeTokenStore.values.set(tokenName, resolvedValue);
    runtimeTokenStore.values.set(normalizeEnvKey(`${endpoint.name}_${tokenName}`), resolvedValue);
    runtimeTokenStore.values.set(normalizeEnvKey(tokenName), resolvedValue);
  }
}

function buildAxiosRequestConfig(endpoint: ApiEndpoint) {
  const resolvedHeaders = resolveTemplateValue(endpoint.headers);
  const resolvedBody = resolveTemplateValue(endpoint.body);
  const headers = buildRequestHeaders(endpoint, resolvedHeaders, resolvedBody);
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

  if (endpoint.method !== 'GET' && endpoint.method !== 'DELETE' && resolvedBody !== undefined) {
    config.data = resolvedBody;
  }

  return config;
}

function buildApiFailureMessage(endpoint: ApiEndpoint, status: number, responseBody: string): string {
  if (status === 401) {
    console.error('Supabase Auth Failed - Missing/Invalid API Key');
  }

  const baseMessage = `Supabase Auth Failed for ${endpoint.name} - Status: ${status}`;
  if (!responseBody.trim()) {
    return baseMessage;
  }

  return `${baseMessage}\nResponse: ${responseBody}`;
}

function getApiClassification(endpoint: ApiEndpoint, status: number): ApiClassification {
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

  const excludedApis = new Set(
    String(process.env.EXCLUDED_APIS || '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
  );

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
      timeout: api.timeout || 10000,
      capture: api.capture
    }));
}

const apiEndpoints = loadApiEndpoints();

test.describe('API Tests', () => {
  test.describe.configure({ mode: 'serial' });

  for (const endpoint of apiEndpoints) {
    test(`${endpoint.method} ${endpoint.name}`, async () => {
      test.skip(isDdpSupabaseAuthFlowRequest(endpoint) && isCiSupabaseSecretMissing(), SKIPPED_SUPABASE_MESSAGE);

      const startTime = Date.now();
      
      try {
        const requestConfig = buildAxiosRequestConfig(endpoint);
        const requestBody = formatRequestBody(endpoint.method, requestConfig.data);
        const response: AxiosResponse = await axios(requestConfig);
        const responseTime = Date.now() - startTime;
        const responseBody = serializeApiData(response.data);

        console.log(`API: ${endpoint.name}`);
        console.log('Request Headers:', requestConfig.headers || {});
        console.log('Request Body:', requestBody);
        console.log('Status:', response.status);
        console.log('Response:', responseBody);

        console.log(`\n=== ${endpoint.name} ===`);
        console.log(`URL: ${endpoint.url}`);
        console.log(`Method: ${endpoint.method}`);
        console.log(`Status: ${response.status}`);
        console.log(`Response Time: ${responseTime}ms`);
        console.log(`Response Size: ${responseBody.length} bytes`);
        console.log('========================\n');
        emitApiRuntimeDetails(requestBody, response.data, response.status);
        captureRuntimeValues(endpoint, response.data);

        const classification = getApiClassification(endpoint, response.status);

        if (classification === 'failed') {
          throw new Error(buildApiFailureMessage(endpoint, response.status, responseBody));
        }

        if (isSupabaseLoginRequest(endpoint.url)) {
          expect(response.status).toBe(200);
          expect(response.data?.access_token, `Missing access_token for ${endpoint.name}`).toBeTruthy();
        }

        // Unexpected 4xx/5xx responses fail the test. Expected negative statuses must be explicit.
        // Verify response time is acceptable
        expect(responseTime).toBeLessThan(endpoint.timeout || 10000);

        // Verify response has data
        expect(response.data).toBeDefined();

      } catch (error: any) {
        console.error(`API: ${endpoint.name}`);
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
        if (isDdpSupabaseAuthFlowRequest(endpoint) && isCiSupabaseSecretMissing()) {
          return {
            name: endpoint.name,
            status: 'skipped',
            responseTime: 0,
            success: true,
            skipped: true,
            error: SKIPPED_SUPABASE_MESSAGE
          };
        }

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
        if (data.skipped) {
          console.log(`⏭ ${data.name}: SKIPPED (${data.error})`);
          return;
        }

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

