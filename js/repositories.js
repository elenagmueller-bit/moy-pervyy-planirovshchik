import { LIMITS } from "./config.js";
import { combineLocalDateTime, todayString, toUtcTimestamp } from "./date-utils.js";
import { createTask, updateTaskRecord } from "./models.js";
import { requestToPromise, runTransaction } from "./db.js";
import { createSeriesRecord, expandSeries, previousOccurrenceDate, seriesRepresentative, splitSeriesRecords, updateWholeSeries } from "./recurrence.js";

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
    return runTransaction(this.database, ["tasks", "series", "meta"], "readwrite", async ({ tasks, series, meta }) => {
      const lastRun = await requestToPromise(meta.get("taskTrashCleanup"));
      if (!force && lastRun?.value && now.getTime() - Date.parse(lastRun.value) < interval) {
        return { skipped: true, deleted: 0 };
      }
      const allTasks = await requestToPromise(tasks.getAll());
      const expired = allTasks.filter((task) => task.trashedAt && Date.parse(task.trashedAt) <= cutoff);
      expired.forEach((task) => tasks.delete(task.id));
      const allSeries = await requestToPromise(series.getAll());
      const expiredSeries = allSeries.filter((item) => item.trashedAt && Date.parse(item.trashedAt) <= cutoff);
      expiredSeries.forEach((item) => {
        series.delete(item.id);
        allTasks.filter((task) => task.seriesId === item.id).forEach((task) => tasks.delete(task.id));
      });
      meta.put({ key: "taskTrashCleanup", value: toUtcTimestamp(now) });
      return { skipped: false, deleted: expired.length + expiredSeries.length };
    });
  }
}

export class RecurrenceRepository {
  constructor(database) {
    this.database = database;
  }

  createFromTask(input, now = new Date()) {
    const series = createSeriesRecord(input, now);
    return runTransaction(this.database, "series", "readwrite", ({ series: store }) => requestToPromise(store.add(series))).then(() => series);
  }

  replaceTaskWithSeries(taskId, input, now = new Date()) {
    const seriesRecord = createSeriesRecord(input, now);
    return runTransaction(this.database, ["tasks", "series"], "readwrite", async ({ tasks, series }) => {
      const current = await requestToPromise(tasks.get(taskId));
      if (!current) throw new DOMException("Задача не найдена", "NotFoundError");
      await requestToPromise(series.add(seriesRecord));
      await requestToPromise(tasks.delete(taskId));
      return seriesRecord;
    });
  }

  getSeries(id) {
    return runTransaction(this.database, "series", "readonly", ({ series }) => requestToPromise(series.get(id)));
  }

  async listRange(rangeStart, rangeEnd, { includeSeriesRepresentatives = false } = {}) {
    const { taskRecords, seriesRecords } = await runTransaction(this.database, ["tasks", "series"], "readonly", async ({ tasks, series }) => ({
      taskRecords: await requestToPromise(tasks.getAll()),
      seriesRecords: await requestToPromise(series.getAll()),
    }));
    const knownSeries = new Set(seriesRecords.map((series) => series.id));
    const ordinary = taskRecords.filter((task) => !task.seriesId || !knownSeries.has(task.seriesId));
    const expanded = seriesRecords.flatMap((series) => expandSeries(series, taskRecords, rangeStart, rangeEnd));
    const representatives = includeSeriesRepresentatives
      ? seriesRecords.filter((series) => series.archivedAt || series.trashedAt || series.status === "cancelled").map(seriesRepresentative)
      : [];
    return [...ordinary, ...expanded, ...representatives];
  }

  changeOccurrence(occurrence, patch, scope = "instance", now = new Date()) {
    if (!occurrence.seriesId) {
      return new TaskRepository(this.database).update(occurrence.id, patch, { now, expectedRevision: occurrence.revision });
    }
    return runTransaction(this.database, ["tasks", "series"], "readwrite", async ({ tasks, series }) => {
      const seriesRecord = await requestToPromise(series.get(occurrence.seriesId));
      if (!seriesRecord) throw new DOMException("Серия не найдена", "NotFoundError");
      if (patch.recurrence === null && scope === "future") {
        const previousDate = previousOccurrenceDate(seriesRecord, occurrence.recurrenceId);
        if (previousDate) {
          await requestToPromise(series.put({ ...seriesRecord, rule: { ...seriesRecord.rule, endType: "date", until: previousDate, count: null }, updatedAt: toUtcTimestamp(now), revision: seriesRecord.revision + 1 }));
        } else await requestToPromise(series.delete(seriesRecord.id));
        const oneTime = createTask({ ...occurrence, ...patch, id: undefined, seriesId: null, recurrenceId: null, recurrence: null, createdAt: undefined }, now);
        if (!occurrence.isVirtual) await requestToPromise(tasks.delete(occurrence.id));
        await requestToPromise(tasks.add(oneTime));
        return oneTime;
      }
      if (patch.recurrence === null && scope === "series") {
        await requestToPromise(series.delete(seriesRecord.id));
        if (!occurrence.isVirtual) await requestToPromise(tasks.delete(occurrence.id));
        const oneTime = createTask({ ...occurrence, ...patch, id: undefined, seriesId: null, recurrenceId: null, recurrence: null, createdAt: undefined }, now);
        await requestToPromise(tasks.add(oneTime));
        return oneTime;
      }
      if (scope === "instance") {
        if (!occurrence.isVirtual) {
          const current = await requestToPromise(tasks.get(occurrence.id));
          if (!current) throw new DOMException("Экземпляр не найден", "NotFoundError");
          const updated = updateTaskRecord(current, patch, now);
          await requestToPromise(tasks.put(updated));
          return updated;
        }
        const materialized = createTask({
          ...occurrence,
          ...patch,
          id: undefined,
          seriesId: seriesRecord.id,
          recurrenceId: occurrence.recurrenceId,
          recurrence: patch.recurrence === null ? null : seriesRecord.rule,
          revision: 1,
          createdAt: undefined,
        }, now);
        await requestToPromise(tasks.add(materialized));
        return materialized;
      }
      if (scope === "future") {
        let records;
        try {
          records = splitSeriesRecords(seriesRecord, occurrence, patch, now);
        } catch (error) {
          if (error.name !== "InvalidStateError") throw error;
          const updated = updateWholeSeries(seriesRecord, occurrence, patch, now);
          await requestToPromise(series.put(updated));
          return updated;
        }
        await requestToPromise(series.put(records.previous));
        await requestToPromise(series.add(records.next));
        if (!occurrence.isVirtual) await requestToPromise(tasks.delete(occurrence.id));
        return records.next;
      }
      const updated = updateWholeSeries(seriesRecord, occurrence, patch, now);
      await requestToPromise(series.put(updated));
      return updated;
    });
  }

  completeOccurrence(occurrence, now = new Date()) {
    return this.changeOccurrence(occurrence, { status: "completed", completedAt: toUtcTimestamp(now), cancelledAt: null }, "instance", now);
  }

  lifecycleOccurrence(occurrence, action, scope = "instance", now = new Date()) {
    const timestamp = toUtcTimestamp(now);
    const patches = {
      cancel: { status: "cancelled", cancelledAt: timestamp, archivedAt: timestamp, completedAt: null },
      archive: { archivedAt: timestamp },
      trash: { trashedAt: timestamp },
    };
    if (!patches[action]) throw new TypeError("Неизвестное действие серии");
    return this.changeOccurrence(occurrence, patches[action], scope, now);
  }

  restoreSeriesRepresentative(occurrence, source, now = new Date()) {
    const patch = source === "trash"
      ? { trashedAt: null }
      : { archivedAt: null, status: occurrence.status === "cancelled" ? "active" : occurrence.status, cancelledAt: occurrence.status === "cancelled" ? null : occurrence.cancelledAt };
    return this.changeOccurrence(occurrence, patch, "series", now);
  }

  deleteSeriesForever(occurrence) {
    if (!occurrence.isSeriesRepresentative || !occurrence.trashedAt) throw new DOMException("Серия не находится в корзине", "InvalidStateError");
    return runTransaction(this.database, ["tasks", "series"], "readwrite", async ({ tasks, series }) => {
      const exceptions = await requestToPromise(tasks.index("seriesId").getAll(occurrence.seriesId));
      exceptions.forEach((task) => tasks.delete(task.id));
      await requestToPromise(series.delete(occurrence.seriesId));
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
    recurrence: new RecurrenceRepository(database),
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
