// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import "./lib/idle-callback";
import { useStore } from "@nanostores/solid";
import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { render } from "solid-js/web";
import DiagnosticsRuntime from "./components/shell/runtime/diagnostics";
import EngineConnection from "./components/shell/runtime/engine-connection";
import { StartupController, StartupOverlaps } from "./components/shell/startup";
import NewShowfileNameModal from "./features/showfile/dialogs/new-showfile-name";
import { APP_NAME, APP_TITLE } from "./lib/app-metadata";
import { backendAppState } from "./lib/engine-runtime";
import {
  initFeatureFlags,
  isStartupDraftRecoveryEnabled,
} from "./lib/feature-flags";
import { isEmbeddedDemoRuntime } from "./lib/runtime-config";
import { appLifecycle } from "./state/app-lifecycle";
import "./state/reduced-motion";
import { appearanceSettings } from "./state/appearance";
import * as types from "./types";

import "./index.css";
import "./components/shell/app/shell.css";
import "./components/widgets/crud/crud-cards.css";

type InteractiveAppModule =
  typeof import("./components/shell/app/interactive-app");

let interactiveAppModule: Promise<InteractiveAppModule> | undefined;

/** Loads the heavy interactive shell chunk once and shares it with Solid lazy. */
function loadInteractiveApp(): Promise<InteractiveAppModule> {
  interactiveAppModule ??= import("./components/shell/app/interactive-app");
  return interactiveAppModule;
}

// Initialize URL-backed runtime settings before app components read them.
initFeatureFlags();
document.title = isEmbeddedDemoRuntime() ? APP_NAME : APP_TITLE;

type InteractiveShellMountProps = {
  active: boolean;
  onReady: () => void;
};

/** Owns the interactive shell in a stable nested Solid root once startup allows it. */
function InteractiveShellMount(props: InteractiveShellMountProps) {
  const [mounted, setMounted] = createSignal(false);
  let mountRef: HTMLDivElement | undefined;
  let disposeInteractiveShell: (() => void) | undefined;
  let disposed = false;

  /** Latches the interactive shell mount so later parent reconciliation cannot move it. */
  createEffect(() => {
    if (!props.active || mounted() || !mountRef) {
      return;
    }

    setMounted(true);
    void loadInteractiveApp().then((module) => {
      if (disposed || !mountRef) {
        return;
      }

      const LoadedInteractiveApp = module.default;
      disposeInteractiveShell = render(
        () => <LoadedInteractiveApp onReady={props.onReady} />,
        mountRef,
      );
    });
  });

  onCleanup(() => {
    disposed = true;
    disposeInteractiveShell?.();
  });

  return (
    <div
      ref={mountRef}
      class={props.active ? "contents" : "hidden"}
      data-interactive-shell-root="true"
    />
  );
}

/** Renders the minimal startup app before loading the full interactive shell. */
function App() {
  const appearance = useStore(appearanceSettings);

  /** Applies local appearance to startup, panels, and overlays mounted on the document body. */
  createEffect(() => {
    document.documentElement.style.setProperty("--accent", appearance().accent);
    document.body.dataset.tabAlignment = appearance().tabAlignment;
    document.body.dataset.muteUnfocusedAccents = String(
      appearance().muteUnfocusedAccents,
    );
    document.documentElement.style.setProperty(
      "--data-grid-column-border",
      appearance().gridlines ? "#ffffff18" : "transparent",
    );
  });
  const lifecycle = useStore(appLifecycle);
  const [interactiveShellReady, setInteractiveShellReady] = createSignal(false);
  let preloadAnimationFrame: number | undefined;

  /** Resets shell readiness if startup returns to a non-interactive phase. */
  createEffect(() => {
    if (lifecycle().phase !== "interactive") {
      setInteractiveShellReady(false);
    }
  });

  /** Keeps the startup splash visible while the interactive shell chunk loads. */
  const holdStartupSplash = () =>
    lifecycle().phase === "interactive" &&
    backendAppState() !== types.AppState.Ready &&
    !interactiveShellReady();

  /** Starts loading the interactive shell after the first startup paint. */
  onMount(() => {
    preloadAnimationFrame = window.requestAnimationFrame(() => {
      void loadInteractiveApp();
    });
  });

  onCleanup(() => {
    if (preloadAnimationFrame !== undefined) {
      window.cancelAnimationFrame(preloadAnimationFrame);
    }
  });

  return (
    <div class="contents" data-app-root="true">
      <EngineConnection />
      <DiagnosticsRuntime />
      <StartupController
        enabled={isStartupDraftRecoveryEnabled() && !isEmbeddedDemoRuntime()}
        bypassShowfilePrompt={isEmbeddedDemoRuntime()}
      />
      <InteractiveShellMount
        active={lifecycle().phase === "interactive"}
        onReady={() => setInteractiveShellReady(true)}
      />
      <div class="contents" data-startup-overlay-root="true">
        <StartupOverlaps hold={holdStartupSplash()} />
      </div>
      <NewShowfileNameModal />
    </div>
  );
}

const appRoot = document.getElementById("app")!;
appRoot.replaceChildren();
render(() => <App />, appRoot);
