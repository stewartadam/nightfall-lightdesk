// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { openFeedbackPage } from "../../../lib/feedback";

/** Renders a terminal startup failure after the interactive chunk loads. */
export default function InteractiveAppError(props: { error: unknown }) {
  /** Normalizes arbitrary thrown values for display. */
  const errorMessage = () =>
    props.error instanceof Error ? props.error.message : String(props.error);

  return (
    <div
      class="flex h-full w-full items-center justify-center bg-neutral-950 px-6 text-neutral-200"
      role="alert"
    >
      <div class="max-w-md rounded-lg border border-neutral-800 bg-neutral-900 p-6 shadow-lg">
        <h1 class="mb-2 text-lg font-bold text-red-500">Application Error</h1>
        <p class="mb-4 text-neutral-300">
          The application encountered an unexpected error during startup and
          cannot continue.
        </p>
        <div class="mb-4 rounded border border-neutral-700 bg-neutral-800 p-3 font-mono text-sm text-neutral-200">
          <p class="mb-1 font-bold">Error Details:</p>
          <p>{errorMessage()}</p>
        </div>
        <p class="text-sm text-neutral-400">
          Please try refreshing the page. If the problem persists, report a bug
          with the error details above.
        </p>
        <button
          type="button"
          class="mt-4 rounded bg-blue-700 px-3 py-2 text-sm text-white hover:bg-blue-600"
          onClick={() => openFeedbackPage("bug")}
        >
          Report a Bug
        </button>
      </div>
    </div>
  );
}
