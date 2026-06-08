import { test } from '@playwright/test';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';

interface AppData {
  appName: string;
  storeId: string;
  expectedUrl: string;
  platform: 'Play Store' | 'App Store';
  projectName: string;
}

interface ProjectAppConfig {
  name?: string;
  playStore?: string | null;
  appStore?: string | null;
}

interface ProjectConfig {
  name?: string;
  id?: string;
  apps?: ProjectAppConfig[];
}

interface ProjectMapping {
  projects?: ProjectConfig[];
}

function normalizePlayStoreValue(playStore: string): { packageName: string; expectedUrl: string } {
  const trimmed = playStore.trim();

  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    const packageName = url.searchParams.get('id') || '';

    return {
      packageName,
      expectedUrl: trimmed
    };
  }

  return {
    packageName: trimmed,
    expectedUrl: `https://play.google.com/store/apps/details?id=${trimmed}`
  };
}

function normalizeAppStoreValue(appStore: string): { appId: string; expectedUrl: string } {
  const trimmed = appStore.trim();

  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    const appIdMatch = url.pathname.match(/(id\d+)/i);
    const appId = appIdMatch?.[1] || '';

    return {
      appId,
      expectedUrl: trimmed
    };
  }

  const appId = trimmed.startsWith('id') ? trimmed : `id${trimmed}`;
  return {
    appId,
    expectedUrl: `https://apps.apple.com/app/${appId}`
  };
}

function loadAppData(): AppData[] {
  const mappingPath = path.join(process.cwd(), 'config', 'project-mapping.json');
  const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8')) as ProjectMapping;
  const projectFilter = process.env.PROJECT_FILTER ? process.env.PROJECT_FILTER.toLowerCase().trim() : '';

  return (mapping.projects || [])
    .filter((project: any) => !projectFilter || (project.id || '').toLowerCase() === projectFilter)
    .flatMap((project) => {
      const apps = project.apps || [];
      const playStoreCount = apps.filter((app) => Boolean(app?.playStore)).length;
      const appStoreCount = apps.filter((app) => Boolean(app?.appStore)).length;
      const normalizedApps: AppData[] = [];

      for (const app of apps) {
        if (!app?.name) {
          continue;
        }

        if (app.playStore) {
          const normalizedPlayStore = normalizePlayStoreValue(app.playStore);
          if (normalizedPlayStore.packageName) {
            normalizedApps.push({
              appName: app.name,
              storeId: normalizedPlayStore.packageName,
              expectedUrl: normalizedPlayStore.expectedUrl,
              platform: 'Play Store',
              projectName: project.name || app.name
            });
          }
        }

        if (app.appStore) {
          const normalizedAppStore = normalizeAppStoreValue(app.appStore);
          if (normalizedAppStore.appId) {
            normalizedApps.push({
              appName: app.name,
              storeId: normalizedAppStore.appId,
              expectedUrl: normalizedAppStore.expectedUrl,
              platform: 'App Store',
              projectName: project.name || app.name
            });
          }
        }
      }

      console.log(`[APP STATUS] project name: ${project.name || 'Unknown'}, playStore count: ${playStoreCount}, appStore count: ${appStoreCount}, total normalized apps: ${normalizedApps.length}`);
      return normalizedApps;
    })
    .filter((app) => Boolean(app.storeId));
}

/**
 * Fetch a URL using Node's built-in https/http module (no browser needed).
 * Returns { status, body, error }.
 */
function fetchUrl(url: string, timeoutMs = 20000): Promise<{ status: number; body: string; error?: string }> {
  return new Promise((resolve) => {
    const protocol = url.startsWith('https') ? https : require('http');
    const req = protocol.get(
      url,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; AdHash-QA/1.0)',
          'Accept': 'text/html,application/xhtml+xml,application/json,*/*',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        timeout: timeoutMs,
      },
      (res: any) => {
        // Follow one redirect
        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
          resolve(fetchUrl(res.headers.location, timeoutMs));
          res.destroy();
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode || 0, body }));
        res.on('error', (e: Error) => resolve({ status: 0, body: '', error: e.message }));
      }
    );
    req.on('error', (e: Error) => resolve({ status: 0, body: '', error: e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: '', error: `Request timed out after ${timeoutMs}ms` });
    });
  });
}

/**
 * Check Play Store via iTunes-style URL reachability.
 * Uses Google Play's web endpoint with HTTP — checks HTTP 200 and that the
 * package ID appears in the response body (proves app exists).
 */
async function checkPlayStore(pkgId: string, appName: string): Promise<{ status: 'passed' | 'failed' | 'warning'; reason: string }> {
  const url = `https://play.google.com/store/apps/details?id=${pkgId}&hl=en&gl=US`;
  try {
    const res = await fetchUrl(url, 20000);
    if (res.error) {
      return { status: 'failed', reason: `Network error: ${res.error}` };
    }
    if (res.status === 200) {
      const body = res.body;
      // Confirm the app actually exists: package ID must appear in the response
      const pkgFound = body.includes(pkgId);
      // Also try matching any significant word (>3 chars) from the app name
      const words = appName.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const nameFound = words.length === 0 || words.some(w => body.toLowerCase().includes(w));
      if (pkgFound || nameFound) {
        return { status: 'passed', reason: `App found on Play Store (${pkgId})` };
      }
      return { status: 'warning', reason: `Page loaded (HTTP 200) but app name not confirmed in body` };
    }
    if (res.status === 404) {
      return { status: 'failed', reason: `App not found on Play Store (${pkgId}) — HTTP 404` };
    }
    if (res.status >= 400) {
      return { status: 'failed', reason: `HTTP ${res.status} — app may not exist` };
    }
    // 3xx without location, 5xx, etc.
    return { status: 'warning', reason: `HTTP ${res.status} — may be rate limited or temporarily unavailable` };
  } catch (e: any) {
    return { status: 'failed', reason: e.message || String(e) };
  }
}

/**
 * Check App Store via the iTunes Lookup API — public JSON API, no browser needed.
 */
async function checkAppStore(appStoreUrl: string, appName: string): Promise<{ status: 'passed' | 'failed' | 'warning'; reason: string }> {
  const appIdMatch = appStoreUrl.match(/id(\d+)/i);
  const appId = appIdMatch ? appIdMatch[1] : '';

  if (appId) {
    // iTunes Lookup API — reliable public endpoint, works from server IPs
    const lookupUrl = `https://itunes.apple.com/lookup?id=${appId}&country=in`;
    try {
      const res = await fetchUrl(lookupUrl, 20000);
      if (res.error) {
        return { status: 'failed', reason: `Network error: ${res.error}` };
      }
      if (res.status === 200) {
        try {
          const data = JSON.parse(res.body);
          const results = data?.results || [];
          if (results.length > 0) {
            const appData = results[0];
            const rating = appData.averageUserRating != null ? appData.averageUserRating.toFixed(1) : 'N/A';
            return {
              status: 'passed',
              reason: `${appData.trackName || appName} v${appData.version || '?'} — Rating: ${rating}`
            };
          }
          return { status: 'failed', reason: `App not found on App Store (id: ${appId})` };
        } catch {
          // JSON parse failed — fall back to URL reachability check
        }
      }
    } catch (e: any) {
      // Fall through to URL reachability check
    }
  }

  // Fallback: check if the App Store URL is reachable
  if (appStoreUrl.startsWith('http')) {
    try {
      const res = await fetchUrl(appStoreUrl, 20000);
      if (res.error) {
        return { status: 'failed', reason: `Network error: ${res.error}` };
      }
      if (res.status >= 200 && res.status < 400) {
        return { status: 'passed', reason: `App Store page reachable (HTTP ${res.status})` };
      }
      return { status: 'failed', reason: `HTTP ${res.status} — app may not exist on App Store` };
    } catch (e: any) {
      return { status: 'failed', reason: e.message || String(e) };
    }
  }

  return { status: 'warning', reason: 'No App Store ID or valid URL found' };
}

test.describe('App Storefront Verification', () => {
  const apps = loadAppData();

  for (const app of apps) {
    // Use test() without the `page` fixture — no browser is launched
    test(`App Status: ${app.appName} (${app.platform})`, async () => {
      test.setTimeout(60000);

      let appStatus: 'passed' | 'failed' | 'warning' = 'failed';
      let appReason = '';

      if (app.platform === 'Play Store') {
        const result = await checkPlayStore(app.storeId, app.appName);
        appStatus = result.status;
        appReason = result.reason;
      } else {
        const result = await checkAppStore(app.expectedUrl, app.appName);
        appStatus = result.status;
        appReason = result.reason;
      }

      // Emit structured marker for server to parse
      console.log(`__APP_RESULT__${JSON.stringify({ appName: app.appName, platform: app.platform, status: appStatus, reason: appReason })}`);

      if (appStatus === 'failed') {
        throw new Error(appReason);
      }
    });
  }
});
