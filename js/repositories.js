import { LIMITS } from "./config.js";
import { combineLocalDateTime, todayString, toUtcTimestamp } from "./date-utils.js";
import { createTask, updateTaskRecord } from "./models.js";
import { requestToPromise, runTransaction } from "./db.js";

const DAY_MS = 86_400_000;
const PRIORITY_ORDER = Object.freeze({ high: 0, medium: 1, low: 2 });

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

export class TaskRepository extends Repository {
  constructor(database) {
    super(database, "tasks");
  }

  create(input, now = new Date()) {
    const task = createTask(input, now);
    return runTransaction(this.database, "tasks", "readwrite", ({ tasks }) => requestToPromise(tasks.add(task))).then(() => task);
  }

  update(id, patch, { now = new Date(), expectedRevision } = {}) {
    return runTransaction(this.database, "tasks", "readwrite", async ({ tasks }) => {
      const current = await requestToPromise(tasks.get(id));
      if (!current) throw new DOMException("Задача не найдена", "NotFoundError");
      if (Number.isInteger(expectedRevision) && current.revision !== expectedRevision) {
        throw new DOMException("Задача уже изменена в другой вкладке", "VersionError");
      }
      const updated = updateTaskRecord(current, patch, now);
      await requestToPromise(tasks.put(updated));
      return updated;
    });
  }

  complete(id, now = new Date()) {
    return this.update(id, { status: "completed", completedAt: toUtcTimestamp(now), cancelledAt: null }, { now });
  }

  reopen(id, now = new Date()) {
    return this.update(id, { status: "active", completedAt: null, cancelledAt: null }, { now });
  }

  cancel(id, now = new Date()) {
    const timestamp = toUtcTimestamp(now);
    return this.update(id, { status: "cancelled", cancelledAt: timestamp, archivedAt: timestamp, completedAt: null }, { now });
  }

  archive(id, now = new Date()) {
    return this.update(id, { archivedAt: toUtcTimestamp(now) }, { now });
  }

  restoreFromArchive(id, now = new Date()) {
    return runTransaction(this.database, "tasks", "readwrite", async ({ tasks }) => {
      const current = await requestToPromise(tasks.get(id));
      if (!current) throw new DOMException("Задача не найдена", "NotFoundError");
      const patch = current.status === "cancelled"
        ? { archivedAt: null, status: "active", cancelledAt: null }
        : { archivedAt: null };
      const updated = updateTaskRecord(current, patch, now);
      await requestToPromise(tasks.put(updated));
      return updated;
    });
  }

  moveToTrash(id, now = new Date()) {
    return this.update(id, { trashedAt: toUtcTimestamp(now) }, { now });
  }

  restoreFromTrash(id, now = new Date()) {
    return this.update(id, { trashedAt: null }, { now });
  }

  async deleteForever(id) {
    const task = await this.get(id);
    if (!task?.trashedAt) throw new DOMException("Окончательно удалить можно только из корзины", "InvalidStateError");
    await this.delete(id);
    return task;
  }

  async cleanupExpiredTrash({ now = new Date(), force = false } = {}) {
    const cutoff = now.getTime() - LIMITS.trashRetentionDays * DAY_MS;
    const interval = LIMITS.trashCleanupIntervalHours * 3_600_000;
    return runTransaction(this.database, ["tasks", "meta"], "readwrite", async ({ tasks, meta }) => {
      const lastRun = await requestToPromise(meta.get("taskTrashCleanup"));
      if (!force && lastRun?.value && now.getTime() - Date.parse(lastRun.value) < interval) {
        return { skipped: true, deleted: 0 };
      }
      const allTasks = await requestToPromise(tasks.getAll());
      const expired = allTasks.filter((task) => task.trashedAt && Date.parse(task.trashedAt) <= cutoff);
      expired.forEach((task) => tasks.delete(task.id));
      meta.put({ key: "taskTrashCleanup", value: toUtcTimestamp(now) });
      return { skipped: false, deleted: expired.length };
    });
  }
}

export function isTaskOverdue(task, now = new Date()) {
  if (!task || task.status !== "active" || task.archivedAt || task.trashedAt) return false;
  const today = todayString(now);
  if (task.date < today) return true;
  if (task.date > today || !task.hasTime) return false;
  const end = combineLocalDateTime(task.date, task.startTime);
  end.setMinutes(end.getMinutes() + task.durationMinutes);
  return end.getTime() < now.getTime();
}

export function taskDeletionDate(task) {
  if (!task?.trashedAt) return null;
  return new Date(Date.parse(task.trashedAt) + LIMITS.trashRetentionDays * DAY_MS);
}

export function filterTasks(tasks, route, filters = {}, now = new Date()) {
  const today = todayString(now);
  return tasks.filter((task) => {
    if (route === "trash") return Boolean(task.trashedAt);
    if (task.trashedAt) return false;
    if (route === "archive") return Boolean(task.archivedAt);
    if (task.archivedAt && !filters.includeArchived) return false;
    if (route === "today" && task.date !== today && !isTaskOverdue(task, now)) return false;
    if (route === "work" && task.category !== "work") return false;
    if (route === "personal" && task.category !== "personal") return false;
    if (filters.dateFrom && task.date < filters.dateFrom) return false;
    if (filters.dateTo && task.date > filters.dateTo) return false;
    if (filters.category && task.category !== filters.category) return false;
    if (filters.priority && task.priority !== filters.priority) return false;
    if (filters.status && task.status !== filters.status) return false;
    if (filters.time === "timed" && !task.hasTime) return false;
    if (filters.time === "untimed" && task.hasTime) return false;
    if (filters.recurrence === "recurring" && !task.recurrence && !task.seriesId) return false;
    if (filters.recurrence === "single" && (task.recurrence || task.seriesId)) return false;
    if (filters.google === "synced" && !task.googleSync) return false;
    if (filters.google === "local" && task.googleSync) return false;
    if (filters.tags) {
      const wanted = filters.tags.toLocaleLowerCase("ru-RU").split(",").map((tag) => tag.trim()).filter(Boolean);
      const actual = task.tags.map((tag) => tag.toLocaleLowerCase("ru-RU"));
      if (!wanted.every((tag) => actual.includes(tag))) return false;
    }
    return true;
  });
}

export function sortTasks(tasks, sort = "date") {
  const values = [...tasks];
  const byDate = (left, right) => left.date.localeCompare(right.date)
    || Number(left.hasTime) - Number(right.hasTime)
    || String(left.startTime || "").localeCompare(String(right.startTime || ""))
    || left.createdAt.localeCompare(right.createdAt);
  if (sort === "created-new") return values.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (sort === "created-old") return values.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (sort === "priority") return values.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || byDate(a, b));
  return values.sort(byDate);
}

export function createRepositories(database) {
  return Object.freeze({
    tasks: new TaskRepository(database),
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
