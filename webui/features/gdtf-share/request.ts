// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { getBackendUrl } from "../../lib/api";

/** Status the engine answers when no GDTF Share account is signed in. */
export const GDTF_SHARE_SIGNED_OUT_STATUS = 428;

/** A failed GDTF Share request, with the engine's message written for the user. */
export class GdtfShareRequestError extends Error {
  /** HTTP status the engine answered, or 0 when it could not be reached. */
  readonly status: number;

  /** Wraps the engine's `message` for a request that answered `status`. */
  constructor(message: string, status: number) {
    super(message);
    this.name = "GdtfShareRequestError";
    this.status = status;
  }

  /** Whether the request failed only because no account is signed in. */
  get signedOut(): boolean {
    return this.status === GDTF_SHARE_SIGNED_OUT_STATUS;
  }
}

/**
 * Sends one GDTF Share request to the engine at `path` and parses its JSON reply.
 *
 * Rejects like {@link sendGdtfShare}.
 */
export async function requestGdtfShare<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  return (await (await sendGdtfShare(path, init)).json()) as T;
}

/**
 * Sends one GDTF Share request to the engine at `path` and resolves with its successful
 * response, unread, for replies that stream.
 *
 * Rejects with a {@link GdtfShareRequestError} carrying the engine's own message. A bare 404
 * with no message means the engine was built without GDTF Share. An aborted request rejects
 * with the browser's `AbortError` unchanged.
 */
export async function sendGdtfShare(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${getBackendUrl()}${path}`, {
      cache: "no-store",
      ...init,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new GdtfShareRequestError("Could not reach Nightfall.", 0);
  }
  if (!response.ok) {
    const message =
      (await response.text()) ||
      (response.status === 404
        ? "GDTF Share is unavailable on this backend."
        : "Could not contact GDTF Share.");
    throw new GdtfShareRequestError(message, response.status);
  }
  return response;
}
