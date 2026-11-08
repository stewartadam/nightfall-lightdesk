// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createSignal, Show } from "solid-js";
import { Input } from "../../../components/ui/form-controls";
import { Button } from "../../../components/ui/visual-language/button";
import DeleteConfirmModal from "../../../components/widgets/delete-confirm-dialog";
import { commandClient } from "../../../lib/engine-commands";
import { getLogger } from "../../../lib/logger";
import { $backupState } from "../../../state/settings";
import {
  type BackupCommand,
  BackupLinkStatus,
  type BackupState,
} from "../../../types";

const log = getLogger(import.meta.url);

/** Describes the link to the primary in a few words for the banner and settings. */
export function describeBackupLink(state: BackupState): string {
  switch (state.link) {
    case BackupLinkStatus.Connecting:
      return "Connecting to the primary";
    case BackupLinkStatus.Loading:
      return "Loading the primary's show";
    case BackupLinkStatus.Synced:
      return state.showfile_name
        ? `In step with the primary's show "${state.showfile_name}"`
        : "In step with the primary's default show";
    case BackupLinkStatus.PairingRequired:
      return "The primary needs its pairing PIN again";
    case BackupLinkStatus.Unreachable:
      return "Primary unreachable; holding the last copied show";
    default:
      return "Not connected";
  }
}

/**
 * Sends a backup role command and resolves whether the engine applied it. A transport failure is
 * logged; command errors toast on their own.
 */
function sendBackupCommand(command: BackupCommand): Promise<boolean> {
  return commandClient
    .invoke("BackupCommand", command)
    .then((result) => result.outcome.type !== "Failed")
    .catch((error: unknown) => {
      log.warn("Could not send backup command", error);
      return false;
    });
}

/**
 * Asks before taking over, since a primary that is still running would then transmit at the
 * same sACN priority as this host.
 */
function TakeOverButton(props: { size?: "compact" | "inline" }) {
  const [confirming, setConfirming] = createSignal(false);
  return (
    <>
      <Button
        size={props.size ?? "compact"}
        variant="primary"
        type="button"
        data-testid="backup-take-over"
        onClick={() => setConfirming(true)}
      >
        Take over
      </Button>
      <DeleteConfirmModal
        isOpen={confirming()}
        title="Take over output"
        message="This Nightfall stops following the primary and outputs the copied show at the show's own priority. Take over only when the primary has stopped, or both will send the same universes."
        confirmLabel="Take over"
        focusCancel
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          void sendBackupCommand({ type: "TakeOver" });
        }}
      />
    </>
  );
}

/** Tells every client of a backup that it only follows the primary, and offers takeover. */
export function BackupBanner() {
  const state = useStore($backupState);
  return (
    <Show when={state().primary_address}>
      {(address) => (
        <div
          class="flex flex-wrap items-center justify-between gap-3 border-b border-sky-500/40 bg-sky-500/10 px-4 py-1.5 text-xs text-sky-100"
          role="status"
          data-testid="backup-banner"
        >
          <span>
            Backup of {address()}: {describeBackupLink(state())}. Changes are
            off here and sACN runs one priority below the primary.
          </span>
          <TakeOverButton />
        </div>
      )}
    </Show>
  );
}

/** Configures which primary this host follows as a backup, with the link's state and errors. */
export function BackupServerSettings() {
  const state = useStore($backupState);
  const [address, setAddress] = createSignal("");
  const [pin, setPin] = createSignal("");
  /** Follows `primary`, pairing with the typed PIN when one was entered. */
  const follow = (event: SubmitEvent, primary: string) => {
    event.preventDefault();
    void sendBackupCommand({
      type: "FollowPrimary",
      data: { address: primary, pin: pin().trim() || undefined },
    }).then((applied) => {
      if (applied) setPin("");
    });
  };
  /** Renders the PIN field shared by the first pairing and pairing again. */
  const pinField = () => (
    <label class="flex flex-col gap-1 text-xs text-gray-400">
      Pairing PIN
      <Input
        density="compact"
        inputmode="numeric"
        autocomplete="off"
        class="w-24"
        value={pin()}
        onInput={(event) => setPin(event.currentTarget.value)}
        data-testid="backup-primary-pin"
      />
    </label>
  );

  return (
    <Show when={state().available}>
      <section
        class="border-b border-gray-800 p-3"
        aria-label="Backup server"
        data-testid="backup-server-settings"
      >
        <h4 class="text-xs font-semibold text-gray-200">Backup server</h4>
        <Show
          when={state().primary_address}
          fallback={
            <form
              class="mt-2 flex flex-wrap items-end gap-2"
              onSubmit={(event) => follow(event, address())}
            >
              <label class="flex flex-col gap-1 text-xs text-gray-400">
                Primary address
                <Input
                  density="compact"
                  placeholder="192.168.1.20:3000"
                  value={address()}
                  onInput={(event) => setAddress(event.currentTarget.value)}
                  data-testid="backup-primary-address"
                />
              </label>
              {pinField()}
              <Button
                size="compact"
                type="submit"
                disabled={!address().trim()}
                data-testid="backup-follow"
              >
                Follow primary
              </Button>
            </form>
          }
        >
          {(primary) => (
            <>
              <div class="mt-2 flex flex-wrap items-center justify-between gap-3">
                <p
                  class="text-xs text-gray-300"
                  data-testid="backup-link-status"
                >
                  Following {primary()}: {describeBackupLink(state())}.
                </p>
                <TakeOverButton />
              </div>
              <Show when={state().link === BackupLinkStatus.PairingRequired}>
                <form
                  class="mt-2 flex flex-wrap items-end gap-2"
                  onSubmit={(event) => follow(event, primary())}
                >
                  {pinField()}
                  <Button
                    size="compact"
                    type="submit"
                    disabled={!pin().trim()}
                    data-testid="backup-pair-again"
                  >
                    Pair again
                  </Button>
                </form>
              </Show>
            </>
          )}
        </Show>
        <p class="mt-2 text-xs text-gray-400">
          A backup keeps a copy of another Nightfall's live show. It sends sACN
          one priority below the show's so receivers follow the primary, mutes
          Art-Net and USB DMX, and turns off changes on this computer. The
          primary needs external control on. Saved on this computer.
        </p>
        <Show when={state().error}>
          {(error) => (
            <p class="mt-2 text-xs text-red-300" role="alert">
              {error()}
            </p>
          )}
        </Show>
      </section>
    </Show>
  );
}
