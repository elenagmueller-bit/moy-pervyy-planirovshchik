import { STORE_DEFINITIONS, requestToPromise, runTransaction } from "./db.js";

export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_STORES = Object.freeze(["tasks", "series", "notes", "settings"]);

function safeSettings(settings) {
  const forbidden = /(token|secret|credential|authorization|sync)/i;
  const clean = (value) => {
    if (Array.isArray(value)) return value.map(clean);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => !forbidden.test(key)).map(([key, child]) => [key, clean(child)]));
  };
  return settings.map(clean);
}

export async function createBackup(database, now = new Date()) {
  const data = await runTransaction(database, BACKUP_STORES, "readonly", async (stores) => {
    const result = {};
    for (const name of BACKUP_STORES) result[name] = await requestToPromise(stores[name].getAll());
    result.settings = safeSettings(result.settings);
    return result;
  });
  return {
    format: "personal-planner-backup",
    version: BACKUP_FORMAT_VERSION,
    createdAt: now.toISOString(),
    deviceTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "local",
    data,
  };
}

export function backupFileName(now = new Date()) {
  return `planner-backup-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}.json`;
}

function assertRecords(name, records) {
  if (!Array.isArray(records)) throw new TypeError(`Раздел ${name} должен быть массивом`);
  const ids = new Set();
  records.forEach((record) => {
    const key = STORE_DEFINITIONS[name].keyPath;
    if (!record || typeof record !== "object" || Array.isArray(record) || typeof record[key] !== "string" || !record[key]) throw new TypeError(`Некорректная запись в разделе ${name}`);
    if (ids.has(record[key])) throw new TypeError(`Повторяющийся идентификатор в разделе ${name}`);
    ids.add(record[key]);
  });
}

export function parseBackup(value) {
  let backup;
  try { backup = typeof value === "string" ? JSON.parse(value) : structuredClone(value); }
  catch { throw new TypeError("Файл не является корректным JSON"); }
  if (backup?.format !== "personal-planner-backup" || backup.version !== BACKUP_FORMAT_VERSION) throw new TypeError("Несовместимая версия резервной копии");
  if (!backup.data || typeof backup.data !== "object") throw new TypeError("В резервной копии нет данных");
  BACKUP_STORES.forEach((name) => assertRecords(name, backup.data[name]));
  return backup;
}

export function importPreview(backup) {
  const checked = parseBackup(backup);
  return {
    tasks: checked.data.tasks.length,
    series: checked.data.series.length,
    notes: checked.data.notes.length,
    settings: checked.data.settings.length,
  };
}

function isIncomingNewer(current, incoming) {
  if (!current) return true;
  if (!incoming.updatedAt || !current.updatedAt) return false;
  return incoming.updatedAt > current.updatedAt;
}

export async function importBackup(database, value, mode = "merge") {
  const backup = parseBackup(value);
  if (!["merge", "replace"].includes(mode)) throw new TypeError("Неизвестный режим импорта");
  return runTransaction(database, BACKUP_STORES, "readwrite", async (stores) => {
    if (mode === "replace") for (const name of BACKUP_STORES) await requestToPromise(stores[name].clear());
    for (const name of BACKUP_STORES) {
      for (const incoming of backup.data[name]) {
        const key = STORE_DEFINITIONS[name].keyPath;
        const current = mode === "merge" ? await requestToPromise(stores[name].get(incoming[key])) : null;
        if (mode === "replace" || isIncomingNewer(current, incoming)) await requestToPromise(stores[name].put(incoming));
      }
    }
    return importPreview(backup);
  });
}

export async function clearLocalData(database) {
  const names = Object.keys(STORE_DEFINITIONS);
  await runTransaction(database, names, "readwrite", async (stores) => {
    for (const name of names) await requestToPromise(stores[name].clear());
    await requestToPromise(stores.meta.put({ key: "schemaVersion", value: database.version, clearedAt: new Date().toISOString() }));
  });
}
