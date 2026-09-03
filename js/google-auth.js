import { GOOGLE_CONFIG } from "./config.js";

let accessToken = null;
let expiresAt = null;

export function getGoogleAuthState() {
  return Object.freeze({
    configured: Boolean(GOOGLE_CONFIG.clientId),
    available: Boolean(window.google?.accounts?.oauth2),
    authenticated: Boolean(accessToken && expiresAt && expiresAt > Date.now()),
    expiresAt,
  });
}

export function clearGoogleToken() {
  accessToken = null;
  expiresAt = null;
}

export function googleAuthFoundationStatus() {
  return "Авторизация будет подключена на этапе 6";
}
