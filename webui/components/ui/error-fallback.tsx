// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ArrowClockwiseIcon } from "@squidlab/phosphor-solid/arrow-clockwise";
import { type JSX, Show } from "solid-js";
import { Alert } from "./alert";
import { Button } from "./visual-language/button";

export interface ErrorFallbackProps {
  /** The value the error boundary caught; usually an `Error`, but anything can be thrown. */
  error: unknown;
  /** Heading naming what failed, such as "Flow editor failed". */
  title?: JSX.Element;
  /** Optional explanation or guidance shown above the error message. */
  description?: JSX.Element;
  /** Resets the surrounding error boundary; adds a primary Retry button when provided. */
  reset?: () => void;
  /** Extra actions placed after Retry, such as a Report Bug button or a help link. */
  actions?: JSX.Element;
  /** Hides the stack trace disclosure for failures whose stack would not help the user. */
  hideDetails?: boolean;
  /** Extra classes for the outer container that centers the alert in the panel. */
  class?: string;
}

/** Headline for a caught value: `Name: message` for errors, the string form of anything else. */
function errorHeadline(error: unknown): string {
  if (error instanceof Error) {
    return error.message ? `${error.name}: ${error.message}` : error.name;
  }
  return String(error);
}

/** Stack trace of a caught error, when the runtime recorded one. */
function errorStack(error: unknown): string | undefined {
  return error instanceof Error && error.stack ? error.stack : undefined;
}

/**
 * Renders the fallback for a panel-level `ErrorBoundary`: a caution alert with
 * a title, optional description, the error's message, its stack behind a
 * "Technical details" disclosure, and a Retry button plus any extra actions.
 * It fills its container and centers the alert.
 *
 * This component deliberately depends only on Solid and the `Alert` and
 * `Button` primitives, with no stores, logger, runtime or bridge imports, so
 * it can still render when the rest of the application has failed. Callers
 * log the error themselves.
 */
export function ErrorFallback(props: ErrorFallbackProps) {
  return (
    <div
      class={`flex h-full w-full items-center justify-center overflow-auto p-4 ${props.class ?? ""}`}
      data-component="ErrorFallback"
    >
      <Alert
        variant="caution"
        role="alert"
        transition="none"
        title={props.title ?? "Something went wrong"}
        class="w-full max-w-xl"
      >
        <Show when={props.description}>
          <div class="flex flex-col gap-1 text-neutral-300">
            {props.description}
          </div>
        </Show>
        <p class="font-mono text-xs [overflow-wrap:anywhere]">
          {errorHeadline(props.error)}
        </p>
        <Show when={!props.hideDetails && errorStack(props.error)}>
          {(stack) => (
            <details class="w-full text-xs text-neutral-400">
              <summary class="cursor-pointer">Technical details</summary>
              <pre class="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded border border-neutral-700 bg-neutral-950 p-2 font-mono [overflow-wrap:anywhere]">
                {stack()}
              </pre>
            </details>
          )}
        </Show>
        <Show when={props.reset || props.actions}>
          <div class="flex flex-wrap items-center gap-2">
            <Show when={props.reset}>
              {(reset) => (
                <Button
                  size="compact"
                  variant="primary"
                  onClick={() => reset()()}
                >
                  <ArrowClockwiseIcon class="size-3.5" aria-hidden />
                  <span>Retry</span>
                </Button>
              )}
            </Show>
            {props.actions}
          </div>
        </Show>
      </Alert>
    </div>
  );
}
