import { GOOGLE_CONFIG } from "./config.js";

function scopesFromResponse(response, requested) {
  return new Set(String(response.scope || requested).split(/\s+/).filter(Boolean));
}

export function createGoogleAuthService({
  clientId = GOOGLE_CONFIG.clientId,
  oauth2 = globalThis.google?.accounts?.oauth2,
  now = () => Date.now(),
} = {}) {
  const getOauth2 = () => oauth2 || globalThis.google?.accounts?.oauth2;
  let token = null;
  let expiresAt = null;
  let grantedScopes = new Set();
  let state = "disconnected";
  const listeners = new Set();
  let warningTimer = 0;
  let expiryTimer = 0;

  const snapshot = () => Object.freeze({
    configured: Boolean(clientId),
    available: Boolean(getOauth2()),
    authenticated: Boolean(token && expiresAt && expiresAt > now()),
    expiresAt,
    state,
    canRead: grantedScopes.has(GOOGLE_CONFIG.readScope),
    canWrite: grantedScopes.has(GOOGLE_CONFIG.writeScope),
  });
  const notify = () => listeners.forEach((listener) => listener(snapshot()));
  const clearTimers = () => { clearTimeout(warningTimer); clearTimeout(expiryTimer); warningTimer = 0; expiryTimer = 0; };
  const scheduleExpiry = () => {
    clearTimers();
    const remaining = expiresAt - now();
    warningTimer = setTimeout(() => { state = "expiring"; notify(); }, Math.max(0, remaining - 300_000));
    expiryTimer = setTimeout(() => { token = null; state = "expired"; notify(); }, Math.max(0, remaining));
  };

  function requireConfiguration() {
    if (!clientId) throw new Error("Google OAuth Client ID не настроен в js/config.js");
    if (!getOauth2()?.initTokenClient) throw new Error("Google Identity Services не загрузился");
  }

  function request(scopes) {
    requireConfiguration();
    state = "connecting"; notify();
    return new Promise((resolve, reject) => {
      let settled = false;
      const client = getOauth2().initTokenClient({
        client_id: clientId,
        scope: scopes.join(" "),
        include_granted_scopes: true,
        callback: (response) => {
          if (settled) return;
          settled = true;
          if (response.error || !response.access_token) {
            state = "disconnected"; notify(); reject(new Error(response.error_description || response.error || "Google не предоставил доступ")); return;
          }
          token = response.access_token;
          expiresAt = now() + Math.max(0, Number(response.expires_in || 0)) * 1_000;
          const returnedScopes = scopesFromResponse(response, scopes.join(" "));
          const api = getOauth2();
          grantedScopes = new Set([...returnedScopes].filter((scope) => !api?.hasGrantedAllScopes || api.hasGrantedAllScopes(response, scope)));
          state = "connected"; scheduleExpiry(); notify(); resolve(snapshot());
        },
        error_callback: (error) => {
          if (settled) return;
          settled = true; state = "disconnected"; notify(); reject(new Error(error?.message || "Окно Google было закрыто"));
        },
      });
      client.requestAccessToken({ prompt: "" });
    });
  }

  function clear() {
    clearTimers(); token = null; expiresAt = null; grantedScopes = new Set(); state = "disconnected"; notify();
  }

  async function revoke() {
    const current = token;
    if (!current) { clear(); return; }
    const api = getOauth2();
    await new Promise((resolve) => api?.revoke ? api.revoke(current, resolve) : resolve());
    clear();
  }

  return Object.freeze({
    getState: snapshot,
    getAccessToken: () => token && expiresAt > now() ? token : null,
    requestReadAccess: () => request([GOOGLE_CONFIG.readScope]),
    requestWriteAccess: () => request([GOOGLE_CONFIG.readScope, GOOGLE_CONFIG.writeScope]),
    clear,
    revoke,
    subscribe(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener); },
  });
}

let defaultService;
export function getDefaultGoogleAuthService() {
  if (!defaultService) defaultService = createGoogleAuthService();
  return defaultService;
}

export function getGoogleAuthState() { return getDefaultGoogleAuthService().getState(); }
export function clearGoogleToken() { return getDefaultGoogleAuthService().clear(); }
