/**
 * Restore May 27 team tasks from screenshot + push to GitHub
 */
const https = require('https');
const fs = require('fs');
const token = process.env.GITHUB_TOKEN || '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';

function ghRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({ hostname:'api.github.com', path, method, headers:{
      'Authorization':'token '+token,'User-Agent':'AdHash-Dashboard',
      'Accept':'application/vnd.github.v3+json','Content-Type':'application/json',
      ...(payload?{'Content-Length':Buffer.byteLength(payload)}:{})
    }}, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve({status:res.statusCode,body:JSON.parse(d)})}catch(e){resolve({status:res.statusCode,body:d})}  }); });
    req.on('error',reject); req.setTimeout(20000,()=>{req.destroy();reject(new Error('timeout'))});
    if(payload) req.write(payload);
    req.end();
  });
}

const cookie = 'adhash_auth=' + encodeURIComponent(Buffer.from('thenilavan@adhashtech.com:Qateam@123').toString('base64url'));

// May 27 team tasks from screenshot — exact data as shown
const MAY27_TEAM_TASKS = [
  {
    date: '2026-05-27',
    projectId: 'humee',
    projectType: 'Website',
    projectUrl: '',
    platform: 'Web',
    envType: 'Staging',
    taskSummary: 'Dashboard - Retesting & Regression Testing',
    taskDescription: '',
    jiraUrl: 'https://adhashtech.atlassian.net/browse/MH-1072',
    estimationHrs: '1d',
    completionDate: '2026-05-27T19:00',
    assignedBy: 'Yogesh',
    currentStatus: 'To Do',
    testingStatus: 'To Do',
    openBugs: {total:0,high:0,medium:0,low:0,assigned:0,inprogress:0},
    reopenBugs: {total:0,high:0,medium:0,low:0,assigned:0,inprogress:0,reopened:0},
    assigneeComments: '',
    assignerComments: ''
  },
  {
    date: '2026-05-27',
    projectId: 'ddp',
    projectType: 'Website',
    projectUrl: '',
    platform: 'Web',
    envType: 'Staging',
    taskSummary: 'Website - New Changes Regression Testing',
    taskDescription: '',
    jiraUrl: 'https://adhashtech.atlassian.net/browse/PROJ-605',
    estimationHrs: '1d',
    completionDate: '2026-05-27T19:00',
    assignedBy: 'Prakash Raj',
    currentStatus: 'To Do',
    testingStatus: 'To Do',
    openBugs: {total:0,high:0,medium:0,low:0,assigned:0,inprogress:0},
    reopenBugs: {total:0,high:0,medium:0,low:0,assigned:0,inprogress:0,reopened:0},
    assigneeComments: '',
    assignerComments: ''
  },
  {
    date: '2026-05-27',
    projectId: 'synctag',
    projectType: 'Website',
    projectUrl: '',
    platform: 'Web',
    envType: 'Production',
    taskSummary: 'Dashboard - On-Boarding Process & Demo Videos Preparation',
    taskDescription: '',
    jiraUrl: 'https://adhashtech.atlassian.net/browse/BE-903',
    estimationHrs: '1d',
    completionDate: '2026-05-27T19:00',
    assignedBy: 'Raghuram',
    currentStatus: 'To Do',
    testingStatus: 'To Do',
    openBugs: {total:0,high:0,medium:0,low:0,assigned:0,inprogress:0},
    reopenBugs: {total:0,high:0,medium:0,low:0,assigned:0,inprogress:0,reopened:0},
    assigneeComments: '',
    assignerComments: ''
  },
  {
    date: '2026-05-27',
    projectId: 'synctag',
    projectType: 'Website',
    projectUrl: '',
    platform: 'Web',
    envType: 'Staging',
    taskSummary: 'Dashboard - File Tag URL Regression Testing',
    taskDescription: '',
    jiraUrl: 'https://adhashtech.atlassian.net/browse/BE-904',
    estimationHrs: '4h',
    completionDate: '2026-05-27T15:00',
    assignedBy: 'Deepa',
    currentStatus: 'To Do',
    testingStatus: 'To Do',
    openBugs: {total:0,high:0,medium:0,low:0,assigned:0,inprogress:0},
    reopenBugs: {total:0,high:0,medium:0,low:0,assigned:0,inprogress:0,reopened:0},
    assigneeComments: '',
    assignerComments: ''
  },
  {
    date: '2026-05-27',
    projectId: 'aisignpro',
    projectType: 'Website',
    projectUrl: '',
    platform: 'Web',
    envType: 'Staging',
    taskSummary: 'Admin - Retesting & High-Level Regression Testing',
    taskDescription: '',
    jiraUrl: 'https://adhashtech.atlassian.net/browse/RM-997',
    estimationHrs: '4h',
    completionDate: '2026-05-27T19:00',
    assignedBy: 'Deepa',
    currentStatus: 'To Do',
    testingStatus: 'To Do',
    openBugs: {total:0,high:0,medium:0,low:0,assigned:0,inprogress:0},
    reopenBugs: {total:0,high:0,medium:0,low:0,assigned:0,inprogress:0,reopened:0},
    assigneeComments: '',
    assignerComments: ''
  },
  {
    date: '2026-05-27',
    projectId: 'adhash',
    projectType: 'Website',
    projectUrl: '',
    platform: 'Web',
    envType: 'Production',
    taskSummary: 'Client Feedback Verification in Zap CRM & Team Task Support',
    taskDescription: '',
    jiraUrl: 'https://adhashtech.atlassian.net/browse/WRK-479',
    estimationHrs: '1d',
    completionDate: '2026-05-27T19:00',
    assignedBy: 'Thenilavan',
    currentStatus: 'In Progress',
    testingStatus: 'To Do',
    openBugs: {total:0,high:0,medium:0,low:0,assigned:0,inprogress:0},
    reopenBugs: {total:0,high:0,medium:0,low:0,assigned:0,inprogress:0,reopened:0},
    assigneeComments: '',
    assignerComments: ''
  }
];

https.get('https://adhashprojectdashboard-production.up.railway.app/api/qa-data', { headers:{Cookie:cookie} }, res => {
  let body = '';
  res.on('data', d => body += d);
  res.on('end', async () => {
    const data = JSON.parse(body);

    // Add May 27 team tasks (keep all May 26 tasks, append May 27)
    const existing = data['qa3_team_tasks'] || [];
    // Remove any existing May 27 tasks (in case partial data exists)
    const withoutMay27 = existing.filter(t => !t.date || !t.date.startsWith('2026-05-27'));
    const updated = [...withoutMay27, ...MAY27_TEAM_TASKS];
    data['qa3_team_tasks'] = updated;
    console.log(`Team tasks: ${existing.length} → ${updated.length} (added ${MAY27_TEAM_TASKS.length} May 27 tasks)`);

    // Push to GitHub
    try {
      const meta = await ghRequest('GET', '/repos/AHY18099/AdHash_Project_Dashboard/contents/data/qa-shared.json', null);
      if (meta.status !== 200) { console.error('Cannot get SHA:', meta.status); return; }
      const sha = meta.body.sha;
      const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
      const result = await ghRequest('PUT', '/repos/AHY18099/AdHash_Project_Dashboard/contents/data/qa-shared.json', {
        message: 'restore: May 27 team tasks from screenshot',
        content, sha
      });
      if (result.status === 200 || result.status === 201) {
        console.log('SUCCESS — pushed to GitHub sha:', result.body.content && result.body.content.sha.slice(0,10));
        fs.writeFileSync('C:/Users/Adhash Tech/AdHash_Project_Dashboard/data/qa-shared.json', JSON.stringify(data, null, 2));
        console.log('Saved locally');
        console.log('\nMay 27 team tasks restored:');
        MAY27_TEAM_TASKS.forEach((t,i) => console.log(` ${i+1}. [${t.projectId}] ${t.taskSummary} — assigned: ${t.assignedBy} | status: ${t.currentStatus}`));
      } else {
        console.error('FAILED:', result.status, result.body && result.body.message);
      }
    } catch(e) { console.error('Error:', e.message); }
  });
}).on('error', e => console.error(e.message));
