import { CATEGORIES, LIMITS, PRIORITIES, RECURRENCE_END_TYPES, RECURRENCE_FREQUENCIES, RECURRENCE_UNITS, TASK_STATUSES } from "./config.js";
import { isValidDateString, isValidTimeString, toUtcTimestamp } from "./date-utils.js";

export class ValidationError extends Error {
  constructor(errors) {
    super("Данные не прошли проверку");
    this.name = "ValidationError";
    this.errors = errors;
  }
}

function rawText(value) {
  return String(value ?? "").trim();
}

function limitedText(value, maxLength) {
  return rawText(value).slice(0, maxLength);
}

function normalizeTags(values) {
  const seen = new Set();
  return (Array.isArray(values) ? values : []).reduce((result, item) => {
    const normalized = rawText(item);
    const key = normalized.toLocaleLowerCase("ru-RU");
    if (normalized && !seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
    return result;
  }, []);
}

function normalizeLinks(values) {
  return (Array.isArray(values) ? values : [])
    .map((item) => ({
      id: item.id || crypto.randomUUID(),
      label: rawText(item.label),
      url: rawText(item.url),
    }))
    .filter((item) => item.label || item.url);
}

function normalizeChecklist(values) {
  return (Array.isArray(values) ? values : []).map((item, index) => ({
    id: item.id || crypto.randomUUID(),
    text: rawText(item.text),
    isDone: Boolean(item.isDone),
    order: Number.isInteger(item.order) ? item.order : index,
  }));
}

function validateLinks(links, errors) {
  links.forEach((link, index) => {
    try {
      const url = new URL(link.url);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("protocol");
    } catch {
      errors[`links.${index}.url`] = "Разрешены только корректные ссылки http:// или https://";
    }
  });
}

function validateTags(values, errors) {
  const tags = normalizeTags(values);
  if (tags.length > LIMITS.tags) errors.tags = `Можно добавить не больше ${LIMITS.tags} тегов`;
  if (tags.some((tag) => tag.length > LIMITS.tagLength)) errors.tags = `Тег может содержать не больше ${LIMITS.tagLength} символов`;
  return tags;
}

export function validateTask(input) {
  const errors = {};
  const title = rawText(input.title);
  const shortDescription = rawText(input.shortDescription);
  const details = rawText(input.details);
  if (!title) errors.title = "Введите название";
  else if (title.length > LIMITS.taskTitle) errors.title = `Не больше ${LIMITS.taskTitle} символов`;
  if (shortDescription.length > LIMITS.taskShortDescription) errors.shortDescription = `Не больше ${LIMITS.taskShortDescription} символов`;
  if (details.length > LIMITS.taskDetails) errors.details = `Не больше ${LIMITS.taskDetails} символов`;
  if (!isValidDateString(input.date)) errors.date = "Выберите корректную дату";
  if (!CATEGORIES.includes(input.category)) errors.category = "Выберите категорию";
  if (!PRIORITIES.includes(input.priority)) errors.priority = "Выберите приоритет";
  if (!TASK_STATUSES.includes(input.status)) errors.status = "Некорректный статус";
  if (input.hasTime && !isValidTimeString(input.startTime)) errors.startTime = "Укажите время";
  else if (input.hasTime && Number(input.startTime.slice(3, 5)) % 15 !== 0) errors.startTime = "Время выбирается с шагом 15 минут";
  if (input.hasTime) {
    const duration = Number(input.durationMinutes);
    if (!Number.isInteger(duration) || duration < LIMITS.durationMin || duration > LIMITS.durationMax || duration % 15 !== 0) {
      errors.durationMinutes = "Длительность должна быть от 15 до 1440 минут с шагом 15 минут";
    }
  }
  const links = normalizeLinks(input.links);
  validateLinks(links, errors);
  const tags = validateTags(input.tags, errors);
  const checklist = normalizeChecklist(input.checklist);
  if (checklist.length > LIMITS.checklist) errors.checklist = `Можно добавить не больше ${LIMITS.checklist} пунктов`;
  if (checklist.some((item) => !item.text)) errors.checklist = "Пустые пункты чек-листа нужно удалить";
  if (input.recurrence) {
    const recurrenceValidation = validateSeries({ ...input.recurrence, startDate: input.date });
    Object.entries(recurrenceValidation.errors).forEach(([key, message]) => { errors[`recurrence.${key}`] = message; });
  }
  return {
    valid: Object.keys(errors).length === 0,
    errors,
    normalized: { ...input, title, shortDescription, details, links, tags, checklist },
  };
}

export function createTask(input, now = new Date()) {
  const timestamp = toUtcTimestamp(now);
  const base = {
    id: input.id || crypto.randomUUID(),
    title: input.title,
    shortDescription: input.shortDescription || "",
    details: input.details || "",
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
    links: input.links || [],
    tags: input.tags || [],
    checklist: input.checklist || [],
    recurrence: input.recurrence || null,
    seriesId: input.seriesId || null,
    recurrenceId: input.recurrenceId || null,
    googleSync: input.googleSync || null,
    createdAt: input.createdAt || timestamp,
    updatedAt: timestamp,
    revision: Number.isInteger(input.revision) ? input.revision : 1,
  };
  const result = validateTask(base);
  if (!result.valid) throw new ValidationError(result.errors);
  return { ...base, ...result.normalized };
}

export function updateTaskRecord(existing, patch, now = new Date()) {
  if (!existing?.id) throw new TypeError("Для обновления нужна существующая задача");
  return createTask({ ...existing, ...patch, id: existing.id, createdAt: existing.createdAt, revision: existing.revision + 1 }, now);
}

export function validateNote(input) {
  const errors = {};
  const title = rawText(input.title);
  if (!title) errors.title = "Введите название";
  else if (title.length > LIMITS.noteTitle) errors.title = `Не больше ${LIMITS.noteTitle} символов`;
  if (!CATEGORIES.includes(input.category)) errors.category = "Выберите категорию";
  if (!PRIORITIES.includes(input.priority)) errors.priority = "Выберите приоритет";
  const links = normalizeLinks(input.links);
  validateLinks(links, errors);
  const tags = validateTags(input.tags, errors);
  return { valid: Object.keys(errors).length === 0, errors, normalized: { ...input, title, links, tags } };
}

export function createNote(input, now = new Date()) {
  const base = {
    id: input.id || crypto.randomUUID(),
    title: input.title,
    text: limitedText(input.text, LIMITS.noteText),
    category: input.category,
    priority: input.priority || "medium",
    isPinned: Boolean(input.isPinned),
    tags: input.tags || [],
    links: input.links || [],
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
  const interval = input.interval ?? 1;
  if (!Number.isInteger(interval) || interval < 1) errors.interval = "Интервал должен быть больше нуля";
  if (!isValidDateString(input.startDate)) errors.startDate = "Некорректная дата начала";
  if (input.frequency === "custom" && !RECURRENCE_UNITS.includes(input.intervalUnit)) errors.intervalUnit = "Выберите единицу интервала";
  if (input.frequency === "weekdays") {
    if (!Array.isArray(input.weekdays) || !input.weekdays.length || input.weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
      errors.weekdays = "Выберите хотя бы один день недели";
    }
  }
  const endType = input.endType || "never";
  if (!RECURRENCE_END_TYPES.includes(endType)) errors.endType = "Некорректное окончание серии";
  if (endType === "date" && (!isValidDateString(input.until) || input.until < input.startDate)) errors.until = "Дата окончания не может быть раньше начала";
  if (endType === "count" && (!Number.isInteger(input.count) || input.count < 1)) errors.count = "Количество повторений должно быть больше нуля";
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
