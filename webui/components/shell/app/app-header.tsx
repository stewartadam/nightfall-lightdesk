// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { FileIcon } from "@squidlab/phosphor-solid/file";
import { MagnifyingGlassIcon } from "@squidlab/phosphor-solid/magnifying-glass";
import { useShowfileObjectPalette } from "../../../features/showfile";
import { openWelcomeGuide } from "../../../features/welcome-guide/state";
import { isEmbeddedDemoRuntime } from "../../../lib/runtime-config";
import { useCommandPalette } from "../../providers/command-registry";
import { ToolbarSeparator } from "../../ui/panel-toolbar";
import Tooltip from "../../ui/tooltip";
import { Button } from "../../ui/visual-language/button";
import HeaderCommandLine from "../header/command-line";
import LayoutSwitcher from "../header/layout-switcher";
import HeaderNotificationHistory from "../header/notification-history";

/** Renders the global navigation header and command entry affordances. */
export default function AppHeader() {
  const { showPalette: openCommandPalette } = useCommandPalette();
  const { showPalette: openObjectPalette } = useShowfileObjectPalette();

  return (
    <header class="nf-app-header z-50 flex w-full shrink-0 px-4 py-2.5 text-sm">
      <nav
        class="grid min-w-0 w-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3"
        aria-label="Global"
      >
        <div class="min-w-0">
          <HeaderCommandLine />
        </div>
        <div class="flex items-center gap-2 text-sm font-semibold">
          <img
            src={`${import.meta.env.BASE_URL}logo.svg`}
            alt="logo"
            class="h-8 w-8 rounded"
          />
          <span>
            {isEmbeddedDemoRuntime() ? "nightfall demo" : "nightfall"}
          </span>
        </div>
        <div class="contents min-w-0 items-center justify-end gap-2 xl:flex">
          <div class="col-span-3 row-start-2 min-w-0 xl:contents">
            <LayoutSwitcher />
          </div>
          <div class="col-start-3 row-start-1 flex shrink-0 flex-row items-center justify-end gap-2">
            <ToolbarSeparator />
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
            <Button
              size="compact"
              onClick={openWelcomeGuide}
              aria-label="Open Welcome Guide"
            >
              Guide
            </Button>
          </div>
        </div>
      </nav>
    </header>
  );
}
