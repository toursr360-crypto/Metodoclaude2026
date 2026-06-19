import { TABLES, buildCreateTableSql, buildCreateTableSqlPg } from "./schema.js";
import { MIGRATIONS, latestVersion } from "./migrations/index.js";
import { getMetaAsync, setMetaAsync } from "./helpers/metaStore.js";
import { getAppVersion } from "./version.js";
import { stringifyJson } from "./helpers/jsonCol.js";

const _migratedAdapters = new WeakSet();

export class MigrationAborted extends Error {
  constructor(message, droppedRows) {
    super(message);
    this.name = "MigrationAborted";
    this.droppedRows = droppedRows;
  }
}

function getTableBuilder(adapter) {
  return adapter.isPg ? buildCreateTableSqlPg : buildCreateTableSql;
}

async function isFreshDb(adapter) {
  try {
    const row = await adapter.get(`SELECT COUNT(*) as c FROM _meta`);
    return !row || (row.c === 0 || row.c === "0");
  } catch {
    return true;
  }
}

async function runVersionedMigrations(adapter) {
  const buildSql = getTableBuilder(adapter);
  await adapter.exec(buildSql("_meta", TABLES._meta));

  const current = parseInt(await getMetaAsync(adapter, "schemaVersion", "0"), 10) || 0;
  const target = latestVersion();
  if (current >= target) return { applied: 0, from: current, to: current };

  const pending = MIGRATIONS.filter((m) => m.version > current);
  let lastApplied = current;
  for (const m of pending) {
    await adapter.transaction(async () => {
      await m.up(adapter);
      await setMetaAsync(adapter, "schemaVersion", m.version);
    });
    lastApplied = m.version;
    console.log(`[DB][migrate] applied #${m.version} ${m.name}`);
  }
  return { applied: pending.length, from: current, to: lastApplied };
}

async function syncSchemaFromTables(adapter) {
  const buildSql = getTableBuilder(adapter);
  for (const [tableName, def] of Object.entries(TABLES)) {
    await adapter.exec(buildSql(tableName, def));

    const existing = await adapter.tableInfo(tableName);
    const existingNames = new Set(existing.map((r) => r.name));

    for (const [colName, colDef] of Object.entries(def.columns)) {
      if (!existingNames.has(colName)) {
        const safeDef = colDef
          .replace(/PRIMARY KEY( AUTOINCREMENT)?/i, "")
          .replace(/UNIQUE/i, "")
          .replace(/AUTOINCREMENT/i, "")
          .trim();
        try {
          await adapter.exec(`ALTER TABLE ${tableName} ADD COLUMN ${colName} ${safeDef}`);
          console.log(`[DB][sync] +column ${tableName}.${colName}`);
        } catch (e) {
          console.warn(`[DB][sync] add column ${tableName}.${colName} failed: ${e.message}`);
        }
      }
    }

    for (const idx of def.indexes || []) {
      try { await adapter.exec(idx); } catch {}
    }
  }
}

async function importLegacyData(adapter) {
  if (adapter.isPg) return;

  let fs, path, LEGACY_FILES, DB_DIR, DATA_FILE, makeBackupDir, backupFile, pruneOldBackups;
  try {
    ({ default: fs } = await import("node:fs"));
    ({ default: path } = await import("node:path"));
    ({ LEGACY_FILES, DB_DIR, DATA_FILE } = await import("./paths.js"));
    ({ makeBackupDir, backupFile, pruneOldBackups } = await import("./backup.js"));
  } catch {
    return;
  }

  const MIGRATED_MARKER = path.join(DB_DIR, ".migrated-from-json");
  const readJsonSafe = (file) => {
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return null; }
  };

  const fresh = await isFreshDb(adapter);
  const alreadyImported = fs.existsSync(MIGRATED_MARKER);
  const legacyMain = readJsonSafe(LEGACY_FILES.main);
  const legacyUsage = readJsonSafe(LEGACY_FILES.usage);
  const legacyDisabled = readJsonSafe(LEGACY_FILES.disabled);
  const legacyDetails = readJsonSafe(LEGACY_FILES.details);
  const hasLegacy = !!(legacyMain || legacyUsage || legacyDisabled || legacyDetails);

  if (!fresh || !hasLegacy || alreadyImported) return;

  const t0 = Date.now();
  const backupDir = makeBackupDir("migrate-from-json");
  for (const f of Object.values(LEGACY_FILES)) backupFile(f, backupDir);

  try {
    await adapter.transaction(async () => {
      if (legacyMain?.settings) {
        await adapter.run(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, [stringifyJson(legacyMain.settings)]);
      }
      await setMetaAsync(adapter, "appVersion", getAppVersion());
      await setMetaAsync(adapter, "migratedAt", new Date().toISOString());
    });
  } catch (err) {
    console.error(`[DB][migrate] aborted: ${err.message}`);
    return;
  }

  try { fs.writeFileSync(MIGRATED_MARKER, new Date().toISOString()); } catch {}
  pruneOldBackups();
  console.log(`[DB][migrate] JSON → SQLite in ${Date.now() - t0}ms`);
}

export async function runMigrationOnce(adapter) {
  if (_migratedAdapters.has(adapter)) return;
  _migratedAdapters.add(adapter);

  const fresh = await isFreshDb(adapter);
  const migInfo = await runVersionedMigrations(adapter);
  await syncSchemaFromTables(adapter);

  if (!adapter.isPg) {
    await importLegacyData(adapter);
  }

  if (fresh) {
    await setMetaAsync(adapter, "appVersion", getAppVersion());
    return;
  }

  try {
    if (adapter.isPg) { await setMetaAsync(adapter, "appVersion", getAppVersion()); return; }
    const { makeBackupDir, backupFile, pruneOldBackups } = await import("./backup.js");
    const { DATA_FILE } = await import("./paths.js");
    const oldVer = await getMetaAsync(adapter, "appVersion", null);
    const newVer = getAppVersion();
    if (oldVer && oldVer !== newVer) {
      const backupDir = makeBackupDir(`upgrade-${oldVer}-to-${newVer}`);
      try { backupFile(DATA_FILE, backupDir); } catch {}
      await setMetaAsync(adapter, "appVersion", newVer);
      pruneOldBackups();
      console.log(`[DB][migrate] App ${oldVer} → ${newVer} | schema ${migInfo.from} → ${migInfo.to}`);
    } else if (migInfo.applied > 0) {
      const backupDir = makeBackupDir(`schema-${migInfo.from}-to-${migInfo.to}`);
      try { backupFile(DATA_FILE, backupDir); } catch {}
      pruneOldBackups();
    }
  } catch {}
}
