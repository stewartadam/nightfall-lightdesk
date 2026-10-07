// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal, Show } from "solid-js";
import { getLogger } from "../../../lib/logger";
import { type PairingResult, submitPairingPin } from "../../../lib/pairing";
import { Dialog, DialogBody, DialogFooter } from "../../ui/dialog";
import { Input } from "../../ui/form-controls";
import { Button } from "../../ui/visual-language/button";

const log = getLogger(import.meta.url);

/** Number of digits in a pairing PIN. */
const PIN_LENGTH = 6;

interface PairingPromptProps {
  /** Whether the device is waiting for the PIN. */
  isOpen: boolean;
  /** Message carried over from an automatic attempt, such as a stale shared link. */
  initialError?: string | null;
  /** Called once the backend accepts the PIN and has stored this device's token. */
  onPaired: () => void;
}

/** Converts a rejected attempt into the message shown under the PIN field. */
export function pairingErrorMessage(result: PairingResult): string | null {
  switch (result.kind) {
    case "paired":
      return null;
    case "incorrect":
      return "That PIN is incorrect.";
    case "rate-limited":
      return `Too many incorrect PINs. Try again in ${result.retryAfterSeconds} s.`;
    case "failed":
      return result.message || "Pairing failed.";
  }
}

/**
 * Asks a device on the network for the pairing PIN before it may control the
 * show. The operator reads the PIN from External control on the computer
 * running Nightfall.
 */
export function PairingPrompt(props: PairingPromptProps) {
  const [pin, setPin] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  /** Shows the latest attempt's error, or the one handed over by the caller. */
  const visibleError = () => error() ?? props.initialError ?? null;

  /** Submits the PIN once all digits are present and reports the outcome. */
  const submit = async () => {
    if (busy() || pin().length !== PIN_LENGTH) return;
    setBusy(true);
    try {
      const result = await submitPairingPin(pin());
      if (result.kind === "paired") {
        setPin("");
        setError(null);
        props.onPaired();
        return;
      }
      setError(pairingErrorMessage(result));
      setPin("");
    } catch (failure) {
      log.warn("Pairing request failed", failure);
      setError("Could not reach Nightfall. Check the connection and retry.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      kind="required"
      isOpen={props.isOpen}
      title="Pair this device"
      onSubmit={() => void submit()}
      busy={busy()}
      class="max-w-sm"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <DialogBody class="space-y-3 text-sm text-neutral-300">
          <p>
            Enter the PIN shown under External control in I/O Transports on the
            computer running Nightfall.
          </p>
          <Input
            autofocus
            aria-label="Pairing PIN"
            class="w-full text-center font-mono text-lg tracking-[0.4em]"
            inputMode="numeric"
            autocomplete="one-time-code"
            pattern="[0-9 ]*"
            placeholder="000000"
            value={pin()}
            disabled={busy()}
            onInput={(event) => {
              // Digits are kept after stripping, so a pasted "123 456" keeps all six.
              setPin(
                event.currentTarget.value
                  .replace(/\D/g, "")
                  .slice(0, PIN_LENGTH),
              );
              event.currentTarget.value = pin();
            }}
          />
          <Show when={visibleError()}>
            {(message) => (
              <p class="text-xs text-red-300" role="alert">
                {message()}
              </p>
            )}
          </Show>
        </DialogBody>
        <DialogFooter>
          <Button
            size="compact"
            variant="primary"
            type="submit"
            disabled={busy() || pin().length !== PIN_LENGTH}
          >
            Pair
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
