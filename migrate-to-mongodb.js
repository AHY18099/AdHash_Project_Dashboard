/**
 * migrate-to-mongodb.js
 * Migrates all data from qa-shared.json (or qa-backup.json) into MongoDB Atlas.
 *
 * Run ONCE after Atlas is set up:
 *   MONGODB_URI=... MONGODB_DB=adhash_qa node migrate-to-mongodb.js
 *
 * Safe to run multiple times — uses upsert so no duplicates are created.
 */

require('dotenv').config();
const { MongoClient, ObjectId } = require('mongodb');
const fs = require('fs');
const path = require('path');

function stripBOM(str) {
  return str.charCodeAt(0) === 0xFEFF ? str.slice(1) : str;
}

function deduplicateById(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  return arr.filter(item => {
    const k = item.id || JSON.stringify(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function ensureId(item) {
  return { ...item, id: item.id || new ObjectId().toString() };
}

async function upsert(col, projectId, item) {
  const doc = ensureId(item);
  // Strip MongoDB-internal fields that cannot be set via $set
  const { _id, ...safeDoc } = doc;
  await col.updateOne(
    { id: safeDoc.id },
    {
      $set: { ...safeDoc, projectId, updatedAt: new Date(), createdAt: safeDoc.createdAt || new Date() }
    },
    { upsert: true }
  );
  return safeDoc;
}

async function migrate() {
  if (!process.env.MONGODB_URI) {
    console.error('❌  MONGODB_URI is not set. Add it to .env or pass as env var.');
    process.exit(1);
  }

  // ── Load source data ──────────────────────────────────────────────────────
  let rawData;
  const candidates = [
    'qa-backup.json',
    'data/qa-shared.json',
    path.join(__dirname, 'qa-backup.json'),
    path.join(__dirname, 'data', 'qa-shared.json'),
  ];
  for (const f of candidates) {
    if (fs.existsSync(f)) {
      console.log(`📂  Reading source: ${f}`);
      rawData = JSON.parse(stripBOM(fs.readFileSync(f, 'utf8')));
      break;
    }
  }
  if (!rawData) {
    console.error('❌  No data file found. Expected qa-backup.json or data/qa-shared.json');
    process.exit(1);
  }

  // ── Connect ───────────────────────────────────────────────────────────────
  const client = new MongoClient(process.env.MONGODB_URI, {
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 10000,
  });
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || 'adhash_qa');
  console.log(`✅  Connected to MongoDB — db: ${db.databaseName}\n`);

  const summary = {};
  function count(col, n) { summary[col] = (summary[col] || 0) + n; }

  // ── Users ─────────────────────────────────────────────────────────────────
  const users = deduplicateById(rawData.qa_users || []);
  if (users.length) {
    const col = db.collection('users');
    for (const u of users) await upsert(col, 'global', u);
    count('users', users.length);
    console.log(`  users: ${users.length}`);
  }

  // ── Releases ──────────────────────────────────────────────────────────────
  const releases = deduplicateById(rawData.qa3_releases || []);
  if (releases.length) {
    const col = db.collection('releases');
    for (const r of releases) await upsert(col, 'global', r);
    count('releases', releases.length);
    console.log(`  releases: ${releases.length}`);
  }

  // ── Daily tasks ───────────────────────────────────────────────────────────
  const dailyTasks = deduplicateById(rawData.qa3_daily_tasks || []);
  if (dailyTasks.length) {
    const col = db.collection('daily_tasks');
    for (const t of dailyTasks) await upsert(col, t.projectId || 'global', t);
    count('daily_tasks', dailyTasks.length);
    console.log(`  daily_tasks: ${dailyTasks.length}`);
  }

  // ── Team tasks ────────────────────────────────────────────────────────────
  const teamTasks = deduplicateById(rawData.qa3_team_tasks || []);
  if (teamTasks.length) {
    const col = db.collection('team_tasks');
    for (const t of teamTasks) await upsert(col, t.projectId || 'global', t);
    count('team_tasks', teamTasks.length);
    console.log(`  team_tasks: ${teamTasks.length}`);
  }

  // ── Per-project data ──────────────────────────────────────────────────────
  const skipKeys = new Set([
    'qa_users', 'qa3_daily_tasks', 'qa3_team_tasks', 'qa3_releases',
    'qa3_save_test', 'qa3_test_1', 'qa3_test_2', 'qa3_heartbeat_test',
    '_deployVersion',
  ]);

  const projectKeys = Object.keys(rawData).filter(
    k => k.startsWith('qa3_') && !skipKeys.has(k)
  );

  console.log(`\n📋  Migrating ${projectKeys.length} projects…\n`);

  for (const key of projectKeys) {
    const projectId = key.replace('qa3_', '');
    const proj = rawData[key];
    if (!proj || typeof proj !== 'object' || Array.isArray(proj)) continue;

    console.log(`  ▸ ${projectId}`);

    // Save project-level config (env, gates, env overview)
    await db.collection('projects').updateOne(
      { id: projectId },
      {
        $set: {
          id:        projectId,
          env:       proj.env       || {},
          gates:     proj.gates     || [],
          updatedAt: new Date(),
          createdAt: new Date(),
        }
      },
      { upsert: true }
    );

    // section → collection name mapping
    const sectionMap = [
      { src: 'credentials',  col: 'credentials'     },
      { src: 'smoke',        col: 'smoke_tests'      },
      { src: 'prod',         col: 'prod_checklist'   },
      { src: 'taskchecklist',col: 'task_checklist'   },
      { src: 'thirdparty',   col: 'third_party'      },
      { src: 'feedback',     col: 'client_feedback'  },
      { src: 'reports',      col: 'saved_reports'    },
      { src: 'releaseNotes', col: 'release_notes'    },
      { src: 'pendingtasks', col: 'pending_tasks'    },
      { src: 'apitests',     col: 'api_tests'        },
      { src: 'testdata',     col: 'test_data'        },
      { src: 'wfdocs',       col: 'workflow_docs'    },
    ];

    for (const { src, col: colName } of sectionMap) {
      const items = deduplicateById(proj[src] || []);
      if (!items.length) continue;
      const col = db.collection(colName);
      for (const item of items) await upsert(col, projectId, item);
      count(colName, items.length);
      console.log(`      ${colName}: ${items.length}`);
    }

    // env_details (production + staging arrays merged into one collection)
    const envDetails = proj.envDetails || {};
    const prodEnvs = deduplicateById(
      (envDetails.production || []).map(e => ({ ...e, envType: 'production' }))
    );
    const stagEnvs = deduplicateById(
      (envDetails.staging || []).map(e => ({ ...e, envType: 'staging' }))
    );
    const allEnvs = [...prodEnvs, ...stagEnvs];
    if (allEnvs.length) {
      const col = db.collection('env_details');
      for (const e of allEnvs) await upsert(col, projectId, e);
      count('env_details', allEnvs.length);
      console.log(`      env_details: ${allEnvs.length}`);
    }
  }

  // ── Create indexes ────────────────────────────────────────────────────────
  console.log('\n🔧  Creating indexes…');
  const indexedCols = [
    'credentials', 'smoke_tests', 'prod_checklist', 'task_checklist',
    'third_party', 'client_feedback', 'saved_reports', 'release_notes',
    'pending_tasks', 'api_tests', 'workflow_docs', 'env_details',
    'daily_tasks', 'team_tasks', 'releases', 'users', 'projects',
  ];
  for (const c of indexedCols) {
    await db.collection(c).createIndex({ id: 1 }, { unique: true, sparse: true, background: true });
    await db.collection(c).createIndex({ projectId: 1 }, { background: true });
  }
  console.log('  ✅  Indexes created\n');

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('━'.repeat(50));
  console.log('MIGRATION COMPLETE — DOCUMENT COUNTS:');
  console.log('━'.repeat(50));
  const projectCount = await db.collection('projects').countDocuments();
  console.log(`  ${'projects'.padEnd(22)} ${projectCount}`);
  for (const [col, n] of Object.entries(summary).sort()) {
    console.log(`  ${col.padEnd(22)} ${n}`);
  }
  console.log('━'.repeat(50));
  console.log('\n✅  Verify these counts in MongoDB Atlas → Browse Collections.');
  console.log('✅  If counts look correct → tell Claude to proceed to Phase 2.\n');

  await client.close();
}

migrate().catch(err => {
  console.error('❌  Migration failed:', err.message);
  process.exit(1);
});
