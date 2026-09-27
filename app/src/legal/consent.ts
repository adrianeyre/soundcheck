import { readLocal, writeLocal } from "../settings/local-settings";

/** Where the app remembers that the cookie notice has been acknowledged. */
export const CONSENT_KEY = "soundcheck.cookie-consent";

export function hasAcknowledgedCookies(): boolean {
  return readLocal(CONSENT_KEY) !== null;
}

export function acknowledgeCookies(now = new Date()): void {
  writeLocal(CONSENT_KEY, now.toISOString());
}
