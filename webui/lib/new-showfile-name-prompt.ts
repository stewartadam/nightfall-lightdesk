// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { atom } from "nanostores";
import type { NewShowfileOptions } from "../types";

export interface NewShowfileNamePromptRequest {
  requestId: string;
}

export const newShowfileNamePrompt = atom<NewShowfileNamePromptRequest | null>(
  null,
);

const pendingResolvers = new Map<
  string,
  (options: NewShowfileOptions | null) => void
>();

/** Creates a stable request id for one new-showfile name prompt. */
function createPromptRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `new-showfile-${Date.now()}`;
}

/** Resolves and clears a pending prompt request if it is still active. */
function resolvePromptRequest(
  requestId: string,
  options: NewShowfileOptions | null,
): void {
  const resolve = pendingResolvers.get(requestId);
  if (!resolve) return;

  pendingResolvers.delete(requestId);
  if (newShowfileNamePrompt.get()?.requestId === requestId) {
    newShowfileNamePrompt.set(null);
  }
  resolve(options);
}

/** Requests the name and initial content for a new show through the shared dialog. */
export function promptForNewShowfile(): Promise<NewShowfileOptions | null> {
  const activeRequest = newShowfileNamePrompt.get();
  if (activeRequest) {
    resolvePromptRequest(activeRequest.requestId, null);
  }

  const requestId = createPromptRequestId();
  return new Promise((resolve) => {
    pendingResolvers.set(requestId, resolve);
    newShowfileNamePrompt.set({ requestId });
  });
}

/** Completes the active request with the trimmed name and sample-data selection. */
export function submitNewShowfileNamePrompt(
  requestId: string,
  name: string,
  includeSampleData: boolean,
): void {
  const trimmed = name.trim();
  resolvePromptRequest(
    requestId,
    trimmed.length > 0 ? { name: trimmed, includeSampleData } : null,
  );
}

/** Cancels the active prompt request without creating a showfile. */
export function cancelNewShowfileNamePrompt(requestId: string): void {
  resolvePromptRequest(requestId, null);
}
