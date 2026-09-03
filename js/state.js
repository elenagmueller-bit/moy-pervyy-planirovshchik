import { DEFAULT_ROUTE } from "./config.js";
import { startOfISOWeek } from "./date-utils.js";

export function createAppState(initial = {}) {
  let value = {
    route: initial.route || DEFAULT_ROUTE,
    selectedDate: initial.selectedDate || new Date(),
    visibleWeek: startOfISOWeek(initial.visibleWeek || new Date()),
    miniCalendarDate: initial.miniCalendarDate || new Date(),
    sidebarCollapsed: Boolean(initial.sidebarCollapsed),
    detailPanel: null,
    online: navigator.onLine,
    ready: false,
  };
  const listeners = new Set();

  return Object.freeze({
    get: () => ({ ...value }),
    set(patch) {
      const previous = value;
      value = { ...value, ...patch };
      listeners.forEach((listener) => listener({ ...value }, previous));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}
