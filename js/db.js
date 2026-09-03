import { DB_NAME, DB_VERSION } from "./config.js";

export const STORE_DEFINITIONS = Object.freeze({
  tasks: { keyPath: "id", indexes: [["date", "date"], ["status", "status"], ["category", "category"], ["updatedAt", "updatedAt"], ["seriesId", "seriesId"], ["archivedAt", "archivedAt"], ["trashedAt", "trashedAt"]] },
  series: { keyPath: "id", indexes: [["updatedAt", "updatedAt"], ["startDate", "startDate"]] },
  notes: { keyPath: "id", indexes: [["category", "category"], ["priority", "priority"], ["updatedAt", "updatedAt"], ["archivedAt", "archivedAt"], ["trashedAt", "trashedAt"]] },
  googleCalendars: { keyPath: "id", indexes: [["selected", "selected"], ["accessRole", "accessRole"]] },
  googleEventsCache: { keyPath: "cacheKey", indexes: [["calendarId", "calendarId"], ["start", "start"], ["updated", "updated"]] },
  syncState: { keyPath: "calendarId", indexes: [] },
  syncQueue: { keyPath: "id", autoIncrement: true, indexes: [["objectId", "objectId"], ["createdAt", "createdAt"], ["status", "status"]] },
  conflictHistory: { keyPath: "id", autoIncrement: true, indexes: [["objectId", "objectId"], ["expiresAt", "expiresAt"]] },
  settings: { keyPath: "id", indexes: [] },
  meta: { keyPath: "key", indexes: [] },
});

function ensureStore(database, transaction, name, definition) {
  const store = database.objectStoreNames.contains(name)
    ? transaction.objectStore(name)
    : database.createObjectStore(name, { keyPath: definition.keyPath, autoIncrement: definition.autoIncrement });
  definition.indexes.forEach(([indexName, keyPath, options]) => {
    if (!store.indexNames.contains(indexName)) store.createIndex(indexName, keyPath, options);
  });
}

export function openPlannerDatabase({ name = DB_NAME, version = DB_VERSION } = {}) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = (event) => {
      const database = request.result;
      const transaction = request.transaction;
      Object.entries(STORE_DEFINITIONS).forEach(([storeName, definition]) => ensureStore(database, transaction, storeName, definition));
      transaction.objectStore("meta").put({ key: "schemaVersion", value: version, migratedFrom: event.oldVersion });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Обновление локальной базы заблокировано другой вкладкой"));
  });
}

export function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new DOMException("Транзакция отменена", "AbortError"));
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function runTransaction(database, storeNames, mode, operation) {
  const names = Array.isArray(storeNames) ? storeNames : [storeNames];
  const transaction = database.transaction(names, mode);
  const completion = transactionDone(transaction);
  const stores = Object.fromEntries(names.map((name) => [name, transaction.objectStore(name)]));
  let result;
  try {
    result = await operation(stores, transaction);
  } catch (error) {
    transaction.abort();
    try { await completion; } catch { /* ожидаемый откат */ }
    throw error;
  }
  await completion;
  return result;
}

export function deletePlannerDatabase(name = DB_NAME) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Удаление базы заблокировано"));
  });
}
