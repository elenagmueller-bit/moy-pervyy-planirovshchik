export function normalizeSearchText(value) {
  return String(value ?? "").toLocaleLowerCase("ru-RU").replaceAll("ё", "е").trim();
}

function linkText(links) {
  return (Array.isArray(links) ? links : []).flatMap((link) => [link.label, link.url]);
}

function taskFields(task) {
  return [task.title, task.shortDescription, task.details, ...(task.tags || []), ...(task.checklist || []).map((item) => item.text), ...linkText(task.links)];
}

function noteFields(note) {
  return [note.title, note.text, ...(note.tags || []), ...linkText(note.links)];
}

function googleFields(event) {
  return [event.summary, event.description, event.location, event.calendarName];
}

function matches(fields, query) {
  return fields.some((value) => normalizeSearchText(value).includes(query));
}

function allowed(record, includeArchive, includeTrash) {
  if (record.trashedAt) return includeTrash;
  if (record.archivedAt) return includeArchive;
  return true;
}

export function searchPlanner({ tasks = [], notes = [], googleEvents = [] }, query, options = {}) {
  const normalized = normalizeSearchText(query);
  const { force = false, includeArchive = false, includeTrash = false } = options;
  if (!normalized || (normalized.length < 2 && !force)) return { query: normalized, active: false, tasks: [], notes: [], googleEvents: [] };
  return {
    query: normalized,
    active: true,
    tasks: tasks.filter((task) => allowed(task, includeArchive, includeTrash) && matches(taskFields(task), normalized)),
    notes: notes.filter((note) => allowed(note, includeArchive, includeTrash) && matches(noteFields(note), normalized)),
    googleEvents: googleEvents.filter((event) => matches(googleFields(event), normalized)),
  };
}
