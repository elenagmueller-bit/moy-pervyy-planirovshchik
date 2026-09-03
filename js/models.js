import { CATEGORIES, LIMITS, PRIORITIES, RECURRENCE_FREQUENCIES, TASK_STATUSES } from "./config.js";
import { isValidDateString, isValidTimeString, toUtcTimestamp } from "./date-utils.js";

export class ValidationError extends Error {
  constructor(errors) {
    super("Данные не прошли проверку");
    this.name = "ValidationError";
    this.errors = errors;
  }
}

function text(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function uniqueTextArray(values, maxItems, maxLength) {
  const seen = new Set();
  return (Array.isArray(values) ? values : []).reduce((result, item) => {
    const normalized = text(item, maxLength);
    const key = normalized.toLocaleLowerCase("ru");
    if (normalized && !seen.has(key) && result.length < maxItems) {
      seen.add(key);
      result.push(normalized);
    }
    return result;
  }, []);
}

function normalizeLinks(values) {
  return (Array.isArray(values) ? values : []).map((item) => ({
    id: item.id || crypto.randomUUID(),
    label: text(item.label, 120),
    url: text(item.url, 2_048),
  }));
}

function validateLinks(links, errors) {
  links.forEach((link, index) => {
    try {
      const url = new URL(link.url);
      if (!(["http:", "https:"].includes(url.protocol))) throw new Error("protocol");
    } catch {
      errors[`links.${index}.url`] = "Разрешены только корректные ссылки http:// или https://";
    }
  });
}

export function validateTask(input) {
  const errors = {};
  const title = text(input.title, LIMITS.taskTitle);
  if (!title) errors.title = "Введите название";
  if (!isValidDateString(input.date)) errors.date = "Выберите корректную дату";
  if (!CATEGORIES.includes(input.category)) errors.category = "Выберите категорию";
  if (!PRIORITIES.includes(input.priority)) errors.priority = "Выберите приоритет";
  if (!TASK_STATUSES.includes(input.status)) errors.status = "Некорректный статус";
  if (input.hasTime && !isValidTimeString(input.startTime)) errors.startTime = "Укажите время";
  if (input.hasTime) {
    const duration = Number(input.durationMinutes);
    if (!Number.isInteger(duration) || duration < LIMITS.durationMin || duration > LIMITS.durationMax || duration % 15 !== 0) {
      errors.durationMinutes = "Длительность должна быть от 15 до 1440 минут с шагом 15 минут";
    }
  }
  const links = normalizeLinks(input.links);
  validateLinks(links, errors);
  return { valid: Object.keys(errors).length === 0, errors, normalized: { ...input, title, links } };
}

export function createTask(input, now = new Date()) {
  const base = {
    id: input.id || crypto.randomUUID(),
    title: input.title,
    shortDescription: text(input.shortDescription, LIMITS.taskShortDescription),
    details: text(input.details, LIMITS.taskDetails),
    date: input.date,
    hasTime: Boolean(input.hasTime),
    startTime: input.hasTime ? input.startTime : null,
    durationMinutes: input.hasTime ? Number(input.durationMinutes ?? 15) : null,
    priority: input.priority || "medium",
    category: input.category,
    status: input.status || "active",
    completedAt: input.completedAt || null,
    cancelledAt: input.cancelledAt || null,
    archivedAt: input.archivedAt || null,
    trashedAt: input.trashedAt || null,
    links: normalizeLinks(input.links),
    tags: uniqueTextArray(input.tags, LIMITS.tags, LIMITS.tagLength),
    checklist: Array.isArray(input.checklist) ? input.checklist.slice(0, LIMITS.checklist) : [],
    recurrence: input.recurrence || null,
    seriesId: input.seriesId || null,
    recurrenceId: input.recurrenceId || null,
    googleSync: input.googleSync || null,
    createdAt: input.createdAt || toUtcTimestamp(now),
    updatedAt: toUtcTimestamp(now),
    revision: Number.isInteger(input.revision) ? input.revision : 1,
  };
  const result = validateTask(base);
  if (!result.valid) throw new ValidationError(result.errors);
  return { ...base, ...result.normalized };
}

export function validateNote(input) {
  const errors = {};
  const title = text(input.title, LIMITS.noteTitle);
  if (!title) errors.title = "Введите название";
  if (!CATEGORIES.includes(input.category)) errors.category = "Выберите категорию";
  if (!PRIORITIES.includes(input.priority)) errors.priority = "Выберите приоритет";
  const links = normalizeLinks(input.links);
  validateLinks(links, errors);
  return { valid: Object.keys(errors).length === 0, errors, normalized: { ...input, title, links } };
}

export function createNote(input, now = new Date()) {
  const base = {
    id: input.id || crypto.randomUUID(),
    title: input.title,
    text: text(input.text, LIMITS.noteText),
    category: input.category,
    priority: input.priority || "medium",
    isPinned: Boolean(input.isPinned),
    tags: uniqueTextArray(input.tags, LIMITS.tags, LIMITS.tagLength),
    links: normalizeLinks(input.links),
    archivedAt: input.archivedAt || null,
    trashedAt: input.trashedAt || null,
    createdAt: input.createdAt || toUtcTimestamp(now),
    updatedAt: toUtcTimestamp(now),
    revision: Number.isInteger(input.revision) ? input.revision : 1,
  };
  const result = validateNote(base);
  if (!result.valid) throw new ValidationError(result.errors);
  return { ...base, ...result.normalized };
}

export function validateSeries(input) {
  const errors = {};
  if (!RECURRENCE_FREQUENCIES.includes(input.frequency)) errors.frequency = "Некорректная частота";
  if (!Number.isInteger(input.interval) || input.interval < 1) errors.interval = "Интервал должен быть больше нуля";
  if (!isValidDateString(input.startDate)) errors.startDate = "Некорректная дата начала";
  if (input.until && (!isValidDateString(input.until) || input.until < input.startDate)) errors.until = "Некорректная дата окончания";
  return { valid: Object.keys(errors).length === 0, errors };
}

export function normalizeSettings(input = {}) {
  return {
    id: "app",
    systemTimeZone: String(input.systemTimeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || "local"),
    selectedGoogleCalendars: Array.isArray(input.selectedGoogleCalendars) ? input.selectedGoogleCalendars : [],
    defaultWritableCalendarId: input.defaultWritableCalendarId || null,
    lastSyncAt: input.lastSyncAt || null,
  };
}
