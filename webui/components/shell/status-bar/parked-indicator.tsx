// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { LockIcon } from "@squidlab/phosphor-solid/lock";
import { Show } from "solid-js";
import { showParkedFixtures } from "../../../features/fixtures";
import { parkedParameters } from "../../../state/appStores";
import { useAppShell } from "../../providers/app-shell";
import { ToolbarButton } from "../../ui/toolbar-button";

/**
 * Status-bar reminder that parameters are parked, since a parked value overrides playback and is
 * easy to forget. Clicking it opens Fixtures filtered to the parked parameters.
 */
export function ParkedIndicator() {
  const shell = useAppShell();
  const $parked = useStore(parkedParameters);

  return (
    <Show when={$parked().length > 0}>
      <ToolbarButton
        size="labeled"
        data-testid="status-parked-indicator"
        label={`${$parked().length} parked`}
        tooltip="Show parked parameters in Fixtures"
        class="text-orange-300"
        onClick={() => showParkedFixtures(shell.dockviewApi())}
      >
        <LockIcon class="size-3.5" aria-hidden />
        <span>{`${$parked().length} parked`}</span>
      </ToolbarButton>
    </Show>
  );
}
