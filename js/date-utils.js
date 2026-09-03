const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function pad(value) {
  return String(value).padStart(2, "0");
}

export function isValidDateString(value) {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 12);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

export function isValidTimeString(value) {
  return TIME_PATTERN.test(value);
}

export function parseLocalDate(value) {
  if (!isValidDateString(value)) throw new TypeError(`Некорректная дата: ${value}`);
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

export function formatLocalDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new TypeError("Ожидалась корректная дата");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function todayString(now = new Date()) {
  return formatLocalDate(now);
}

export function addCalendarDays(value, amount) {
  const date = typeof value === "string" ? parseLocalDate(value) : new Date(value.getTime());
  date.setDate(date.getDate() + amount);
  return typeof value === "string" ? formatLocalDate(date) : date;
}

export function addCalendarMonthsClamped(value, amount) {
  const source = typeof value === "string" ? parseLocalDate(value) : new Date(value.getTime());
  const desiredDay = source.getDate();
  const result = new Date(source.getFullYear(), source.getMonth() + amount, 1, 12);
  const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0, 12).getDate();
  result.setDate(Math.min(desiredDay, lastDay));
  return typeof value === "string" ? formatLocalDate(result) : result;
}

export function startOfISOWeek(value) {
  const date = typeof value === "string" ? parseLocalDate(value) : new Date(value.getFullYear(), value.getMonth(), value.getDate(), 12);
  const weekday = date.getDay() || 7;
  date.setDate(date.getDate() - weekday + 1);
  return date;
}

export function endOfISOWeek(value) {
  return addCalendarDays(startOfISOWeek(value), 6);
}

export function getISOWeek(value) {
  const source = typeof value === "string" ? parseLocalDate(value) : value;
  const utc = new Date(Date.UTC(source.getFullYear(), source.getMonth(), source.getDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  return Math.ceil((((utc - yearStart) / 86_400_000) + 1) / 7);
}

export function getWeekDates(value) {
  const monday = startOfISOWeek(value);
  return Array.from({ length: 7 }, (_, index) => addCalendarDays(monday, index));
}

export function combineLocalDateTime(dateValue, timeValue) {
  if (!isValidDateString(dateValue) || !isValidTimeString(timeValue)) throw new TypeError("Некорректные дата или время");
  const [year, month, day] = dateValue.split("-").map(Number);
  const [hour, minute] = timeValue.split(":").map(Number);
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

export function toUtcTimestamp(date = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new TypeError("Ожидалась корректная дата");
  return date.toISOString();
}

export function getSystemTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "Локальное время";
}

export function formatPeriodLabel(value, locale = "ru-RU") {
  const [start, , , , , , end] = getWeekDates(value);
  const monthName = (date) => new Intl.DateTimeFormat(locale, { day: "numeric", month: "long" })
    .formatToParts(date)
    .find((part) => part.type === "month")?.value || date.toLocaleDateString(locale, { month: "long" });
  const startMonth = monthName(start);
  const endMonth = monthName(end);
  if (start.getFullYear() !== end.getFullYear()) {
    return `${start.getDate()} ${startMonth} ${start.getFullYear()} – ${end.getDate()} ${endMonth} ${end.getFullYear()}`;
  }
  if (start.getMonth() !== end.getMonth()) {
    return `${start.getDate()} ${startMonth} – ${end.getDate()} ${endMonth} ${end.getFullYear()}`;
  }
  return `${start.getDate()}–${end.getDate()} ${endMonth} ${end.getFullYear()}`;
}

export function monthMatrix(value) {
  const source = typeof value === "string" ? parseLocalDate(value) : value;
  const first = new Date(source.getFullYear(), source.getMonth(), 1, 12);
  const start = startOfISOWeek(first);
  return Array.from({ length: 42 }, (_, index) => addCalendarDays(start, index));
}
