import "../js/backup.js";
import "../js/calendar-view.js";
import "../js/forms.js";
import "../js/google-auth.js";
import "../js/google-calendar.js";
import "../js/repositories.js";
import "../js/router.js";
import "../js/search.js";
import "../js/state.js";
import "../js/sync.js";
import "../js/ui.js";
import { DB_VERSION } from "../js/config.js";
import { deletePlannerDatabase, openPlannerDatabase, requestToPromise, runTransaction, STORE_DEFINITIONS } from "../js/db.js";
import { addCalendarDays, addCalendarMonthsClamped, combineLocalDateTime, endOfISOWeek, formatLocalDate, formatPeriodLabel, getISOWeek, startOfISOWeek, toUtcTimestamp } from "../js/date-utils.js";
import { createNote, createTask, validateSeries, validateTask, ValidationError } from "../js/models.js";
import { previewSeries } from "../js/recurrence.js";

const results = [];

function assert(condition, message = "Условие не выполнено") {
  if (!condition) throw new Error(message);
}

async function check(name, test) {
  try {
    await test();
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, error: error?.message || String(error) });
  }
}

function openLegacyDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const tasks = request.result.createObjectStore("tasks", { keyPath: "id" });
      tasks.createIndex("date", "date");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

await check("Все ES-модули успешно импортируются", () => assert(true));

await check("ISO-недели и границы недели", () => {
  assert(getISOWeek(new Date(2020, 11, 31, 12)) === 53, "31.12.2020 должен быть в неделе 53");
  assert(getISOWeek(new Date(2021, 0, 1, 12)) === 53, "01.01.2021 должен быть в неделе 53");
  assert(formatLocalDate(startOfISOWeek("2026-09-03")) === "2026-08-31");
  assert(formatLocalDate(endOfISOWeek("2026-09-03")) === "2026-09-06");
  assert(formatPeriodLabel("2026-09-03").includes("августа"), "Название месяца должно быть в родительном падеже");
});

await check("Календарная арифметика и високосный год", () => {
  assert(addCalendarDays("2024-02-28", 1) === "2024-02-29");
  assert(addCalendarDays("2023-02-28", 1) === "2023-03-01");
  assert(addCalendarMonthsClamped("2026-01-31", 1) === "2026-02-28");
  assert(addCalendarMonthsClamped("2024-01-31", 1) === "2024-02-29");
  const acrossMidnight = combineLocalDateTime("2026-09-03", "23:45");
  acrossMidnight.setMinutes(acrossMidnight.getMinutes() + 30);
  assert(formatLocalDate(acrossMidnight) === "2026-09-04");
  assert(toUtcTimestamp(acrossMidnight).endsWith("Z"));
});

await check("Базовая модель задачи и валидация", () => {
  const invalid = validateTask({ title: "", date: "2026-02-30", category: "", priority: "medium", status: "active", hasTime: true, startTime: "25:00", durationMinutes: 10 });
  assert(!invalid.valid && Object.keys(invalid.errors).length >= 4);
  const task = createTask({ title: "  Проверить основу  ", date: "2026-09-03", category: "work", priority: "medium", status: "active", hasTime: true, startTime: "10:00", durationMinutes: 15 });
  assert(task.title === "Проверить основу");
  assert(task.revision === 1 && task.updatedAt.endsWith("Z"));
  let threw = false;
  try { createTask({ title: "", date: "", category: "" }); } catch (error) { threw = error instanceof ValidationError; }
  assert(threw, "Некорректная задача должна быть отклонена");
});

await check("Базовые модели заметки и серии", () => {
  const note = createNote({ title: " Идея ", category: "personal", priority: "low", text: "Текст" });
  assert(note.title === "Идея" && note.isPinned === false);
  const series = { frequency: "monthly", interval: 1, startDate: "2026-01-31", until: "2026-04-30" };
  assert(validateSeries(series).valid);
  assert(JSON.stringify(previewSeries(series, 4)) === JSON.stringify(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]));
});

const testDatabaseName = `planner-stage1-test-${crypto.randomUUID()}`;

await check("IndexedDB мигрирует схему 1 → 2 без потери записи", async () => {
  const legacy = await openLegacyDatabase(testDatabaseName);
  const transaction = legacy.transaction("tasks", "readwrite");
  transaction.objectStore("tasks").put({ id: "legacy", date: "2026-09-03", title: "Старая запись" });
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  legacy.close();
  const database = await openPlannerDatabase({ name: testDatabaseName, version: DB_VERSION });
  assert(database.version === DB_VERSION);
  assert(Object.keys(STORE_DEFINITIONS).every((name) => database.objectStoreNames.contains(name)), "Созданы не все stores");
  const stored = await runTransaction(database, "tasks", "readonly", ({ tasks }) => requestToPromise(tasks.get("legacy")));
  assert(stored?.title === "Старая запись", "Старая запись потеряна");
  Object.entries(STORE_DEFINITIONS).forEach(([name, definition]) => {
    const store = database.transaction(name, "readonly").objectStore(name);
    definition.indexes.forEach(([indexName]) => assert(store.indexNames.contains(indexName), `Нет индекса ${name}.${indexName}`));
  });
  database.close();
});

await check("Транзакция IndexedDB откатывается целиком", async () => {
  const database = await openPlannerDatabase({ name: testDatabaseName, version: DB_VERSION });
  let rejected = false;
  try {
    await runTransaction(database, ["tasks", "notes"], "readwrite", async ({ tasks, notes }) => {
      tasks.put({ id: "rollback-task", title: "Не сохранять", date: "2026-09-03" });
      notes.put({ id: "rollback-note", title: "Не сохранять" });
      throw new Error("Искусственная ошибка");
    });
  } catch { rejected = true; }
  assert(rejected, "Транзакция должна вернуть ошибку");
  const task = await runTransaction(database, "tasks", "readonly", ({ tasks }) => requestToPromise(tasks.get("rollback-task")));
  const note = await runTransaction(database, "notes", "readonly", ({ notes }) => requestToPromise(notes.get("rollback-note")));
  assert(task === undefined && note === undefined, "Данные частично сохранились");
  database.close();
});

await deletePlannerDatabase(testDatabaseName);

await check("Обычный запуск не содержит тестовых пользовательских данных", async () => {
  const database = await openPlannerDatabase();
  const tasks = await runTransaction(database, "tasks", "readonly", ({ tasks: store }) => requestToPromise(store.count()));
  const notes = await runTransaction(database, "notes", "readonly", ({ notes: store }) => requestToPromise(store.count()));
  assert(tasks === 0 && notes === 0, `Найдены тестовые данные: tasks=${tasks}, notes=${notes}`);
  database.close();
});

const list = document.querySelector("[data-results]");
results.forEach((result) => {
  const item = document.createElement("li");
  item.className = result.passed ? "pass" : "fail";
  item.textContent = result.passed ? `Пройдено: ${result.name}` : `Ошибка: ${result.name} — ${result.error}`;
  list.append(item);
});
const passed = results.filter((result) => result.passed).length;
document.querySelector("[data-summary]").textContent = `${passed} из ${results.length} проверок пройдено`;
document.documentElement.dataset.testStatus = passed === results.length ? "passed" : "failed";
window.__STAGE1_TEST_RESULTS__ = results;
