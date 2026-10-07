// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ArrowsClockwiseIcon } from "@squidlab/phosphor-solid/arrows-clockwise";
import { createResource, createSignal, Show } from "solid-js";
import { Button } from "../../../components/ui/visual-language/button";
import { getLogger } from "../../../lib/logger";
import {
  fetchPairingPin,
  formatPairingPin,
  regeneratePairingPin,
} from "../../../lib/pairing";

const log = getLogger(import.meta.url);

/**
 * Shows the PIN other devices enter to pair, with an action that replaces it
 * and signs every paired device out. Renders nothing on a paired device,
 * since only the computer running Nightfall may read the PIN.
 */
export function RemotePairingPin() {
  /** Loads the PIN, resolving to null where the backend refuses to show it. */
  const [pin, { mutate }] = createResource(async () => {
    try {
      return await fetchPairingPin();
    } catch (error) {
      log.debug("Pairing PIN is not readable from this device", error);
      return null;
    }
  });
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  /** Replaces the PIN; devices paired with the old one must pair again. */
  const regenerate = async () => {
    setBusy(true);
    setError(null);
    try {
      mutate(await regeneratePairingPin());
    } catch (failure) {
      log.warn("Failed to regenerate the pairing PIN", failure);
      setError("Could not create a new PIN.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Show when={pin()}>
      {(current) => (
        <div class="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-400">
          <span>Pairing PIN</span>
          <span
            class="font-mono text-sm tracking-widest text-gray-100"
            data-testid="remote-pairing-pin"
          >
            {formatPairingPin(current())}
          </span>
          <Button
            size="compact"
            type="button"
            class="items-center gap-1.5"
            title="Create a new PIN and sign out every paired device"
            disabled={busy()}
            onClick={() => void regenerate()}
          >
            <ArrowsClockwiseIcon class="size-4" aria-hidden />
            <span>New PIN</span>
          </Button>
          <Show when={error()}>
            {(message) => (
              <span class="text-red-300" role="alert">
                {message()}
              </span>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}
