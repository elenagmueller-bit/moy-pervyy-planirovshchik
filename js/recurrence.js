import { addCalendarDays, addCalendarMonthsClamped, parseLocalDate, toUtcTimestamp } from "./date-utils.js";
import { createTask, validateSeries, ValidationError } from "./models.js";

const TEMPLATE_FIELDS = Object.freeze([
  "title", "shortDescription", "details", "hasTime", "startTime", "durationMinutes", "priority", "category",
  "links", "tags", "checklist", "googleSync",
]);

function isoWeekday(value) {
  const day = parseLocalDate(value).getDay();
  return day || 7;
}

function daysBetween(left, right) {
  const a = parseLocalDate(left);
  const b = parseLocalDate(right);
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

function pickTemplate(task) {
  return Object.fromEntries(TEMPLATE_FIELDS.map((key) => [key, structuredClone(task[key] ?? null)]));
}

export function normalizeRecurrenceRule(input = {}, startDate) {
  const frequency = input.frequency || "daily";
  return {
    frequency,
    interval: frequency === "custom" ? Number(input.interval || 1) : 1,
    intervalUnit: frequency === "custom" ? input.intervalUnit || "days" : null,
    weekdays: frequency === "weekdays" ? [...new Set((input.weekdays || []).map(Number))].sort((a, b) => a - b) : [],
    endType: input.endType || "never",
    until: input.endType === "date" ? input.until || null : null,
    count: input.endType === "count" ? Number(input.count || 1) : null,
    anchorDay: parseLocalDate(startDate).getDate(),
    anchorMonth: parseLocalDate(startDate).getMonth() + 1,
  };
}

export function createSeriesRecord(taskInput, now = new Date()) {
  const task = createTask(taskInput, now);
  if (!task.recurrence) throw new ValidationError({ recurrence: "Выберите повторение" });
  const rule = normalizeRecurrenceRule(task.recurrence, task.date);
  const validation = validateSeries({ ...rule, startDate: task.date });
  if (!validation.valid) throw new ValidationError(validation.errors);
  const timestamp = toUtcTimestamp(now);
  return {
    id: task.seriesId || crypto.randomUUID(),
    template: pickTemplate(task),
    startDate: task.date,
    rule,
    status: "active",
    completedAt: null,
    cancelledAt: null,
    archivedAt: null,
    trashedAt: null,
    splitFromSeriesId: taskInput.splitFromSeriesId || null,
    createdAt: task.createdAt || timestamp,
    updatedAt: timestamp,
    revision: 1,
  };
}

function monthlyDate(startDate, monthOffset) {
  return addCalendarMonthsClamped(startDate, monthOffset);
}

function nextSimpleDate(series, occurrenceIndex) {
  const { rule, startDate } = series;
  if (rule.frequency === "daily") return addCalendarDays(startDate, occurrenceIndex);
  if (rule.frequency === "weekly") return addCalendarDays(startDate, occurrenceIndex * 7);
  if (rule.frequency === "monthly") return monthlyDate(startDate, occurrenceIndex);
  if (rule.frequency === "yearly") return monthlyDate(startDate, occurrenceIndex * 12);
  if (rule.frequency === "custom") {
    if (rule.intervalUnit === "days") return addCalendarDays(startDate, occurrenceIndex * rule.interval);
    if (rule.intervalUnit === "weeks") return addCalendarDays(startDate, occurrenceIndex * rule.interval * 7);
    if (rule.intervalUnit === "months") return monthlyDate(startDate, occurrenceIndex * rule.interval);
    return monthlyDate(startDate, occurrenceIndex * rule.interval * 12);
  }
  return startDate;
}

function withinEnd(rule, date, ordinal) {
  if (rule.endType === "date" && date > rule.until) return false;
  if (rule.endType === "count" && ordinal > rule.count) return false;
  return true;
}

export function generateOccurrenceDates(series, rangeStart, rangeEnd) {
  if (!series || rangeStart > rangeEnd) return [];
  const validation = validateSeries({ ...series.rule, startDate: series.startDate });
  if (!validation.valid) return [];
  const dates = [];
  let ordinal = 0;
  if (series.rule.frequency === "weekdays") {
    let date = series.startDate;
    while (date <= rangeEnd) {
      if (series.rule.weekdays.includes(isoWeekday(date))) {
        ordinal += 1;
        if (!withinEnd(series.rule, date, ordinal)) break;
        if (date >= rangeStart) dates.push(date);
      }
      date = addCalendarDays(date, 1);
    }
    return dates;
  }
  while (true) {
    const date = nextSimpleDate(series, ordinal);
    const occurrenceNumber = ordinal + 1;
    if (date > rangeEnd || !withinEnd(series.rule, date, occurrenceNumber)) break;
    if (date >= rangeStart) dates.push(date);
    ordinal += 1;
  }
  return dates;
}

export function occurrenceCountBefore(series, date) {
  if (date <= series.startDate) return 0;
  return generateOccurrenceDates({ ...series, rule: { ...series.rule, endType: "never", until: null, count: null } }, series.startDate, addCalendarDays(date, -1)).length;
}

export function previousOccurrenceDate(series, recurrenceId) {
  const dates = generateOccurrenceDates({ ...series, rule: { ...series.rule, endType: "never", until: null, count: null } }, series.startDate, addCalendarDays(recurrenceId, -1));
  return dates.at(-1) || null;
}

export function seriesToOccurrence(series, recurrenceId, overrides = {}) {
  return {
    id: `occ:${series.id}:${recurrenceId}`,
    ...structuredClone(series.template),
    date: recurrenceId,
    status: "active",
    completedAt: null,
    cancelledAt: null,
    archivedAt: null,
    trashedAt: null,
    recurrence: structuredClone(series.rule),
    seriesId: series.id,
    recurrenceId,
    createdAt: series.createdAt,
    updatedAt: series.updatedAt,
    revision: series.revision,
    isVirtual: true,
    ...overrides,
  };
}

export function seriesRepresentative(series) {
  return seriesToOccurrence(series, series.startDate, {
    id: `series:${series.id}`,
    status: series.status,
    completedAt: series.completedAt,
    cancelledAt: series.cancelledAt,
    archivedAt: series.archivedAt,
    trashedAt: series.trashedAt,
    isSeriesRepresentative: true,
  });
}

export function expandSeries(series, exceptions, rangeStart, rangeEnd) {
  if (series.trashedAt || series.archivedAt || series.status === "cancelled") return [];
  const exceptionMap = new Map(exceptions.filter((task) => task.seriesId === series.id).map((task) => [task.recurrenceId, task]));
  const result = [];
  const consumed = new Set();
  generateOccurrenceDates(series, rangeStart, rangeEnd).forEach((recurrenceId) => {
    const exception = exceptionMap.get(recurrenceId);
    if (exception) {
      consumed.add(exception.id);
      if (exception.date >= rangeStart && exception.date <= rangeEnd) result.push(exception);
    } else result.push(seriesToOccurrence(series, recurrenceId));
  });
  exceptions.forEach((exception) => {
    if (exception.seriesId === series.id && !consumed.has(exception.id) && exception.date >= rangeStart && exception.date <= rangeEnd) result.push(exception);
  });
  return result;
}

export function splitSeriesRecords(series, occurrence, patch = {}, now = new Date()) {
  const previousDate = previousOccurrenceDate(series, occurrence.recurrenceId);
  if (!previousDate) throw new DOMException("Нельзя разделить серию перед первым событием", "InvalidStateError");
  const beforeCount = occurrenceCountBefore(series, occurrence.recurrenceId);
  const timestamp = toUtcTimestamp(now);
  const previous = {
    ...structuredClone(series),
    rule: { ...series.rule, endType: "date", until: previousDate, count: null },
    updatedAt: timestamp,
    revision: series.revision + 1,
  };
  const newStartDate = patch.date || occurrence.date;
  const nextRuleInput = patch.recurrence || series.rule;
  const nextRule = normalizeRecurrenceRule(nextRuleInput, newStartDate);
  if (series.rule.endType === "count" && !patch.recurrence) {
    nextRule.endType = "count";
    nextRule.count = Math.max(1, series.rule.count - beforeCount);
  } else if (series.rule.endType === "date" && !patch.recurrence) {
    nextRule.endType = "date";
    nextRule.until = series.rule.until;
  }
  const nextTemplate = { ...structuredClone(series.template) };
  TEMPLATE_FIELDS.forEach((key) => { if (key in patch) nextTemplate[key] = structuredClone(patch[key]); });
  const next = {
    ...structuredClone(series),
    id: crypto.randomUUID(),
    template: nextTemplate,
    startDate: newStartDate,
    rule: nextRule,
    status: patch.status || "active",
    completedAt: patch.completedAt || null,
    cancelledAt: patch.cancelledAt || null,
    archivedAt: patch.archivedAt || null,
    trashedAt: patch.trashedAt || null,
    splitFromSeriesId: series.id,
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 1,
  };
  return { previous, next };
}

export function updateWholeSeries(series, occurrence, patch = {}, now = new Date()) {
  const template = { ...structuredClone(series.template) };
  TEMPLATE_FIELDS.forEach((key) => { if (key in patch) template[key] = structuredClone(patch[key]); });
  const dateShift = patch.date ? daysBetween(occurrence.date, patch.date) : 0;
  const startDate = dateShift ? addCalendarDays(series.startDate, dateShift) : series.startDate;
  const rule = patch.recurrence ? normalizeRecurrenceRule(patch.recurrence, startDate) : { ...series.rule, anchorDay: parseLocalDate(startDate).getDate(), anchorMonth: parseLocalDate(startDate).getMonth() + 1 };
  return {
    ...structuredClone(series),
    template,
    startDate,
    rule,
    status: "status" in patch ? patch.status : series.status,
    completedAt: "completedAt" in patch ? patch.completedAt : series.completedAt,
    cancelledAt: "cancelledAt" in patch ? patch.cancelledAt : series.cancelledAt,
    archivedAt: "archivedAt" in patch ? patch.archivedAt : series.archivedAt,
    trashedAt: "trashedAt" in patch ? patch.trashedAt : series.trashedAt,
    updatedAt: toUtcTimestamp(now),
    revision: series.revision + 1,
  };
}

export function previewSeries(rule, startDate, count = 5) {
  const legacy = rule?.startDate && rule?.frequency;
  const actualStart = legacy ? rule.startDate : startDate;
  const actualRule = rule;
  const actualCount = legacy ? Number(startDate) || 5 : count;
  const series = { startDate: actualStart, rule: normalizeRecurrenceRule(actualRule, actualStart) };
  const end = addCalendarMonthsClamped(actualStart, 240);
  return generateOccurrenceDates(series, actualStart, end).slice(0, actualCount);
}
