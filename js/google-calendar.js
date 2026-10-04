import { CALENDAR_TIME_ZONES } from "./config.js";
import { addCalendarDays } from "./date-utils.js";

const API_ROOT = "https://www.googleapis.com/calendar/v3";

export class GoogleApiError extends Error {
  constructor(status, message, payload = null, retryAfterMs = 0) {
    super(message || `Google Calendar API: ${status}`);
    this.name = "GoogleApiError";
    this.status = status;
    this.payload = payload;
    this.retryAfterMs = retryAfterMs;
  }
}

export function canWriteCalendar(calendar) {
  return ["writer", "owner"].includes(calendar?.accessRole);
}

function appendPageToken(url, token) {
  const value = new URL(url);
  if (token) value.searchParams.set("pageToken", token);
  return value.toString();
}

function safeApiMessage(payload, fallback) {
  return payload?.error?.message || fallback;
}

function retryAfterMilliseconds(response) {
  const value = response.headers?.get?.("Retry-After");
  if (!value) return 0;
  if (/^\d+$/.test(value)) return Number(value) * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

export function stableGoogleEventId(localId) {
  const cleaned = String(localId || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  return `planner${cleaned || "00000"}`.slice(0, 1024);
}

function addMinutes(date, time, duration) {
  const [hours, minutes] = time.split(":").map(Number);
  const total = hours * 60 + minutes + duration;
  return { date: addCalendarDays(date, Math.floor(total / 1_440)), time: `${String(Math.floor((total % 1_440) / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}` };
}

function recurrenceToRRule(rule) {
  if (!rule) return null;
  const parts = [];
  const frequency = rule.frequency === "weekdays" ? "WEEKLY" : rule.frequency === "custom"
    ? { days: "DAILY", weeks: "WEEKLY", months: "MONTHLY", years: "YEARLY" }[rule.intervalUnit]
    : { daily: "DAILY", weekly: "WEEKLY", monthly: "MONTHLY", yearly: "YEARLY" }[rule.frequency];
  parts.push(`FREQ=${frequency}`);
  if (rule.frequency === "custom" && rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.frequency === "weekdays") parts.push(`BYDAY=${(rule.weekdays || []).map((day) => ["", "MO", "TU", "WE", "TH", "FR", "SA", "SU"][day]).join(",")}`);
  if (rule.endType === "date" && rule.until) parts.push(`UNTIL=${rule.until.replaceAll("-", "")}T205959Z`);
  if (rule.endType === "count" && rule.count) parts.push(`COUNT=${rule.count}`);
  return `RRULE:${parts.join(";")}`;
}

function descriptionFromTask(task) {
  const parts = [];
  if (task.shortDescription) parts.push(task.shortDescription);
  if (task.details) parts.push(task.details);
  if (task.checklist?.length) parts.push(`Чек-лист:\n${task.checklist.map((item) => `${item.isDone ? "✓" : "○"} ${item.text}`).join("\n")}`);
  if (task.tags?.length) parts.push(`Теги: ${task.tags.map((tag) => `#${tag}`).join(" ")}`);
  if (task.links?.length) parts.push(`Ссылки:\n${task.links.map((link) => `${link.label || link.url}: ${link.url}`).join("\n")}`);
  return parts.join("\n\n");
}

export function taskToGoogleEvent(task) {
  const payload = {
    id: stableGoogleEventId(task.id || task.seriesId),
    summary: task.title,
    description: descriptionFromTask(task),
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 10 }] },
  };
  if (task.hasTime) {
    const end = addMinutes(task.date, task.startTime, task.durationMinutes);
    payload.start = { dateTime: `${task.date}T${task.startTime}:00+03:00`, timeZone: CALENDAR_TIME_ZONES.primary.id };
    payload.end = { dateTime: `${end.date}T${end.time}:00+03:00`, timeZone: CALENDAR_TIME_ZONES.primary.id };
  } else {
    payload.start = { date: task.date };
    payload.end = { date: addCalendarDays(task.date, 1) };
  }
  const rrule = recurrenceToRRule(task.recurrence);
  if (rrule) payload.recurrence = [rrule];
  return payload;
}

function dateTimeParts(value) {
  const match = String(value || "").match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  return match ? { date: match[1], time: match[2] } : null;
}

export function normalizeGoogleEvent(event, calendar) {
  const allDay = Boolean(event.start?.date);
  const startParts = allDay ? { date: event.start.date, time: null } : dateTimeParts(event.start?.dateTime);
  const endParts = allDay ? { date: event.end?.date || addCalendarDays(startParts.date, 1), time: null } : dateTimeParts(event.end?.dateTime);
  if (!startParts || !endParts) return null;
  let durationMinutes = null;
  if (!allDay) {
    const start = Date.parse(event.start.dateTime);
    const end = Date.parse(event.end.dateTime);
    durationMinutes = Math.max(1, Math.round((end - start) / 60_000));
  }
  return {
    cacheKey: `${calendar.id}:${event.id}`,
    id: event.id,
    calendarId: calendar.id,
    calendarName: calendar.summary || calendar.id,
    calendarColor: calendar.backgroundColor || "#bec8c8",
    title: event.summary || "Занято",
    summary: event.summary || "Занято",
    description: event.description || "",
    location: event.location || "",
    htmlLink: event.htmlLink || "",
    organizer: event.organizer?.displayName || event.organizer?.email || "",
    responseStatus: event.attendees?.find((attendee) => attendee.self)?.responseStatus || "",
    status: event.status || "confirmed",
    start: event.start,
    end: event.end,
    date: startParts.date,
    endDate: endParts.date,
    hasTime: !allDay,
    startTime: startParts.time,
    durationMinutes,
    recurringEventId: event.recurringEventId || null,
    etag: event.etag || null,
    updated: event.updated || null,
    isGoogleEvent: true,
  };
}

export function createGoogleCalendarService({ auth, fetchImpl = globalThis.fetch } = {}) {
  async function request(path, options = {}) {
    const token = auth?.getAccessToken();
    if (!token) throw new GoogleApiError(401, "Нужен вход в Google");
    const response = await fetchImpl(path.startsWith("http") ? path : `${API_ROOT}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(options.headers || {}) },
    });
    const payload = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) throw new GoogleApiError(response.status, safeApiMessage(payload, response.statusText), payload, retryAfterMilliseconds(response));
    return payload;
  }

  async function paged(url) {
    const items = [];
    let token = null;
    do {
      const page = await request(appendPageToken(url, token));
      items.push(...(page.items || [])); token = page.nextPageToken || null;
    } while (token);
    return items;
  }

  async function listCalendars() {
    return (await paged(`${API_ROOT}/users/me/calendarList?minAccessRole=reader&showHidden=false`)).map((calendar) => ({
      id: calendar.id,
      summary: calendar.summary || calendar.id,
      backgroundColor: calendar.backgroundColor || "#bec8c8",
      foregroundColor: calendar.foregroundColor || "#3f403b",
      accessRole: calendar.accessRole || "reader",
      primary: Boolean(calendar.primary),
      selected: Boolean(calendar.selected),
    }));
  }

  async function listEvents(calendar, { timeMin, timeMax }) {
    const result = await listEventChanges(calendar, { timeMin, timeMax });
    return result.items.filter((event) => event.status !== "cancelled").map((event) => normalizeGoogleEvent(event, calendar)).filter(Boolean);
  }

  async function listEventChanges(calendar, { timeMin, timeMax, syncToken } = {}) {
    const base = new URL(`${API_ROOT}/calendars/${encodeURIComponent(calendar.id)}/events`);
    base.searchParams.set("singleEvents", "true"); base.searchParams.set("showDeleted", "true"); base.searchParams.set("maxResults", "2500");
    if (syncToken) base.searchParams.set("syncToken", syncToken);
    else { base.searchParams.set("timeMin", timeMin); base.searchParams.set("timeMax", timeMax); }
    const items = []; let pageToken = null; let nextSyncToken = null;
    do {
      const url = new URL(base); if (pageToken) url.searchParams.set("pageToken", pageToken);
      const page = await request(url.toString()); items.push(...(page.items || [])); pageToken = page.nextPageToken || null; nextSyncToken = page.nextSyncToken || nextSyncToken;
    } while (pageToken);
    return { items, nextSyncToken };
  }

  async function insertTask(calendarId, task) {
    const payload = taskToGoogleEvent(task);
    try {
      return await request(`/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=none`, { method: "POST", body: JSON.stringify(payload) });
    } catch (error) {
      if (error.status !== 409) throw error;
      return request(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(payload.id)}`);
    }
  }

  function updateTask(calendarId, eventId, task, etag) {
    const payload = taskToGoogleEvent(task);
    delete payload.id;
    return request(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`, { method: "PUT", headers: etag ? { "If-Match": etag } : {}, body: JSON.stringify(payload) });
  }

  function deleteEvent(calendarId, eventId, etag) {
    return request(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`, { method: "DELETE", headers: etag ? { "If-Match": etag } : {} });
  }

  return Object.freeze({ listCalendars, listEvents, listEventChanges, insertTask, updateTask, deleteEvent, getEvent: (calendarId, eventId) => request(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`) });
}
