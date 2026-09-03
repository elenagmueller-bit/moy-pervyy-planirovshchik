import { deletePlannerDatabase, openPlannerDatabase } from "../js/db.js";
import { createTask, updateTaskRecord, validateTask } from "../js/models.js";
import { createRepositories, filterTasks, isTaskOverdue, sortTasks } from "../js/repositories.js";

const results = [];
const list = document.querySelector("[data-results]");
const summary = document.querySelector("[data-summary]");
const testDatabaseName = `planner-stage2-${crypto.randomUUID()}`;

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

const base = {
  title: "Задача",
  shortDescription: "",
  details: "",
  date: "2026-09-03",
  hasTime: false,
  startTime: null,
  durationMinutes: null,
  priority: "medium",
  category: "work",
  status: "active",
  tags: [],
  checklist: [],
  links: [],
};

await check("Границы обязательных и текстовых полей", () => {
  assert(!validateTask({ ...base, title: "" }).valid);
  assert(!validateTask({ ...base, title: "x".repeat(201) }).valid);
  assert(!validateTask({ ...base, shortDescription: "x".repeat(501) }).valid);
  assert(!validateTask({ ...base, details: "x".repeat(10_001) }).valid);
  assert(!validateTask({ ...base, date: "2026-02-30" }).valid);
  assert(!validateTask({ ...base, category: "" }).valid);
});

await check("Время, длительность и переход через полночь", () => {
  assert(!validateTask({ ...base, hasTime: true, startTime: "10:07", durationMinutes: 15 }).valid);
  assert(!validateTask({ ...base, hasTime: true, startTime: "25:00", durationMinutes: 15 }).valid);
  [0, 14, 16, 1_441].forEach((durationMinutes) => assert(!validateTask({ ...base, hasTime: true, startTime: "23:45", durationMinutes }).valid));
  [15, 30, 1_440].forEach((durationMinutes) => assert(validateTask({ ...base, hasTime: true, startTime: "23:45", durationMinutes }).valid));
  assert(createTask({ ...base, hasTime: true, startTime: "23:45", durationMinutes: undefined }).durationMinutes === 15);
});

await check("Ссылки, теги и чек-лист", () => {
  assert(validateTask({ ...base, links: [{ label: "Документ", url: "https://example.com" }] }).valid);
  assert(!validateTask({ ...base, links: [{ label: "Файл", url: "file:///tmp/a" }] }).valid);
  assert(!validateTask({ ...base, links: [{ label: "Ошибка", url: "javascript:alert(1)" }] }).valid);
  assert(!validateTask({ ...base, tags: Array.from({ length: 21 }, (_, i) => `тег${i}`) }).valid);
  assert(!validateTask({ ...base, tags: ["x".repeat(31)] }).valid);
  assert(!validateTask({ ...base, checklist: Array.from({ length: 101 }, (_, i) => ({ text: `Пункт ${i}` })) }).valid);
});

await check("Фабрика сохраняет локальные поля и увеличивает revision", () => {
  const created = createTask({ ...base, tags: ["Важно", "важно"], checklist: [{ text: "  Проверить  " }] }, new Date("2026-09-03T08:00:00Z"));
  const updated = updateTaskRecord(created, { title: "Изменено" }, new Date("2026-09-03T09:00:00Z"));
  assert(created.tags.length === 1 && created.tags[0] === "Важно");
  assert(created.checklist[0].text === "Проверить");
  assert(updated.revision === 2 && updated.createdAt === created.createdAt && updated.updatedAt !== created.updatedAt);
});

let database = await openPlannerDatabase({ name: testDatabaseName });
let repositories = createRepositories(database);
let workTask;
let personalTask;

await check("Создание личной и рабочей задачи переживает переоткрытие БД", async () => {
  workTask = await repositories.tasks.create({ ...base, title: "Рабочая", priority: "high", hasTime: true, startTime: "09:00", durationMinutes: 30 });
  personalTask = await repositories.tasks.create({ ...base, title: "Личная", category: "personal", priority: "low", date: "2026-09-04" });
  database.close();
  database = await openPlannerDatabase({ name: testDatabaseName });
  repositories = createRepositories(database);
  const stored = await repositories.tasks.getAll();
  assert(stored.length === 2);
  assert(stored.find((task) => task.id === workTask.id).durationMinutes === 30);
  assert(stored.find((task) => task.id === personalTask.id).category === "personal");
});

await check("Все переходы статуса и временные метки", async () => {
  const completed = await repositories.tasks.complete(workTask.id, new Date("2026-09-03T10:00:00Z"));
  assert(completed.status === "completed" && completed.completedAt && completed.revision === 2 && !completed.archivedAt);
  const reopened = await repositories.tasks.reopen(workTask.id, new Date("2026-09-03T11:00:00Z"));
  assert(reopened.status === "active" && !reopened.completedAt && reopened.revision === 3);
  const cancelled = await repositories.tasks.cancel(workTask.id, new Date("2026-09-03T12:00:00Z"));
  assert(cancelled.status === "cancelled" && cancelled.cancelledAt && cancelled.archivedAt && cancelled.revision === 4);
  const restored = await repositories.tasks.restoreFromArchive(workTask.id, new Date("2026-09-03T13:00:00Z"));
  assert(restored.status === "active" && !restored.cancelledAt && !restored.archivedAt && restored.revision === 5);
  const completedAgain = await repositories.tasks.complete(workTask.id);
  const archived = await repositories.tasks.archive(workTask.id);
  const restoredCompleted = await repositories.tasks.restoreFromArchive(workTask.id);
  assert(completedAgain.status === "completed" && archived.archivedAt && restoredCompleted.status === "completed" && !restoredCompleted.archivedAt);
});

await check("Корзина восстанавливает прежнее место и защищает окончательное удаление", async () => {
  await repositories.tasks.moveToTrash(workTask.id, new Date("2026-09-04T00:00:00Z"));
  assert((await repositories.tasks.get(workTask.id)).trashedAt);
  const restored = await repositories.tasks.restoreFromTrash(workTask.id);
  assert(!restored.trashedAt && restored.status === "completed");
  let protectedDelete = false;
  try { await repositories.tasks.deleteForever(workTask.id); } catch (error) { protectedDelete = error.name === "InvalidStateError"; }
  assert(protectedDelete);
});

await check("Очистка удаляет 30 суток, но сохраняет 29 суток и архив", async () => {
  const now = new Date("2026-09-03T12:00:00Z");
  const old = await repositories.tasks.create({ ...base, title: "30 суток", trashedAt: new Date(now.getTime() - 30 * 86_400_000).toISOString() }, now);
  const recent = await repositories.tasks.create({ ...base, title: "29 суток", trashedAt: new Date(now.getTime() - 29 * 86_400_000).toISOString() }, now);
  const archived = await repositories.tasks.create({ ...base, title: "Архив", archivedAt: new Date(now.getTime() - 90 * 86_400_000).toISOString() }, now);
  const cleanup = await repositories.tasks.cleanupExpiredTrash({ now, force: true });
  assert(cleanup.deleted === 1 && !(await repositories.tasks.get(old.id)));
  assert(await repositories.tasks.get(recent.id));
  assert(await repositories.tasks.get(archived.id));
});

await check("Просрочка со временем и без времени", () => {
  const now = new Date(2026, 8, 3, 12, 0, 0);
  assert(isTaskOverdue({ ...base, date: "2026-09-02" }, now));
  assert(!isTaskOverdue({ ...base, date: "2026-09-03" }, now));
  assert(isTaskOverdue({ ...base, date: "2026-09-03", hasTime: true, startTime: "10:00", durationMinutes: 15 }, now));
  assert(!isTaskOverdue({ ...base, date: "2026-09-03", hasTime: true, startTime: "11:50", durationMinutes: 15 }, now));
  assert(!isTaskOverdue({ ...base, date: "2026-09-02", archivedAt: "2026-09-02T00:00:00Z" }, now));
});

await check("Разделы, фильтры и сортировки", () => {
  const sample = [
    createTask({ ...base, id: "1", title: "Без времени", priority: "low", date: "2026-09-04", createdAt: "2026-09-01T00:00:00Z" }),
    createTask({ ...base, id: "2", title: "Со временем", category: "personal", priority: "high", date: "2026-09-04", hasTime: true, startTime: "08:00", durationMinutes: 15, createdAt: "2026-09-02T00:00:00Z" }),
    createTask({ ...base, id: "3", title: "В архиве", archivedAt: "2026-09-02T00:00:00Z", createdAt: "2026-09-03T00:00:00Z" }),
    createTask({ ...base, id: "4", title: "В корзине", trashedAt: "2026-09-02T00:00:00Z", createdAt: "2026-09-04T00:00:00Z" }),
  ];
  assert(filterTasks(sample, "work").length === 1);
  assert(filterTasks(sample, "personal").length === 1);
  assert(filterTasks(sample, "archive").length === 1);
  assert(filterTasks(sample, "trash").length === 1);
  assert(filterTasks(sample, "tasks", { includeArchived: true }).length === 3);
  assert(filterTasks(sample, "tasks", { category: "personal", priority: "high", time: "timed" }).length === 1);
  assert(sortTasks(sample.slice(0, 2), "date")[0].id === "1");
  assert(sortTasks(sample.slice(0, 2), "priority")[0].id === "2");
  assert(sortTasks(sample.slice(0, 2), "created-new")[0].id === "2");
});

await check("Повторное создание с тем же ID не даёт дубликат", async () => {
  const duplicate = { ...base, id: crypto.randomUUID(), title: "Один раз" };
  await repositories.tasks.create(duplicate);
  let blocked = false;
  try { await repositories.tasks.create(duplicate); } catch (error) { blocked = error.name === "ConstraintError"; }
  assert(blocked);
  assert((await repositories.tasks.getAll()).filter((task) => task.id === duplicate.id).length === 1);
});

database.close();
await deletePlannerDatabase(testDatabaseName);

results.forEach((result) => {
  const item = document.createElement("li");
  item.className = result.passed ? "passed" : "failed";
  item.textContent = result.passed ? `Пройдено: ${result.name}` : `Ошибка: ${result.name} — ${result.error}`;
  list.append(item);
});
const passed = results.filter((result) => result.passed).length;
summary.textContent = `${passed} из ${results.length} проверок пройдено`;
document.documentElement.dataset.testStatus = passed === results.length ? "passed" : "failed";
window.__STAGE2_TEST_RESULTS__ = results;
