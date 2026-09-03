import { DEFAULT_ROUTE, STORAGE_KEYS } from "./config.js";
import { openPlannerDatabase } from "./db.js";
import { createRepositories } from "./repositories.js";
import { createRouter, routeFromHash } from "./router.js";
import { createAppState } from "./state.js";
import { createUI } from "./ui.js";

function readBoolean(key) {
  return localStorage.getItem(key) === "true";
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;
  return navigator.serviceWorker.register("./sw.js", { scope: "./" });
}

async function start() {
  const database = await openPlannerDatabase();
  const repositories = createRepositories(database);
  const storedRoute = localStorage.getItem(STORAGE_KEYS.lastRoute) || DEFAULT_ROUTE;
  const state = createAppState({
    route: window.location.hash ? routeFromHash() : storedRoute,
    sidebarCollapsed: readBoolean(STORAGE_KEYS.sidebarCollapsed),
  });
  const router = createRouter(state);
  const ui = createUI({ state, router, repositories });

  window.addEventListener("online", () => state.set({ online: true }));
  window.addEventListener("offline", () => state.set({ online: false }));
  state.subscribe((current, previous) => {
    if (current.online !== previous.online) {
      ui.showToast(current.online ? "Соединение восстановлено" : "Вы офлайн. Локальные изменения будут сохранены");
    }
  });

  const cleanup = await repositories.tasks.cleanupExpiredTrash();
  await ui.mount();
  if (cleanup.deleted) ui.showToast(`Из корзины удалено устаревших задач: ${cleanup.deleted}`);
  state.set({ ready: true });
  if (!window.location.hash) router.navigate(state.get().route, { replace: true });

  try {
    await registerServiceWorker();
  } catch {
    ui.showToast("Офлайн-режим пока недоступен. Остальные функции работают");
  }

  window.__PLANNER_DIAGNOSTICS__ = Object.freeze({
    appReady: true,
    schemaVersion: database.version,
    storeNames: Array.from(database.objectStoreNames),
    route: () => state.get().route,
    taskCount: () => repositories.tasks.getAll().then((tasks) => tasks.length),
  });
}

start().catch((error) => {
  const status = document.querySelector("[data-startup-status]");
  status.textContent = "Не удалось открыть локальное хранилище. Обновите страницу или проверьте настройки браузера.";
  status.dataset.error = error?.name || "StartupError";
});
