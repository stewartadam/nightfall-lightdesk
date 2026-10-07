// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import {
  connectionStatus,
  EngineRuntimeStatus,
  engineRuntime,
  getWebSocketUrl,
} from "../../../lib/engine-runtime";
import { getLogger } from "../../../lib/logger";
import {
  $pairingPromptOpen,
  fetchPairingStatus,
  submitPairingPin,
  takePinFromLocation,
} from "../../../lib/pairing";
import {
  configuredEngineRuntime,
  isEmbeddedDemoRuntime,
} from "../../../lib/runtime-config";
import { isTauriRuntime } from "../../../lib/tauri";
import { PairingPrompt, pairingErrorMessage } from "../../overlays/pairing";

const log = getLogger(import.meta.url);

/**
 * Returns whether this page might reach the backend from another device and
 * so may need to pair. The desktop shell and the embedded demo never do.
 */
function mayNeedPairing(): boolean {
  return !isTauriRuntime() && !isEmbeddedDemoRuntime();
}

/**
 * Connects the application shell to its configured engine runtime, asking for
 * the pairing PIN first when the page runs on another device.
 */
export default function EngineConnection() {
  const prompting = useStore($pairingPromptOpen);
  /** Opens or closes the PIN prompt, which also hides the connection overlay. */
  const setPrompting = (open: boolean) => $pairingPromptOpen.set(open);
  const [linkError, setLinkError] = createSignal<string | null>(null);
  let disposed = false;
  let checking = false;
  // Pages on the operator's own computer never pair, so they skip the re-check.
  let pairingRequired = true;

  /** Starts the engine runtime against the resolved websocket endpoint. */
  const connect = () => {
    log.debug("Connecting to engine...");
    engineRuntime.start(configuredEngineRuntime(getWebSocketUrl()));
  };

  /**
   * Returns whether this device may connect, pairing first with a PIN carried
   * in the page link when it has one. Throws when the backend is unreachable.
   */
  const ensurePaired = async (linkPin: string | null): Promise<boolean> => {
    const status = await fetchPairingStatus();
    pairingRequired = status.required;
    if (status.paired) return true;
    if (linkPin === null) return false;
    const result = await submitPairingPin(linkPin);
    if (result.kind === "paired") return true;
    setLinkError(pairingErrorMessage(result));
    return false;
  };

  /**
   * Connects once this device is paired, or opens the PIN prompt. An
   * unreachable backend connects anyway so the runtime's reconnect loop and
   * the connection overlay take over; the disconnect check below catches a
   * pairing requirement once the backend answers.
   */
  const pairThenConnect = async () => {
    const linkPin = takePinFromLocation();
    if (!mayNeedPairing()) {
      connect();
      return;
    }
    checking = true;
    try {
      const paired = await ensurePaired(linkPin);
      if (disposed) return;
      if (paired) connect();
      else setPrompting(true);
    } catch (error) {
      log.warn("Could not check pairing status; connecting anyway", error);
      if (!disposed) connect();
    } finally {
      checking = false;
    }
  };

  /**
   * Re-checks pairing whenever the connection drops, since a regenerated PIN
   * or an app restart signs this device out and every reconnect would then be
   * refused. Stops the runtime and asks for the PIN instead of retrying.
   */
  createEffect(
    on(
      connectionStatus,
      (status) => {
        if (
          status !== EngineRuntimeStatus.Disconnected ||
          prompting() ||
          checking ||
          !pairingRequired ||
          !mayNeedPairing()
        ) {
          return;
        }
        checking = true;
        fetchPairingStatus()
          .then((pairing) => {
            if (disposed || pairing.paired || prompting()) return;
            log.info("This device is no longer paired; asking for the PIN");
            engineRuntime.stop();
            setPrompting(true);
          })
          .catch(() => {
            // The backend is still unreachable; the runtime keeps reconnecting.
          })
          .finally(() => {
            checking = false;
          });
      },
      { defer: true },
    ),
  );

  onMount(() => {
    log.trace("mounting");
    void pairThenConnect();
  });

  onCleanup(() => {
    log.trace("unmounting");
    log.debug("Disconnecting from engine...");
    disposed = true;
    engineRuntime.stop();
  });

  return (
    <PairingPrompt
      isOpen={prompting()}
      initialError={linkError()}
      onPaired={() => {
        setPrompting(false);
        setLinkError(null);
        connect();
      }}
    />
  );
}
