// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { getBackendUrl } from "../../lib/api";
import type { GdtfShareAccountStatus } from "../../types";

/** Username and password sent to the engine to sign in to GDTF Share. */
export interface GdtfShareCredentials {
  user: string;
  password: string;
}

/** What a request does with the engine's GDTF Share account. */
export type GdtfShareAccountAction = "status" | "sign-in" | "sign-out";

/** Path of the account resource on the backend. */
const ACCOUNT_PATH = "/api/gdtf-share/account";

/**
 * Reads or changes the engine's GDTF Share account: `status` reads it, `sign-in` signs in
 * with `credentials` and `sign-out` signs out. Changes use POST, which the backend's CORS
 * policy allows from the desktop shell. Resolves with the account status afterwards, or
 * rejects with the engine's own message, which is written to be shown to the user.
 */
export async function requestGdtfShareAccount(
  action: GdtfShareAccountAction,
  credentials?: GdtfShareCredentials,
): Promise<GdtfShareAccountStatus> {
  const path =
    action === "sign-out" ? `${ACCOUNT_PATH}/sign-out` : ACCOUNT_PATH;
  const response = await fetch(`${getBackendUrl()}${path}`, {
    method: action === "status" ? "GET" : "POST",
    cache: "no-store",
    headers: credentials ? { "Content-Type": "application/json" } : undefined,
    body: credentials ? JSON.stringify(credentials) : undefined,
  });
  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? "GDTF Share is unavailable on this backend."
        : (await response.text()) || "Could not contact GDTF Share.",
    );
  }
  return (await response.json()) as GdtfShareAccountStatus;
}
