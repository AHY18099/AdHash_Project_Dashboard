import { test, expect } from '@playwright/test';
import * as https from 'https';
import * as tls from 'tls';

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

// Real domains from AdHash-Projects-Certificate-Expiry-Test repository
const domains: DomainConfig[] = [
  // Main Projects
  { name: 'Algomax - GoPocket', url: 'gopocket.algomax.co', warningDays: 30 },
  { name: 'Algomax - ProSky', url: 'prosky.algomax.co', warningDays: 30 },
  { name: 'WavedIn - Admin', url: 'superadmin.wavedin.app', warningDays: 30 },
  { name: 'WavedIn - Marketplace', url: 'market.wavedin.app', warningDays: 30 },
  { name: 'Auto Checker', url: 'manage.autochecker.com', warningDays: 30 },
  { name: 'Spark me', url: 'sparkanalytics.synctag.com', warningDays: 30 },
  { name: 'ZapAI', url: 'www.zapai.us', warningDays: 30 },
  { name: 'ZapCRM', url: 'zapcrm.io', warningDays: 30 },
  { name: 'Lead ZapCRM', url: 'lead.zapcrm.io', warningDays: 30 },
  { name: 'Metclaf', url: 'metcalf.ai', warningDays: 30 },
  { name: 'Humee - Admin', url: 'humee.com', warningDays: 30 },
  { name: 'Humee - Dashboard', url: 'dashboard.humee.com', warningDays: 30 },
  { name: 'Ai Sign Pro - Admin', url: 'admin.aisignpro.com', warningDays: 30 },
  { name: 'AI Sign Pro - CPA', url: 'cpa.aisignpro.com', warningDays: 30 },
  { name: 'Ai Sign Pro - Participant', url: 'participant.aisignpro.com', warningDays: 30 },
  { name: 'AdHash Website', url: 'adhashtech.com', warningDays: 30 },

  // API Endpoints
  { name: 'WavedIn API', url: 'mobileliveapi.wavedin.app', warningDays: 30 },
  { name: 'Auto Checker API 1', url: 'manageadminapi.autochecker.com', warningDays: 30 },
  { name: 'Auto Checker API 2', url: 'ebaydev.autochecker.com', warningDays: 30 },
  { name: 'Auto Checker API 3', url: 'managemobileapi.autochecker.com', warningDays: 30 },
  { name: 'Spark me API', url: 'spark.synctag.com', warningDays: 30 },
  { name: 'ZapCRM Lead API', url: 'api.zapcrm.io', warningDays: 30 },
  { name: 'Humee API', url: 'api.humee.com', warningDays: 30 },
  { name: 'Ai Sign Pro API', url: 'api.aisignpro.com', warningDays: 30 },
  { name: 'SMC API', url: 'api.sendmovieclips.com', warningDays: 30 }
];

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
        
        // If it's a connection error, it might be a test environment issue
        if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
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

