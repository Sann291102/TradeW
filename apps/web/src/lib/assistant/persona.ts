'use client';

import { API_URL, api, getToken } from '../api';

/**
 * The user-chosen AI identity, client side (`AI-PERSONA.md`).
 *
 * Two storage locations, deliberately:
 *
 *   PRE-AUTH   localStorage only. No account exists yet, and creating a
 *              server-side record for someone who may never sign up is data
 *              collection with no purpose (§2).
 *   POST-AUTH  the user row, read through the API. localStorage becomes a
 *              cache so the dock can render a name before the first fetch
 *              lands rather than flashing "TradeW AI".
 */

const LOCAL_KEY = 'tradew_ai_persona_name';

/** What the assistant is called before anyone has named it. */
export const DEFAULT_PERSONA_NAME = 'TradeW AI';

export function readLocalPersonaName(): string | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(LOCAL_KEY);
  return raw && raw.trim() ? raw : null;
}

export function writeLocalPersonaName(name: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(LOCAL_KEY, name);
}

export function clearLocalPersonaName(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(LOCAL_KEY);
}

export interface NameValidation {
  ok: boolean;
  name?: string;
  message?: string;
  ruleId?: string;
}

/**
 * Ask the server whether a name is acceptable, before signup.
 *
 * Unauthenticated by design — the naming moment happens on the landing page.
 * This is a convenience so the user is not told their name was rejected only
 * after creating an account; the same filter runs again on every write, so
 * skipping this call changes nothing about what can be stored.
 */
export async function validatePersonaName(name: string): Promise<NameValidation> {
  try {
    const res = await fetch(`${API_URL}/ai/persona/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    // A non-OK response is the SERVICE failing, not the name being rejected.
    // Without this check an error body (`{statusCode:500,message:"..."}`) casts
    // to a NameValidation with `ok` undefined — so an API outage told the user
    // their name was refused, quoting the server's error as the reason.
    if (!res.ok) return { ok: true, name: name.trim() };
    return (await res.json()) as NameValidation;
  } catch {
    // API unreachable. Let the name through locally — the server will validate
    // it again at signup, and blocking the landing page on an API outage would
    // be a worse failure than deferring the check.
    return { ok: true, name: name.trim() };
  }
}

const FALLBACK_SUGGESTIONS = ['Nova', 'Atlas', 'Vega', 'Iris'];

export async function fetchSuggestions(): Promise<string[]> {
  try {
    const res = await fetch(`${API_URL}/ai/persona/suggestions`);
    // Same reasoning as above: an unchecked 5xx parsed to `{}` and returned an
    // EMPTY list, so a failing optional service silently removed the suggested
    // names rather than falling back to them.
    if (!res.ok) return FALLBACK_SUGGESTIONS;
    const data = (await res.json()) as { suggestions?: string[] };
    return data.suggestions?.length ? data.suggestions : FALLBACK_SUGGESTIONS;
  } catch {
    return FALLBACK_SUGGESTIONS;
  }
}

/** The signed-in user's persona, authoritative. Caches into localStorage. */
export async function fetchPersona(): Promise<{ name: string | null } | null> {
  if (!getToken()) return null;
  try {
    const data = (await api('/ai/persona')) as { name: string | null };
    if (data.name) writeLocalPersonaName(data.name);
    return data;
  } catch {
    return null;
  }
}

export async function savePersonaName(name: string): Promise<NameValidation> {
  try {
    const data = (await api('/ai/persona', {
      method: 'PUT',
      body: JSON.stringify({ name }),
    })) as { name: string };
    writeLocalPersonaName(data.name);
    return { ok: true, name: data.name };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'That name did not work.';
    return { ok: false, message };
  }
}

/**
 * The name to render right now.
 *
 * Synchronous and never null so no surface has to handle an unnamed state
 * inline — callers refresh from `fetchPersona()` when a token exists.
 */
export function personaName(): string {
  return readLocalPersonaName() ?? DEFAULT_PERSONA_NAME;
}
