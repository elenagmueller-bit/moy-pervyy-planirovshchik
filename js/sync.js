import { addCalendarDays } from "./date-utils.js";
import { requestToPromise, runTransaction } from "./db.js";
import { normalizeGoogleEvent } from "./google-calendar.js";
import { updateTaskRecord } from "./models.js?v=0.8.0";

const CONFLICT_RETENTION_DAYS = 30;
const MAX_TEMPORARY_ATTEMPTS = 3;
const FIVE_MINUTES = 300_000;

function timestamp(now) { return now().toISOString(); }
function temporaryStatus(status) { return status === 429 || status >= 500; }
function permissionReason(error) {
  return error?.payload?.error?.errors?.[0]?.reason || "";
}
function quotaError(error) {
  return error?.status === 429 || ["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"].includes(permissionReason(error));
}
function recurrenceFromGoogle(values = []) {
  const source = values.find((value) => String(value).startsWith("RRULE:"));
  if (!source) return null;
  const parts = Object.fromEntries(source.slice(6).split(";").map((part) => part.split("=")));
  const frequency = { DAILY: "daily", WEEKLY: "weekly", MONTHLY: "monthly", YEARLY: "yearly" }[parts.FREQ];
  if (!frequency) return null;
  const weekdays = parts.BYDAY?.split(",").map((day) => ({ MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 })[day]).filter(Boolean);
  const rule = {
    frequency: weekdays?.length ? "weekdays" : frequency,
    interval: Number(parts.INTERVAL || 1), intervalUnit: frequency === "daily" ? "days" : frequency === "weekly" ? "weeks" : frequency === "monthly" ? "months" : "years",
    weekdays: weekdays || [], endType: "never", until: null, count: null,
  };
  if (parts.COUNT) { rule.endType = "count"; rule.count = Number(parts.COUNT); }
  if (parts.UNTIL) { rule.endType = "date"; rule.until = `${parts.UNTIL.slice(0, 4)}-${parts.UNTIL.slice(4, 6)}-${parts.UNTIL.slice(6, 8)}`; }
  return rule;
}

export function googleEventToLocalPatch(rawEvent, localTask) {
  const normalized = normalizeGoogleEvent(rawEvent, { id: localTask.googleSync.calendarId, summary: "Google Calendar" });
  if (!normalized) return {};
  return {
    title: normalized.title,
    shortDescription: "",
    details: normalized.description,
    date: normalized.date,
    hasTime: normalized.hasTime,
    startTime: normalized.startTime,
    durationMinutes: normalized.hasTime ? normalized.durationMinutes : null,
    recurrence: recurrenceFromGoogle(rawEvent.recurrence),
  };
}

function entityTask(entity, isSeries) {
  return isSeries ? { ...entity.template, id: entity.id, date: entity.startDate, recurrence: entity.rule } : entity;
}
function entityLink(entity, isSeries) { return isSeries ? entity?.template?.googleSync : entity?.googleSync; }

export function createSyncEngine({ repositories, googleCalendar, googleAuth, now = () => new Date(), online = () => navigator.onLine, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const database = repositories.tasks.database;
  const listeners = new Set();
  let running = false;
  const emit = (event) => listeners.forEach((listener) => listener(event));

  async function putEntityLink(objectId, isSeries, link) {
    if (isSeries) {
      const current = await repositories.series.get(objectId);
      if (!current) return null;
      const updated = { ...current, template: { ...current.template, googleSync: link }, revision: current.revision + 1, updatedAt: timestamp(now) };
      await repositories.series.put(updated); return updated;
    }
    const current = await repositories.tasks.get(objectId);
    if (!current) return null;
    return repositories.tasks.update(objectId, { googleSync: link }, { expectedRevision: current.revision, now: now() });
  }

  async function queueEntity(entity, { action = null, calendarId = null, eventId = null, etag = null, isSeries = Boolean(entity?.template) } = {}) {
    const link = entityLink(entity, isSeries) || {};
    const operation = action || (link.eventId || eventId ? "update" : "create");
    const objectId = entity.id;
    const at = timestamp(now);
    return runTransaction(database, [isSeries ? "series" : "tasks", "syncQueue"], "readwrite", async (stores) => {
      const entityStore = stores[isSeries ? "series" : "tasks"];
      const current = await requestToPromise(entityStore.get(objectId));
      if (!current) throw new DOMException("Задача не найдена", "NotFoundError");
      const all = await requestToPromise(stores.syncQueue.getAll());
      const replaceable = operation !== "delete" && [...all].reverse().find((item) => item.objectId === objectId && item.status !== "processing" && item.action !== "delete");
      const queueRecord = {
        ...(replaceable || {}), objectId, isSeries, action: replaceable?.action === "create" ? "create" : operation,
        calendarId: calendarId || link.calendarId, eventId: eventId || link.eventId || null, etag: etag || link.etag || null,
        payload: entityTask(current, isSeries), status: "queued", attempts: 0, nextAttemptAt: null,
        createdAt: replaceable?.createdAt || at, updatedAt: at, lastErrorCode: null, lastErrorMessage: null,
      };
      const id = await requestToPromise(stores.syncQueue.put(queueRecord));
      queueRecord.id = replaceable?.id || id;
      const nextLink = { ...link, calendarId: queueRecord.calendarId, eventId: queueRecord.eventId, etag: queueRecord.etag, syncStatus: operation === "delete" ? "pendingDelete" : queueRecord.eventId ? "pendingUpdate" : "pendingCreate", lastAttemptAt: at, lastErrorCode: null, lastErrorMessage: null };
      if (isSeries) await requestToPromise(entityStore.put({ ...current, template: { ...current.template, googleSync: nextLink }, revision: current.revision + 1, updatedAt: at }));
      else await requestToPromise(entityStore.put(updateTaskRecord(current, { googleSync: nextLink }, now())));
      emit({ type: "queued", operation: queueRecord });
      return queueRecord;
    });
  }

  async function updateQueue(operation, patch) {
    await repositories.syncQueue.put({ ...operation, ...patch, updatedAt: timestamp(now) });
  }

  async function markSuccess(operation, event = null) {
    const storeName = operation.isSeries ? "series" : "tasks";
    await runTransaction(database, [storeName, "syncQueue"], "readwrite", async (stores) => {
      const current = await requestToPromise(stores[storeName].get(operation.objectId));
      if (current) {
        const oldLink = entityLink(current, operation.isSeries) || {};
        const link = operation.action === "delete" ? null : {
          ...oldLink, calendarId: operation.calendarId, eventId: event?.id || operation.eventId,
          etag: event?.etag || oldLink.etag || null, googleUpdatedAt: event?.updated || oldLink.googleUpdatedAt || null,
          lastSyncedLocalRevision: current.revision + 1, syncStatus: "synced", lastErrorCode: null, lastErrorMessage: null, lastAttemptAt: timestamp(now),
        };
        if (operation.isSeries) await requestToPromise(stores[storeName].put({ ...current, template: { ...current.template, googleSync: link }, revision: current.revision + 1, updatedAt: timestamp(now) }));
        else await requestToPromise(stores[storeName].put(updateTaskRecord(current, { googleSync: link }, now())));
      }
      await requestToPromise(stores.syncQueue.delete(operation.id));
    });
  }

  async function markRemoteDeleted(operation) {
    const storeName = operation.isSeries ? "series" : "tasks";
    await runTransaction(database, [storeName, "syncQueue"], "readwrite", async (stores) => {
      const current = await requestToPromise(stores[storeName].get(operation.objectId));
      const link = entityLink(current, operation.isSeries);
      if (current && link) {
        const ended = { ...link, syncStatus: "readOnlyRemote", endedAt: timestamp(now), lastErrorCode: "REMOTE_DELETED", lastErrorMessage: "Связанное событие удалено в Google Calendar. Локальная задача сохранена", lastAttemptAt: timestamp(now) };
        if (operation.isSeries) await requestToPromise(stores[storeName].put({ ...current, template: { ...current.template, googleSync: ended }, revision: current.revision + 1, updatedAt: timestamp(now) }));
        else await requestToPromise(stores[storeName].put(updateTaskRecord(current, { googleSync: ended }, now())));
      }
      await requestToPromise(stores.syncQueue.delete(operation.id));
    });
    emit({ type: "remoteDeleted", objectId: operation.objectId });
  }

  async function saveConflict(operation, remoteEvent) {
    const current = operation.isSeries ? await repositories.series.get(operation.objectId) : await repositories.tasks.get(operation.objectId);
    if (!current || operation.isSeries) {
      await updateQueue(operation, { status: "error", attempts: MAX_TEMPORARY_ATTEMPTS, lastErrorCode: "CONFLICT_SERIES", lastErrorMessage: "Конфликт серии требует ручного редактирования" });
      return;
    }
    const localVersion = structuredClone(current);
    const patch = googleEventToLocalPatch(remoteEvent, current);
    const expiresAt = new Date(now().getTime() + CONFLICT_RETENTION_DAYS * 86_400_000).toISOString();
    const conflictId = await runTransaction(database, ["tasks", "conflictHistory", "syncQueue"], "readwrite", async ({ tasks, conflictHistory, syncQueue }) => {
      const latest = await requestToPromise(tasks.get(operation.objectId));
      const updated = updateTaskRecord(latest, { ...patch, googleSync: { ...latest.googleSync, etag: remoteEvent.etag || null, googleUpdatedAt: remoteEvent.updated || null, syncStatus: "synced", lastErrorCode: null, lastErrorMessage: null, lastAttemptAt: timestamp(now) } }, now());
      await requestToPromise(tasks.put(updated));
      const id = await requestToPromise(conflictHistory.add({ objectId: operation.objectId, calendarId: operation.calendarId, eventId: operation.eventId, localVersion, googleVersion: structuredClone(remoteEvent), googleEtag: remoteEvent.etag || null, createdAt: timestamp(now), expiresAt, resolvedAt: null }));
      await requestToPromise(syncQueue.delete(operation.id));
      return id;
    });
    emit({ type: "conflict", conflictId, objectId: operation.objectId, localVersion, googleVersion: remoteEvent });
  }

  async function processOne(operation) {
    const current = operation.isSeries ? await repositories.series.get(operation.objectId) : await repositories.tasks.get(operation.objectId);
    const payload = current ? entityTask(current, operation.isSeries) : operation.payload;
    try {
      let event = null;
      if (operation.action === "create") event = await googleCalendar.insertTask(operation.calendarId, payload);
      else if (operation.action === "update") event = await googleCalendar.updateTask(operation.calendarId, operation.eventId, payload, operation.etag);
      else await googleCalendar.deleteEvent(operation.calendarId, operation.eventId, operation.etag);
      await markSuccess(operation, event); emit({ type: "sent", operation, event }); return "continue";
    } catch (error) {
      if (error.status === 401) {
        googleAuth.clear(); await updateQueue(operation, { status: "waitingAuth", lastErrorCode: "401", lastErrorMessage: "Нужен вход в Google" }); emit({ type: "needsAuth" }); return "stop";
      }
      if (error.status === 404 && operation.action !== "create") { await markRemoteDeleted(operation); return "continue"; }
      if (error.status === 412 && operation.action !== "create") {
        const remote = await googleCalendar.getEvent(operation.calendarId, operation.eventId);
        await saveConflict(operation, remote); return "continue";
      }
      const retryable = temporaryStatus(error.status) || quotaError(error);
      if (retryable) {
        const attempts = Number(operation.attempts || 0) + 1;
        if (attempts >= MAX_TEMPORARY_ATTEMPTS) {
          await updateQueue(operation, { status: "error", attempts, lastErrorCode: String(error.status), lastErrorMessage: error.message });
          const link = entityLink(current, operation.isSeries);
          if (link) await putEntityLink(operation.objectId, operation.isSeries, { ...link, syncStatus: "error", lastErrorCode: String(error.status), lastErrorMessage: error.message, lastAttemptAt: timestamp(now) });
          emit({ type: "failed", operation, error }); return "continue";
        }
        const delay = Math.max(error.retryAfterMs || 0, 1_000 * (2 ** (attempts - 1)));
        await updateQueue(operation, { status: "queued", attempts, nextAttemptAt: new Date(now().getTime() + delay).toISOString(), lastErrorCode: String(error.status), lastErrorMessage: error.message });
        emit({ type: "retry", operation, attempts, delay }); return "retry";
      }
      await updateQueue(operation, { status: "error", attempts: Number(operation.attempts || 0) + 1, lastErrorCode: String(error.status || "GOOGLE_ERROR"), lastErrorMessage: error.message });
      const link = entityLink(current, operation.isSeries);
      if (link) await putEntityLink(operation.objectId, operation.isSeries, { ...link, syncStatus: "error", lastErrorCode: String(error.status || "GOOGLE_ERROR"), lastErrorMessage: error.status === 403 ? "Нет доступа к выбранному календарю" : error.message, lastAttemptAt: timestamp(now) });
      emit({ type: "failed", operation, error }); return "continue";
    }
  }

  async function flush({ waitForDelays = false } = {}) {
    if (running || !online()) return { processed: 0, pending: (await repositories.syncQueue.getAll()).length };
    if (!googleAuth.getAccessToken()) { emit({ type: "needsAuth" }); return { processed: 0, needsAuth: true }; }
    running = true; let processed = 0;
    try {
      while (true) {
        const queue = (await repositories.syncQueue.getAll()).sort((a, b) => Number(a.id) - Number(b.id));
        const operation = queue[0];
        if (!operation || operation.status === "error") break;
        if (!["queued", "waitingAuth", "processing"].includes(operation.status)) break;
        const wait = operation.nextAttemptAt ? Date.parse(operation.nextAttemptAt) - now().getTime() : 0;
        if (wait > 0) { if (!waitForDelays) break; await sleep(wait); }
        await updateQueue(operation, { status: "processing" });
        const outcome = await processOne(operation); processed += 1;
        if (outcome === "stop" || (outcome === "retry" && !waitForDelays)) break;
      }
    } finally { running = false; }
    return { processed, pending: (await repositories.syncQueue.getAll()).length };
  }

  async function retry(objectId = null) {
    const queue = await repositories.syncQueue.getAll();
    await Promise.all(queue.filter((item) => !objectId || item.objectId === objectId).map((item) => repositories.syncQueue.put({ ...item, status: "queued", attempts: 0, nextAttemptAt: null, lastErrorCode: null, lastErrorMessage: null, updatedAt: timestamp(now) })));
    return flush();
  }

  async function detachDeletedLinks(calendarId, eventIds) {
    if (!eventIds.size) return;
    const [tasks, series] = await Promise.all([repositories.tasks.getAll(), repositories.series.getAll()]);
    for (const task of tasks) if (task.googleSync?.calendarId === calendarId && eventIds.has(task.googleSync.eventId)) await putEntityLink(task.id, false, { ...task.googleSync, syncStatus: "readOnlyRemote", endedAt: timestamp(now), lastErrorCode: "REMOTE_DELETED", lastErrorMessage: "Связанное событие удалено в Google Calendar. Локальная задача сохранена" });
    for (const item of series) if (item.template?.googleSync?.calendarId === calendarId && eventIds.has(item.template.googleSync.eventId)) await putEntityLink(item.id, true, { ...item.template.googleSync, syncStatus: "readOnlyRemote", endedAt: timestamp(now), lastErrorCode: "REMOTE_DELETED", lastErrorMessage: "Связанное событие удалено в Google Calendar. Локальная задача сохранена" });
    emit({ type: "remoteDeleted", count: eventIds.size });
  }

  async function applyRemoteLinkedUpdates(calendarId, rawItems) {
    const active = new Map(rawItems.filter((item) => item.status !== "cancelled").map((item) => [item.id, item]));
    if (!active.size) return;
    const [tasks, series] = await Promise.all([repositories.tasks.getAll(), repositories.series.getAll()]);
    for (const task of tasks) {
      const link = task.googleSync;
      const remote = link?.calendarId === calendarId ? active.get(link.eventId) : null;
      if (!remote || link.syncStatus !== "synced" || remote.etag === link.etag) continue;
      const patch = googleEventToLocalPatch(remote, task);
      await repositories.tasks.update(task.id, { ...patch, googleSync: { ...link, etag: remote.etag || null, googleUpdatedAt: remote.updated || null, lastSyncedLocalRevision: task.revision + 1, lastAttemptAt: timestamp(now), lastErrorCode: null, lastErrorMessage: null } }, { expectedRevision: task.revision, now: now() });
    }
    for (const item of series) {
      const link = item.template?.googleSync;
      const remote = link?.calendarId === calendarId ? active.get(link.eventId) : null;
      if (!remote || link.syncStatus !== "synced" || remote.etag === link.etag) continue;
      const local = { ...item.template, date: item.startDate, recurrence: item.rule, googleSync: link };
      const patch = googleEventToLocalPatch(remote, local);
      await repositories.series.put({ ...item, startDate: patch.date || item.startDate, rule: patch.recurrence || item.rule, template: { ...item.template, ...patch, googleSync: { ...link, etag: remote.etag || null, googleUpdatedAt: remote.updated || null, lastSyncedLocalRevision: item.revision + 1, lastAttemptAt: timestamp(now), lastErrorCode: null, lastErrorMessage: null } }, revision: item.revision + 1, updatedAt: timestamp(now) });
    }
  }

  async function applySyncPage(calendar, page, { full, range }) {
    const cancelled = new Set(page.items.filter((item) => item.status === "cancelled").map((item) => item.id));
    await runTransaction(database, ["googleEventsCache", "syncState"], "readwrite", async ({ googleEventsCache, syncState }) => {
      if (full) {
        const existing = await requestToPromise(googleEventsCache.index("calendarId").getAll(calendar.id));
        for (const item of existing) await requestToPromise(googleEventsCache.delete(item.cacheKey));
      }
      for (const raw of page.items) {
        const key = `${calendar.id}:${raw.id}`;
        if (raw.status === "cancelled") await requestToPromise(googleEventsCache.delete(key));
        else {
          const normalized = normalizeGoogleEvent(raw, calendar);
          if (normalized) await requestToPromise(googleEventsCache.put(normalized));
        }
      }
      await requestToPromise(syncState.put({ calendarId: calendar.id, nextSyncToken: page.nextSyncToken, rangeStart: range.start, rangeEnd: range.end, lastSyncAt: timestamp(now) }));
    });
    await detachDeletedLinks(calendar.id, cancelled);
    await applyRemoteLinkedUpdates(calendar.id, page.items);
  }

  async function synchronizeCalendar(calendar, range, { forceFull = false } = {}) {
    const state = await repositories.syncState.get(calendar.id);
    const rangeExpanded = !state || range.start < state.rangeStart || range.end > state.rangeEnd;
    const full = forceFull || rangeExpanded || !state?.nextSyncToken;
    try {
      const page = await googleCalendar.listEventChanges(calendar, full ? { timeMin: range.timeMin, timeMax: range.timeMax } : { syncToken: state.nextSyncToken });
      await applySyncPage(calendar, page, { full, range: full ? range : { start: state.rangeStart, end: state.rangeEnd } });
      emit({ type: "calendarSynced", calendarId: calendar.id, full }); return page;
    } catch (error) {
      if (error.status === 410 && !full) {
        await runTransaction(database, ["googleEventsCache", "syncState"], "readwrite", async ({ googleEventsCache, syncState }) => {
          const existing = await requestToPromise(googleEventsCache.index("calendarId").getAll(calendar.id));
          for (const item of existing) await requestToPromise(googleEventsCache.delete(item.cacheKey));
          await requestToPromise(syncState.delete(calendar.id));
        });
        return synchronizeCalendar(calendar, range, { forceFull: true });
      }
      if (error.status === 401) { googleAuth.clear(); emit({ type: "needsAuth" }); }
      throw error;
    }
  }

  async function synchronizeCalendars(calendars, range, options = {}) {
    if (!online() || !googleAuth.getAccessToken()) return false;
    for (const calendar of calendars.filter((item) => item.selected)) await synchronizeCalendar(calendar, range, options);
    return true;
  }

  async function reapplyConflict(conflictId) {
    const conflict = await repositories.conflictHistory.get(conflictId);
    if (!conflict || conflict.resolvedAt) return false;
    const current = await repositories.tasks.get(conflict.objectId);
    if (!current) return false;
    const local = conflict.localVersion;
    const restored = await repositories.tasks.update(current.id, { title: local.title, shortDescription: local.shortDescription, details: local.details, date: local.date, hasTime: local.hasTime, startTime: local.startTime, durationMinutes: local.durationMinutes, recurrence: local.recurrence, googleSync: { ...current.googleSync, etag: conflict.googleEtag } }, { expectedRevision: current.revision, now: now() });
    await repositories.conflictHistory.put({ ...conflict, resolvedAt: timestamp(now), resolution: "localReapplied" });
    await queueEntity(restored, { action: "update", calendarId: conflict.calendarId, eventId: conflict.eventId, etag: conflict.googleEtag });
    return flush();
  }

  async function cleanupConflicts() {
    const all = await repositories.conflictHistory.getAll();
    await Promise.all(all.filter((item) => Date.parse(item.expiresAt) <= now().getTime()).map((item) => repositories.conflictHistory.delete(item.id)));
  }

  return Object.freeze({
    queueEntity, flush, retry, synchronizeCalendar, synchronizeCalendars, reapplyConflict, cleanupConflicts,
    getQueue: () => repositories.syncQueue.getAll(),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    isStale(lastSyncAt) { return !lastSyncAt || now().getTime() - Date.parse(lastSyncAt) >= FIVE_MINUTES; },
  });
}
