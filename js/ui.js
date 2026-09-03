import { STORAGE_KEYS } from "./config.js";
import { addCalendarDays, formatLocalDate, formatPeriodLabel, getISOWeek, getSystemTimeZone, monthMatrix, todayString } from "./date-utils.js";
import { renderWeekCalendar } from "./calendar-view.js";

const ROUTE_COPY = Object.freeze({
  today: ["Сегодня", "Здесь появятся дела и события текущего дня", "◉"],
  work: ["Рабочие задачи", "Рабочий список пока пуст", "▣"],
  personal: ["Личные задачи", "Личный список пока пуст", "⌂"],
  tasks: ["Все задачи", "Здесь будут собраны все ваши задачи", "☷"],
  notes: ["Заметки", "Здесь будут ваши заметки", "▤"],
  archive: ["Архив", "Архив пока пуст", "□"],
  trash: ["Корзина", "Удалённые записи будут храниться здесь 30 дней", "⌫"],
  settings: ["Настройки", "Основные параметры планировщика", "⚙"],
});

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderEmptyView(route) {
  const [title, description, symbol] = ROUTE_COPY[route];
  const card = element("section", "page-card");
  card.dataset.view = route;
  const heading = element("header", "page-heading");
  const copy = document.createElement("div");
  copy.append(element("h1", "", title), element("p", "", description));
  heading.append(copy);
  card.append(heading);

  if (route === "settings") {
    const empty = element("div", "empty-state");
    const content = element("div", "empty-state__content");
    content.append(
      element("div", "empty-state__symbol", symbol),
      element("h2", "", "Планировщик использует время устройства"),
      element("p", "", `Текущий часовой пояс браузера: ${getSystemTimeZone()}. Настройки данных и Google Calendar появятся на следующих этапах.`),
    );
    empty.append(content);
    card.append(empty);
    return card;
  }

  const empty = element("div", "empty-state");
  const content = element("div", "empty-state__content");
  content.append(element("div", "empty-state__symbol", symbol), element("h2", "", description));
  const message = route === "trash" ? "Здесь можно будет восстановить запись или удалить её навсегда." : "Планировщик готов. Добавление записей станет доступно на следующем этапе.";
  content.append(element("p", "", message));
  empty.append(content);
  card.append(empty);
  return card;
}

export function createUI({ state, router }) {
  const appShell = document.querySelector("[data-app-shell]");
  const viewContainer = document.querySelector("[data-view-container]");
  const detailPanel = document.querySelector("[data-detail-panel]");
  const scrim = document.querySelector("[data-scrim]");
  const createMenu = document.querySelector("[data-create-menu]");
  const createButton = document.querySelector("[data-action='open-create-menu']");
  const miniGrid = document.querySelector("[data-mini-calendar-grid]");
  const miniMonth = document.querySelector("[data-mini-month]");
  const panelTitle = document.querySelector("[data-panel-title]");
  const panelBody = document.querySelector("[data-panel-body]");
  const toastRegion = document.querySelector("[data-toast-region]");
  const startupStatus = document.querySelector("[data-startup-status]");
  let toastTimer = 0;

  function showToast(message) {
    window.clearTimeout(toastTimer);
    toastRegion.replaceChildren(element("div", "toast", message));
    toastTimer = window.setTimeout(() => toastRegion.replaceChildren(), 3_200);
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
      const button = element("button", "mini-day", String(date.getDate()));
      button.type = "button";
      button.dataset.date = dateValue;
      button.setAttribute("aria-label", date.toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long", year: "numeric" }));
      if (date.getMonth() !== focusDate.getMonth()) button.classList.add("is-outside");
      if (dateValue === todayString()) button.classList.add("is-today");
      if (dateValue === formatLocalDate(currentState.selectedDate)) button.classList.add("is-selected");
      button.addEventListener("click", () => {
        state.set({ selectedDate: date, visibleWeek: date, miniCalendarDate: date });
        router.navigate("calendar");
      });
      miniGrid.append(button);
    });
  }

  function renderRoute(currentState) {
    viewContainer.replaceChildren(currentState.route === "calendar" ? renderWeekCalendar(currentState.visibleWeek) : renderEmptyView(currentState.route));
    document.querySelectorAll("[data-route]").forEach((button) => {
      if (button.dataset.route === currentState.route) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    document.title = `${currentState.route === "calendar" ? "Календарь" : ROUTE_COPY[currentState.route][0]} — Мой планировщик`;
  }

  function openPanel(kind) {
    const isTask = kind === "task";
    panelTitle.textContent = isTask ? "Новая задача" : "Новая заметка";
    const placeholder = element("div", "panel-placeholder");
    placeholder.textContent = isTask
      ? "Форма задачи будет реализована на этапе 2. Сейчас проверяется работа боковой панели и навигации."
      : "Форма заметки будет реализована на этапе 5. Сейчас проверяется работа боковой панели и навигации.";
    panelBody.replaceChildren(placeholder);
    detailPanel.classList.add("is-open");
    detailPanel.setAttribute("aria-hidden", "false");
    scrim.hidden = false;
    createMenu.hidden = true;
    createButton.setAttribute("aria-expanded", "false");
    state.set({ detailPanel: kind });
    detailPanel.querySelector("[data-action='close-panel']").focus();
  }

  function closePanel() {
    detailPanel.classList.remove("is-open");
    detailPanel.setAttribute("aria-hidden", "true");
    scrim.hidden = true;
    state.set({ detailPanel: null });
  }

  function shiftWeek(amount) {
    const date = addCalendarDays(state.get().visibleWeek, amount * 7);
    state.set({ visibleWeek: date, selectedDate: date, miniCalendarDate: date });
  }

  function goToday() {
    const today = new Date();
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

  function handleAction(action) {
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
      "create-task": () => openPanel("task"),
      "create-note": () => openPanel("note"),
      "close-panel": closePanel,
      "connect-google": () => showToast("Подключение Google Calendar будет доступно на этапе 6"),
    };
    actions[action]?.();
  }

  document.addEventListener("click", (event) => {
    const routeButton = event.target.closest("[data-route]");
    if (routeButton) router.navigate(routeButton.dataset.route);
    const actionButton = event.target.closest("[data-action]");
    if (actionButton) handleAction(actionButton.dataset.action);
    if (!event.target.closest("[data-create-menu], [data-action='open-create-menu']")) {
      createMenu.hidden = true;
      createButton.setAttribute("aria-expanded", "false");
    }
  });

  scrim.addEventListener("click", closePanel);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.get().detailPanel) closePanel();
    const target = event.target;
    const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable;
    if (typing) return;
    if (event.key === "/") {
      event.preventDefault();
      document.querySelector("[data-search-input]").focus();
    } else if (event.key.toLocaleLowerCase("ru") === "c") openPanel("task");
    else if (event.key.toLocaleLowerCase("ru") === "n") openPanel("note");
    else if (event.key.toLocaleLowerCase("ru") === "t") goToday();
  });

  state.subscribe((currentState, previous) => {
    appShell.classList.toggle("sidebar-collapsed", currentState.sidebarCollapsed);
    if (currentState.sidebarCollapsed !== previous.sidebarCollapsed) {
      document.querySelector("[data-action='toggle-sidebar']").setAttribute("aria-label", currentState.sidebarCollapsed ? "Развернуть боковую панель" : "Свернуть боковую панель");
    }
    updatePeriod(currentState);
    renderMiniCalendar(currentState);
    if (currentState.route !== previous.route || currentState.visibleWeek.getTime() !== previous.visibleWeek.getTime()) renderRoute(currentState);
  });

  function mount() {
    const current = state.get();
    appShell.classList.toggle("sidebar-collapsed", current.sidebarCollapsed);
    updatePeriod(current);
    renderMiniCalendar(current);
    renderRoute(current);
    window.requestAnimationFrame(() => startupStatus.classList.add("is-ready"));
  }

  return Object.freeze({ mount, showToast, openPanel, closePanel });
}
