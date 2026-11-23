// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type Accessor, createSignal, untrack } from "solid-js";
import { getLogger } from "./logger";
import { createEffect } from "./solid-compat";

const log = getLogger(import.meta.url);

/** Reactive view of a value computed by async work. */
export type AsyncValue<Value> = {
  /** The latest settled value, kept while a newer request runs or after a failure. */
  value: Accessor<Value>;
  /** Whether a request is in flight. */
  loading: Accessor<boolean>;
  /** The latest request's failure, cleared when the next request starts. */
  error: Accessor<unknown>;
  /** Whether the latest request settled without failing. */
  ready: Accessor<boolean>;
  /** Runs the request again for the current source. */
  refetch: () => void;
  /** Replaces the value locally, without a request. */
  set: (value: Value) => void;
};

type Source<Input> = Accessor<Input | false | null | undefined>;

/**
 * Runs `fetcher` whenever `source` changes and exposes the latest result as
 * plain signals.
 *
 * A falsy source skips the request, keeps the last value, clears `error` and
 * drops any request in flight. When requests overlap, only the newest one's
 * result or failure is kept, and `set` supersedes them all. Failures are
 * logged and exposed through `error`, never thrown into the render tree, so a
 * caller that ignores them keeps showing the last value.
 *
 * This replaces Solid 1.x's `createResource`, which Solid 2.0 removes. It
 * never suspends, so it behaves the same on both versions.
 */
export function createAsyncValue<Input, Value>(
  source: Source<Input>,
  fetcher: (input: Input) => Value | Promise<Value>,
  options: { initialValue: Value },
): AsyncValue<Value>;
export function createAsyncValue<Input, Value>(
  source: Source<Input>,
  fetcher: (input: Input) => Value | Promise<Value>,
): AsyncValue<Value | undefined>;
export function createAsyncValue<Input, Value>(
  source: Source<Input>,
  fetcher: (input: Input) => Value | Promise<Value>,
  options?: { initialValue: Value },
): AsyncValue<Value | undefined> {
  const [value, setValue] = createSignal<Value | undefined>(
    options?.initialValue,
  );
  const hasInput = (input: Input | false | null | undefined): input is Input =>
    input !== undefined && input !== null && input !== false;
  // Loading from the first frame, since the first request starts after render.
  const [loading, setLoading] = createSignal(hasInput(untrack(source)));
  const [error, setError] = createSignal<unknown>();
  const [settled, setSettled] = createSignal(false);
  const [attempt, setAttempt] = createSignal(0);
  let latestRequest = 0;

  /** Drops any request in flight and clears the loading and error state. */
  const settleWithoutRequest = () => {
    latestRequest += 1;
    setLoading(false);
    setError(undefined);
  };

  /** Starts a request for each new source value or refetch, ignoring superseded results. */
  createEffect(
    () => [source(), attempt()] as const,
    ([input]) => {
      if (!hasInput(input)) {
        settleWithoutRequest();
        return;
      }
      const request = ++latestRequest;
      setLoading(true);
      setError(undefined);
      Promise.resolve()
        .then(() => fetcher(input))
        .then(
          (next) => {
            if (request !== latestRequest) return;
            setValue(() => next);
            setSettled(true);
            setLoading(false);
          },
          (failure: unknown) => {
            if (request !== latestRequest) return;
            log.error("Async value request failed", failure);
            setError(failure ?? new Error("Async value request failed"));
            setLoading(false);
          },
        );
    },
  );

  return {
    value,
    loading,
    error,
    ready: () => settled() && !loading() && error() === undefined,
    refetch: () => setAttempt((count) => count + 1),
    set: (next) => {
      settleWithoutRequest();
      setValue(() => next);
      setSettled(true);
    },
  };
}

/** Runs `fetcher` once when created, for async values with no reactive input. */
export function createAsyncValueOnce<Value>(
  fetcher: () => Value | Promise<Value>,
): AsyncValue<Value | undefined> {
  return createAsyncValue(
    () => true,
    () => fetcher(),
  );
}
