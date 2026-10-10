// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { ArrowCounterClockwiseIcon } from "@squidlab/phosphor-solid/arrow-counter-clockwise";
import { CaretDownIcon } from "@squidlab/phosphor-solid/caret-down";
import { FileIcon } from "@squidlab/phosphor-solid/file";
import { FileTextIcon } from "@squidlab/phosphor-solid/file-text";
import { MagnifyingGlassIcon } from "@squidlab/phosphor-solid/magnifying-glass";
import { Show } from "solid-js";
import { useShowfileObjectPalette } from "../../../features/showfile";
import { TempoControls } from "../../../features/tempo";
import { connectionStatus } from "../../../lib/engine-runtime";
import { isEmbeddedDemoRuntime } from "../../../lib/runtime-config";
import { currentShowfileName } from "../../../lib/showfile-loading";
import { compactViewport } from "../../../state/viewport";
import { useCommandPalette } from "../../providers/command-registry";
import { DropdownMenuItem } from "../../ui/dropdown-menu";
import { ToolbarSeparator } from "../../ui/panel-toolbar";
import Tooltip from "../../ui/tooltip";
import { Button } from "../../ui/visual-language/button";
import HeaderCommandLine from "../header/command-line";
import LayoutSwitcher from "../header/layout-switcher";
import HeaderNotificationHistory from "../header/notification-history";
import { resetBrowserDemo } from "../runtime/browser-demo-banner";
import AppMenu from "../status-bar/app-menu";
import { ConnectionIndicator } from "../status-bar/connection-indicator";
import UndoControls from "../status-bar/undo-controls";

/** Renders the app logo and name in the docked header. */
function HeaderBrand() {
  return (
    <div class="flex items-center gap-2 text-sm font-semibold">
      <img
        src={`${import.meta.env.BASE_URL}logo.svg`}
        alt="logo"
        class="h-8 w-8 rounded"
      />
      <span>{isEmbeddedDemoRuntime() ? "nightfall demo" : "nightfall"}</span>
    </div>
  );
}

/** Renders the palette and notification buttons shared by both header layouts. */
function HeaderActions() {
  const { showPalette: openCommandPalette } = useCommandPalette();
  const { showPalette: openObjectPalette } = useShowfileObjectPalette();

  return (
    <>
      <Tooltip content={() => "Open command palette"} position="bottom">
        <Button
          size="icon"
          type="button"
          onClick={openCommandPalette}
          aria-label="Open command palette"
        >
          <MagnifyingGlassIcon class="size-4" aria-hidden />
        </Button>
      </Tooltip>
      <Tooltip content={() => "Open object palette"} position="bottom">
        <Button
          size="icon"
          type="button"
          onClick={openObjectPalette}
          aria-label="Open object palette"
        >
          <FileIcon class="size-4" aria-hidden />
        </Button>
      </Tooltip>
      <HeaderNotificationHistory />
    </>
  );
}

/**
 * The phone header: one slim row that also carries what the status bar holds
 * on wider screens. The logo opens the application menu, which also names the
 * showfile and holds the object palette and demo reset. The connection dot
 * sits beside the logo; tempo, undo, search and notifications sit on the right.
 */
function CompactHeaderBar() {
  const { showPalette: openCommandPalette } = useCommandPalette();
  const { showPalette: openObjectPalette } = useShowfileObjectPalette();
  const showfileName = useStore(currentShowfileName);

  return (
    <nav class="flex min-w-0 w-full items-center gap-1" aria-label="Global">
      <AppMenu
        triggerLabel="Main menu"
        triggerClass="nf-compact-logo-menu"
        trigger={
          <>
            <img
              src={`${import.meta.env.BASE_URL}logo.svg`}
              alt=""
              class="size-7 rounded"
            />
            <CaretDownIcon class="size-3 text-gray-400" aria-hidden />
          </>
        }
        placement="below"
        align="start"
        leadingItems={() => (
          <>
            <DropdownMenuItem icon={FileTextIcon} disabled onClick={() => {}}>
              <span data-testid="compact-showfile-name">{showfileName()}</span>
            </DropdownMenuItem>
            <DropdownMenuItem icon={FileIcon} onClick={openObjectPalette}>
              Object Palette
            </DropdownMenuItem>
            <Show when={isEmbeddedDemoRuntime()}>
              <DropdownMenuItem
                icon={ArrowCounterClockwiseIcon}
                onClick={resetBrowserDemo}
              >
                Reset Demo
              </DropdownMenuItem>
            </Show>
          </>
        )}
      />
      <ConnectionIndicator class="nf-toolbar-slot" />
      <span class="flex-1" />
      <Show when={connectionStatus() === "connected"}>
        <TempoControls placement="below" />
        <UndoControls placement="below" />
      </Show>
      <Button
        size="icon"
        type="button"
        onClick={openCommandPalette}
        aria-label="Open command palette"
      >
        <MagnifyingGlassIcon class="size-4" aria-hidden />
      </Button>
      <HeaderNotificationHistory />
    </nav>
  );
}

/**
 * Renders the global navigation header and command entry affordances. Compact
 * screens get one slim row instead (see `CompactHeaderBar`): the command line
 * stays reachable as its own panel, and the layout switcher is left out
 * because the compact shell does not switch named layouts.
 */
export default function AppHeader() {
  const compact = useStore(compactViewport);

  return (
    <header
      class="nf-app-header z-50 flex w-full shrink-0 text-sm"
      classList={{
        "px-4 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))]": !compact(),
        "py-1 pt-[max(0.25rem,env(safe-area-inset-top))] pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.5rem,env(safe-area-inset-right))]":
          compact(),
      }}
    >
      <Show when={!compact()} fallback={<CompactHeaderBar />}>
        <nav
          class="grid min-w-0 w-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3"
          aria-label="Global"
        >
          <div class="min-w-0">
            <HeaderCommandLine />
          </div>
          <HeaderBrand />
          <div class="contents min-w-0 items-center justify-end gap-2 xl:flex">
            <div class="col-span-3 row-start-2 min-w-0 xl:contents">
              <LayoutSwitcher />
            </div>
            <div class="col-start-3 row-start-1 flex shrink-0 flex-row items-center justify-end gap-2">
              <ToolbarSeparator />
              <HeaderActions />
            </div>
          </div>
        </nav>
      </Show>
    </header>
  );
}
