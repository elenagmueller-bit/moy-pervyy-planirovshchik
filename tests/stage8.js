import { APP_VERSION, CACHE_VERSION, LIMITS } from "../js/config.js?stage=8";
import { renderWeekCalendar } from "../js/calendar-view.js?stage=8";
import { convertWallTime } from "../js/date-utils.js?stage=8";
import { searchPlanner } from "../js/search.js?stage=8";
import { paginateItems, storagePressure } from "../js/ui.js?stage=8";

const results = [];
const list = document.querySelector("[data-results]");
const assert = (value, message = "Проверка не пройдена") => { if (!value) throw new Error(message); };
async function check(name, operation) { try { await operation(); results.push({ name, passed: true }); } catch (error) { results.push({ name, passed: false, error: error.message }); } }
const source = async (path) => (await fetch(path, { cache: "no-store" })).text();

await check("Версия выпуска и Service Worker согласованы", async () => {
  const worker = await source("../sw.js");
  assert(APP_VERSION === "0.8.0" && CACHE_VERSION === "planner-shell-v16");
  assert(worker.includes(`const CACHE_NAME = "${CACHE_VERSION}"`));
});

await check("Все прикладные ES-модули доступны напрямую", async () => {
  const names = ["main", "config", "date-utils", "models", "db", "repositories", "recurrence", "state", "router", "ui", "calendar-view", "forms", "search", "google-auth", "google-calendar", "sync", "backup"];
  const responses = await Promise.all(names.map((name) => fetch(`../js/${name}.js`, { cache: "no-store" })));
  assert(responses.every((response) => response.ok));
});

await check("Manifest Service Worker содержит всю статическую оболочку", async () => {
  const worker = await source("../sw.js");
  const required = ["index.html", "style.css", "main.js", "config.js", "date-utils.js", "models.js", "db.js", "repositories.js", "recurrence.js", "state.js", "router.js", "ui.js", "calendar-view.js", "forms.js", "search.js", "google-auth.js", "google-calendar.js", "sync.js", "backup.js"];
  assert(required.every((name) => worker.includes(name)));
  assert(!/indexedDB|googleapis\.com|importScripts/.test(worker));
});

await check("CSP разрешает только собственный код и официальный Google GIS", async () => {
  const html = await source("../index.html");
  assert(html.includes("Content-Security-Policy") && html.includes("https://accounts.google.com/gsi/client") && html.includes("object-src 'none'") && html.includes("base-uri 'self'"));
  assert(!html.includes("'unsafe-eval'"));
});

await check("Нет динамического исполнения и небезопасного HTML", async () => {
  const files = await Promise.all(["ui", "forms", "models", "backup", "sync"].map((name) => source(`../js/${name}.js`)));
  assert(files.every((text) => !/\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|\beval\s*\(|new\s+Function/.test(text)));
});

await check("В проекте нет Client Secret и постоянного хранения access token", async () => {
  const files = await Promise.all(["config", "google-auth", "google-calendar", "backup"].map((name) => source(`../js/${name}.js`)));
  assert(files.every((text) => !/client[_-]?secret/i.test(text)));
  assert(!/localStorage\.setItem\([^\n]*(token|access)/i.test(files.join("\n")));
});

await check("Длинный список выдаётся страницами по 100 элементов", () => {
  const page = paginateItems(Array.from({ length: 10_000 }, (_, index) => index));
  assert(LIMITS.listPageSize === 100 && page.shown === 100 && page.total === 10_000 && page.hasMore);
});

await check("Поиск по 10 000 объектов быстрее целевых 300 мс", () => {
  const tasks = Array.from({ length: 10_000 }, (_, index) => ({ title: `Задача ${index}`, shortDescription: index === 9_999 ? "точная находка" : "", details: "", tags: [], checklist: [], links: [] }));
  const started = performance.now();
  const found = searchPlanner({ tasks }, "точная находка");
  const elapsed = performance.now() - started;
  assert(found.tasks.length === 1 && elapsed < 300, `Поиск занял ${elapsed.toFixed(1)} мс`);
});

await check("Порог предупреждения хранилища равен 80%", () => {
  assert(LIMITS.storageWarningRatio === 0.8 && storagePressure({ usage: 80, quota: 100 }) === 0.8 && storagePressure({}) === null);
});

await check("Пустой календарь содержит подсказку первого запуска", () => {
  const calendar = renderWeekCalendar(new Date("2026-12-31T12:00:00"), { tasks: [], googleEvents: [], showFirstRunHint: true });
  assert(calendar.textContent.includes("Добавьте первую задачу или подключите календари Google"));
  assert(calendar.querySelectorAll(".week-day").length === 7);
});

await check("Швейцарская шкала автоматически учитывает летнее время", () => {
  const winter = convertWallTime("2026-01-15", "12:00", "Europe/Moscow", "Europe/Zurich");
  const summer = convertWallTime("2026-07-15", "12:00", "Europe/Moscow", "Europe/Zurich");
  assert(winter.time === "10:00" && summer.time === "11:00");
});

await check("Единственный файловый ввод предназначен для JSON-backup", async () => {
  const html = await source("../js/ui.js");
  assert((html.match(/type\s*=\s*"file"/g) || []).length === 1 && html.includes("application/json,.json"));
});

await check("Внешние ссылки защищены noopener и noreferrer", async () => {
  const files = `${await source("../js/ui.js")}\n${await source("../js/forms.js")}`;
  const targets = (files.match(/target\s*=\s*"_blank"/g) || []).length;
  const protectedLinks = (files.match(/rel\s*=\s*"noopener noreferrer"/g) || []).length;
  assert(targets > 0 && protectedLinks === targets);
});

await check("Подготовлена инструкция production OAuth без backend", async () => {
  const guide = await source("../GOOGLE_CALENDAR_SETUP.md");
  assert(guide.includes("https://elenagmueller-bit.github.io") && guide.includes("moy-pervyy-planirovshchik") && guide.includes("Client Secret") && guide.includes("backend"));
});

results.forEach((result) => { const item = document.createElement("li"); item.className = result.passed ? "passed" : "failed"; item.textContent = result.passed ? `Пройдено: ${result.name}` : `Ошибка: ${result.name} — ${result.error}`; list.append(item); });
const passed = results.filter((item) => item.passed).length;
document.querySelector("[data-summary]").textContent = `${passed} из ${results.length} проверок пройдено`;
document.documentElement.dataset.testStatus = passed === results.length ? "passed" : "failed";
window.__STAGE8_TEST_RESULTS__ = results;
