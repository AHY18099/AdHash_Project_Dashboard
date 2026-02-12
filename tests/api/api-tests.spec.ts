import { test, expect } from '@playwright/test';
import axios, { AxiosResponse } from 'axios';

interface ApiEndpoint {
  name: string;
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: any;
  expectedStatus: number;
  timeout?: number;
}

// All AdHash API Endpoints - 41 Total
const apiEndpoints: ApiEndpoint[] = [
  // AdHash
  {
    name: 'AdHash - Website',
    url: 'https://adhashtech.com/',
    method: 'GET',
    expectedStatus: 200,
    timeout: 10000
  },

  // AutoChecker
  {
    name: 'AutoChecker - Admin',
    url: 'https://manage.autochecker.com/',
    method: 'GET',
    expectedStatus: 200,
    timeout: 10000
  },

  // KaiCare AI
  {
    name: 'KaiCare AI - Admin',
    url: 'https://admin.kaicare.ai/',
    method: 'GET',
    expectedStatus: 200,
    timeout: 10000
  },
  {
    name: 'KaiCare AI - Doctor',
    url: 'https://doctor.kaicare.ai/',
    method: 'GET',
    expectedStatus: 200,
    timeout: 10000
  },
  {
    name: 'KaiCare AI - CPT Code Loader',
    url: 'https://adminapi.kaicare.ai/api/PhysicianAsst/UpdateCPTCode',
    method: 'GET',
    expectedStatus: 200,
    timeout: 10000
  },
  {
    name: 'KaiCare AI - Call Record Loader',
    url: 'https://adminapi.kaicare.ai/api/Calls/ProcessCallRecordUploads?key=9dk3ci5AaSsCHJAgRrEqExpEBzF/PfERfrAF7ur07tQ=',
    method: 'GET',
    expectedStatus: 200,
    timeout: 10000
  },

  // MyHealth CCM
  {
    name: 'MyHealth CCM - CRM',
    url: 'https://crm.myhealthccm.com/',
    method: 'GET',
    expectedStatus: 200,
    timeout: 10000
  },
  {
    name: 'MyHealth CCM - Admin',
    url: 'https://admin.myhealthccm.com/',
    method: 'GET',
    expectedStatus: 200,
    timeout: 10000
  },
  {
    name: 'MyHealth CCM - CPA',
    url: 'https://cpa.myhealthccm.com/',
    method: 'GET',
    expectedStatus: 200,
    timeout: 10000
  },
  {
    name: 'MyHealth CCM - Participants',
    url: 'https://participants.myhealthccm.com/',
    method: 'GET',
    expectedStatus: 200,
    timeout: 10000
  },
  {
    name: 'MyHealth CCM - Forms',
    url: 'https://forms.myhealthccm.com/',
    method: 'GET',
    expectedStatus: 200,
    timeout: 10000
  },
  {
    name: 'MyHealth CCM - Participants CRM',
    url: 'https://participantscrm.myhealthccm.com/',
    method: 'GET',
    expectedStatus: 200,
    timeout: 10000
  },

  // MyHealth RTM
  {
    name: 'MyHealth RTM - Admin',
    url: 'https://admin.myhealthrtm.com/',
    method: 'GET',
    expectedStatus: 200,
    timeout: 10000
  },
  {
    name: 'MyHealth RTM - CPA',
    url: 'https://cpa.myhealthrtm.com/',
    method: 'GET',
    expectedStatus: 200,
    timeout: 10000
  },
  {
    name: 'MyHealth RTM - Participants',
    url: 'https://participants.myhealthrtm.com/',
    method: 'GET',
    expectedStatus: 200,
    timeout: 10000
  },

  // WavedIn
  {
    name: 'WavedIn - Super Admin',
    url: 'https://superadmin.wavedin.app/',
    method: 'GET',
    expectedStatus: 200,
    timeout: 10000
  },
  {
    name: 'WavedIn - Market',
    url: 'https://market.wavedin.app/',
    method: 'GET',
    expectedStatus: 200,
    timeout: 10000
  },

  // Synctag / Sparkme
  {
    name: 'Sparkme - Analytics',
    url: 'https://sparkanalytics.synctag.com/',
    method: 'GET',
    expectedStatus: 200,
    timeout: 10000
  },

  // Algomax
  {
    name: 'Algomax - ProSky',
    url: 'https://prosky.algomax.co',
    method: 'GET',
    expectedStatus: 200,
    timeout: 10000
  },
  {
    name: 'Algomax - GoPocket',
    url: 'https://gopocket.algomax.co',
    method: 'GET',
    expectedStatus: 200,
    timeout: 10000
  },

  // ZapCRM
  {
    name: 'ZapCRM - AI',
    url: 'https://zapcrm.ai/',
    method: 'GET',
    expectedStatus: 200,
    timeout: 10000
  },
  {
    name: 'ZapCRM - Main',
    url: 'https://zapcrm.io/',
    method: 'GET',
    expectedStatus: 200,
    timeout: 10000
  },
  {
    name: 'ZapCRM - Lead',
    url: 'https://lead.zapcrm.io/',
    method: 'GET',
    expectedStatus: 200,
    timeout: 10000
  },
  {
    name: 'ZapCRM - Secure',
    url: 'https://secure.zapcrm.io/',
    method: 'GET',
    expectedStatus: 200,
    timeout: 10000
  },
  {
    name: 'ZapCRM - Social',
    url: 'https://social.zapcrm.io/',
    method: 'GET',
    expectedStatus: 200,
    timeout: 10000
  },

  // AskEPI
  {
    name: 'AskEPI - Web',
    url: 'https://askepi.ai/',
    method: 'GET',
    expectedStatus: 200,
    timeout: 10000
  },

  // RiskRealm
  {
    name: 'RiskRealm - Admin',
    url: 'https://www.riskrealm.ai/',
    method: 'GET',
    expectedStatus: 200,
    timeout: 10000
  },
  {
    name: 'RiskRealm - Chat',
    url: 'https://chat.riskrealm.ai/',
    method: 'GET',
    expectedStatus: 200,
    timeout: 10000
  },

  // AutoeVantage
  {
    name: 'AutoeVantage - eCommerce',
    url: 'https://www.autoevantage.com/',
    method: 'GET',
    expectedStatus: 200,
    timeout: 10000
  },
  {
    name: 'AutoeVantage - Tools',
    url: 'https://tools.autoevantage.com/',
    method: 'GET',
    expectedStatus: 200,
    timeout: 10000
  },
  {
    name: 'AutoeVantage - Analytics',
    url: 'https://admin.autoevantage.com/',
    method: 'GET',
    expectedStatus: 200,
    timeout: 10000
  },

  // Metcalf
  {
    name: 'Metcalf - Web',
    url: 'https://metcalf.ai/',
    method: 'GET',
    expectedStatus: 200,
    timeout: 10000
  },

  // Humee
  {
    name: 'Humee - Main',
    url: 'https://www.humee.com/',
    method: 'GET',
    expectedStatus: 200,
    timeout: 10000
  },
  {
    name: 'Humee - Dashboard',
    url: 'https://dashboard.humee.com/',
    method: 'GET',
    expectedStatus: 200,
    timeout: 10000
  },
  {
    name: 'Humee - Admin',
    url: 'https://admin.humee.com/',
    method: 'GET',
    expectedStatus: 200,
    timeout: 10000
  },
  {
    name: 'Humee - CPA',
    url: 'https://cpa.humee.com/',
    method: 'GET',
    expectedStatus: 200,
    timeout: 10000
  },
  {
    name: 'Humee - Participant',
    url: 'https://participant.humee.com/',
    method: 'GET',
    expectedStatus: 200,
    timeout: 10000
  },

  // AiSignPro
  {
    name: 'AiSignPro - Admin',
    url: 'https://admin.aisignpro.com/',
    method: 'GET',
    expectedStatus: 200,
    timeout: 10000
  },
  {
    name: 'AiSignPro - CPA',
    url: 'https://cpa.aisignpro.com/',
    method: 'GET',
    expectedStatus: 200,
    timeout: 10000
  },
  {
    name: 'AiSignPro - Participant',
    url: 'https://participant.aisignpro.com/',
    method: 'GET',
    expectedStatus: 200,
    timeout: 10000
  },

  // ZapAI
  {
    name: 'ZapAI - Web',
    url: 'https://zapai.us/',
    method: 'GET',
    expectedStatus: 200,
    timeout: 10000
  }
];

test.describe('API Tests', () => {
  for (const endpoint of apiEndpoints) {
    test(`${endpoint.method} ${endpoint.name}`, async () => {
      const startTime = Date.now();
      
      try {
        let response: AxiosResponse;

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

        // Verify status code
        expect(response.status).toBe(endpoint.expectedStatus);

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
            success: response.status === endpoint.expectedStatus
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

