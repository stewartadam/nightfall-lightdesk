// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  createSignal,
  ErrorBoundary,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { getLogger } from "../../../lib/logger";
import AppProviders from "./app-providers";
import { initializeApplicationRuntime, initializePreline } from "./app-runtime";
import InteractiveAppError from "./interactive-app-error";
import AppShell from "./shell-layout";

const log = getLogger(import.meta.url);

type InteractiveAppProps = {
  /** Called after runtime setup finishes and the shell has had a paint opportunity. */
  onReady: () => void;
};

/** Owns full-shell runtime setup after the minimal startup app has completed. */
export default function InteractiveApp(props: InteractiveAppProps) {
  const [runtimeReady, setRuntimeReady] = createSignal(false);
  const [runtimeError, setRuntimeError] = createSignal<unknown>(null);
  let cleanupApplicationRuntime: (() => void) | undefined;
  let readyAnimationFrame: number | undefined;

  /** Performs synchronous runtime startup before revealing the app shell. */
  onMount(() => {
    log.trace("mounting");
    try {
      cleanupApplicationRuntime = initializeApplicationRuntime();
    } catch (error) {
      log.error("Initialization error:", error);
      setRuntimeError(error);
      readyAnimationFrame = window.requestAnimationFrame(props.onReady);
      return;
    }

    setRuntimeReady(true);
    readyAnimationFrame = window.requestAnimationFrame(() => {
      initializePreline();
      props.onReady();
    });
  });

  onCleanup(() => {
    log.trace("unmounting");
    if (readyAnimationFrame !== undefined) {
      window.cancelAnimationFrame(readyAnimationFrame);
    }
    cleanupApplicationRuntime?.();
  });

  return (
    <Show
      when={runtimeReady()}
      fallback={
        <Show when={runtimeError()}>
          {(error) => <InteractiveAppError error={error()} />}
        </Show>
      }
    >
      <ErrorBoundary
        fallback={(error) => <InteractiveAppError error={error} />}
      >
        <AppProviders>
          <AppShell />
        </AppProviders>
      </ErrorBoundary>
    </Show>
  );
}
