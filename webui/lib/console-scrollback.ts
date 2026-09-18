// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../types";

export const DEFAULT_CONSOLE_SCROLLBACK_LIMIT = 500;

type ConsoleCommandStatus = "pending" | "success" | "error";

export interface ConsoleScrollbackEntry {
  id: string;
  correlationId: string;
  command: string;
  source: string;
  submittedAt: number;
  completedAt?: number;
  status: ConsoleCommandStatus;
  errorMessage?: string;
  resultMessage?: string;
}

/**
 * Normalize UUID-style correlation IDs to the compact lowercase form used for
 * scrollback matching.
 */
export function normalizeCorrelationId(correlationId: string): string {
  return correlationId.replace(/-/g, "").toLowerCase();
}

/**
 * Decode a correlation ID received as either a string or a 16-byte wire value.
 */
export function decodeCorrelationId(rawCorrelationId: unknown): string | null {
  if (typeof rawCorrelationId === "string") {
    const normalized = normalizeCorrelationId(rawCorrelationId);
    return normalized.length > 0 ? normalized : null;
  }

  if (rawCorrelationId instanceof Uint8Array) {
    if (rawCorrelationId.length !== 16) {
      return null;
    }
    return Array.from(rawCorrelationId)
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
  }

  return null;
}

/**
 * Create the optimistic scrollback row shown while a command is still running.
 */
export function createPendingConsoleScrollbackEntry(
  command: string,
  correlationId: string,
  submittedAt = Date.now(),
  source = "UI",
): ConsoleScrollbackEntry {
  const normalizedCorrelationId = normalizeCorrelationId(correlationId);

  return {
    id: `${normalizedCorrelationId}:${submittedAt}`,
    correlationId: normalizedCorrelationId,
    command,
    source,
    submittedAt,
    status: "pending",
  };
}

export function createImmediateErrorConsoleScrollbackEntry(
  command: string,
  errorMessage: string,
  submittedAt = Date.now(),
  source = "UI",
): ConsoleScrollbackEntry {
  const localCorrelationId = `local-${submittedAt}`;

  return {
    id: `${localCorrelationId}:${submittedAt}`,
    correlationId: localCorrelationId,
    command,
    source,
    submittedAt,
    completedAt: submittedAt,
    status: "error",
    errorMessage,
  };
}

export function upsertPendingConsoleScrollbackEntry(
  entries: ConsoleScrollbackEntry[],
  command: string,
  correlationId: string,
  source: string,
  limit = DEFAULT_CONSOLE_SCROLLBACK_LIMIT,
): ConsoleScrollbackEntry[] {
  const normalizedCorrelationId = normalizeCorrelationId(correlationId);
  let replaced = false;

  const nextEntries = entries.map((entry) => {
    if (entry.correlationId !== normalizedCorrelationId) {
      return entry;
    }
    replaced = true;
    return {
      ...entry,
      command,
      source,
    };
  });

  if (replaced) {
    return nextEntries;
  }

  return appendConsoleScrollbackEntry(
    nextEntries,
    createPendingConsoleScrollbackEntry(
      command,
      normalizedCorrelationId,
      Date.now(),
      source,
    ),
    limit,
  );
}

/**
 * Append a scrollback row while enforcing the configured history limit.
 */
export function appendConsoleScrollbackEntry(
  entries: ConsoleScrollbackEntry[],
  entry: ConsoleScrollbackEntry,
  limit = DEFAULT_CONSOLE_SCROLLBACK_LIMIT,
): ConsoleScrollbackEntry[] {
  if (limit <= 0) {
    return [];
  }

  const nextEntries = [...entries, entry];
  if (nextEntries.length <= limit) {
    return nextEntries;
  }

  return nextEntries.slice(nextEntries.length - limit);
}

/**
 * Mark the scrollback row for a command result as successful or failed.
 */
export function resolveConsoleScrollbackEntryByCorrelation(
  entries: ConsoleScrollbackEntry[],
  correlationId: string,
  outcome: types.CommandOutcome,
  completedAt = Date.now(),
): ConsoleScrollbackEntry[] {
  const normalizedCorrelationId = normalizeCorrelationId(correlationId);
  let didChange = false;

  const nextEntries: ConsoleScrollbackEntry[] = entries.map(
    (entry): ConsoleScrollbackEntry => {
      if (entry.correlationId !== normalizedCorrelationId) {
        return entry;
      }

      didChange = true;

      if (outcome.type === "Failed") {
        return {
          ...entry,
          status: "error",
          completedAt,
          errorMessage: outcome.data.message,
          resultMessage: undefined,
        };
      }

      return {
        ...entry,
        status: "success",
        completedAt,
        errorMessage: undefined,
        resultMessage:
          typeof outcome.data.output?.value === "string"
            ? outcome.data.output.value
            : undefined,
      };
    },
  );

  return didChange ? nextEntries : entries;
}
