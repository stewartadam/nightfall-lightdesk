// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../../../types";
import { findCatalogEntry } from "./action-catalog";

/** Number of recent invocation failures retained for inspection. */
export const INVOCATION_FAILURE_HISTORY_LIMIT = 50;

/** Toast lifetime for failures from continuous input, shorter than the default. */
export const CONTINUOUS_FAILURE_TOAST_MS = 3000;

/** Toast content describing one failed action invocation. */
export interface InvocationFailureToast {
  /** Severity used to present the failure. */
  level: "error" | "warning";
  /** Catalog label of the failed action, or its raw ID when unknown. */
  title: string;
  /** Failure explanation followed by the surface source that invoked the action. */
  message: string;
  /** Presentation lifetime override, when the default is too intrusive. */
  ttlMs?: number;
}

/** Returns the history with the newest failure first, bounded to `limit` entries. */
export function appendInvocationFailure(
  history: readonly types.ActionInvocationFailure[],
  failure: types.ActionInvocationFailure,
  limit = INVOCATION_FAILURE_HISTORY_LIMIT,
): types.ActionInvocationFailure[] {
  return [failure, ...history].slice(0, Math.max(0, limit));
}

/**
 * Describes a failed invocation for a toast using the action's catalog label.
 *
 * Failures from continuous scalar input (faders) are presented as short-lived warnings,
 * since the backend re-reports them while the fader keeps moving.
 */
export function describeInvocationFailure(
  failure: types.ActionInvocationFailure,
  catalog: readonly types.ActionCatalogEntry[],
): InvocationFailureToast {
  const label =
    findCatalogEntry(catalog, failure.action.id)?.descriptor.label ??
    failure.action.id;
  const continuous = failure.input.type === "Scalar";
  return {
    level: continuous ? "warning" : "error",
    title: `${label} failed`,
    message: failure.source
      ? `${failure.error.message} (${failure.source})`
      : failure.error.message,
    ...(continuous ? { ttlMs: CONTINUOUS_FAILURE_TOAST_MS } : {}),
  };
}
