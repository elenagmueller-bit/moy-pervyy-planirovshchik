import { CALENDAR_TIME_ZONES, LIMITS, STORAGE_KEYS } from "./config.js";
import { addCalendarDays, combineLocalDateTime, dateStringInZone, endOfISOWeek, formatLocalDate, formatPeriodLabel, getISOWeek, getSystemTimeZone, monthMatrix, startOfISOWeek, wallClockDateInZone } from "./date-utils.js";
import { createNoteForm, createNoteViewer, createTaskForm, createTaskViewer } from "./forms.js?v=0.8.0";
import { filterNotes, filterTasks, isTaskOverdue, sortNotes, sortTasks, taskDeletionDate } from "./repositories.js?v=0.8.0";
import { findTaskConflicts, renderWeekCalendar } from "./calendar-view.js?v=0.8.0";
import { backupFileName, clearLocalData, createBackup, importBackup, importPreview, parseBackup } from "./backup.js?v=0.8.0";
import { searchPlanner } from "./search.js?v=0.8.0";

export function paginateItems(items, limit = LIMITS.listPageSize) {
  const safeLimit = Math.max(1, Number(limit) || LIMITS.listPageSize);
  return Object.freeze({ items: items.slice(0, safeLimit), total: items.length, shown: Math.min(items.length, safeLimit), hasMore: items.length > safeLimit });
}

export function storagePressure(estimate) {
  if (!estimate || !Number.isFinite(estimate.usage) || !Number.isFinite(estimate.quota) || estimate.quota <= 0) return null;
  return estimate.usage / estimate.quota;
}

const ROUTE_COPY = Object.freeze({
  today: ["Сегодня", "Задачи текущего дня и просроченные дела", "◉"],
  work: ["Рабочие задачи", "Рабочие дела в одном спокойном списке", "▣"],
  personal: ["Личные задачи", "Личные планы и важные мелочи", "⌂"],
  tasks: ["Все задачи", "Все локальные задачи", "☷"],
  notes: ["Заметки", "Мысли, ссылки и важные записи", "▤"],
  archive: ["Архив", "Завершённые вручную и отменённые задачи", "□"],
  trash: ["Корзина", "Удалённые записи хранятся 30 дней", "⌫"],
  settings: ["Настройки", "Основные параметры планировщика", "⚙"],
});

const LABELS = Object.freeze({
  priority: { high: "Высокий", medium: "Средний", low: "Низкий" },
  category: { work: "Работа", personal: "Личное" },
  status: { active: "Активная", completed: "Выполнена", cancelled: "Отменена" },
});

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, action, className = "button button--quiet") {
  const control = element("button", className, label);
  control.type = "button";
  control.dataset.taskAction = action;
  return control;
}

function formatTaskDate(task) {
  const date = new Date(`${task.date}T12:00:00`);
  const day = date.toLocaleDateString("ru-RU", { day: "numeric", month: "long", weekday: "short" });
  if (!task.hasTime) return `${day} · без времени`;
  const end = combineLocalDateTime(task.date, task.startTime);
  end.setMinutes(end.getMinutes() + task.durationMinutes);
  const endTime = end.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const rollover = formatLocalDate(end) !== task.date ? ` · до ${endTime} следующего дня` : "";
  return `${day}, ${task.startTime} · ${task.durationMinutes} мин${rollover}`;
}

function emptyState(route) {
  const [, description, symbol] = ROUTE_COPY[route];
  const empty = element("div", "empty-state");
  const content = element("div", "empty-state__content");
  content.append(element("div", "empty-state__symbol", symbol), element("h2", "", description));
  const message = route === "trash"
    ? "Здесь можно восстановить запись или удалить её навсегда."
    : route === "archive" ? "Отменённые и архивированные вручную записи появятся здесь."
    : route === "notes" ? "Добавьте первую заметку кнопкой «Создать»." : "Добавьте первую задачу кнопкой «Создать».";
  content.append(element("p", "", message));
  empty.append(content);
  return empty;
}

function selectControl(name, label, values, selected = "") {
  const wrapper = element("label", "filter-field");
  wrapper.append(element("span", "", label));
  const select = document.createElement("select");
  select.name = name;
  values.forEach(([value, text]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    option.selected = value === selected;
    select.append(option);
  });
  wrapper.append(select);
  return wrapper;
}

function inputControl(name, label, type, value = "") {
  const wrapper = element("label", "filter-field");
  wrapper.append(element("span", "", label));
  const input = document.createElement("input");
  input.name = name;
  input.type = type;
  input.value = value;
  wrapper.append(input);
  return wrapper;
}

function renderFilters(filters, sort, route) {
  const panel = element("details", "filter-panel");
  const summary = element("summary", "", "Фильтры и сортировка");
  const grid = element("div", "filter-grid");
  grid.append(
    inputControl("dateFrom", "Дата от", "date", filters.dateFrom),
    inputControl("dateTo", "Дата до", "date", filters.dateTo),
    selectControl("category", "Категория", [["", "Все"], ["work", "Работа"], ["personal", "Личное"]], filters.category),
    selectControl("priority", "Приоритет", [["", "Все"], ["high", "Высокий"], ["medium", "Средний"], ["low", "Низкий"]], filters.priority),
    selectControl("status", "Статус", [["", "Все"], ["active", "Активные"], ["completed", "Выполненные"], ["cancelled", "Отменённые"]], filters.status),
    selectControl("time", "Время", [["", "Все"], ["timed", "Со временем"], ["untimed", "Без времени"]], filters.time),
    selectControl("recurrence", "Повторение", [["", "Все"], ["recurring", "Повторяющиеся"], ["single", "Однократные"]], filters.recurrence),
    selectControl("google", "Google", [["", "Все"], ["synced", "Синхронизированы"], ["local", "Только локальные"]], filters.google),
    inputControl("tags", "Теги", "text", filters.tags),
    selectControl("sort", "Сортировка", [["date", "По дате и времени"], ["created-new", "Сначала новые"], ["created-old", "Сначала старые"], ["priority", "По приоритету"]], sort),
  );
  if (route === "tasks") {
    const archived = element("label", "filter-check");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.name = "includeArchived";
    checkbox.checked = Boolean(filters.includeArchived);
    archived.append(checkbox, element("span", "", "Показывать архивные"));
    grid.append(archived);
  }
  const reset = element("button", "button button--quiet", "Сбросить все фильтры");
  reset.type = "button";
  reset.dataset.action = "reset-task-filters";
  panel.append(summary, grid, reset);
  return panel;
}

function cardActions(task, route) {
  if (route === "trash") return [button("Восстановить", "restore-trash"), button("Удалить навсегда", "delete-forever", "button button--danger")];
  if (route === "archive") return [button("Восстановить", "restore-archive"), button("В корзину", "trash", "button button--danger-quiet")];
  const actions = [button("Открыть", "view")];
  actions.push(task.status === "completed" ? button("Вернуть в работу", "reopen") : button("Завершить", "complete", "button button--complete"));
  if (task.status === "active") actions.push(button("Отменить", "cancel"));
  actions.push(button("В архив", "archive"), button("Удалить", "trash", "button button--danger-quiet"));
  return actions;
}

function renderTaskCard(task, route, now = new Date()) {
  const overdue = isTaskOverdue(task, now);
  const card = element("article", `task-card priority-${task.priority}${task.status === "completed" ? " is-completed" : ""}${overdue ? " is-overdue" : ""}`);
  card.dataset.taskId = task.id;
  const top = element("div", "task-card__top");
  const statusButton = element("button", "task-check", task.status === "completed" ? "✓" : "○");
  statusButton.type = "button";
  statusButton.dataset.taskAction = task.status === "completed" ? "reopen" : "complete";
  statusButton.setAttribute("aria-label", task.status === "completed" ? `Вернуть в работу: ${task.title}` : `Завершить: ${task.title}`);
  if (route === "trash" || route === "archive" || task.status === "cancelled") statusButton.disabled = true;
  const copy = element("div", "task-card__copy");
  const title = element("h2", "", task.title);
  title.dataset.taskAction = "view";
  title.tabIndex = 0;
  copy.append(title);
  if (task.shortDescription) copy.append(element("p", "", task.shortDescription));
  const badges = element("div", "task-badges");
  badges.append(
    element("span", `badge badge--${task.priority}`, `${task.priority === "high" ? "!" : task.priority === "medium" ? "•" : "–"} ${LABELS.priority[task.priority]}`),
    element("span", "badge", LABELS.category[task.category]),
    element("span", "badge", LABELS.status[task.status]),
  );
  if (overdue) badges.append(element("span", "badge badge--overdue", "Просрочено"));
  if (task.recurrence) badges.append(element("span", "badge badge--recurring", "↻ Повторяется"));
  if (task.googleSync) badges.append(element("span", "badge badge--google", task.googleSync.syncStatus === "synced" ? "G Синхронизирована" : task.googleSync.syncStatus?.startsWith("pending") ? "G Ожидает отправки" : task.googleSync.syncStatus === "readOnlyRemote" ? "G Связь завершена" : "G Требует внимания"));
  if (task.seriesId && !task.isVirtual && !task.isSeriesRepresentative) badges.append(element("span", "badge", "Изменён экземпляр"));
  if (task.archivedAt) badges.append(element("span", "badge", "В архиве"));
  top.append(statusButton, copy, badges);
  const meta = element("div", "task-card__meta", formatTaskDate(task));
  if (route === "trash") {
    const deletion = taskDeletionDate(task);
    meta.append(element("span", "trash-deadline", `Будет удалена ${deletion.toLocaleDateString("ru-RU")}`));
  }
  const actions = element("div", "task-card__actions");
  cardActions(task, route).forEach((control) => actions.append(control));
  card.append(top, meta, actions);
  return card;
}

function noteButton(label, action, className = "button button--quiet") {
  const control = element("button", className, label);
  control.type = "button";
  control.dataset.noteAction = action;
  return control;
}

function renderNoteCard(note, source = "active") {
  const card = element("article", `note-card priority-${note.priority}`);
  card.dataset.noteId = note.id;
  const header = element("div", "note-card__header");
  const copy = document.createElement("div");
  const title = element("h2", "", note.title);
  title.dataset.noteAction = "view";
  title.tabIndex = 0;
  copy.append(title);
  if (note.text) copy.append(element("p", "note-card__preview", note.text));
  header.append(copy, element("span", "note-pin", note.isPinned ? "● Закреплена" : ""));
  const badges = element("div", "task-badges");
  badges.append(element("span", `badge badge--${note.priority}`, LABELS.priority[note.priority]), element("span", "badge", LABELS.category[note.category]));
  note.tags.forEach((tag) => badges.append(element("span", "badge", `#${tag}`)));
  const meta = element("p", "note-card__meta", `Изменена ${new Date(note.updatedAt).toLocaleString("ru-RU")}`);
  const actions = element("div", "task-card__actions");
  if (source === "trash") actions.append(noteButton("Восстановить", "restore-trash"), noteButton("Удалить навсегда", "delete-forever", "button button--danger"));
  else if (source === "archive") actions.append(noteButton("Восстановить", "restore-archive"), noteButton("В корзину", "trash", "button button--danger-quiet"));
  else actions.append(noteButton("Открыть", "view"), noteButton(note.isPinned ? "Открепить" : "Закрепить", "toggle-pin"), noteButton("В архив", "archive"), noteButton("Удалить", "trash", "button button--danger-quiet"));
  card.append(header, badges, meta, actions);
  return card;
}

function renderTodayGroups(tasks, now) {
  const root = element("div", "today-groups");
  const groups = [
    ["Просроченные", tasks.filter((task) => isTaskOverdue(task, now))],
    ["Без времени", tasks.filter((task) => !isTaskOverdue(task, now) && task.status === "active" && !task.hasTime)],
    ["По времени", tasks.filter((task) => !isTaskOverdue(task, now) && task.status === "active" && task.hasTime)],
  ];
  groups.forEach(([title, items]) => {
    if (!items.length) return;
    const section = element("section", "task-group");
    section.append(element("h2", "", `${title} · ${items.length}`));
    const list = element("div", "task-list");
    items.forEach((task) => list.append(renderTaskCard(task, "today", now)));
    section.append(list);
    root.append(section);
  });
  const completed = tasks.filter((task) => task.status === "completed");
  if (completed.length) {
    const details = element("details", "completed-group");
    details.append(element("summary", "", `Выполнено сегодня · ${completed.length}`));
    const list = element("div", "task-list");
    completed.forEach((task) => list.append(renderTaskCard(task, "today", now)));
    details.append(list);
    root.append(details);
  }
  if (tasks.length && tasks.every((task) => task.status === "completed")) root.prepend(element("div", "support-message", "На сегодня всё готово. Хорошая работа"));
  return root;
}

export function createUI({ state, router, repositories, googleAuth, googleCalendar, syncEngine }) {
  const appShell = document.querySelector("[data-app-shell]");
  const viewContainer = document.querySelector("[data-view-container]");
  const detailPanel = document.querySelector("[data-detail-panel]");
  const scrim = document.querySelector("[data-scrim]");
  const createMenu = document.querySelector("[data-create-menu]");
  const createButton = document.querySelector("[data-action='open-create-menu']");
  const miniGrid = document.querySelector("[data-mini-calendar-grid]");
  const miniMonth = document.querySelector("[data-mini-month]");
  const panelEyebrow = document.querySelector(".detail-panel .eyebrow");
  const panelTitle = document.querySelector("[data-panel-title]");
  const panelBody = document.querySelector("[data-panel-body]");
  const toastRegion = document.querySelector("[data-toast-region]");
  const startupStatus = document.querySelector("[data-startup-status]");
  const dialogLayer = document.querySelector("[data-dialog-layer]");
  const googleStatus = document.querySelector("[data-google-status]");
  const connectGoogleButton = document.querySelector("[data-action='connect-google']");
  let tasks = [];
  let notes = [];
  let googleCalendars = [];
  let googleEvents = [];
  let appSettings = null;
  let syncQueueCount = 0;
  let googleState = googleAuth.getState();
  let toastTimer = 0;
  let overduePromptShown = false;
  let filters = {};
  let taskSort = "date";
  let noteFilters = {};
  let noteSort = "created-new";
  let archiveEntity = "tasks";
  let searchState = { query: "", force: false, includeArchive: false, includeTrash: false };
  let panelContext = null;
  let periodicSyncTimer = 0;
  let searchTimer = 0;
  const listLimits = new Map();
  let secondaryTimeZone = localStorage.getItem(STORAGE_KEYS.secondaryTimeZone) || "Europe/Samara";

  function pageFor(key, items) {
    return paginateItems(items, listLimits.get(key) || LIMITS.listPageSize);
  }

  function resetListPages() {
    listLimits.clear();
  }

  function loadMoreControl(key, page) {
    if (!page.hasMore) return null;
    const control = element("button", "button button--outline load-more", `Показать ещё · ${page.total - page.shown}`);
    control.type = "button";
    control.dataset.action = "load-more";
    control.dataset.listKey = key;
    return control;
  }

  function renderGoogleStatus() {
    const labels = {
      disconnected: googleState.configured ? "Google не подключён" : "Google требует настройки",
      connecting: "Подключаем Google…",
      connected: "Google подключён",
      expiring: "Скоро потребуется вход",
      expired: "Нужен вход в Google",
    };
    const offline = !navigator.onLine;
    const cacheLabel = appSettings?.lastSyncAt ? ` · данные на ${new Date(appSettings.lastSyncAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}` : "";
    const text = offline ? `Офлайн${cacheLabel}` : syncQueueCount ? `${syncQueueCount} ждёт синхронизации` : labels[googleState.state] || "Google не подключён";
    googleStatus.querySelector("span:last-child").textContent = text;
    googleStatus.classList.toggle("is-offline", offline);
    googleStatus.classList.toggle("is-connected", googleState.authenticated);
    connectGoogleButton.textContent = googleState.authenticated ? "Обновить" : googleState.state === "expired" ? "Войти снова" : "Подключить";
  }
  googleAuth.subscribe((nextState) => { googleState = nextState; renderGoogleStatus(); });
  syncEngine.subscribe((event) => { handleSyncEvent(event).catch(() => showToast("Не удалось обновить состояние синхронизации", "error")); });

  function renderCalendarSources() {
    const container = document.querySelector(".calendar-sources");
    container.replaceChildren(element("h2", "", "Календари"));
    if (!googleCalendars.length) {
      const control = element("button", "source-placeholder", "Google Calendar · подключить"); control.type = "button"; control.dataset.action = "connect-google"; container.append(control); return;
    }
    googleCalendars.forEach((calendar) => {
      const row = element("label", "source-placeholder calendar-source-toggle");
      const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = Boolean(calendar.selected); checkbox.value = calendar.id; checkbox.dataset.googleSidebarToggle = "";
      const color = element("span", "google-calendar-color"); color.style.backgroundColor = calendar.backgroundColor;
      row.append(checkbox, color, element("span", "calendar-source-name", calendar.summary)); container.append(row);
    });
  }

  function showToast(message, kind = "neutral") {
    window.clearTimeout(toastTimer);
    const toast = element("div", `toast toast--${kind}`, message);
    toastRegion.replaceChildren(toast);
    toastTimer = window.setTimeout(() => toastRegion.replaceChildren(), 3_200);
  }

  function showDialog({ title, message, choices }) {
    return new Promise((resolve) => {
      const previousFocus = document.activeElement;
      const dialog = dialogLayer.querySelector(".dialog");
      dialog.querySelector("[data-dialog-title]").textContent = title;
      dialog.querySelector("[data-dialog-message]").textContent = message;
      const actions = dialog.querySelector(".dialog__actions");
      actions.replaceChildren();
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        dialogLayer.hidden = true;
        dialogLayer.removeEventListener("keydown", onKeydown);
        if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
        resolve(value);
      };
      const onKeydown = (event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(choices[0]?.value); return; }
        if (event.key !== "Tab") return;
        const focusable = [...actions.querySelectorAll("button:not(:disabled)")];
        if (!focusable.length) return;
        const first = focusable[0]; const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      };
      choices.forEach(({ value, label, kind = "quiet" }) => {
        const control = element("button", `button button--${kind}`, label);
        control.type = "button";
        control.addEventListener("click", () => finish(value), { once: true });
        actions.append(control);
      });
      dialogLayer.hidden = false;
      dialogLayer.addEventListener("keydown", onKeydown);
      actions.lastElementChild?.focus();
    });
  }

  async function refreshQueueState() {
    syncQueueCount = (await repositories.syncQueue.getAll()).length;
    renderGoogleStatus();
    if (state.get().route === "settings") renderRoute(state.get());
  }

  async function handleSyncEvent(event) {
    if (["queued", "sent", "failed", "retry", "needsAuth"].includes(event.type)) await refreshQueueState();
    if (["sent", "failed"].includes(event.type)) await refreshTasks();
    if (event.type === "calendarSynced") {
      googleEvents = await repositories.googleEventsCache.getAll();
      renderRoute(state.get());
    }
    if (event.type === "needsAuth") showToast("Изменения сохранены. Для отправки войдите в Google", "error");
    if (event.type === "failed") showToast("Не удалось обновить Google Calendar. Задача сохранена локально", "error");
    if (event.type === "remoteDeleted") {
      await refreshTasks();
      showToast("Связанное событие удалено в Google Calendar. Локальная задача сохранена", "error");
    }
    if (event.type === "conflict") {
      await refreshTasks();
      const choice = await showDialog({
        title: "Событие изменилось в Google Calendar",
        message: `Версия Google уже применена к задаче «${event.localVersion.title}». Локальные приоритет, категория, теги и чек-лист сохранены. Можно вернуть локальные дату и описание отдельным новым изменением.`,
        choices: [
          { value: "local", label: "Вернуть мои значения" },
          { value: "google", label: "Оставить версию Google", kind: "primary" },
        ],
      });
      if (choice === "local") await syncEngine.reapplyConflict(event.conflictId);
      await refreshTasks();
    }
  }

  async function backgroundSync() {
    if (document.hidden || !navigator.onLine || !googleAuth.getAccessToken()) return false;
    if (!syncQueueCount || googleState.canWrite) await syncEngine.flush();
    if (googleCalendars.some((calendar) => calendar.selected)) await refreshGoogleEvents();
    await loadStoredGoogleData();
    return true;
  }

  function updatePeriod(currentState) {
    document.querySelector("[data-period-label]").textContent = formatPeriodLabel(currentState.visibleWeek);
    document.querySelector("[data-week-number]").textContent = `Неделя ${getISOWeek(currentState.visibleWeek)}`;
  }

  function renderMiniCalendar(currentState) {
    const focusDate = currentState.miniCalendarDate;
    miniMonth.textContent = focusDate.toLocaleDateString("ru-RU", { month: "long", year: "numeric" });
    miniGrid.replaceChildren();
    monthMatrix(focusDate).forEach((date) => {
      const dateValue = formatLocalDate(date);
      const control = element("button", "mini-day", String(date.getDate()));
      control.type = "button";
      control.dataset.date = dateValue;
      control.setAttribute("aria-label", date.toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long", year: "numeric" }));
      if (date.getMonth() !== focusDate.getMonth()) control.classList.add("is-outside");
      if (dateValue === dateStringInZone(new Date(), CALENDAR_TIME_ZONES.primary.id)) control.classList.add("is-today");
      if (dateValue === formatLocalDate(currentState.selectedDate)) control.classList.add("is-selected");
      control.addEventListener("click", () => {
        state.set({ selectedDate: date, visibleWeek: date, miniCalendarDate: date });
        router.navigate("calendar");
      });
      miniGrid.append(control);
    });
  }

  function pageHeader(route, count) {
    const [title, description] = ROUTE_COPY[route];
    const heading = element("header", "page-heading");
    const copy = document.createElement("div");
    copy.append(element("h1", "", title), element("p", "", `${description}${Number.isInteger(count) ? ` · ${count}` : ""}`));
    const create = element("button", "button button--primary", route === "notes" ? "+ Заметка" : "+ Задача");
    create.type = "button";
    create.dataset.action = route === "notes" ? "create-note" : "create-task";
    if (["settings", "calendar", "archive", "trash"].includes(route)) create.hidden = true;
    heading.append(copy, create);
    return heading;
  }

  function renderNoteFilters() {
    const panel = element("details", "filter-panel");
    const grid = element("div", "filter-grid");
    grid.append(
      selectControl("note-category", "Категория", [["", "Все"], ["work", "Работа"], ["personal", "Личное"]], noteFilters.category),
      selectControl("note-priority", "Приоритет", [["", "Все"], ["high", "Высокий"], ["medium", "Средний"], ["low", "Низкий"]], noteFilters.priority),
      selectControl("note-pinned", "Закрепление", [["", "Все"], ["yes", "Закреплённые"], ["no", "Обычные"]], noteFilters.pinned),
      inputControl("note-tags", "Теги", "text", noteFilters.tags),
      inputControl("note-createdFrom", "Создана от", "date", noteFilters.createdFrom),
      inputControl("note-createdTo", "Создана до", "date", noteFilters.createdTo),
      selectControl("note-sort", "Сортировка", [["created-new", "Сначала новые"], ["priority", "По приоритету"], ["updated", "По изменению"]], noteSort),
    );
    const reset = element("button", "button button--quiet", "Сбросить все фильтры");
    reset.type = "button";
    reset.dataset.action = "reset-note-filters";
    panel.append(element("summary", "", "Фильтры и сортировка"), grid, reset);
    return panel;
  }

  function renderNoteRoute(source = "active") {
    const visible = sortNotes(filterNotes(notes, noteFilters, source), noteSort);
    const pageKey = `notes:${source}`;
    const page = pageFor(pageKey, visible);
    const card = element("section", "page-card");
    card.dataset.view = source === "active" ? "notes" : source;
    card.append(pageHeader(source === "active" ? "notes" : source, visible.length));
    if (source === "archive") {
      const tabs = element("div", "section-tabs");
      const taskTab = element("button", "", "Задачи"); taskTab.type = "button"; taskTab.dataset.action = "show-archive-tasks";
      const noteTab = element("button", "is-active", "Заметки"); noteTab.type = "button"; noteTab.dataset.action = "show-archive-notes"; noteTab.setAttribute("aria-current", "page");
      tabs.append(taskTab, noteTab); card.append(tabs);
    }
    if (source === "active") card.append(renderNoteFilters());
    if (!visible.length) card.append(emptyState(source === "active" ? "notes" : source));
    else {
      const pinned = page.items.filter((note) => note.isPinned);
      const ordinary = page.items.filter((note) => !note.isPinned);
      [["Закреплённые", pinned], [source === "active" ? "Остальные заметки" : "Заметки", ordinary]].forEach(([title, items]) => {
        if (!items.length) return;
        const section = element("section", "note-group");
        section.append(element("h2", "", `${title} · ${items.length}`));
        const list = element("div", "note-grid");
        items.forEach((note) => list.append(renderNoteCard(note, source)));
        section.append(list);
        card.append(section);
      });
      const more = loadMoreControl(pageKey, page); if (more) card.append(more);
    }
    return card;
  }

  function renderSearchResults() {
    const result = searchPlanner({ tasks, notes, googleEvents }, searchState.query, searchState);
    const card = element("section", "page-card search-results");
    const heading = element("header", "page-heading");
    const copy = document.createElement("div");
    copy.append(element("h1", "", `Поиск: «${searchState.query}»`), element("p", "", "Задачи и заметки сгруппированы по типу"));
    heading.append(copy);
    const options = element("div", "search-options");
    [["includeArchive", "Искать в архиве"], ["includeTrash", "Искать в корзине"]].forEach(([name, label]) => {
      const row = element("label", "filter-check");
      const control = document.createElement("input"); control.type = "checkbox"; control.name = name; control.checked = searchState[name];
      row.append(control, element("span", "", label)); options.append(row);
    });
    card.append(heading, options);
    if (!result.tasks.length && !result.notes.length && !result.googleEvents.length) {
      const empty = emptyState("tasks");
      empty.querySelector("h2").textContent = "Ничего не найдено. Попробуйте изменить запрос или сбросить фильтры";
      const reset = element("button", "button button--quiet", "Сбросить поиск"); reset.type = "button"; reset.dataset.action = "reset-search";
      empty.querySelector(".empty-state__content").append(reset); card.append(empty); return card;
    }
    if (result.tasks.length) {
      const page = pageFor("search:tasks", result.tasks);
      const group = element("section", "task-group"); group.append(element("h2", "", `Задачи · ${result.tasks.length}`));
      const list = element("div", "task-list"); page.items.forEach((task) => list.append(renderTaskCard(task, task.trashedAt ? "trash" : task.archivedAt ? "archive" : "tasks"))); group.append(list); const more = loadMoreControl("search:tasks", page); if (more) group.append(more); card.append(group);
    }
    if (result.notes.length) {
      const page = pageFor("search:notes", result.notes);
      const group = element("section", "note-group"); group.append(element("h2", "", `Заметки · ${result.notes.length}`));
      const list = element("div", "note-grid"); page.items.forEach((note) => list.append(renderNoteCard(note, note.trashedAt ? "trash" : note.archivedAt ? "archive" : "active"))); group.append(list); const more = loadMoreControl("search:notes", page); if (more) group.append(more); card.append(group);
    }
    if (result.googleEvents.length) {
      const page = pageFor("search:google", result.googleEvents);
      const group = element("section", "note-group"); group.append(element("h2", "", `Google Calendar · ${result.googleEvents.length}`));
      const list = element("div", "note-grid");
      page.items.forEach((event) => {
        const item = element("article", "note-card google-result-card"); item.dataset.googleEventKey = event.cacheKey;
        item.append(element("h2", "", event.title), element("p", "note-card__preview", `${event.calendarName} · ${event.date}${event.hasTime ? `, ${event.startTime}` : " · весь день"}`));
        const open = element("button", "button button--quiet", "Открыть"); open.type = "button"; open.dataset.googleAction = "view"; item.append(open); list.append(item);
      });
      group.append(list); const more = loadMoreControl("search:google", page); if (more) group.append(more); card.append(group);
    }
    return card;
  }

  function renderGoogleSettings() {
    const section = element("section", "settings-data google-settings");
    section.append(element("h2", "", "Google Calendar"));
    if (!googleState.configured) {
      section.append(element("p", "", "Для реального подключения укажите OAuth Client ID веб-приложения в GOOGLE_CONFIG.clientId файла js/config.js и добавьте адрес сайта в Authorized JavaScript origins Google Cloud."));
      return section;
    }
    section.append(element("p", "", googleState.authenticated ? "Аккаунт подключён. Выберите календари для показа и один календарь для новых задач." : "Подключение запрашивает только чтение календарей. Право записи будет запрошено при первой отправке задачи."));
    if (appSettings?.lastSyncAt) section.append(element("p", "google-cache-age", `Данные Google на ${new Date(appSettings.lastSyncAt).toLocaleString("ru-RU")}`));
    if (syncQueueCount) section.append(element("p", "google-queue-status", `Ожидают отправки: ${syncQueueCount}`));
    const actions = element("div", "settings-actions");
    const connect = element("button", "button button--primary", googleState.authenticated ? "Обновить календари" : googleState.state === "expired" ? "Войти снова" : "Подключить Google Calendar"); connect.type = "button"; connect.dataset.action = "connect-google"; actions.append(connect);
    if (googleState.authenticated) {
      const disconnect = element("button", "button button--outline", "Отключить Google Calendar"); disconnect.type = "button"; disconnect.dataset.action = "disconnect-google";
      const revoke = element("button", "button button--danger-quiet", "Отозвать разрешение Google"); revoke.type = "button"; revoke.dataset.action = "revoke-google"; actions.append(disconnect, revoke);
    }
    section.append(actions);
    if (!googleCalendars.length) return section;
    const list = element("div", "google-calendar-list");
    googleCalendars.forEach((calendar) => {
      const row = element("label", "google-calendar-row");
      const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = Boolean(calendar.selected); checkbox.value = calendar.id; checkbox.dataset.googleCalendarSelect = "";
      const color = element("span", "google-calendar-color"); color.style.backgroundColor = calendar.backgroundColor;
      const role = { owner: "Владелец", writer: "Можно изменять", reader: "Только чтение", freeBusyReader: "Только занятость" }[calendar.accessRole] || calendar.accessRole;
      row.append(checkbox, color, element("span", "", calendar.summary), element("small", "", role)); list.append(row);
    });
    const writable = googleCalendars.filter((calendar) => ["writer", "owner"].includes(calendar.accessRole));
    const defaultSelect = document.createElement("select"); defaultSelect.name = "defaultGoogleCalendar"; defaultSelect.setAttribute("aria-label", "Календарь Google по умолчанию");
    defaultSelect.append(new Option("Выберите календарь", "")); writable.forEach((calendar) => defaultSelect.append(new Option(calendar.summary, calendar.id)));
    defaultSelect.value = appSettings?.defaultWritableCalendarId || "";
    const save = element("button", "button button--primary", "Сохранить выбор календарей"); save.type = "button"; save.dataset.action = "save-google-calendars";
    section.append(list, selectControl("google-default-wrapper", "Календарь для новых задач", [], ""));
    section.lastElementChild.querySelector("select").replaceWith(defaultSelect);
    section.append(save);
    return section;
  }

  function renderNonTaskView(route) {
    const card = element("section", "page-card");
    card.dataset.view = route;
    card.append(pageHeader(route));
    if (route === "settings") {
      const settings = element("div", "settings-card");
      const selectedZone = CALENDAR_TIME_ZONES.secondary.find((zone) => zone.id === secondaryTimeZone) || CALENDAR_TIME_ZONES.secondary[0];
      settings.append(
        element("h2", "", "Часовые шкалы"),
        element("p", "", "Основная шкала: Москва"),
        element("p", "", `Дополнительная шкала: ${selectedZone.label}`),
        element("p", "", `Время устройства: ${getSystemTimeZone()}`),
        element("p", "", "Дополнительная шкала переключается в календаре."),
      );
      settings.append(renderGoogleSettings());
      const data = element("section", "settings-data");
      data.append(element("h2", "", "Локальные данные"), element("p", "", "Резервная копия включает задачи, серии, заметки и настройки без токенов и кэша Google."));
      const actions = element("div", "settings-actions");
      [["Экспортировать резервную копию", "export-backup", "button button--primary"], ["Импортировать JSON", "choose-import", "button button--outline"], ["Удалить все локальные данные", "clear-local-data", "button button--danger"]].forEach(([label, action, className]) => {
        const control = element("button", className, label); control.type = "button"; control.dataset.action = action; actions.append(control);
      });
      const file = document.createElement("input"); file.type = "file"; file.accept = "application/json,.json"; file.hidden = true; file.dataset.backupInput = "";
      data.append(actions, file); settings.append(data);
      card.append(settings);
    } else card.append(emptyState(route));
    return card;
  }

  function renderTaskRoute(route) {
    const now = wallClockDateInZone(new Date(), CALENDAR_TIME_ZONES.primary.id);
    const visible = sortTasks(filterTasks(tasks, route, filters, now), taskSort);
    const pageKey = `tasks:${route}`;
    const page = pageFor(pageKey, visible);
    const card = element("section", "page-card");
    card.dataset.view = route;
    card.append(pageHeader(route, visible.length));
    if (route === "archive") {
      const tabs = element("div", "section-tabs");
      const taskTab = element("button", "is-active", "Задачи");
      taskTab.type = "button";
      taskTab.setAttribute("aria-current", "page");
      taskTab.dataset.action = "show-archive-tasks";
      const noteTab = element("button", "", "Заметки");
      noteTab.type = "button";
      noteTab.dataset.action = "show-archive-notes";
      tabs.append(taskTab, noteTab);
      card.append(tabs);
    }
    card.append(renderFilters(filters, taskSort, route));
    if (!visible.length) card.append(emptyState(route));
    else if (route === "today") card.append(renderTodayGroups(page.items, now));
    else {
      const list = element("div", "task-list");
      page.items.forEach((task) => list.append(renderTaskCard(task, route, now)));
      card.append(list);
    }
    const more = loadMoreControl(pageKey, page); if (more) card.append(more);
    if (route === "trash" && visible.length) {
      const clear = element("button", "button button--danger trash-clear", "Очистить корзину");
      clear.type = "button";
      clear.dataset.action = "clear-task-trash";
      card.append(clear);
    }
    return card;
  }

  function renderRoute(currentState) {
    const taskRoutes = ["today", "work", "personal", "tasks", "archive", "trash"];
    const content = searchState.query && (searchState.query.trim().length >= 2 || searchState.force)
      ? renderSearchResults()
      : currentState.route === "calendar"
      ? renderWeekCalendar(currentState.visibleWeek, {
        tasks,
        googleEvents: googleEvents.filter((event) => googleCalendars.some((calendar) => calendar.id === event.calendarId && calendar.selected) && !tasks.some((task) => task.googleSync?.calendarId === event.calendarId && task.googleSync?.eventId === event.id && !task.googleSync?.endedAt)),
        showFirstRunHint: !tasks.length && !googleEvents.length,
        onCreate: (defaults) => openTaskForm(null, defaults),
        onOpen: openTaskViewer,
        onOpenGoogle: openGoogleEventViewer,
        onMove: moveCalendarTask,
        onResize: resizeCalendarTask,
        secondaryTimeZone,
        onSecondaryTimeZoneChange: (value) => {
          secondaryTimeZone = value;
          localStorage.setItem(STORAGE_KEYS.secondaryTimeZone, value);
          renderRoute(state.get());
        },
        scrollTop: Number(localStorage.getItem(STORAGE_KEYS.calendarScroll)) || 0,
        onScroll: (scrollTop) => localStorage.setItem(STORAGE_KEYS.calendarScroll, String(Math.round(scrollTop))),
      })
      : currentState.route === "notes" ? renderNoteRoute()
      : currentState.route === "archive" && archiveEntity === "notes" ? renderNoteRoute("archive")
      : currentState.route === "trash" ? renderTrashRoute()
      : taskRoutes.includes(currentState.route) ? renderTaskRoute(currentState.route) : renderNonTaskView(currentState.route);
    viewContainer.replaceChildren(content);
    document.querySelectorAll("[data-route]").forEach((control) => {
      if (control.dataset.route === currentState.route) control.setAttribute("aria-current", "page");
      else control.removeAttribute("aria-current");
    });
    document.title = `${currentState.route === "calendar" ? "Календарь" : ROUTE_COPY[currentState.route][0]} — Мой планировщик`;
    renderCalendarSources();
  }

  function renderTrashRoute() {
    const taskVisible = sortTasks(filterTasks(tasks, "trash", filters), taskSort);
    const noteVisible = sortNotes(filterNotes(notes, {}, "trash"), noteSort);
    const card = element("section", "page-card"); card.dataset.view = "trash";
    card.append(pageHeader("trash", taskVisible.length + noteVisible.length));
    if (!taskVisible.length && !noteVisible.length) card.append(emptyState("trash"));
    if (taskVisible.length) {
      const page = pageFor("trash:tasks", taskVisible);
      const group = element("section", "task-group"); group.append(element("h2", "", `Задачи · ${taskVisible.length}`));
      const list = element("div", "task-list"); page.items.forEach((task) => list.append(renderTaskCard(task, "trash"))); group.append(list); const more = loadMoreControl("trash:tasks", page); if (more) group.append(more); card.append(group);
    }
    if (noteVisible.length) {
      const page = pageFor("trash:notes", noteVisible);
      const group = element("section", "note-group"); group.append(element("h2", "", `Заметки · ${noteVisible.length}`));
      const list = element("div", "note-grid"); page.items.forEach((note) => list.append(renderNoteCard(note, "trash"))); group.append(list); const more = loadMoreControl("trash:notes", page); if (more) group.append(more); card.append(group);
    }
    if (taskVisible.length || noteVisible.length) {
      const clear = element("button", "button button--danger trash-clear", "Очистить корзину"); clear.type = "button"; clear.dataset.action = "clear-all-trash"; card.append(clear);
    }
    return card;
  }

  async function refreshTasks({ render = true } = {}) {
    const current = state.get();
    const primaryToday = dateStringInZone(new Date(), CALENDAR_TIME_ZONES.primary.id);
    const start = current.route === "calendar" ? formatLocalDate(startOfISOWeek(current.visibleWeek)) : addCalendarDays(primaryToday, -730);
    const end = current.route === "calendar" ? formatLocalDate(endOfISOWeek(current.visibleWeek)) : addCalendarDays(primaryToday, 730);
    tasks = await repositories.recurrence.listRange(start, end, { includeSeriesRepresentatives: ["archive", "trash"].includes(current.route) });
    notes = await repositories.notes.getAll();
    if (render) renderRoute(state.get());
  }

  async function loadStoredGoogleData() {
    let queue;
    [googleCalendars, googleEvents, appSettings, queue] = await Promise.all([
      repositories.googleCalendars.getAll(),
      repositories.googleEventsCache.getAll(),
      repositories.settings.get("app"),
      repositories.syncQueue.getAll(),
    ]);
    syncQueueCount = queue.length;
    renderGoogleStatus();
  }

  async function connectGoogle() {
    if (!googleState.configured) {
      showToast("Сначала укажите Google OAuth Client ID в js/config.js", "error");
      router.navigate("settings");
      return false;
    }
    try {
      if (syncQueueCount && (!googleState.authenticated || !googleState.canWrite)) await googleAuth.requestWriteAccess();
      else if (!googleState.authenticated) await googleAuth.requestReadAccess();
      await syncEngine.flush();
      const previous = new Map(googleCalendars.map((calendar) => [calendar.id, calendar]));
      const received = await googleCalendar.listCalendars();
      googleCalendars = received.map((calendar) => ({ ...calendar, selected: previous.has(calendar.id) ? Boolean(previous.get(calendar.id).selected) : Boolean(calendar.primary) }));
      await Promise.all(googleCalendars.map((calendar) => repositories.googleCalendars.put(calendar)));
      if (googleCalendars.some((calendar) => calendar.selected)) await refreshGoogleEvents();
      router.navigate("settings"); renderRoute(state.get());
      showToast("Google подключён. Проверьте выбор календарей", "success");
      return true;
    } catch (error) {
      showToast(error.message || "Не удалось подключить Google", "error");
      return false;
    }
  }

  function googleRangeDates(rangeStart = null, rangeEnd = null) {
    const today = dateStringInZone(new Date(), CALENDAR_TIME_ZONES.primary.id);
    const start = rangeStart || addCalendarDays(today, -365);
    const end = rangeEnd || addCalendarDays(today, 730);
    return { start, end, timeMin: `${start}T00:00:00+03:00`, timeMax: `${addCalendarDays(end, 1)}T00:00:00+03:00` };
  }

  async function refreshGoogleEvents(rangeStart = null, rangeEnd = null) {
    if (!googleAuth.getAccessToken() || !navigator.onLine) return false;
    const range = googleRangeDates(rangeStart, rangeEnd);
    await syncEngine.synchronizeCalendars(googleCalendars, range);
    googleEvents = await repositories.googleEventsCache.getAll();
    appSettings = { ...(appSettings || { id: "app" }), googleCacheStart: range.start, googleCacheEnd: range.end, lastSyncAt: new Date().toISOString() };
    await repositories.settings.put(appSettings);
    renderRoute(state.get());
    return true;
  }

  async function ensureGoogleWeek(visibleWeek) {
    if (!googleState.authenticated || !googleCalendars.some((calendar) => calendar.selected)) return;
    const start = formatLocalDate(startOfISOWeek(visibleWeek));
    const end = formatLocalDate(endOfISOWeek(visibleWeek));
    if (appSettings?.googleCacheStart <= start && appSettings?.googleCacheEnd >= end) return;
    const range = googleRangeDates(start, end);
    await syncEngine.synchronizeCalendars(googleCalendars, range);
    googleEvents = await repositories.googleEventsCache.getAll();
    appSettings = { ...(appSettings || { id: "app" }), googleCacheStart: !appSettings?.googleCacheStart || start < appSettings.googleCacheStart ? start : appSettings.googleCacheStart, googleCacheEnd: !appSettings?.googleCacheEnd || end > appSettings.googleCacheEnd ? end : appSettings.googleCacheEnd, lastSyncAt: new Date().toISOString() };
    await repositories.settings.put(appSettings); renderRoute(state.get());
  }

  async function saveGoogleCalendars() {
    const chosen = new Set([...viewContainer.querySelectorAll("[data-google-calendar-select]:checked")].map((input) => input.value));
    const defaultCalendarId = viewContainer.querySelector("[name='defaultGoogleCalendar']")?.value || null;
    const writable = googleCalendars.find((calendar) => calendar.id === defaultCalendarId && ["writer", "owner"].includes(calendar.accessRole));
    if (defaultCalendarId && !writable) { showToast("Для отправки выберите календарь с правом записи", "error"); return; }
    googleCalendars = googleCalendars.map((calendar) => ({ ...calendar, selected: chosen.has(calendar.id) }));
    await Promise.all(googleCalendars.map((calendar) => repositories.googleCalendars.put(calendar)));
    appSettings = { ...(appSettings || { id: "app" }), selectedGoogleCalendars: [...chosen], defaultWritableCalendarId: writable?.id || null };
    await repositories.settings.put(appSettings);
    try { await refreshGoogleEvents(); showToast("Календари сохранены и события обновлены", "success"); }
    catch (error) { showToast(`Выбор сохранён. Не удалось загрузить события: ${error.message}`, "error"); }
  }

  async function disconnectGoogle({ revoke = false } = {}) {
    const confirmed = await showDialog({ title: revoke ? "Отозвать разрешение Google?" : "Отключить Google Calendar?", message: "Локальные задачи и заметки сохранятся. Кэш событий Google будет очищен; события в Google Calendar не удалятся.", choices: [{ value: false, label: "Не сейчас" }, { value: true, label: revoke ? "Отозвать разрешение" : "Отключить", kind: "danger" }] });
    if (!confirmed) return;
    if (revoke) await googleAuth.revoke(); else googleAuth.clear();
    await repositories.googleIntegration.disconnect();
    googleEvents = []; await refreshTasks(); showToast(revoke ? "Разрешение Google отозвано" : "Google Calendar отключён");
  }

  function chooseSeriesScope(action) {
    return showDialog({
      title: `${action}: область серии`,
      message: "К каким событиям применить действие?",
      choices: [
        { value: "instance", label: "Только это событие" },
        { value: "future", label: "Это и последующие" },
        { value: "series", label: "Всю серию", kind: "primary" },
      ],
    });
  }

  function revealPanel(eyebrow, title, body, context) {
    panelEyebrow.textContent = eyebrow;
    panelTitle.textContent = title;
    panelBody.replaceChildren(body);
    detailPanel.classList.add("is-open");
    detailPanel.setAttribute("aria-hidden", "false");
    scrim.hidden = false;
    createMenu.hidden = true;
    createButton.setAttribute("aria-expanded", "false");
    panelContext = context;
    state.set({ detailPanel: context?.kind || "custom" });
  }

  function closePanelImmediately() {
    detailPanel.classList.remove("is-open");
    detailPanel.setAttribute("aria-hidden", "true");
    scrim.hidden = true;
    panelBody.replaceChildren();
    panelContext = null;
    state.set({ detailPanel: null });
  }

  function withoutGoogleFormFields(values) {
    const clean = { ...values };
    delete clean.googleEnabled;
    delete clean.googleCalendarId;
    return clean;
  }

  async function syncEntityToGoogle(entity, values, { isSeries = false, existingLink = null } = {}) {
    const calendarId = values.googleCalendarId || existingLink?.calendarId;
    await syncEngine.queueEntity(entity, { action: existingLink?.eventId ? "update" : "create", calendarId, eventId: existingLink?.eventId || null, etag: existingLink?.etag || null, isSeries });
    if (!navigator.onLine || !googleAuth.getAccessToken()) {
      await loadStoredGoogleData();
      showToast("Изменения сохранены и будут отправлены в Google после подключения");
      return false;
    }
    const result = await syncEngine.flush();
    await loadStoredGoogleData();
    if (result.pending) showToast("Изменения сохранены и ожидают синхронизации");
    else showToast("Задача сохранена и отправлена в Google Calendar", "success");
    return !result.pending;
  }

  async function requestClosePanel() {
    const form = panelBody.querySelector("form[data-dirty='true']");
    if (!form) return closePanelImmediately();
    const choice = await showDialog({
      title: "Есть несохранённые изменения",
      message: "Что сделать с несохранёнными изменениями?",
      choices: [
        { value: "stay", label: "Остаться" },
        { value: "discard", label: "Не сохранять" },
        { value: "save", label: "Сохранить", kind: "primary" },
      ],
    });
    if (choice === "discard") closePanelImmediately();
    if (choice === "save") {
      form.dataset.closeAfterSave = "true";
      form.requestSubmit();
    }
  }

  function openTaskForm(task = null, patch = {}, conversionNote = null) {
    const source = task ? { ...task, ...patch } : patch;
    const form = createTaskForm({
      task: task ? source : null,
      defaults: task ? null : source,
      google: {
        connected: googleState.authenticated,
        calendars: googleCalendars,
        defaultCalendarId: appSettings?.defaultWritableCalendarId,
        onRequestAccess: async () => {
          if (!googleState.configured) { showToast("Сначала настройте Google OAuth Client ID", "error"); return { connected: false }; }
          await googleAuth.requestReadAccess();
          if (!googleCalendars.length) {
            googleCalendars = await googleCalendar.listCalendars();
            await Promise.all(googleCalendars.map((calendar) => repositories.googleCalendars.put(calendar)));
          }
          return { connected: true, calendars: googleCalendars };
        },
      },
      onSave: async (values) => {
        if (findTaskConflicts(values, tasks).length) {
          const proceed = await showDialog({
            title: "Есть пересечение",
            message: "На это время уже запланировано событие. Всё равно сохранить?",
            choices: [
              { value: false, label: "Вернуться к выбору времени" },
              { value: true, label: "Сохранить", kind: "primary" },
            ],
          });
          if (!proceed) return false;
        }
        let saveBase = task;
        if (task && !task.seriesId) {
          const latest = await repositories.tasks.get(task.id);
          if (latest && latest.revision !== task.revision) {
            const resolution = await showDialog({
              title: "Задача изменена в другой вкладке",
              message: "Можно загрузить последнюю версию или сохранить введённые значения как новую редакцию.",
              choices: [
                { value: "overwrite", label: "Сохранить мою редакцию" },
                { value: "reload", label: "Загрузить новую версию", kind: "primary" },
              ],
            });
            if (resolution === "reload") { closePanelImmediately(); openTaskForm(latest); return false; }
            saveBase = latest;
          }
        }
        const existingLink = saveBase?.googleSync?.endedAt ? null : saveBase?.googleSync || null;
        let unlinkChoice = "keep";
        if (existingLink && !values.googleEnabled) {
          unlinkChoice = await showDialog({ title: "Отключить задачу от Google?", message: "Можно оставить событие в Google Calendar или удалить его вместе с отключением связи.", choices: [{ value: "delete", label: "Удалить событие и отключить", kind: "danger" }, { value: "keep", label: "Только отключить связь", kind: "primary" }] });
        }
        if (values.googleEnabled && !googleState.canWrite && navigator.onLine) {
          try { await googleAuth.requestWriteAccess(); }
          catch { /* локальная запись всё равно попадёт в очередь */ }
        }
        const storageValues = withoutGoogleFormFields(values);
        if (!values.googleEnabled) storageValues.googleSync = null;
        let saved;
        if (task?.seriesId) {
          const scope = await chooseSeriesScope("Изменить");
          saved = await repositories.recurrence.changeOccurrence(task, storageValues, scope);
        } else if (task && values.recurrence) saved = await repositories.recurrence.replaceTaskWithSeries(task.id, storageValues);
        else if (task) saved = await repositories.tasks.update(task.id, storageValues, { expectedRevision: saveBase.revision });
        else if (conversionNote && values.recurrence) {
          saved = await repositories.recurrence.createFromTask({ ...source, ...storageValues });
          await repositories.notes.archive(conversionNote.id);
        } else if (conversionNote) saved = (await repositories.notes.convertToTask(conversionNote.id, { ...source, ...storageValues })).task;
        else if (values.recurrence) saved = await repositories.recurrence.createFromTask({ ...source, ...storageValues });
        else saved = await repositories.tasks.create({ ...source, ...storageValues });
        if (existingLink && !values.googleEnabled && unlinkChoice === "delete") {
          await syncEngine.queueEntity({ ...saved, googleSync: existingLink }, { action: "delete", calendarId: existingLink.calendarId, eventId: existingLink.eventId, etag: existingLink.etag, isSeries: Boolean(saved.template) });
          await syncEngine.flush();
        }
        if (values.googleEnabled) {
          await syncEntityToGoogle(saved, values, { isSeries: Boolean(saved.template), existingLink });
        }
        await refreshTasks();
        if (!values.googleEnabled) showToast(conversionNote ? "Заметка превращена в задачу и перемещена в архив" : task ? "Изменения сохранены" : "Задача добавлена в план");
        closePanelImmediately();
      },
    });
    revealPanel(task ? "Редактирование" : conversionNote ? "Из заметки" : "Новая задача", task ? task.title : conversionNote ? "Превратить в задачу" : "Новая задача", form, { kind: "task-form", taskId: task?.id || null });
  }

  async function confirmCalendarConflict(candidate) {
    if (!findTaskConflicts(candidate, tasks).length) return true;
    return showDialog({
      title: "Есть пересечение",
      message: "На это время уже запланировано событие. Всё равно сохранить?",
      choices: [
        { value: false, label: "Вернуться к выбору времени" },
        { value: true, label: "Сохранить", kind: "primary" },
      ],
    });
  }

  async function moveCalendarTask(task, patch) {
    const candidate = { ...task, ...patch };
    if (!(await confirmCalendarConflict(candidate))) return;
    const scope = task.seriesId ? await chooseSeriesScope("Перенести") : "instance";
    const saved = task.seriesId ? await repositories.recurrence.changeOccurrence(task, patch, scope) : await repositories.tasks.update(task.id, patch, { expectedRevision: task.revision });
    if (task.googleSync && !task.googleSync.endedAt) await syncEntityToGoogle(saved, { ...task, ...patch, googleEnabled: true, googleCalendarId: task.googleSync.calendarId }, { isSeries: Boolean(saved.template), existingLink: task.googleSync });
    await refreshTasks();
    showToast("Задача перенесена");
  }

  async function resizeCalendarTask(task, durationMinutes) {
    const candidate = { ...task, durationMinutes };
    if (!(await confirmCalendarConflict(candidate))) return renderRoute(state.get());
    const scope = task.seriesId ? await chooseSeriesScope("Изменить длительность") : "instance";
    const saved = task.seriesId ? await repositories.recurrence.changeOccurrence(task, { durationMinutes }, scope) : await repositories.tasks.update(task.id, { durationMinutes }, { expectedRevision: task.revision });
    if (task.googleSync && !task.googleSync.endedAt) await syncEntityToGoogle(saved, { ...task, durationMinutes, googleEnabled: true, googleCalendarId: task.googleSync.calendarId }, { isSeries: Boolean(saved.template), existingLink: task.googleSync });
    await refreshTasks();
    showToast("Длительность изменена");
  }

  function viewActions(task) {
    if (task.trashedAt) return [{ label: "Восстановить", action: "restore-trash" }, { label: "Удалить навсегда", action: "delete-forever", kind: "danger" }];
    if (task.archivedAt) return [{ label: "Восстановить", action: "restore-archive" }, { label: "В корзину", action: "trash", kind: "danger-quiet" }];
    return [
      { label: "Редактировать", action: "edit", kind: "primary" },
      ...(task.googleSync?.syncStatus === "error" ? [{ label: "Повторить Google", action: "retry-google" }] : []),
      { label: task.status === "completed" ? "Вернуть в работу" : "Завершить", action: task.status === "completed" ? "reopen" : "complete", kind: "complete" },
      ...(task.status === "active" ? [{ label: "Отменить", action: "cancel" }] : []),
      { label: "В архив", action: "archive" },
      { label: "Удалить", action: "trash", kind: "danger-quiet" },
    ];
  }

  function openTaskViewer(task) {
    revealPanel("Задача", task.title, createTaskViewer(task, viewActions(task)), { kind: "task-view", taskId: task.id });
    detailPanel.querySelector("[data-action='close-panel']").focus();
  }

  function openNoteForm(note = null) {
    const form = createNoteForm({
      note,
      onSave: async (values) => {
        if (note) await repositories.notes.update(note.id, values, { expectedRevision: note.revision });
        else await repositories.notes.create(values);
        await refreshTasks();
        showToast(note ? "Заметка обновлена" : "Заметка сохранена");
        closePanelImmediately();
      },
    });
    revealPanel(note ? "Редактирование" : "Новая заметка", note?.title || "Новая заметка", form, { kind: "note-form", noteId: note?.id || null });
  }

  function noteViewActions(note) {
    if (note.trashedAt) return [{ label: "Восстановить", action: "restore-trash" }, { label: "Удалить навсегда", action: "delete-forever", kind: "danger" }];
    if (note.archivedAt) return [{ label: "Восстановить", action: "restore-archive" }, { label: "В корзину", action: "trash", kind: "danger-quiet" }];
    return [
      { label: "Редактировать", action: "edit", kind: "primary" },
      { label: note.isPinned ? "Открепить" : "Закрепить", action: "toggle-pin" },
      { label: "Превратить в задачу", action: "convert", kind: "complete" },
      { label: "В архив", action: "archive" },
      { label: "Удалить", action: "trash", kind: "danger-quiet" },
    ];
  }

  function openNoteViewer(note) {
    revealPanel("Заметка", note.title, createNoteViewer(note, noteViewActions(note)), { kind: "note-view", noteId: note.id });
  }

  function openGoogleEventViewer(event) {
    const view = element("article", "task-view google-event-view");
    if (event.description) view.append(element("p", "task-view__details", event.description));
    const details = element("dl", "task-details");
    const rows = [
      ["Календарь", event.calendarName],
      ["Дата", event.date],
      ["Время", event.hasTime ? `${event.startTime} · ${event.durationMinutes} мин` : event.endDate > addCalendarDays(event.date, 1) ? `Весь день до ${event.endDate}` : "Весь день"],
      ["Место", event.location],
      ["Организатор", event.organizer],
      ["Участие", event.responseStatus],
    ].filter(([, value]) => value);
    rows.forEach(([label, value]) => {
      const row = element("div", "task-detail-row"); row.append(element("dt", "", label), element("dd", "", value)); details.append(row);
    });
    view.append(details);
    if (event.htmlLink && navigator.onLine) {
      const link = element("a", "button button--outline", "Открыть в Google Calendar"); link.href = event.htmlLink; link.target = "_blank"; link.rel = "noopener noreferrer"; view.append(link);
    } else if (event.htmlLink) view.append(element("p", "google-offline-note", "Ссылка Google Calendar недоступна офлайн"));
    revealPanel("Google Calendar · только просмотр", event.title, view, { kind: "google-event", googleEventKey: event.cacheKey });
  }

  async function executeNoteAction(note, action) {
    if (action === "view") return openNoteViewer(note);
    if (action === "edit") return openNoteForm(note);
    if (action === "convert") {
      return openTaskForm(null, {
        title: note.title,
        details: note.text,
        category: note.category,
        priority: note.priority,
        tags: note.tags,
        links: note.links,
      }, note);
    }
    if (["archive", "trash", "delete-forever"].includes(action)) {
      const label = action === "archive" ? "Переместить заметку в архив?" : action === "trash" ? "Переместить заметку в корзину на 30 дней?" : "Удалить заметку навсегда?";
      const confirmed = await showDialog({ title: label, message: `«${note.title}»`, choices: [{ value: false, label: "Не сейчас" }, { value: true, label: "Продолжить", kind: "danger" }] });
      if (!confirmed) return;
    }
    if (action === "toggle-pin") await repositories.notes.pin(note.id, !note.isPinned);
    if (action === "archive") await repositories.notes.archive(note.id);
    if (action === "trash") await repositories.notes.moveToTrash(note.id);
    if (action === "restore-archive") await repositories.notes.restoreFromArchive(note.id);
    if (action === "restore-trash") await repositories.notes.restoreFromTrash(note.id);
    if (action === "delete-forever") await repositories.notes.deleteForever(note.id);
    await refreshTasks();
    if (panelContext?.noteId === note.id) closePanelImmediately();
    showToast(action === "toggle-pin" ? (note.isPinned ? "Заметка откреплена" : "Заметка закреплена") : "Изменение сохранено");
  }

  async function confirmTaskAction(task, action) {
    const confirmations = {
      cancel: ["Отменить задачу?", `«${task.title}» будет отменена и перемещена в архив.`, "Отменить задачу"],
      archive: ["Переместить в архив?", `Задача «${task.title}» исчезнет из обычных списков.`, "В архив"],
      trash: ["Удалить задачу?", `«${task.title}» будет перемещена в корзину на 30 дней.`, "Удалить"],
      "delete-forever": ["Удалить навсегда?", `Задача «${task.title}» будет удалена без возможности восстановления.`, "Удалить навсегда"],
    };
    const [title, message, label] = confirmations[action];
    return showDialog({ title, message, choices: [{ value: false, label: "Не сейчас" }, { value: true, label, kind: "danger" }] });
  }

  async function executeTaskAction(task, action) {
    if (action === "view") return openTaskViewer(task);
    if (action === "edit") return openTaskForm(task);
    if (action === "retry-google") {
      if (!googleAuth.getAccessToken() && navigator.onLine) {
        try { await googleAuth.requestWriteAccess(); } catch { showToast("Вход в Google не завершён", "error"); return; }
      }
      await syncEngine.retry(task.id); await refreshTasks(); await refreshQueueState(); return;
    }
    let scope = "instance";
    if (task.seriesId && ["cancel", "trash"].includes(action)) scope = await chooseSeriesScope(action === "cancel" ? "Отменить" : "Удалить");
    if (["cancel", "trash", "delete-forever"].includes(action) && !(await confirmTaskAction(task, action))) return;
    if (action === "archive" && task.status === "active" && !(await confirmTaskAction(task, action))) return;
    let googleDelete = false;
    if (task.googleSync && ["cancel", "trash"].includes(action)) {
      const choice = await showDialog({ title: "Что сделать с событием Google?", message: "Локальная задача изменится в любом случае.", choices: [{ value: "delete", label: "Удалить событие Google", kind: "danger" }, { value: "keep", label: "Оставить событие Google", kind: "primary" }] });
      googleDelete = choice === "delete";
    }
    if (action === "complete") {
      if (task.seriesId) await repositories.recurrence.completeOccurrence(task);
      else await repositories.tasks.complete(task.id);
      showToast("Готово — ещё одно дело завершено", "success");
    } else if (action === "reopen") {
      if (task.seriesId) await repositories.recurrence.changeOccurrence(task, { status: "active", completedAt: null }, "instance");
      else await repositories.tasks.reopen(task.id);
      showToast("Задача снова в работе");
    } else if (action === "cancel") {
      if (task.seriesId) await repositories.recurrence.lifecycleOccurrence(task, "cancel", scope);
      else await repositories.tasks.cancel(task.id);
      showToast("Задача отменена и перемещена в архив");
    } else if (action === "archive") {
      if (task.seriesId) await repositories.recurrence.lifecycleOccurrence(task, "archive", "instance");
      else await repositories.tasks.archive(task.id);
      showToast("Задача перемещена в архив");
    } else if (action === "trash") {
      if (task.seriesId) await repositories.recurrence.lifecycleOccurrence(task, "trash", scope);
      else await repositories.tasks.moveToTrash(task.id);
      showToast("Задача перемещена в корзину");
    } else if (action === "restore-archive") {
      if (task.isSeriesRepresentative) await repositories.recurrence.restoreSeriesRepresentative(task, "archive");
      else await repositories.tasks.restoreFromArchive(task.id);
      showToast("Задача восстановлена из архива");
    } else if (action === "restore-trash") {
      if (task.isSeriesRepresentative) await repositories.recurrence.restoreSeriesRepresentative(task, "trash");
      else await repositories.tasks.restoreFromTrash(task.id);
      showToast("Задача восстановлена из корзины");
    } else if (action === "delete-forever") {
      if (task.isSeriesRepresentative) await repositories.recurrence.deleteSeriesForever(task);
      else await repositories.tasks.deleteForever(task.id);
      showToast("Задача удалена навсегда");
    }
    if (googleDelete) {
      if (!googleState.canWrite && navigator.onLine) {
        try { await googleAuth.requestWriteAccess(); } catch { /* операция останется в очереди */ }
      }
      const current = task.seriesId ? await repositories.series.get(task.seriesId) : await repositories.tasks.get(task.id);
      await syncEngine.queueEntity(current || task, { action: "delete", calendarId: task.googleSync.calendarId, eventId: task.googleSync.eventId, etag: task.googleSync.etag, isSeries: Boolean(current?.template) });
      const result = await syncEngine.flush();
      showToast(result.pending ? "Удаление события Google ожидает синхронизации" : "Событие Google удалено");
    }
    await refreshTasks();
    if (panelContext?.taskId === task.id) closePanelImmediately();
  }

  function openOverduePanel(overdueTasks) {
    const root = element("div", "overdue-panel");
    root.append(element("p", "", "Просроченные задачи остались на своих датах. Выберите действие для каждой или перенесите отмеченные на сегодня."));
    const list = element("div", "overdue-list");
    overdueTasks.forEach((task) => {
      const row = element("div", "overdue-row");
      row.dataset.taskId = task.id;
      const check = document.createElement("input");
      check.type = "checkbox";
      check.setAttribute("aria-label", `Выбрать ${task.title}`);
      const copy = element("div", "");
      copy.append(element("strong", "", task.title), element("small", "", formatTaskDate(task)));
      const actions = element("div", "overdue-row__actions");
      [button("Перенести", "overdue-reschedule"), button("Редактировать", "edit"), button("Отменить", "cancel"), button("Оставить", "overdue-keep")].forEach((control) => actions.append(control));
      row.append(check, copy, actions);
      list.append(row);
    });
    const bulk = element("button", "button button--primary", "Перенести выбранные на сегодня");
    bulk.type = "button";
    bulk.dataset.taskAction = "overdue-bulk-today";
    root.append(list, bulk);
    revealPanel("Внимание", "Разобрать просроченные", root, { kind: "overdue" });
  }

  async function maybeShowOverdue() {
    if (overduePromptShown) return;
    overduePromptShown = true;
    const overdue = tasks.filter((task) => isTaskOverdue(task));
    if (overdue.length) openOverduePanel(overdue);
  }

  function shiftWeek(amount) {
    const date = addCalendarDays(state.get().visibleWeek, amount * 7);
    state.set({ visibleWeek: date, selectedDate: date, miniCalendarDate: date });
  }

  function goToday() {
    const today = wallClockDateInZone(new Date(), CALENDAR_TIME_ZONES.primary.id);
    state.set({ visibleWeek: today, selectedDate: today, miniCalendarDate: today });
    router.navigate("calendar");
  }

  function changeMiniMonth(amount) {
    const current = state.get().miniCalendarDate;
    state.set({ miniCalendarDate: new Date(current.getFullYear(), current.getMonth() + amount, 1, 12) });
  }

  function toggleSidebar() {
    const collapsed = !state.get().sidebarCollapsed;
    localStorage.setItem(STORAGE_KEYS.sidebarCollapsed, String(collapsed));
    state.set({ sidebarCollapsed: collapsed });
  }

  async function clearTaskTrash() {
    const trashed = tasks.filter((task) => task.trashedAt);
    if (!trashed.length) return;
    const confirmed = await showDialog({ title: "Очистить корзину?", message: `Будет навсегда удалено задач: ${trashed.length}.`, choices: [{ value: false, label: "Не сейчас" }, { value: true, label: "Очистить", kind: "danger" }] });
    if (!confirmed) return;
    await Promise.all(trashed.map((task) => task.isSeriesRepresentative ? repositories.recurrence.deleteSeriesForever(task) : repositories.tasks.deleteForever(task.id)));
    await refreshTasks();
    showToast("Корзина очищена");
  }

  async function clearAllTrash() {
    const trashedTasks = tasks.filter((task) => task.trashedAt);
    const trashedNotes = notes.filter((note) => note.trashedAt);
    const confirmed = await showDialog({ title: "Очистить корзину?", message: `Будет удалено навсегда: задач — ${trashedTasks.length}, заметок — ${trashedNotes.length}.`, choices: [{ value: false, label: "Не сейчас" }, { value: true, label: "Очистить", kind: "danger" }] });
    if (!confirmed) return;
    await Promise.all(trashedTasks.map((task) => task.isSeriesRepresentative ? repositories.recurrence.deleteSeriesForever(task) : repositories.tasks.deleteForever(task.id)));
    await Promise.all(trashedNotes.map((note) => repositories.notes.deleteForever(note.id)));
    await refreshTasks(); showToast("Корзина очищена");
  }

  async function downloadBackup() {
    const backup = await createBackup(repositories.tasks.database);
    const json = JSON.stringify(backup, null, 2);
    if (json.length > 5_000_000) {
      const proceed = await showDialog({ title: "Большая резервная копия", message: `Размер файла около ${(json.length / 1_000_000).toFixed(1)} МБ. Продолжить?`, choices: [{ value: false, label: "Отмена" }, { value: true, label: "Скачать", kind: "primary" }] });
      if (!proceed) return false;
    }
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = backupFileName(); anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    showToast("Резервная копия подготовлена");
    return true;
  }

  async function handleBackupFile(file) {
    let backup;
    try { backup = parseBackup(await file.text()); }
    catch (error) { showToast(error.message, "error"); return; }
    const preview = importPreview(backup);
    const mode = await showDialog({
      title: "Проверка резервной копии",
      message: `Задач: ${preview.tasks}, серий: ${preview.series}, заметок: ${preview.notes}. Как импортировать данные?`,
      choices: [{ value: null, label: "Отмена" }, { value: "merge", label: "Объединить" }, { value: "replace", label: "Заменить", kind: "danger" }],
    });
    if (!mode) return;
    if (mode === "replace") {
      const next = await showDialog({ title: "Заменить локальные данные?", message: "Текущие задачи, серии, заметки и настройки будут заменены. Сначала можно скачать резервную копию.", choices: [{ value: null, label: "Отмена" }, { value: "backup", label: "Скачать и продолжить" }, { value: "continue", label: "Продолжить без копии", kind: "danger" }] });
      if (!next) return;
      if (next === "backup" && !(await downloadBackup())) return;
    }
    await importBackup(repositories.tasks.database, backup, mode);
    await refreshTasks();
    showToast(mode === "merge" ? "Данные объединены" : "Локальные данные заменены", "success");
  }

  function confirmFullClear() {
    return new Promise((resolve) => {
      const dialog = dialogLayer.querySelector(".dialog");
      dialog.querySelector("[data-dialog-title]").textContent = "Удалить все локальные данные?";
      const message = dialog.querySelector("[data-dialog-message]");
      message.textContent = "Будут удалены задачи, заметки, архив, корзина, локальный кэш Google и настройки. События в Google Calendar не удаляются.";
      const acknowledge = element("label", "danger-acknowledge");
      const check = document.createElement("input"); check.type = "checkbox";
      acknowledge.append(check, element("span", "", "Я понимаю, что данные нельзя восстановить без резервной копии"));
      message.after(acknowledge);
      const actions = dialog.querySelector(".dialog__actions"); actions.replaceChildren();
      const cancel = element("button", "button button--quiet", "Отмена"); cancel.type = "button";
      const backup = element("button", "button button--outline", "Экспортировать"); backup.type = "button";
      const confirm = element("button", "button button--danger", "Удалить всё"); confirm.type = "button"; confirm.disabled = true;
      check.addEventListener("change", () => { confirm.disabled = !check.checked; });
      const finish = (value) => { acknowledge.remove(); dialogLayer.hidden = true; resolve(value); };
      cancel.addEventListener("click", () => finish(null));
      backup.addEventListener("click", async () => { await downloadBackup(); });
      confirm.addEventListener("click", () => finish(true));
      actions.append(cancel, backup, confirm); dialogLayer.hidden = false; check.focus();
    });
  }

  async function removeAllLocalData() {
    if (!(await confirmFullClear())) return;
    await clearLocalData(repositories.tasks.database);
    tasks = []; notes = []; filters = {}; noteFilters = {}; searchState = { query: "", force: false, includeArchive: false, includeTrash: false };
    document.querySelector("[data-search-input]").value = "";
    router.navigate("calendar"); renderRoute(state.get()); showToast("Все локальные данные удалены");
  }

  async function handleAction(action, source = null) {
    if (action === "load-more") {
      const key = source?.dataset.listKey;
      if (key) {
        listLimits.set(key, (listLimits.get(key) || LIMITS.listPageSize) + LIMITS.listPageSize);
        renderRoute(state.get());
      }
      return;
    }
    const actions = {
      today: goToday,
      "previous-week": () => shiftWeek(-1),
      "next-week": () => shiftWeek(1),
      "previous-month": () => changeMiniMonth(-1),
      "next-month": () => changeMiniMonth(1),
      "toggle-sidebar": toggleSidebar,
      "open-create-menu": () => {
        createMenu.hidden = !createMenu.hidden;
        createButton.setAttribute("aria-expanded", String(!createMenu.hidden));
      },
      "create-task": () => openTaskForm(),
      "create-note": () => openNoteForm(),
      "close-panel": requestClosePanel,
      "reset-task-filters": () => { filters = {}; taskSort = "date"; renderRoute(state.get()); },
      "clear-task-trash": clearTaskTrash,
      "clear-all-trash": clearAllTrash,
      "reset-note-filters": () => { noteFilters = {}; noteSort = "created-new"; renderRoute(state.get()); },
      "show-archive-tasks": () => { archiveEntity = "tasks"; renderRoute(state.get()); },
      "show-archive-notes": () => { archiveEntity = "notes"; renderRoute(state.get()); },
      "reset-search": () => { searchState = { query: "", force: false, includeArchive: false, includeTrash: false }; document.querySelector("[data-search-input]").value = ""; renderRoute(state.get()); },
      "export-backup": downloadBackup,
      "choose-import": () => document.querySelector("[data-backup-input]")?.click(),
      "clear-local-data": removeAllLocalData,
      "connect-google": connectGoogle,
      "save-google-calendars": saveGoogleCalendars,
      "disconnect-google": () => disconnectGoogle(),
      "revoke-google": () => disconnectGoogle({ revoke: true }),
    };
    await actions[action]?.();
  }

  document.addEventListener("click", async (event) => {
    const routeButton = event.target.closest("[data-route]");
    if (routeButton) router.navigate(routeButton.dataset.route);
    const actionButton = event.target.closest("[data-action]");
    if (actionButton) await handleAction(actionButton.dataset.action, actionButton);
    const taskAction = event.target.closest("[data-task-action]");
    if (taskAction) {
      const row = taskAction.closest("[data-task-id]");
      const task = tasks.find((item) => item.id === (row?.dataset.taskId || panelContext?.taskId));
      if (!task && taskAction.dataset.taskAction !== "overdue-bulk-today") return;
      if (taskAction.dataset.taskAction === "overdue-reschedule") return openTaskForm(task);
      if (taskAction.dataset.taskAction === "overdue-keep") {
        row.remove();
        if (!panelBody.querySelector("[data-task-id]")) closePanelImmediately();
        return;
      }
      if (taskAction.dataset.taskAction === "overdue-bulk-today") {
        const ids = [...panelBody.querySelectorAll("[data-task-id]:has(input:checked)")].map((item) => item.dataset.taskId);
        const primaryToday = dateStringInZone(new Date(), CALENDAR_TIME_ZONES.primary.id);
        for (const id of ids) {
          const current = await repositories.tasks.get(id);
          const saved = await repositories.tasks.update(id, { date: primaryToday });
          if (current?.googleSync && !current.googleSync.endedAt) await syncEngine.queueEntity(saved, { action: "update", calendarId: current.googleSync.calendarId, eventId: current.googleSync.eventId, etag: current.googleSync.etag });
        }
        await syncEngine.flush();
        await refreshTasks();
        closePanelImmediately();
        showToast("Выбранные задачи перенесены на сегодня");
        return;
      }
      await executeTaskAction(task, taskAction.dataset.taskAction);
    }
    const noteAction = event.target.closest("[data-note-action]");
    if (noteAction) {
      const row = noteAction.closest("[data-note-id]");
      const note = notes.find((item) => item.id === (row?.dataset.noteId || panelContext?.noteId));
      if (note) await executeNoteAction(note, noteAction.dataset.noteAction);
    }
    const googleAction = event.target.closest("[data-google-action]");
    if (googleAction) {
      const eventKey = googleAction.closest("[data-google-event-key]")?.dataset.googleEventKey;
      const googleEvent = googleEvents.find((item) => item.cacheKey === eventKey);
      if (googleEvent) openGoogleEventViewer(googleEvent);
    }
    if (!event.target.closest("[data-create-menu], [data-action='open-create-menu']")) {
      createMenu.hidden = true;
      createButton.setAttribute("aria-expanded", "false");
    }
  });

  viewContainer.addEventListener("change", (event) => {
    if (event.target.matches(".search-options input")) {
      searchState = { ...searchState, [event.target.name]: event.target.checked };
      resetListPages();
      renderRoute(state.get());
      return;
    }
    const control = event.target.closest(".filter-grid input, .filter-grid select");
    if (!control) return;
    if (control.name.startsWith("note-")) {
      const key = control.name.slice(5);
      if (key === "sort") noteSort = control.value;
      else noteFilters = { ...noteFilters, [key]: control.value };
    } else if (control.name === "sort") taskSort = control.value;
    else filters = { ...filters, [control.name]: control.type === "checkbox" ? control.checked : control.value };
    resetListPages();
    renderRoute(state.get());
  });

  document.addEventListener("change", async (event) => {
    if (event.target.matches("[data-google-sidebar-toggle]")) {
      const calendar = googleCalendars.find((item) => item.id === event.target.value);
      if (!calendar) return;
      calendar.selected = event.target.checked;
      await repositories.googleCalendars.put(calendar);
      const selectedGoogleCalendars = googleCalendars.filter((item) => item.selected).map((item) => item.id);
      appSettings = { ...(appSettings || { id: "app" }), selectedGoogleCalendars };
      await repositories.settings.put(appSettings);
      renderRoute(state.get());
      if (calendar.selected && googleAuth.getAccessToken() && navigator.onLine) {
        refreshGoogleEvents().catch(() => showToast("Календарь включён, но события пока не удалось обновить", "error"));
      }
      return;
    }
    if (event.target.matches("[data-backup-input]") && event.target.files?.[0]) {
      await handleBackupFile(event.target.files[0]);
      event.target.value = "";
    }
  });

  const searchInput = document.querySelector("[data-search-input]");
  searchInput.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      searchState = { ...searchState, query: searchInput.value, force: false };
      resetListPages();
      renderRoute(state.get());
    }, 200);
  });
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault(); window.clearTimeout(searchTimer); searchState = { ...searchState, query: searchInput.value, force: true }; resetListPages(); renderRoute(state.get());
    }
  });

  viewContainer.addEventListener("keydown", (event) => {
    const title = event.target.closest("h2[data-task-action='view']");
    if (title && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      const task = tasks.find((item) => item.id === title.closest("[data-task-id]").dataset.taskId);
      openTaskViewer(task);
    }
    const noteTitle = event.target.closest("h2[data-note-action='view']");
    if (noteTitle && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      const note = notes.find((item) => item.id === noteTitle.closest("[data-note-id]").dataset.noteId);
      openNoteViewer(note);
    }
  });

  scrim.addEventListener("click", requestClosePanel);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.get().detailPanel && dialogLayer.hidden) requestClosePanel();
    const target = event.target;
    const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable;
    if (typing) return;
    if (event.key === "/") {
      event.preventDefault();
      document.querySelector("[data-search-input]").focus();
    } else if (event.key.toLocaleLowerCase("ru-RU") === "c") openTaskForm();
    else if (event.key.toLocaleLowerCase("ru-RU") === "n") openNoteForm();
    else if (event.key.toLocaleLowerCase("ru-RU") === "t") goToday();
  });

  state.subscribe((currentState, previous) => {
    appShell.classList.toggle("sidebar-collapsed", currentState.sidebarCollapsed);
    if (currentState.sidebarCollapsed !== previous.sidebarCollapsed) {
      document.querySelector("[data-action='toggle-sidebar']").setAttribute("aria-label", currentState.sidebarCollapsed ? "Развернуть боковую панель" : "Свернуть боковую панель");
    }
    updatePeriod(currentState);
    renderMiniCalendar(currentState);
    if (currentState.online !== previous.online) renderGoogleStatus();
    if (currentState.route !== previous.route || currentState.visibleWeek.getTime() !== previous.visibleWeek.getTime()) {
      refreshTasks();
      if (currentState.route === "calendar") ensureGoogleWeek(currentState.visibleWeek).catch(() => showToast("Не удалось догрузить события Google", "error"));
    }
  });

  async function mount() {
    const current = state.get();
    appShell.classList.toggle("sidebar-collapsed", current.sidebarCollapsed);
    updatePeriod(current);
    renderMiniCalendar(current);
    await Promise.all([refreshTasks({ render: false }), loadStoredGoogleData()]);
    await syncEngine.cleanupConflicts();
    renderRoute(current);
    if (navigator.storage?.estimate) {
      navigator.storage.estimate().then((estimate) => {
        const ratio = storagePressure(estimate);
        if (ratio !== null && ratio >= LIMITS.storageWarningRatio) showToast("Хранилище заполнено более чем на 80%. Экспортируйте данные и очистите корзину", "error");
      }).catch(() => {});
    }
    window.requestAnimationFrame(() => startupStatus.classList.add("is-ready"));
    window.setTimeout(maybeShowOverdue, 250);
    if (!periodicSyncTimer) periodicSyncTimer = window.setInterval(() => { backgroundSync().catch(() => {}); }, 300_000);
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && syncEngine.isStale(appSettings?.lastSyncAt)) backgroundSync().catch(() => {});
  });

  async function handleOnline() {
    renderGoogleStatus();
    if (googleAuth.getAccessToken() && (!syncQueueCount || googleState.canWrite)) await backgroundSync();
    else if (googleAuth.getAccessToken() && syncQueueCount) showToast("Соединение восстановлено. Подтвердите доступ Google для отправки изменений");
    else if (syncQueueCount) showToast("Соединение восстановлено. Войдите в Google, чтобы отправить изменения");
  }

  return Object.freeze({ mount, showToast, refreshTasks, openTaskForm, requestClosePanel, handleOnline });
}
