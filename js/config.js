export const APP_NAME = "Мой планировщик";
export const APP_VERSION = "0.3.0";
export const DB_NAME = "personal-planner";
export const DB_VERSION = 2;
export const CACHE_VERSION = "planner-shell-v5";
export const DEFAULT_ROUTE = "calendar";
export const VALID_ROUTES = Object.freeze([
  "today",
  "work",
  "personal",
  "tasks",
  "calendar",
  "notes",
  "archive",
  "trash",
  "settings",
]);

export const PRIORITIES = Object.freeze(["high", "medium", "low"]);
export const CATEGORIES = Object.freeze(["work", "personal"]);
export const TASK_STATUSES = Object.freeze(["active", "completed", "cancelled"]);
export const RECURRENCE_FREQUENCIES = Object.freeze(["daily", "weekly", "monthly", "yearly"]);

export const LIMITS = Object.freeze({
  taskTitle: 200,
  taskShortDescription: 500,
  taskDetails: 10_000,
  noteTitle: 200,
  noteText: 20_000,
  tagLength: 30,
  tags: 20,
  checklist: 100,
  durationMin: 15,
  durationMax: 1_440,
  trashRetentionDays: 30,
  trashCleanupIntervalHours: 24,
});

export const STORAGE_KEYS = Object.freeze({
  sidebarCollapsed: "planner.ui.sidebarCollapsed",
  lastRoute: "planner.ui.lastRoute",
  calendarScroll: "planner.ui.calendarScroll",
  introSeen: "planner.ui.introSeen",
});

export const GOOGLE_CONFIG = Object.freeze({
  clientId: "",
  readScope: "https://www.googleapis.com/auth/calendar.readonly",
  writeScope: "https://www.googleapis.com/auth/calendar.events",
});
