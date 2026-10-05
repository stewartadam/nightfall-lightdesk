// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { onCleanup, onMount, Show } from "solid-js";
import { ObjectPatchWizardModal } from "../../../features/object-library";
import { PatchWizard } from "../../../features/patch";
import { ShowfileDialogs } from "../../../features/showfile";
import { compactViewport } from "../../../state/viewport";
import ConnectionOverlay from "../../overlays/connection";
import ShellOverlayHosts from "../../overlays/shell-hosts";
import { useAppShell } from "../../providers/app-shell";
import TauriMenuBridge from "../bridges/tauri-menu";
import ExportShowfileCommand from "../command-palette/commands/export-showfile-command";
import FeedbackCommands from "../command-palette/commands/feedback-commands";
import SettingsCommand from "../command-palette/commands/settings-command";
import CompactNavigation from "../compact/compact-navigation";
import { createCompactPanels } from "../compact/compact-panels";
import { bindCompactSwipe } from "../compact/compact-swipe";
import DockviewApp from "../docking/dockview/dockview-workspaces";
import LayoutCommands from "../docking/layout-commands";
import ShowfileTransitionVeil from "../docking/showfile-transition-veil";
import StatusBar from "../status-bar";
import AppHeader from "./app-header";

/** Mounts shell effects, bridges, overlays, and modal hosts outside Dockview. */
function ShellRuntime() {
  return (
    <>
      <SettingsCommand />
      <ExportShowfileCommand />
      <FeedbackCommands />
      <LayoutCommands />
      <TauriMenuBridge />
      <ConnectionOverlay />
      <ShellOverlayHosts />
      <PatchWizard />
      <ObjectPatchWizardModal />
      <ShowfileDialogs />
    </>
  );
}

/** Renders the visible docked application surface and persistent status bar. */
function DockedContent() {
  return (
    <div class="flex h-full min-h-0 w-full flex-col overflow-hidden">
      <div class="min-h-0 w-full flex-1 overflow-hidden">
        <ShowfileTransitionVeil>
          <DockviewApp />
        </ShowfileTransitionVeil>
      </div>
      <StatusBar />
    </div>
  );
}

/**
 * Renders one panel at a time for small screens, with swipe and a bottom tab
 * bar to move between panels.
 */
function CompactContent() {
  const shell = useAppShell();
  const panels = createCompactPanels(shell.dockviewApi);
  let surface: HTMLDivElement | undefined;

  /** Lets a horizontal flick on the shown panel step to its neighbor. */
  onMount(() => {
    if (!surface) return;
    onCleanup(bindCompactSwipe(surface, panels.step));
  });

  return (
    <div class="flex h-full min-h-0 w-full flex-col overflow-hidden">
      <div ref={surface} class="min-h-0 w-full flex-1 overflow-hidden">
        <ShowfileTransitionVeil>
          <DockviewApp compact />
        </ShowfileTransitionVeil>
      </div>
      <StatusBar />
      <CompactNavigation panels={panels} />
    </div>
  );
}

/**
 * Chooses the docked or compact surface for the viewport. Crossing the
 * breakpoint remounts the workspace so each mode starts from the saved
 * docked arrangement.
 */
function ShellContent() {
  const compact = useStore(compactViewport);
  return (
    <Show when={compact()} fallback={<DockedContent />}>
      <CompactContent />
    </Show>
  );
}

/** Composes the global header, runtime hosts, and docked application layout. */
export default function AppShell() {
  return (
    <div class="nf-app-shell flex h-full min-h-0 w-full flex-col overflow-hidden">
      <AppHeader />
      <div class="min-h-0 flex-1 overflow-hidden">
        <ShellRuntime />
        <ShellContent />
      </div>
    </div>
  );
}
