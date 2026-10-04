import {
  CALENDAR_END_MINUTES,
  CALENDAR_START_MINUTES,
  SLOT_HEIGHT,
  durationFromResize,
  findTaskConflicts,
  layoutTimedTasks,
  minutesToTime,
  renderWeekCalendar,
  timeToMinutes,
} from "../js/calendar-view.js";
import { convertWallTime, wallTimeToInstant } from "../js/date-utils.js";

const results = [];
const list = document.querySelector("[data-results]");
const summary = document.querySelector("[data-summary]");
const mount = document.querySelector("[data-test-mount]");

function assert(condition, message = "Проверка не пройдена") {
  if (!condition) throw new Error(message);
}

async function check(name, operation) {
  try {
    await operation();
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, error: error.message });
  }
}

function task(overrides = {}) {
  return {
    id: crypto.randomUUID(),
    title: "Задача",
    date: "2026-08-31",
    hasTime: true,
    startTime: "09:00",
    durationMinutes: 30,
    priority: "medium",
    category: "work",
    status: "active",
    archivedAt: null,
    trashedAt: null,
    ...overrides,
  };
}

await check("Преобразование времени и границы длительности", () => {
  assert(timeToMinutes("06:15") === 375);
  assert(minutesToTime(1_455) === "00:15");
  assert(durationFromResize(30, SLOT_HEIGHT) === 45);
  assert(durationFromResize(15, -500) === 15);
  assert(durationFromResize(1_440, 500) === 1_440);
});

await check("Москва — основная шкала, Самара и Швейцария пересчитываются", () => {
  assert(convertWallTime("2026-01-15", "12:00", "Europe/Moscow", "Europe/Samara").time === "13:00");
  assert(convertWallTime("2026-07-15", "12:00", "Europe/Moscow", "Europe/Samara").time === "13:00");
  assert(convertWallTime("2026-01-15", "12:00", "Europe/Moscow", "Europe/Zurich").time === "10:00");
  assert(convertWallTime("2026-07-15", "12:00", "Europe/Moscow", "Europe/Zurich").time === "11:00");
});

await check("Пересечения учитывают соседний день", () => {
  const first = task({ id: "first", date: "2026-08-31", startTime: "23:30", durationMinutes: 60 });
  const second = task({ id: "second", date: "2026-09-01", startTime: "00:00", durationMinutes: 15 });
  const third = task({ id: "third", date: "2026-09-01", startTime: "01:00", durationMinutes: 15 });
  assert(findTaskConflicts(first, [first, second, third]).map((item) => item.id).join() === "second");
  assert(findTaskConflicts({ ...first, hasTime: false }, [second]).length === 0);
});

await check("Пересекающиеся карточки получают отдельные колонки", () => {
  const values = [
    task({ id: "a", startTime: "09:00", durationMinutes: 60 }),
    task({ id: "b", startTime: "09:30", durationMinutes: 60 }),
    task({ id: "c", startTime: "10:00", durationMinutes: 60 }),
  ];
  const layout = layoutTimedTasks(values);
  assert(layout.every((item) => item.columns === 2));
  assert(layout.find((item) => item.task.id === "a").column !== layout.find((item) => item.task.id === "b").column);
});

await check("Неделя на границе года остаётся с понедельника по воскресенье", () => {
  const boundary = renderWeekCalendar("2020-12-31", { tasks: [], now: new Date(2020, 11, 31, 12) });
  const days = [...boundary.querySelectorAll(".week-day__number")].map((item) => item.textContent).join(",");
  assert(days === "28,29,30,31,1,2,3");
});

const sampleTasks = [
  task({ id: "all-day", title: "Без времени", hasTime: false, startTime: null, durationMinutes: null }),
  task({ id: "early", title: "Рано", startTime: "05:30" }),
  task({ id: "late", title: "Поздно", startTime: "23:15" }),
  task({ id: "cross", title: "Через полночь", startTime: "22:45", durationMinutes: 90 }),
  task({ id: "overlap-a", title: "Встреча A", startTime: "10:00", durationMinutes: 60 }),
  task({ id: "overlap-b", title: "Встреча B", startTime: "10:15", durationMinutes: 30 }),
];
let created = null;
let moved = null;
let resized = null;
let scrollValue = null;
let selectedZone = null;
const calendar = renderWeekCalendar("2026-08-31", {
  tasks: sampleTasks,
  now: wallTimeToInstant("2026-08-31", "10:30", "Europe/Moscow"),
  secondaryTimeZone: "Europe/Zurich",
  onSecondaryTimeZoneChange: (value) => { selectedZone = value; },
  onCreate: (value) => { created = value; },
  onMove: (value, patch) => { moved = { value, patch }; },
  onResize: (value, durationMinutes) => { resized = { value, durationMinutes }; },
  scrollTop: 96,
  onScroll: (value) => { scrollValue = value; },
});
mount.append(calendar);
await new Promise((resolve) => requestAnimationFrame(resolve));

await check("Неделя содержит 7 дней и 68 четвертей часа в каждом", () => {
  assert(calendar.querySelectorAll(".week-day").length === 7);
  assert(calendar.querySelectorAll(".calendar-day-column").length === 7);
  assert(calendar.querySelectorAll(".calendar-slot").length === 68 * 7);
  assert(calendar.querySelector(".calendar-slot").dataset.time === "06:00");
  assert(calendar.querySelectorAll(".calendar-slot")[67].dataset.time === "22:45");
  assert(CALENDAR_START_MINUTES === 360 && CALENDAR_END_MINUTES === 1_380);
});

await check("В календаре видны Москва и выбранная дополнительная шкала", () => {
  assert(calendar.querySelector(".calendar-header-corner").textContent === "МоскваШвейцария");
  assert(calendar.querySelector("[aria-label='Дополнительная часовая шкала']").value === "Europe/Zurich");
  const firstLabel = calendar.querySelector(".calendar-time-label");
  assert(firstLabel.querySelector("strong").textContent === "06:00");
  assert(firstLabel.querySelector("small").textContent === "05:00");
  const selector = calendar.querySelector("[aria-label='Дополнительная часовая шкала']");
  selector.value = "Europe/Samara";
  selector.dispatchEvent(new Event("change", { bubbles: true }));
  assert(selectedZone === "Europe/Samara");
});

await check("Задачи всех временных типов остаются в DOM", () => {
  ["all-day", "early", "late", "cross", "overlap-a", "overlap-b"].forEach((id) => assert(calendar.querySelector(`[data-calendar-task-id="${id}"]`), `Не найдена ${id}`));
  assert(calendar.querySelector('[data-calendar-task-id="cross"] span').textContent.includes("+1 день"));
  assert(calendar.querySelectorAll(".calendar-compact-region")[0].textContent.includes("Раньше 06:00 · 1"));
  assert(calendar.querySelectorAll(".calendar-compact-region")[1].textContent.includes("Позже 23:00 · 1"));
});

await check("DOM-раскладка пересечений не накладывает карточки в одну колонку", () => {
  const first = calendar.querySelector('[data-calendar-task-id="overlap-a"]');
  const second = calendar.querySelector('[data-calendar-task-id="overlap-b"]');
  assert(first.style.left !== second.style.left);
  assert(first.style.width === second.style.width);
});

await check("Щелчок по слоту создаёт 15-минутную задачу", () => {
  created = null;
  const slot = calendar.querySelector('[data-date="2026-09-01"][data-time="08:30"]');
  slot.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  slot.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
  assert(created?.date === "2026-09-01" && created.startTime === "08:30" && created.durationMinutes === 15);
});

await check("Выделение нескольких слотов задаёт длительность", () => {
  created = null;
  const first = calendar.querySelector('[data-date="2026-09-02"][data-time="11:00"]');
  const last = calendar.querySelector('[data-date="2026-09-02"][data-time="11:45"]');
  first.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  last.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
  last.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
  assert(created?.startTime === "11:00" && created.durationMinutes === 60);
});

await check("Щелчок и drop в области без времени дают правильные данные", () => {
  created = null;
  const allDayCell = calendar.querySelector('[data-all-day-date="2026-09-03"]');
  allDayCell.click();
  assert(created?.date === "2026-09-03" && created.hasTime === false);
  const transfer = new DataTransfer();
  transfer.setData("text/plain", "overlap-a");
  allDayCell.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  assert(moved?.value.id === "overlap-a" && moved.patch.hasTime === false && moved.patch.startTime === null);
});

await check("Drop задачи без времени в сетку назначает 15 минут", () => {
  const target = calendar.querySelector('[data-date="2026-09-04"][data-time="14:15"]');
  const transfer = new DataTransfer();
  transfer.setData("text/plain", "all-day");
  target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  assert(moved?.value.id === "all-day" && moved.patch.startTime === "14:15" && moved.patch.durationMinutes === 15);

  const timedTransfer = new DataTransfer();
  timedTransfer.setData("text/plain", "overlap-a");
  target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: timedTransfer }));
  assert(moved?.value.id === "overlap-a" && moved.patch.durationMinutes === 60);
});

await check("Область без времени сворачивает записи после трёх", () => {
  const many = Array.from({ length: 5 }, (_, index) => task({ id: `all-${index}`, title: `Весь день ${index}`, hasTime: false, startTime: null, durationMinutes: null }));
  const compactCalendar = renderWeekCalendar("2026-08-31", { tasks: many });
  const cell = compactCalendar.querySelector('[data-all-day-date="2026-08-31"]');
  assert(cell.querySelectorAll("[data-calendar-task-id]").length === 3);
  assert(cell.querySelector(".calendar-more").textContent === "Ещё 2");
  cell.querySelector(".calendar-more").click();
  assert(cell.querySelectorAll("[data-calendar-task-id]").length === 5);
});

await check("Нижний маркер меняет длительность с шагом 15 минут", () => {
  resized = null;
  const handle = calendar.querySelector('[data-calendar-task-id="overlap-a"] [data-resize-handle]');
  handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientY: 100 }));
  document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientY: 132 }));
  document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientY: 132 }));
  assert(resized?.value.id === "overlap-a" && resized.durationMinutes === 90);
});

await check("Линия текущего времени и прокрутка работают", () => {
  const line = calendar.querySelector(".current-time-line");
  assert(line && line.style.top === "288px");
  const scroll = calendar.querySelector("[data-calendar-scroll]");
  assert(scroll.scrollTop === 96);
  scroll.scrollTop = 144;
  scroll.dispatchEvent(new Event("scroll"));
  assert(scrollValue === 144);
});

results.forEach((result) => {
  const item = document.createElement("li");
  item.textContent = result.passed ? `Пройдено: ${result.name}` : `Ошибка: ${result.name} — ${result.error}`;
  item.className = result.passed ? "passed" : "failed";
  list.append(item);
});
const passed = results.filter((result) => result.passed).length;
summary.textContent = `${passed} из ${results.length} проверок пройдено`;
document.documentElement.dataset.testStatus = passed === results.length ? "passed" : "failed";
window.__STAGE3_TEST_RESULTS__ = results;
