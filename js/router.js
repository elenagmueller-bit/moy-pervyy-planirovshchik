import { DEFAULT_ROUTE, STORAGE_KEYS, VALID_ROUTES } from "./config.js";

export function normalizeRoute(route) {
  return VALID_ROUTES.includes(route) ? route : DEFAULT_ROUTE;
}

export function routeFromHash(hash = window.location.hash) {
  return normalizeRoute(hash.replace(/^#\/?/, ""));
}

export function createRouter(state) {
  function navigate(route, { replace = false } = {}) {
    const nextRoute = normalizeRoute(route);
    const nextHash = `#/${nextRoute}`;
    if (window.location.hash !== nextHash) {
      window.history[replace ? "replaceState" : "pushState"]({}, "", nextHash);
    }
    localStorage.setItem(STORAGE_KEYS.lastRoute, nextRoute);
    state.set({ route: nextRoute });
  }

  function handleHashChange() {
    const route = routeFromHash();
    localStorage.setItem(STORAGE_KEYS.lastRoute, route);
    state.set({ route });
  }

  window.addEventListener("hashchange", handleHashChange);
  return Object.freeze({ navigate, sync: handleHashChange });
}
