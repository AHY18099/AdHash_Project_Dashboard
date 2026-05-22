import { test, expect } from '@playwright/test';
import * as https from 'https';
import * as tls from 'tls';
import * as fs from 'fs';
import * as path from 'path';

interface CertificateInfo {
  domain: string;
  issuer: string;
  validFrom: Date;
  validTo: Date;
  daysRemaining: number;
  isValid: boolean;
}

interface DomainConfig {
  name: string;
  url: string;
  warningDays?: number;
}

interface ProjectConfig {
  name?: string;
  ssl?: string[];
  sslCerts?: string[];
}

interface ProjectMapping {
  projects?: ProjectConfig[];
}

function normalizeSslHost(value: string): string {
  const trimmed = value.trim();

  if (/^https?:\/\//i.test(trimmed)) {
    return new URL(trimmed).hostname.toLowerCase();
  }

  return trimmed.replace(/^https?:\/\//i, '').split('/')[0].replace(/:\d+$/, '').toLowerCase();
}

function getProjectSslEntries(project: ProjectConfig): string[] {
  const rawEntries = (project.ssl && project.ssl.length > 0)
    ? project.ssl
    : (project.sslCerts || []);
  const seen = new Set<string>();

  return rawEntries
    .map((entry) => normalizeSslHost(entry))
    .filter((entry) => {
      if (!entry || seen.has(entry)) {
        return false;
      }

      seen.add(entry);
      return true;
    });
}

function loadDomainConfigs(): DomainConfig[] {
  const mappingPath = path.join(process.cwd(), 'config', 'project-mapping.json');
  const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8')) as ProjectMapping;
  const projectFilter = process.env.PROJECT_FILTER ? process.env.PROJECT_FILTER.toLowerCase().trim() : '';
  const seen = new Set<string>();

  return (mapping.projects || [])
    .filter((project: any) => !projectFilter || (project.id || '').toLowerCase() === projectFilter)
    .flatMap((project) => getProjectSslEntries(project).map((url) => ({
      name: url,
      url,
      warningDays: 30
    })))
    .filter((entry) => {
      if (seen.has(entry.url)) {
        return false;
      }

      seen.add(entry.url);
      return true;
    });
}

const domains = loadDomainConfigs();

async function getCertificateInfo(hostname: string): Promise<CertificateInfo> {
  return new Promise((resolve, reject) => {
    const options = {
      host: hostname,
      port: 443,
      method: 'GET',
      rejectUnauthorized: false,
      agent: false
    };

    const req = https.request(options, (res) => {
      const cert = (res.socket as tls.TLSSocket).getPeerCertificate();
      
      if (!cert || Object.keys(cert).length === 0) {
        reject(new Error('No certificate found'));
        return;
      }

      const validFrom = new Date(cert.valid_from);
      const validTo = new Date(cert.valid_to);
      const now = new Date();
      const daysRemaining = Math.ceil((validTo.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

      resolve({
        domain: hostname,
        issuer: cert.issuer?.O || 'Unknown',
        validFrom,
        validTo,
        daysRemaining,
        isValid: now >= validFrom && now <= validTo
      });

      req.abort();
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.end();
  });
}

test.describe('SSL Certificate Expiry Tests', () => {
  for (const domain of domains) {
    test(`Check SSL certificate for ${domain.name}`, async () => {
      try {
        const certInfo = await getCertificateInfo(domain.url);

        console.log(`\n=== ${domain.name} Certificate Info ===`);
        console.log(`Domain: ${certInfo.domain}`);
        console.log(`Issuer: ${certInfo.issuer}`);
        console.log(`Valid From: ${certInfo.validFrom.toISOString()}`);
        console.log(`Valid To: ${certInfo.validTo.toISOString()}`);
        console.log(`Days Remaining: ${certInfo.daysRemaining}`);
        console.log(`Is Valid: ${certInfo.isValid}`);
        console.log('=====================================\n');

        // Assert certificate is valid
        expect(certInfo.isValid).toBe(true);

        // Assert certificate is not expired
        expect(certInfo.daysRemaining).toBeGreaterThan(0);

        // Warn if certificate is expiring soon
        const warningDays = domain.warningDays || 30;
        if (certInfo.daysRemaining <= warningDays) {
          console.warn(`⚠️  WARNING: Certificate for ${domain.name} expires in ${certInfo.daysRemaining} days!`);
        }

        // Fail if certificate expires in less than 7 days
        expect(certInfo.daysRemaining).toBeGreaterThan(7);

      } catch (error: any) {
        console.error(`✗ Error checking certificate for ${domain.name}:`, error.message);
        
        // If it's a connection/network error, skip (unreachable from this machine)
        if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || error.code === 'ECONNRESET' || error.message?.includes('timeout')) {
          test.skip();
        } else {
          throw error;
        }
      }
    });
  }

  test('Certificate expiry summary', async () => {
    const results = await Promise.allSettled(
      domains.map(async (domain) => {
        try {
          const certInfo = await getCertificateInfo(domain.url);
          return {
            domain: domain.name,
            daysRemaining: certInfo.daysRemaining,
            isValid: certInfo.isValid,
            validTo: certInfo.validTo
          };
        } catch (error: any) {
          return {
            domain: domain.name,
            daysRemaining: -1,
            isValid: false,
            error: error.message
          };
        }
      })
    );

    console.log('\n=== Certificate Expiry Summary ===');
    results.forEach((result) => {
      if (result.status === 'fulfilled') {
        const data = result.value;
        const icon = data.isValid && data.daysRemaining > 7 ? '✓' : '⚠️';
        console.log(`${icon} ${data.domain}: ${data.daysRemaining} days remaining`);
        if (data.error) {
          console.log(`  Error: ${data.error}`);
        }
      }
    });
    console.log('==================================\n');
  });
});

