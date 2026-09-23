// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ObjectPatchWizardModal } from "../../../features/object-library";
import { PatchWizard } from "../../../features/patch";
import { ShowfileDialogs } from "../../../features/showfile";
import { GuideInvitation, WelcomeGuide } from "../../../features/welcome-guide";
import ConnectionOverlay from "../../overlays/connection";
import ShellOverlayHosts from "../../overlays/shell-hosts";
import TauriMenuBridge from "../bridges/tauri-menu";
import ExportShowfileCommand from "../command-palette/commands/export-showfile-command";
import FeedbackCommands from "../command-palette/commands/feedback-commands";
import SettingsCommand from "../command-palette/commands/settings-command";
import DockviewApp from "../docking/dockview/dockview-workspaces";
import LayoutCommands from "../docking/layout-commands";
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
function ShellContent() {
  return (
    <div class="flex h-full min-h-0 w-full flex-col overflow-hidden">
      <GuideInvitation />
      <div class="nf-guide-workspace flex min-h-0 w-full flex-1 overflow-hidden">
        <div class="min-h-0 min-w-0 flex-1 overflow-hidden">
          <DockviewApp />
        </div>
        <WelcomeGuide />
      </div>
      <StatusBar />
    </div>
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
