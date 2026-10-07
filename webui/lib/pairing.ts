// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Pairing PIN flow for devices that reach the backend over the network.
 *
 * The backend decides who must pair: the computer running Nightfall never
 * does, and a device that paired earlier in the app session carries an
 * `HttpOnly` cookie the browser sends on every request and websocket upgrade.
 */

import { atom } from "nanostores";
import type {
  RemotePairingAttempt,
  RemotePairingPin,
  RemotePairingStatus,
} from "../types";
import { getBackendUrl } from "./api";

/** URL fragment key a shared link uses to carry the PIN. */
const PIN_FRAGMENT_KEY = "pin";

/**
 * Whether this device is waiting for the user to enter the pairing PIN. The
 * connection overlay stays hidden meanwhile, since the prompt explains why
 * the engine is not connected and must stay usable.
 */
export const $pairingPromptOpen = atom(false);

/** Result of submitting a PIN. */
export type PairingResult =
  | { kind: "paired" }
  | { kind: "incorrect" }
  | { kind: "rate-limited"; retryAfterSeconds: number }
  | { kind: "failed"; message: string };

/** Asks the backend whether this device must enter the PIN before connecting. */
export async function fetchPairingStatus(): Promise<RemotePairingStatus> {
  const response = await fetch(`${getBackendUrl()}/api/pairing`);
  if (!response.ok) {
    throw new Error(`Pairing status request failed (${response.status})`);
  }
  return (await response.json()) as RemotePairingStatus;
}

/** Submits a PIN and maps the backend's answer to a result the prompt can show. */
export async function submitPairingPin(pin: string): Promise<PairingResult> {
  const attempt: RemotePairingAttempt = { pin };
  const response = await fetch(`${getBackendUrl()}/api/pairing`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(attempt),
  });
  if (response.ok) return { kind: "paired" };
  if (response.status === 401) return { kind: "incorrect" };
  if (response.status === 429) {
    const retryAfter = Number.parseInt(
      response.headers.get("Retry-After") ?? "",
      10,
    );
    return {
      kind: "rate-limited",
      retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : 1,
    };
  }
  return { kind: "failed", message: await response.text() };
}

/**
 * Fetches the PIN for display. Resolves to null on another device, which may
 * not read it, and throws when the backend cannot be reached.
 */
export async function fetchPairingPin(): Promise<string | null> {
  const response = await fetch(`${getBackendUrl()}/api/pairing/pin`);
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new Error(await response.text());
  return ((await response.json()) as RemotePairingPin).pin;
}

/** Replaces the PIN and signs out every paired device, returning the new PIN. */
export async function regeneratePairingPin(): Promise<string> {
  const response = await fetch(`${getBackendUrl()}/api/pairing/pin`, {
    method: "POST",
  });
  if (!response.ok) throw new Error(await response.text());
  return ((await response.json()) as RemotePairingPin).pin;
}

/** Splits a six-digit PIN into two groups of three so it is easy to read aloud. */
export function formatPairingPin(pin: string): string {
  return pin.length === 6 ? `${pin.slice(0, 3)} ${pin.slice(3)}` : pin;
}

/**
 * Returns the PIN carried in a URL fragment such as `#pin=123456`, together
 * with the fragment left once the PIN is removed.
 */
export function parsePinFragment(hash: string): {
  pin: string | null;
  remainingHash: string;
} {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const pin = params.get(PIN_FRAGMENT_KEY);
  params.delete(PIN_FRAGMENT_KEY);
  const remaining = params.toString();
  return { pin, remainingHash: remaining ? `#${remaining}` : "" };
}

/**
 * Removes a PIN from the page's URL fragment and returns it.
 *
 * The fragment never reaches the server, and stripping it at once keeps the
 * PIN out of the address bar, history and bookmarks.
 */
export function takePinFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  const { pin, remainingHash } = parsePinFragment(window.location.hash);
  if (pin === null) return null;
  const { pathname, search } = window.location;
  window.history.replaceState(
    window.history.state,
    "",
    `${pathname}${search}${remainingHash}`,
  );
  return pin;
}
