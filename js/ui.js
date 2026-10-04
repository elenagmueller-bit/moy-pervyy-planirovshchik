import { CALENDAR_TIME_ZONES, STORAGE_KEYS } from "./config.js";
import { addCalendarDays, combineLocalDateTime, dateStringInZone, endOfISOWeek, formatLocalDate, formatPeriodLabel, getISOWeek, getSystemTimeZone, monthMatrix, startOfISOWeek, wallClockDateInZone } from "./date-utils.js";
import { createTaskForm, createTaskViewer } from "./forms.js";
import { filterTasks, isTaskOverdue, sortTasks, taskDeletionDate } from "./repositories.js";
import { findTaskConflicts, renderWeekCalendar } from "./calendar-view.js";

const ROUTE_COPY = Object.freeze({
  today: ["Сегодня", "Задачи текущего дня и просроченные дела", "◉"],
  work: ["Рабочие задачи", "Рабочие дела в одном спокойном списке", "▣"],
  personal: ["Личные задачи", "Личные планы и важные мелочи", "⌂"],
  tasks: ["Все задачи", "Все локальные задачи", "☷"],
  notes: ["Заметки", "Здесь будут ваши заметки", "▤"],
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
    : route === "archive" ? "Отменённые и архивированные вручную задачи появятся здесь." : "Добавьте первую задачу кнопкой «Создать».";
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

export function createUI({ state, router, repositories }) {
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
  let tasks = [];
  let toastTimer = 0;
  let overduePromptShown = false;
  let filters = {};
  let taskSort = "date";
  let panelContext = null;
  let secondaryTimeZone = localStorage.getItem(STORAGE_KEYS.secondaryTimeZone) || "Europe/Samara";

  function showToast(message, kind = "neutral") {
    window.clearTimeout(toastTimer);
    const toast = element("div", `toast toast--${kind}`, message);
    toastRegion.replaceChildren(toast);
    toastTimer = window.setTimeout(() => toastRegion.replaceChildren(), 3_200);
  }

  function showDialog({ title, message, choices }) {
    return new Promise((resolve) => {
      const dialog = dialogLayer.querySelector(".dialog");
      dialog.querySelector("[data-dialog-title]").textContent = title;
      dialog.querySelector("[data-dialog-message]").textContent = message;
      const actions = dialog.querySelector(".dialog__actions");
      actions.replaceChildren();
      choices.forEach(({ value, label, kind = "quiet" }) => {
        const control = element("button", `button button--${kind}`, label);
        control.type = "button";
        control.addEventListener("click", () => {
          dialogLayer.hidden = true;
          resolve(value);
        }, { once: true });
        actions.append(control);
      });
      dialogLayer.hidden = false;
      actions.lastElementChild?.focus();
    });
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
    const create = element("button", "button button--primary", "+ Задача");
    create.type = "button";
    create.dataset.action = "create-task";
    if (["notes", "settings", "calendar"].includes(route)) create.hidden = true;
    heading.append(copy, create);
    return heading;
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
        element("p", "", "Дополнительная шкала переключается в календаре. Подключение Google и управление резервными копиями появятся на следующих этапах."),
      );
      card.append(settings);
    } else card.append(emptyState(route));
    return card;
  }

  function renderTaskRoute(route) {
    const now = wallClockDateInZone(new Date(), CALENDAR_TIME_ZONES.primary.id);
    const visible = sortTasks(filterTasks(tasks, route, filters, now), taskSort);
    const card = element("section", "page-card");
    card.dataset.view = route;
    card.append(pageHeader(route, visible.length));
    if (route === "archive") {
      const tabs = element("div", "section-tabs");
      const taskTab = element("button", "is-active", "Задачи");
      taskTab.type = "button";
      taskTab.setAttribute("aria-current", "page");
      const noteTab = element("button", "", "Заметки");
      noteTab.type = "button";
      noteTab.disabled = true;
      noteTab.title = "Заметки будут реализованы на этапе 5";
      tabs.append(taskTab, noteTab);
      card.append(tabs);
    }
    card.append(renderFilters(filters, taskSort, route));
    if (!visible.length) card.append(emptyState(route));
    else if (route === "today") card.append(renderTodayGroups(visible, now));
    else {
      const list = element("div", "task-list");
      visible.forEach((task) => list.append(renderTaskCard(task, route, now)));
      card.append(list);
    }
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
    const content = currentState.route === "calendar"
      ? renderWeekCalendar(currentState.visibleWeek, {
        tasks,
        onCreate: (defaults) => openTaskForm(null, defaults),
        onOpen: openTaskViewer,
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
      : taskRoutes.includes(currentState.route) ? renderTaskRoute(currentState.route) : renderNonTaskView(currentState.route);
    viewContainer.replaceChildren(content);
    document.querySelectorAll("[data-route]").forEach((control) => {
      if (control.dataset.route === currentState.route) control.setAttribute("aria-current", "page");
      else control.removeAttribute("aria-current");
    });
    document.title = `${currentState.route === "calendar" ? "Календарь" : ROUTE_COPY[currentState.route][0]} — Мой планировщик`;
  }

  async function refreshTasks({ render = true } = {}) {
    const current = state.get();
    const primaryToday = dateStringInZone(new Date(), CALENDAR_TIME_ZONES.primary.id);
    const start = current.route === "calendar" ? formatLocalDate(startOfISOWeek(current.visibleWeek)) : addCalendarDays(primaryToday, -730);
    const end = current.route === "calendar" ? formatLocalDate(endOfISOWeek(current.visibleWeek)) : addCalendarDays(primaryToday, 730);
    tasks = await repositories.recurrence.listRange(start, end, { includeSeriesRepresentatives: ["archive", "trash"].includes(current.route) });
    if (render) renderRoute(state.get());
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

  async function requestClosePanel() {
    const form = panelBody.querySelector("form[data-dirty='true']");
    if (!form) return closePanelImmediately();
    const choice = await showDialog({
      title: "Есть несохранённые изменения",
      message: "Что сделать с изменениями в задаче?",
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

  function openTaskForm(task = null, patch = {}) {
    const source = task ? { ...task, ...patch } : patch;
    const form = createTaskForm({
      task: task ? source : null,
      defaults: task ? null : source,
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
        if (task?.seriesId) {
          const scope = await chooseSeriesScope("Изменить");
          await repositories.recurrence.changeOccurrence(task, values, scope);
        } else if (task && values.recurrence) await repositories.recurrence.replaceTaskWithSeries(task.id, values);
        else if (task) await repositories.tasks.update(task.id, values, { expectedRevision: task.revision });
        else if (values.recurrence) await repositories.recurrence.createFromTask({ ...source, ...values });
        else await repositories.tasks.create({ ...source, ...values });
        await refreshTasks();
        showToast(task ? "Изменения сохранены" : "Задача добавлена в план");
        closePanelImmediately();
      },
    });
    revealPanel(task ? "Редактирование" : "Новая задача", task ? task.title : "Новая задача", form, { kind: "task-form", taskId: task?.id || null });
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
    if (task.seriesId) await repositories.recurrence.changeOccurrence(task, patch, scope);
    else await repositories.tasks.update(task.id, patch, { expectedRevision: task.revision });
    await refreshTasks();
    showToast("Задача перенесена");
  }

  async function resizeCalendarTask(task, durationMinutes) {
    const candidate = { ...task, durationMinutes };
    if (!(await confirmCalendarConflict(candidate))) return renderRoute(state.get());
    const scope = task.seriesId ? await chooseSeriesScope("Изменить длительность") : "instance";
    if (task.seriesId) await repositories.recurrence.changeOccurrence(task, { durationMinutes }, scope);
    else await repositories.tasks.update(task.id, { durationMinutes }, { expectedRevision: task.revision });
    await refreshTasks();
    showToast("Длительность изменена");
  }

  function viewActions(task) {
    if (task.trashedAt) return [{ label: "Восстановить", action: "restore-trash" }, { label: "Удалить навсегда", action: "delete-forever", kind: "danger" }];
    if (task.archivedAt) return [{ label: "Восстановить", action: "restore-archive" }, { label: "В корзину", action: "trash", kind: "danger-quiet" }];
    return [
      { label: "Редактировать", action: "edit", kind: "primary" },
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

  function openNotePlaceholder() {
    revealPanel("Новая заметка", "Новая заметка", element("div", "panel-placeholder", "Форма заметки будет реализована на этапе 5."), { kind: "note" });
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
    let scope = "instance";
    if (task.seriesId && ["cancel", "trash"].includes(action)) scope = await chooseSeriesScope(action === "cancel" ? "Отменить" : "Удалить");
    if (["cancel", "trash", "delete-forever"].includes(action) && !(await confirmTaskAction(task, action))) return;
    if (action === "archive" && task.status === "active" && !(await confirmTaskAction(task, action))) return;
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

  async function handleAction(action) {
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
      "create-note": openNotePlaceholder,
      "close-panel": requestClosePanel,
      "reset-task-filters": () => { filters = {}; taskSort = "date"; renderRoute(state.get()); },
      "clear-task-trash": clearTaskTrash,
      "connect-google": () => showToast("Подключение Google Calendar будет доступно на этапе 6"),
    };
    await actions[action]?.();
  }

  document.addEventListener("click", async (event) => {
    const routeButton = event.target.closest("[data-route]");
    if (routeButton) router.navigate(routeButton.dataset.route);
    const actionButton = event.target.closest("[data-action]");
    if (actionButton) await handleAction(actionButton.dataset.action);
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
        await Promise.all(ids.map((id) => repositories.tasks.update(id, { date: primaryToday })));
        await refreshTasks();
        closePanelImmediately();
        showToast("Выбранные задачи перенесены на сегодня");
        return;
      }
      await executeTaskAction(task, taskAction.dataset.taskAction);
    }
    if (!event.target.closest("[data-create-menu], [data-action='open-create-menu']")) {
      createMenu.hidden = true;
      createButton.setAttribute("aria-expanded", "false");
    }
  });

  viewContainer.addEventListener("change", (event) => {
    const control = event.target.closest(".filter-grid input, .filter-grid select");
    if (!control) return;
    if (control.name === "sort") taskSort = control.value;
    else filters = { ...filters, [control.name]: control.type === "checkbox" ? control.checked : control.value };
    renderRoute(state.get());
  });

  viewContainer.addEventListener("keydown", (event) => {
    const title = event.target.closest("h2[data-task-action='view']");
    if (title && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      const task = tasks.find((item) => item.id === title.closest("[data-task-id]").dataset.taskId);
      openTaskViewer(task);
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
    else if (event.key.toLocaleLowerCase("ru-RU") === "n") openNotePlaceholder();
    else if (event.key.toLocaleLowerCase("ru-RU") === "t") goToday();
  });

  state.subscribe((currentState, previous) => {
    appShell.classList.toggle("sidebar-collapsed", currentState.sidebarCollapsed);
    if (currentState.sidebarCollapsed !== previous.sidebarCollapsed) {
      document.querySelector("[data-action='toggle-sidebar']").setAttribute("aria-label", currentState.sidebarCollapsed ? "Развернуть боковую панель" : "Свернуть боковую панель");
    }
    updatePeriod(currentState);
    renderMiniCalendar(currentState);
    if (currentState.route !== previous.route || currentState.visibleWeek.getTime() !== previous.visibleWeek.getTime()) refreshTasks();
  });

  async function mount() {
    const current = state.get();
    appShell.classList.toggle("sidebar-collapsed", current.sidebarCollapsed);
    updatePeriod(current);
    renderMiniCalendar(current);
    await refreshTasks({ render: false });
    renderRoute(current);
    window.requestAnimationFrame(() => startupStatus.classList.add("is-ready"));
    window.setTimeout(maybeShowOverdue, 250);
  }

  return Object.freeze({ mount, showToast, refreshTasks, openTaskForm, requestClosePanel });
}
