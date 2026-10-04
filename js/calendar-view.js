import { CALENDAR_TIME_ZONES } from "./config.js";
import { addCalendarDays, combineLocalDateTime, convertWallTime, dateStringInZone, formatLocalDate, getWeekDates } from "./date-utils.js";

export const CALENDAR_START_MINUTES = 6 * 60;
export const CALENDAR_END_MINUTES = 23 * 60;
export const SLOT_MINUTES = 15;
export const SLOT_HEIGHT = 16;
const WEEKDAY_NAMES = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const PRIORITY_LABELS = Object.freeze({ high: "! Высокий", medium: "• Средний", low: "– Низкий" });
const CATEGORY_LABELS = Object.freeze({ work: "Работа", personal: "Личное" });

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function timeToMinutes(value) {
  const [hours, minutes] = String(value).split(":").map(Number);
  return hours * 60 + minutes;
}

export function minutesToTime(value) {
  const normalized = ((value % 1_440) + 1_440) % 1_440;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

function intervalsOverlap(left, right) {
  return left.start < right.end && right.start < left.end;
}

export function findTaskConflicts(candidate, tasks) {
  if (!candidate?.hasTime || candidate.archivedAt || candidate.trashedAt) return [];
  const candidateStart = combineLocalDateTime(candidate.date, candidate.startTime).getTime();
  const candidateEnd = candidateStart + candidate.durationMinutes * 60_000;
  return tasks.filter((task) => {
    if (task.id === candidate.id || !task.hasTime || task.archivedAt || task.trashedAt || task.status === "cancelled") return false;
    const start = combineLocalDateTime(task.date, task.startTime).getTime();
    const end = start + task.durationMinutes * 60_000;
    return candidateStart < end && start < candidateEnd;
  });
}

export function layoutTimedTasks(tasks) {
  const sorted = tasks
    .filter((task) => task.hasTime)
    .map((task) => ({ task, start: timeToMinutes(task.startTime), end: timeToMinutes(task.startTime) + task.durationMinutes }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const result = [];
  let index = 0;
  while (index < sorted.length) {
    const group = [sorted[index]];
    let groupEnd = sorted[index].end;
    index += 1;
    while (index < sorted.length && sorted[index].start < groupEnd) {
      group.push(sorted[index]);
      groupEnd = Math.max(groupEnd, sorted[index].end);
      index += 1;
    }
    const columnEnds = [];
    group.forEach((entry) => {
      let column = columnEnds.findIndex((end) => end <= entry.start);
      if (column === -1) column = columnEnds.length;
      columnEnds[column] = entry.end;
      entry.column = column;
    });
    const columns = Math.max(1, columnEnds.length);
    group.forEach((entry) => result.push({ ...entry, columns }));
  }
  return result;
}

export function durationFromResize(initialDuration, deltaPixels) {
  const slotDelta = Math.round(deltaPixels / SLOT_HEIGHT);
  return Math.max(SLOT_MINUTES, Math.min(1_440, initialDuration + slotDelta * SLOT_MINUTES));
}

function taskTimeLabel(task) {
  if (!task.hasTime) return "Без времени";
  const start = combineLocalDateTime(task.date, task.startTime);
  const end = new Date(start.getTime() + task.durationMinutes * 60_000);
  const endLabel = end.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const nextDay = formatLocalDate(end) !== task.date ? " +1 день" : "";
  return `${task.startTime}–${endLabel}${nextDay}`;
}

function createTaskChip(task, { compact = false, onOpen, onMove, onResize } = {}) {
  const chip = element("article", `calendar-task priority-${task.priority}${compact ? " is-compact" : ""}${task.status === "completed" ? " is-completed" : ""}`);
  chip.dataset.calendarTaskId = task.id;
  chip.tabIndex = 0;
  chip.setAttribute("role", "button");
  chip.setAttribute("aria-label", `${task.title}. ${taskTimeLabel(task)}. ${PRIORITY_LABELS[task.priority]}. ${CATEGORY_LABELS[task.category]}`);
  if (task.status === "active") chip.draggable = true;
  const title = element("strong", "", task.title);
  const seriesMark = task.seriesId && !task.isVirtual ? "↻ изменено · " : task.recurrence ? "↻ · " : "";
  const meta = element("span", "", `${seriesMark}${taskTimeLabel(task)} · ${CATEGORY_LABELS[task.category]} · ${PRIORITY_LABELS[task.priority]}`);
  chip.append(title, meta);
  chip.addEventListener("click", (event) => {
    if (!event.target.closest("[data-resize-handle]")) onOpen?.(task);
  });
  chip.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen?.(task);
    }
  });
  chip.addEventListener("dragstart", (event) => {
    if (task.status !== "active") return event.preventDefault();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", task.id);
    chip.classList.add("is-dragging");
  });
  chip.addEventListener("dragend", () => chip.classList.remove("is-dragging"));
  if (!compact && task.status === "active") {
    const handle = element("div", "calendar-task__resize");
    handle.dataset.resizeHandle = "";
    handle.setAttribute("aria-hidden", "true");
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const startY = event.clientY;
      let nextDuration = task.durationMinutes;
      const move = (moveEvent) => {
        nextDuration = durationFromResize(task.durationMinutes, moveEvent.clientY - startY);
        chip.style.height = `${Math.max(SLOT_HEIGHT, nextDuration / SLOT_MINUTES * SLOT_HEIGHT)}px`;
        chip.dataset.previewDuration = String(nextDuration);
      };
      const end = () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", end);
        delete chip.dataset.previewDuration;
        if (nextDuration !== task.durationMinutes) onResize?.(task, nextDuration);
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", end, { once: true });
    });
    chip.append(handle);
  }
  return chip;
}

function createGoogleChip(event, { compact = false, onOpenGoogle } = {}) {
  const chip = element("article", `calendar-google-event${compact ? " is-compact" : ""}`);
  chip.dataset.googleEventKey = event.cacheKey;
  chip.tabIndex = 0;
  chip.setAttribute("role", "button");
  chip.setAttribute("aria-label", `${event.title}. Google Calendar: ${event.calendarName}. ${taskTimeLabel(event)}`);
  chip.style.setProperty("--google-color", event.calendarColor || "#bec8c8");
  chip.append(element("strong", "", event.title), element("span", "", `${taskTimeLabel(event)} · ${event.calendarName}`));
  chip.addEventListener("click", () => onOpenGoogle?.(event));
  chip.addEventListener("keydown", (keyboardEvent) => {
    if (keyboardEvent.key === "Enter" || keyboardEvent.key === " ") { keyboardEvent.preventDefault(); onOpenGoogle?.(event); }
  });
  return chip;
}

function createCalendarChip(item, options = {}) {
  return item.isGoogleEvent ? createGoogleChip(item, options) : createTaskChip(item, options);
}

function makeDropTarget(node, patchForTask, tasksById, onMove) {
  node.addEventListener("dragover", (event) => {
    if (!event.dataTransfer.types.includes("text/plain")) return;
    event.preventDefault();
    node.classList.add("is-drop-target");
  });
  node.addEventListener("dragleave", () => node.classList.remove("is-drop-target"));
  node.addEventListener("drop", (event) => {
    event.preventDefault();
    node.classList.remove("is-drop-target");
    const task = tasksById.get(event.dataTransfer.getData("text/plain"));
    if (task) onMove?.(task, patchForTask(task));
  });
}

function renderCompactRegion(label, dates, grouped, callbacks, tasksById) {
  const total = [...grouped.values()].reduce((sum, values) => sum + values.length, 0);
  const details = element("details", "calendar-compact-region");
  if (!total) details.classList.add("is-empty");
  const summary = element("summary", "", `${label}${total ? ` · ${total}` : ""}`);
  const row = element("div", "calendar-compact-grid");
  row.append(element("div", "calendar-compact-label", ""));
  dates.forEach((date) => {
    const dateValue = formatLocalDate(date);
    const cell = element("div", "calendar-compact-cell");
    (grouped.get(dateValue) || []).forEach((task) => cell.append(createCalendarChip(task, { compact: true, ...callbacks })));
    row.append(cell);
  });
  details.append(summary, row);
  return details;
}

function renderAllDay(dates, grouped, callbacks, tasksById) {
  const row = element("div", "calendar-all-day-grid");
  row.append(element("div", "calendar-row-label", "Без времени / весь день"));
  dates.forEach((date) => {
    const dateValue = formatLocalDate(date);
    const cell = element("div", "all-day-cell");
    cell.dataset.allDayDate = dateValue;
    cell.tabIndex = 0;
    cell.setAttribute("role", "button");
    cell.setAttribute("aria-label", `Создать задачу без времени на ${date.toLocaleDateString("ru-RU")}`);
    const values = grouped.get(dateValue) || [];
    values.slice(0, 3).forEach((task) => cell.append(createCalendarChip(task, { compact: true, ...callbacks })));
    if (values.length > 3) {
      const more = element("button", "calendar-more", `Ещё ${values.length - 3}`);
      more.type = "button";
      more.addEventListener("click", (event) => {
        event.stopPropagation();
        const expanded = more.dataset.expanded === "true";
        cell.querySelectorAll(".calendar-task:nth-of-type(n+4)").forEach((item) => { item.hidden = expanded; });
        if (!expanded && more.dataset.loaded !== "true") {
          values.slice(3).forEach((task) => cell.insertBefore(createCalendarChip(task, { compact: true, ...callbacks }), more));
          more.dataset.loaded = "true";
        }
        more.dataset.expanded = String(!expanded);
        more.textContent = expanded ? `Ещё ${values.length - 3}` : "Свернуть";
      });
      cell.append(more);
    }
    cell.addEventListener("click", (event) => {
      if (!event.target.closest(".calendar-task, .calendar-google-event, .calendar-more")) callbacks.onCreate?.({ date: dateValue, hasTime: false, startTime: null, durationMinutes: null });
    });
    cell.addEventListener("keydown", (event) => {
      if ((event.key === "Enter" || event.key === " ") && event.target === cell) {
        event.preventDefault();
        callbacks.onCreate?.({ date: dateValue, hasTime: false, startTime: null, durationMinutes: null });
      }
    });
    makeDropTarget(cell, () => ({ date: dateValue, hasTime: false, startTime: null, durationMinutes: null }), tasksById, callbacks.onMove);
    row.append(cell);
  });
  return row;
}

function zoneAxisLabel(dateValue, timeValue, timeZone) {
  const converted = convertWallTime(dateValue, timeValue, CALENDAR_TIME_ZONES.primary.id, timeZone.id);
  const dayMark = converted.dayOffset === 1 ? " +1" : converted.dayOffset === -1 ? " −1" : "";
  return `${converted.time}${dayMark}`;
}

function renderTimeBody(dates, timedByDate, callbacks, tasksById, now, secondaryTimeZone) {
  const body = element("div", "calendar-time-body");
  const axis = element("div", "calendar-time-axis");
  const axisDate = formatLocalDate(dates[Math.min(3, dates.length - 1)]);
  for (let hour = 6; hour <= 23; hour += 1) {
    const label = element("span", "calendar-time-label");
    label.append(
      element("strong", "", `${String(hour).padStart(2, "0")}:00`),
      element("small", "", zoneAxisLabel(axisDate, `${String(hour).padStart(2, "0")}:00`, secondaryTimeZone)),
    );
    label.style.top = `${(hour * 60 - CALENDAR_START_MINUTES) / SLOT_MINUTES * SLOT_HEIGHT}px`;
    axis.append(label);
  }
  body.append(axis);
  let selection = null;
  const clearSelection = () => body.querySelectorAll(".calendar-slot.is-selected").forEach((slot) => slot.classList.remove("is-selected"));
  const finishSelection = () => {
    if (!selection) return;
    const { date, start, end } = selection;
    clearSelection();
    selection = null;
    const first = Math.min(start, end);
    const last = Math.max(start, end);
    callbacks.onCreate?.({ date, hasTime: true, startTime: minutesToTime(CALENDAR_START_MINUTES + first * SLOT_MINUTES), durationMinutes: (last - first + 1) * SLOT_MINUTES });
  };

  dates.forEach((date) => {
    const dateValue = formatLocalDate(date);
    const moscowToday = dateStringInZone(now, CALENDAR_TIME_ZONES.primary.id);
    const column = element("div", `calendar-day-column${dateValue === moscowToday ? " is-today" : ""}`);
    column.dataset.calendarDate = dateValue;
    const slots = element("div", "calendar-slots");
    const slotCount = (CALENDAR_END_MINUTES - CALENDAR_START_MINUTES) / SLOT_MINUTES;
    for (let slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
      const minutes = CALENDAR_START_MINUTES + slotIndex * SLOT_MINUTES;
      const slot = element("button", "calendar-slot");
      slot.type = "button";
      slot.dataset.date = dateValue;
      slot.dataset.time = minutesToTime(minutes);
      slot.dataset.slotIndex = String(slotIndex);
      slot.setAttribute("aria-label", `Создать задачу ${date.toLocaleDateString("ru-RU")} в ${minutesToTime(minutes)}`);
      slot.addEventListener("mousedown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        selection = { date: dateValue, start: slotIndex, end: slotIndex };
        clearSelection();
        slot.classList.add("is-selected");
      });
      slot.addEventListener("mouseenter", () => {
        if (!selection || selection.date !== dateValue) return;
        selection.end = slotIndex;
        clearSelection();
        const first = Math.min(selection.start, selection.end);
        const last = Math.max(selection.start, selection.end);
        [...slots.children].slice(first, last + 1).forEach((item) => item.classList.add("is-selected"));
      });
      slot.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          callbacks.onCreate?.({ date: dateValue, hasTime: true, startTime: minutesToTime(minutes), durationMinutes: SLOT_MINUTES });
        }
      });
      makeDropTarget(slot, (task) => ({ date: dateValue, hasTime: true, startTime: minutesToTime(minutes), durationMinutes: task.hasTime ? task.durationMinutes : SLOT_MINUTES }), tasksById, callbacks.onMove);
      slots.append(slot);
    }
    column.append(slots);
    layoutTimedTasks(timedByDate.get(dateValue) || []).forEach(({ task, start, end, column: overlapColumn, columns }) => {
      const chip = createCalendarChip(task, callbacks);
      const visibleStart = Math.max(start, CALENDAR_START_MINUTES);
      const visibleEnd = Math.min(end, CALENDAR_END_MINUTES);
      chip.style.top = `${(visibleStart - CALENDAR_START_MINUTES) / SLOT_MINUTES * SLOT_HEIGHT}px`;
      chip.style.height = `${Math.max(SLOT_HEIGHT, (visibleEnd - visibleStart) / SLOT_MINUTES * SLOT_HEIGHT)}px`;
      chip.style.left = `calc(${overlapColumn / columns * 100}% + 2px)`;
      chip.style.width = `calc(${100 / columns}% - 4px)`;
      column.append(chip);
    });
    if (dateValue === moscowToday) {
      const moscowTime = new Intl.DateTimeFormat("en-GB", { timeZone: CALENDAR_TIME_ZONES.primary.id, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
      const minutes = timeToMinutes(moscowTime);
      if (minutes >= CALENDAR_START_MINUTES && minutes <= CALENDAR_END_MINUTES) {
        const line = element("div", "current-time-line");
        line.style.top = `${(minutes - CALENDAR_START_MINUTES) / SLOT_MINUTES * SLOT_HEIGHT}px`;
        line.setAttribute("aria-label", `Текущее время ${minutesToTime(minutes)}`);
        column.append(line);
      }
    }
    body.append(column);
  });
  body.addEventListener("mouseup", finishSelection);
  body.addEventListener("mouseleave", () => {
    if (selection) {
      clearSelection();
      selection = null;
    }
  });
  return body;
}

export function renderWeekCalendar(visibleWeek, options = {}) {
  const tasks = (options.tasks || []).filter((task) => !task.archivedAt && !task.trashedAt && task.status !== "cancelled");
  const callbacks = { onCreate: options.onCreate, onOpen: options.onOpen, onOpenGoogle: options.onOpenGoogle, onMove: options.onMove, onResize: options.onResize };
  const now = options.now || new Date();
  const secondaryTimeZone = CALENDAR_TIME_ZONES.secondary.find((zone) => zone.id === options.secondaryTimeZone) || CALENDAR_TIME_ZONES.secondary[0];
  const moscowToday = dateStringInZone(now, CALENDAR_TIME_ZONES.primary.id);
  const dates = getWeekDates(visibleWeek);
  const dateSet = new Set(dates.map(formatLocalDate));
  const weekTasks = tasks.filter((task) => dateSet.has(task.date));
  const googleEvents = (options.googleEvents || []).filter((event) => event.status !== "cancelled");
  const tasksById = new Map(weekTasks.map((task) => [task.id, task]));
  const allDay = new Map();
  const early = new Map();
  const late = new Map();
  const timed = new Map();
  weekTasks.forEach((task) => {
    let target = allDay;
    if (task.hasTime) {
      const start = timeToMinutes(task.startTime);
      target = start < CALENDAR_START_MINUTES ? early : start >= CALENDAR_END_MINUTES ? late : timed;
    }
    if (!target.has(task.date)) target.set(task.date, []);
    target.get(task.date).push(task);
  });
  googleEvents.forEach((event) => {
    if (!event.hasTime) {
      let date = event.date;
      while (date < event.endDate) {
        if (dateSet.has(date)) {
          if (!allDay.has(date)) allDay.set(date, []);
          allDay.get(date).push({ ...event, date });
        }
        date = addCalendarDays(date, 1);
      }
      return;
    }
    if (!dateSet.has(event.date)) return;
    const start = timeToMinutes(event.startTime);
    const target = start < CALENDAR_START_MINUTES ? early : start >= CALENDAR_END_MINUTES ? late : timed;
    if (!target.has(event.date)) target.set(event.date, []);
    target.get(event.date).push(event);
  });

  const card = element("section", "page-card calendar-card");
  card.dataset.view = "calendar";
  const heading = element("header", "page-heading");
  const headingCopy = document.createElement("div");
  headingCopy.append(element("h1", "", "Календарь"), element("p", "", "Нажмите или выделите время, чтобы создать задачу"));
  const zoneControl = element("label", "calendar-timezone-control");
  zoneControl.append(element("span", "", "Дополнительная шкала"));
  const zoneSelect = document.createElement("select");
  zoneSelect.setAttribute("aria-label", "Дополнительная часовая шкала");
  CALENDAR_TIME_ZONES.secondary.forEach((zone) => {
    const option = document.createElement("option");
    option.value = zone.id;
    option.textContent = zone.label;
    option.selected = zone.id === secondaryTimeZone.id;
    zoneSelect.append(option);
  });
  zoneSelect.addEventListener("change", () => options.onSecondaryTimeZoneChange?.(zoneSelect.value));
  zoneControl.append(zoneSelect);
  const headingActions = element("div", "calendar-heading-actions");
  headingActions.append(element("span", "eyebrow", "Основное время · Москва"), zoneControl);
  heading.append(headingCopy, headingActions);
  card.append(heading);
  if (options.showFirstRunHint) card.append(element("p", "first-run-hint", "Добавьте первую задачу или подключите календари Google"));

  const header = element("div", "calendar-week-header");
  const corner = element("div", "calendar-header-corner");
  corner.append(element("strong", "", "Москва"), element("small", "", secondaryTimeZone.label));
  header.append(corner);
  dates.forEach((date, index) => {
    const dateValue = formatLocalDate(date);
    const day = element("div", `week-day${dateValue === moscowToday ? " is-today" : ""}`);
    day.setAttribute("role", "columnheader");
    day.append(element("span", "week-day__name", WEEKDAY_NAMES[index]), element("span", "week-day__number", String(date.getDate())));
    header.append(day);
  });

  const scroll = element("div", "calendar-scroll");
  scroll.dataset.calendarScroll = "";
  scroll.append(
    header,
    renderCompactRegion("Раньше 06:00", dates, early, callbacks, tasksById),
    renderAllDay(dates, allDay, callbacks, tasksById),
    renderTimeBody(dates, timed, callbacks, tasksById, now, secondaryTimeZone),
    renderCompactRegion("Позже 23:00", dates, late, callbacks, tasksById),
  );
  window.requestAnimationFrame(() => { scroll.scrollTop = Number(options.scrollTop) || 0; });
  scroll.addEventListener("scroll", () => options.onScroll?.(scroll.scrollTop), { passive: true });
  card.append(scroll);
  return card;
}
