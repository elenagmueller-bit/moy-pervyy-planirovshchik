import { LIMITS } from "./config.js";
import { validateTask } from "./models.js";

const PRIORITY_LABELS = Object.freeze({ high: "Высокий", medium: "Средний", low: "Низкий" });
const CATEGORY_LABELS = Object.freeze({ work: "Работа", personal: "Личное" });

function node(tag, className, text) {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
}

function field(labelText, control, hint = "") {
  const wrapper = node("label", "form-field");
  wrapper.append(node("span", "form-field__label", labelText), control);
  if (hint) wrapper.append(node("small", "form-field__hint", hint));
  const error = node("small", "form-field__error");
  error.dataset.errorFor = control.name;
  wrapper.append(error);
  return wrapper;
}

function input(name, type = "text", value = "") {
  const control = document.createElement("input");
  control.name = name;
  control.type = type;
  if (type === "checkbox") control.checked = Boolean(value);
  else control.value = value ?? "";
  return control;
}

function textarea(name, value = "", rows = 3) {
  const control = document.createElement("textarea");
  control.name = name;
  control.rows = rows;
  control.value = value ?? "";
  return control;
}

function select(name, options, value = "") {
  const control = document.createElement("select");
  control.name = name;
  options.forEach(([optionValue, label]) => {
    const option = document.createElement("option");
    option.value = optionValue;
    option.textContent = label;
    option.selected = optionValue === value;
    control.append(option);
  });
  return control;
}

function parseTags(value) {
  return value.split(",").map((tag) => tag.trim()).filter(Boolean);
}

function renderChecklist(container, items = []) {
  container.replaceChildren();
  items.forEach((item) => {
    const row = node("div", "repeater-row");
    const done = input("checklistDone", "checkbox", item.isDone);
    done.setAttribute("aria-label", "Пункт выполнен");
    const textControl = input("checklistText", "text", item.text);
    textControl.dataset.id = item.id || "";
    textControl.placeholder = "Текст пункта";
    const remove = node("button", "icon-button icon-button--small", "×");
    remove.type = "button";
    remove.setAttribute("aria-label", "Удалить пункт чек-листа");
    remove.addEventListener("click", () => row.remove());
    row.append(done, textControl, remove);
    container.append(row);
  });
}

function renderLinks(container, items = []) {
  container.replaceChildren();
  items.forEach((item) => {
    const row = node("div", "repeater-row repeater-row--link");
    const label = input("linkLabel", "text", item.label);
    label.dataset.id = item.id || "";
    label.placeholder = "Подпись";
    const url = input("linkUrl", "url", item.url);
    url.placeholder = "https://…";
    const remove = node("button", "icon-button icon-button--small", "×");
    remove.type = "button";
    remove.setAttribute("aria-label", "Удалить ссылку");
    remove.addEventListener("click", () => row.remove());
    row.append(label, url, remove);
    container.append(row);
  });
}

function collectRows(form) {
  const checklist = [...form.querySelectorAll("[data-checklist] .repeater-row")].map((row, order) => ({
    id: row.querySelector("[name='checklistText']").dataset.id || undefined,
    text: row.querySelector("[name='checklistText']").value,
    isDone: row.querySelector("[name='checklistDone']").checked,
    order,
  }));
  const links = [...form.querySelectorAll("[data-links] .repeater-row")].map((row) => ({
    id: row.querySelector("[name='linkLabel']").dataset.id || undefined,
    label: row.querySelector("[name='linkLabel']").value,
    url: row.querySelector("[name='linkUrl']").value,
  })).filter((link) => link.label.trim() || link.url.trim());
  return { checklist, links };
}

export function taskInputFromForm(form, existing = null) {
  const data = new FormData(form);
  const hasTime = data.get("hasTime") === "on";
  const rows = collectRows(form);
  return {
    ...(existing || {}),
    title: data.get("title"),
    shortDescription: data.get("shortDescription"),
    details: data.get("details"),
    date: data.get("date"),
    hasTime,
    startTime: hasTime ? data.get("startTime") : null,
    durationMinutes: hasTime ? Number(data.get("durationMinutes")) : null,
    priority: data.get("priority") || "medium",
    category: data.get("category"),
    status: existing?.status || "active",
    tags: parseTags(data.get("tags") || ""),
    checklist: rows.checklist,
    links: rows.links,
    recurrence: existing?.recurrence || null,
    googleSync: existing?.googleSync || null,
  };
}

function clearErrors(form) {
  form.querySelectorAll("[data-error-for]").forEach((element) => { element.textContent = ""; });
  form.querySelectorAll("[aria-invalid='true']").forEach((element) => element.removeAttribute("aria-invalid"));
}

function showErrors(form, errors) {
  clearErrors(form);
  Object.entries(errors).forEach(([key, message]) => {
    const name = key.startsWith("links.") ? "links" : key;
    const messageNode = form.querySelector(`[data-error-for="${name}"]`);
    if (messageNode) messageNode.textContent = message;
    const control = form.elements.namedItem(name);
    if (control instanceof HTMLElement) control.setAttribute("aria-invalid", "true");
  });
}

export function createTaskForm({ task = null, onSave }) {
  const form = node("form", "task-form");
  form.noValidate = true;
  form.dataset.dirty = "false";
  const title = input("title", "text", task?.title);
  title.maxLength = LIMITS.taskTitle;
  title.placeholder = "Например, подготовить отчёт";
  const shortDescription = input("shortDescription", "text", task?.shortDescription);
  shortDescription.maxLength = LIMITS.taskShortDescription;
  const details = textarea("details", task?.details, 5);
  details.maxLength = LIMITS.taskDetails;
  const date = input("date", "date", task?.date);
  const category = select("category", [["", "Выберите категорию"], ["work", "Работа"], ["personal", "Личное"]], task?.category || "");
  const priority = select("priority", [["high", "Высокий"], ["medium", "Средний"], ["low", "Низкий"]], task?.priority || "medium");
  const hasTime = input("hasTime", "checkbox", task?.hasTime);
  const startTime = input("startTime", "time", task?.startTime);
  startTime.step = "900";
  const duration = input("durationMinutes", "number", task?.durationMinutes ?? 15);
  duration.min = String(LIMITS.durationMin);
  duration.max = String(LIMITS.durationMax);
  duration.step = "15";
  const timeFields = node("div", "form-grid form-grid--time");
  timeFields.append(field("Время", startTime), field("Длительность, минут", duration, "От 15 минут до 24 часов, шаг 15 минут"));
  const updateTimeVisibility = () => {
    timeFields.hidden = !hasTime.checked;
    startTime.disabled = !hasTime.checked;
    duration.disabled = !hasTime.checked;
  };
  hasTime.addEventListener("change", updateTimeVisibility);

  const checklist = node("div", "repeater", undefined);
  checklist.dataset.checklist = "";
  renderChecklist(checklist, task?.checklist || []);
  const addChecklist = node("button", "button button--quiet button--small", "+ Пункт чек-листа");
  addChecklist.type = "button";
  addChecklist.addEventListener("click", () => {
    if (checklist.children.length >= LIMITS.checklist) return;
    const items = [...checklist.children].map((row) => ({
      id: row.querySelector("[name='checklistText']").dataset.id,
      text: row.querySelector("[name='checklistText']").value,
      isDone: row.querySelector("[name='checklistDone']").checked,
    }));
    renderChecklist(checklist, [...items, { text: "", isDone: false }]);
    checklist.lastElementChild.querySelector("[name='checklistText']").focus();
    form.dataset.dirty = "true";
  });

  const links = node("div", "repeater");
  links.dataset.links = "";
  renderLinks(links, task?.links || []);
  const addLink = node("button", "button button--quiet button--small", "+ Ссылка");
  addLink.type = "button";
  addLink.addEventListener("click", () => {
    const items = [...links.children].map((row) => ({
      id: row.querySelector("[name='linkLabel']").dataset.id,
      label: row.querySelector("[name='linkLabel']").value,
      url: row.querySelector("[name='linkUrl']").value,
    }));
    renderLinks(links, [...items, { label: "", url: "" }]);
    links.lastElementChild.querySelector("[name='linkLabel']").focus();
    form.dataset.dirty = "true";
  });

  const tags = input("tags", "text", task?.tags?.join(", ") || "");
  tags.placeholder = "Через запятую";
  const checklistError = node("small", "form-field__error");
  checklistError.dataset.errorFor = "checklist";
  const linksError = node("small", "form-field__error");
  linksError.dataset.errorFor = "links";

  const googleSwitch = node("label", "switch-row is-disabled");
  const google = input("google", "checkbox", false);
  google.disabled = true;
  googleSwitch.append(google, node("span", "", "Добавить в Google Calendar"), node("small", "", "Станет доступно после подключения Google"));
  const recurrence = select("recurrence", [["none", "Не повторяется"]], "none");
  recurrence.disabled = true;

  const submit = node("button", "button button--primary", task ? "Сохранить изменения" : "Сохранить задачу");
  submit.type = "submit";
  const actions = node("div", "form-actions");
  actions.append(submit);

  form.append(
    field("Название *", title),
    field("Краткое описание", shortDescription),
    field("Подробное описание", details),
    node("hr", "form-divider"),
    field("Дата *", date),
    field("Категория *", category),
    field("Приоритет", priority),
  );
  const timeSwitch = node("label", "switch-row");
  timeSwitch.append(hasTime, node("span", "", "Указать время"));
  form.append(timeSwitch, timeFields, field("Теги", tags, `До ${LIMITS.tags} тегов, каждый до ${LIMITS.tagLength} символов`));
  const checklistGroup = node("section", "form-group");
  checklistGroup.append(node("h3", "", "Чек-лист"), checklist, addChecklist, checklistError);
  const linksGroup = node("section", "form-group");
  linksGroup.append(node("h3", "", "Ссылки"), links, addLink, linksError);
  form.append(checklistGroup, linksGroup, field("Повторение", recurrence, "Настройка повторений появится на этапе 4"), googleSwitch, actions);
  updateTimeVisibility();

  const updateSaveState = () => {
    const candidate = taskInputFromForm(form, task);
    submit.disabled = !validateTask(candidate).valid || form.dataset.saving === "true";
  };
  form.addEventListener("input", () => { form.dataset.dirty = "true"; updateSaveState(); });
  form.addEventListener("change", () => { form.dataset.dirty = "true"; updateSaveState(); });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (form.dataset.saving === "true") return;
    const candidate = taskInputFromForm(form, task);
    const validation = validateTask(candidate);
    if (!validation.valid) {
      showErrors(form, validation.errors);
      form.querySelector("[aria-invalid='true']")?.focus();
      return;
    }
    clearErrors(form);
    form.dataset.saving = "true";
    submit.disabled = true;
    submit.textContent = "Сохраняем…";
    try {
      await onSave(validation.normalized);
      form.dataset.dirty = "false";
    } catch (error) {
      const message = node("div", "form-error", error.name === "VersionError" ? "Задача уже изменена в другой вкладке. Откройте её заново." : "Не удалось сохранить задачу. Введённые данные оставлены в форме.");
      actions.prepend(message);
    } finally {
      form.dataset.saving = "false";
      submit.textContent = task ? "Сохранить изменения" : "Сохранить задачу";
      updateSaveState();
    }
  });
  updateSaveState();
  window.requestAnimationFrame(() => title.focus());
  return form;
}

function infoRow(label, value) {
  const row = node("div", "task-detail-row");
  row.append(node("dt", "", label), node("dd", "", value));
  return row;
}

export function createTaskViewer(task, actionDefinitions) {
  const view = node("article", `task-view priority-${task.priority}`);
  if (task.shortDescription) view.append(node("p", "task-view__lead", task.shortDescription));
  if (task.details) view.append(node("p", "task-view__details", task.details));
  const list = node("dl", "task-details");
  list.append(
    infoRow("Дата", new Date(`${task.date}T12:00:00`).toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long", year: "numeric" })),
    infoRow("Время", task.hasTime ? `${task.startTime} · ${task.durationMinutes} мин` : "Без времени"),
    infoRow("Приоритет", PRIORITY_LABELS[task.priority]),
    infoRow("Категория", CATEGORY_LABELS[task.category]),
    infoRow("Статус", task.status === "completed" ? "Выполнена" : task.status === "cancelled" ? "Отменена" : "Активна"),
  );
  view.append(list);
  if (task.tags.length) view.append(node("p", "task-view__tags", task.tags.map((tag) => `#${tag}`).join("  ")));
  if (task.checklist.length) {
    const checklist = node("ul", "task-view__checklist");
    task.checklist.sort((a, b) => a.order - b.order).forEach((item) => checklist.append(node("li", item.isDone ? "is-done" : "", `${item.isDone ? "✓" : "○"} ${item.text}`)));
    view.append(node("h3", "", "Чек-лист"), checklist);
  }
  if (task.links.length) {
    const links = node("div", "task-view__links");
    task.links.forEach((item) => {
      const anchor = node("a", "", item.label || item.url);
      anchor.href = item.url;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      links.append(anchor);
    });
    view.append(node("h3", "", "Ссылки"), links);
  }
  const meta = node("p", "task-view__meta", `Создана ${new Date(task.createdAt).toLocaleString("ru-RU")} · Изменение ${task.revision}`);
  view.append(meta);
  const actions = node("div", "task-view__actions");
  actionDefinitions.forEach(({ label, action, kind = "quiet" }) => {
    const button = node("button", `button button--${kind}`, label);
    button.type = "button";
    button.dataset.taskAction = action;
    actions.append(button);
  });
  view.append(actions);
  return view;
}

export function formFoundationStatus() {
  return Object.freeze({ taskFormsEnabled: true, noteFormsEnabled: false, plannedFor: "Этапы 2 и 5" });
}
