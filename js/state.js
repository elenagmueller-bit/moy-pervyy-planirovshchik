import { CALENDAR_TIME_ZONES, DEFAULT_ROUTE } from "./config.js";
import { startOfISOWeek, wallClockDateInZone } from "./date-utils.js";

export function createAppState(initial = {}) {
  const primaryNow = wallClockDateInZone(new Date(), CALENDAR_TIME_ZONES.primary.id);
  let value = {
    route: initial.route || DEFAULT_ROUTE,
    selectedDate: initial.selectedDate || primaryNow,
    visibleWeek: startOfISOWeek(initial.visibleWeek || primaryNow),
    miniCalendarDate: initial.miniCalendarDate || primaryNow,
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
