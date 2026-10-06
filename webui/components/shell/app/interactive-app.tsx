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
import { reportFatalError } from "../../../lib/uncaught-error-reporter";
import AppProviders from "./app-providers";
import { initializeApplicationRuntime, initializePreline } from "./app-runtime";
import AppShell from "./shell-layout";

const log = getLogger(import.meta.url);

type InteractiveAppProps = {
  /** Called after runtime setup finishes and the shell has had a paint opportunity. */
  onReady: () => void;
};

/** Reports a shell render failure once, leaving the fatal error dialog to explain it. */
function ReportShellFailure(props: { error: unknown }) {
  onMount(() => reportFatalError("workspace", props.error));
  return null;
}

/** Owns full-shell runtime setup after the minimal startup app has completed. */
export default function InteractiveApp(props: InteractiveAppProps) {
  const [runtimeReady, setRuntimeReady] = createSignal(false);
  let cleanupApplicationRuntime: (() => void) | undefined;
  let readyAnimationFrame: number | undefined;

  /** Performs synchronous runtime startup before revealing the app shell. */
  onMount(() => {
    log.trace("mounting");
    try {
      cleanupApplicationRuntime = initializeApplicationRuntime();
    } catch (error) {
      reportFatalError("workspace startup", error);
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
    <Show when={runtimeReady()}>
      <ErrorBoundary fallback={(error) => <ReportShellFailure error={error} />}>
        <AppProviders>
          <AppShell />
        </AppProviders>
      </ErrorBoundary>
    </Show>
  );
}
