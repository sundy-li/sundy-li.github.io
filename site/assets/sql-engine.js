const DUCKDB_MODULE = 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.32.0/+esm';
const ROW_LIMIT = 50;

const PROFILE_URL = new URL('../data/profile.json', import.meta.url);
const PROFILE_COLUMNS = [
  'name', 'handle', 'location', 'university', 'focus_areas', 'tech_stack',
  'organization', 'organization_url', 'current_project', 'project_url', 'project_summary',
  'early_project', 'early_project_url', 'github', 'telegram', 'x', 'site_source',
];
const PROFILE_LIST_COLUMNS = new Set(['focus_areas', 'tech_stack']);

async function seedProfile(connection, profile, lang) {
  const locale = lang === 'zh-CN' ? 'zh-CN' : 'en';
  const values = PROFILE_COLUMNS.map((column) => {
    const value = profile[column];
    return typeof value === 'string' || Array.isArray(value) ? value : value[locale];
  });
  const definitions = PROFILE_COLUMNS.map((name) => `${name} VARCHAR${PROFILE_LIST_COLUMNS.has(name) ? '[]' : ''}`);
  const parameters = values.map((value) => Array.isArray(value) ? `[${value.map(() => '?').join(', ')}]` : '?');
  await connection.query(`CREATE TABLE profile (${definitions.join(', ')})`);
  const insert = await connection.prepare(`INSERT INTO profile VALUES (${parameters.join(', ')})`);
  try {
    await insert.query(...values.flat());
  } finally {
    await insert.close();
  }
}

export async function openEngine(signal, lang) {
  const profileResponse = await fetch(PROFILE_URL, { signal });
  if (!profileResponse.ok) throw new Error(`Profile download failed (${profileResponse.status}).`);
  const profile = await profileResponse.json();
  const duckdb = await import(DUCKDB_MODULE);
  signal.throwIfAborted();
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const workerResponse = await fetch(bundle.mainWorker, { signal });
  if (!workerResponse.ok) throw new Error(`Worker download failed (${workerResponse.status}).`);
  const workerUrl = URL.createObjectURL(await workerResponse.blob());
  let worker;
  try {
    signal.throwIfAborted();
    worker = new Worker(workerUrl);
  } finally {
    URL.revokeObjectURL(workerUrl);
  }

  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  const close = () => { void db.terminate(); };
  signal.addEventListener('abort', close, { once: true });
  try {
    await db.instantiate(bundle.mainModule);
    const connection = await db.connect();
    // This demo uses public profile data only. Disable external files and extension downloads.
    await connection.query(`
      SET memory_limit = '128MB';
      SET enable_external_access = false;
      SET autoinstall_known_extensions = false;
      SET autoload_known_extensions = false;
      SET lock_configuration = true;
    `);
    signal.throwIfAborted();
    await seedProfile(connection, profile, lang);
    signal.throwIfAborted();
    return { connection, close };
  } catch (error) {
    close();
    throw error;
  } finally {
    signal.removeEventListener('abort', close);
  }
}

export async function queryDatabase(connection, sql) {
  const reader = await connection.send(sql, true);
  await reader.open();
  const columns = reader.schema.fields.map(({ name }) => name);
  const rows = [];
  let limited = false;
  for await (const batch of reader) {
    const vectors = columns.map((_, index) => batch.getChildAt(index));
    const size = Math.min(batch.numRows, ROW_LIMIT - rows.length);
    for (let i = 0; i < size; i++) rows.push(vectors.map(vector => vector.get(i)));
    if (size < batch.numRows) {
      limited = true;
      break;
    }
  }
  if (limited) await connection.cancelSent();
  return { columns, rows, limited };
}
