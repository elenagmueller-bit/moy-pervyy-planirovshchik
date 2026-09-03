import { requestToPromise, runTransaction } from "./db.js";

export class Repository {
  constructor(database, storeName) {
    this.database = database;
    this.storeName = storeName;
  }

  get(id) {
    return runTransaction(this.database, this.storeName, "readonly", ({ [this.storeName]: store }) => requestToPromise(store.get(id)));
  }

  getAll() {
    return runTransaction(this.database, this.storeName, "readonly", ({ [this.storeName]: store }) => requestToPromise(store.getAll()));
  }

  put(value) {
    return runTransaction(this.database, this.storeName, "readwrite", ({ [this.storeName]: store }) => requestToPromise(store.put(value)));
  }

  delete(id) {
    return runTransaction(this.database, this.storeName, "readwrite", ({ [this.storeName]: store }) => requestToPromise(store.delete(id)));
  }
}

export function createRepositories(database) {
  return Object.freeze({
    tasks: new Repository(database, "tasks"),
    series: new Repository(database, "series"),
    notes: new Repository(database, "notes"),
    googleCalendars: new Repository(database, "googleCalendars"),
    googleEventsCache: new Repository(database, "googleEventsCache"),
    syncState: new Repository(database, "syncState"),
    syncQueue: new Repository(database, "syncQueue"),
    conflictHistory: new Repository(database, "conflictHistory"),
    settings: new Repository(database, "settings"),
    meta: new Repository(database, "meta"),
  });
}
