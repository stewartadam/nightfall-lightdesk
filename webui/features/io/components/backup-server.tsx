// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createSignal, Match, Show, Switch } from "solid-js";
import { Alert } from "../../../components/ui/alert";
import { Badge, type BadgeTone } from "../../../components/ui/badge";
import { Checkbox, Input } from "../../../components/ui/form-controls";
import { Button } from "../../../components/ui/visual-language/button";
import DeleteConfirmModal from "../../../components/widgets/delete-confirm-dialog";
import { commandClient } from "../../../lib/engine-commands";
import { documentationPageUrl } from "../../../lib/feedback";
import { getLogger } from "../../../lib/logger";
import { $backupState } from "../../../state/settings";
import {
  type BackupCommand,
  BackupLinkStatus,
  type BackupPeer,
  BackupPeerState,
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

/** Formats a Unix time in milliseconds as a local time of day. */
function timeOfDay(ms: number): string {
  return new Date(ms).toLocaleTimeString();
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
        message="This Nightfall stops following the primary and outputs the copied show at the show's own priority. A primary that can still reach this computer steps down and becomes its backup."
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

/** Describes how this primary's backup is doing, in a few words after its address. */
function describeBackupPeer(peer: BackupPeer): string {
  const since = peer.last_seen_ms ? timeOfDay(peer.last_seen_ms) : undefined;
  switch (peer.state) {
    case BackupPeerState.InStep:
      return "in step";
    case BackupPeerState.NotInStep:
      return since ? `not in step since ${since}` : "not in step yet";
    case BackupPeerState.Unreachable:
      return since ? `unreachable since ${since}` : "unreachable";
    case BackupPeerState.AlsoPrimary:
      return "also sending as a primary";
    default:
      return "checking";
  }
}

/** Badge tone for how this primary's backup is doing. */
function peerTone(state: BackupPeerState): BadgeTone {
  switch (state) {
    case BackupPeerState.InStep:
      return "success";
    case BackupPeerState.AlsoPrimary:
      return "danger";
    case BackupPeerState.Checking:
      return "neutral";
    default:
      return "warning";
  }
}

/** Badge tone for how the link to the primary stands. */
function linkTone(link: BackupLinkStatus): BadgeTone {
  switch (link) {
    case BackupLinkStatus.Synced:
      return "success";
    case BackupLinkStatus.PairingRequired:
    case BackupLinkStatus.Unreachable:
      return "warning";
    default:
      return "info";
  }
}

/**
 * Names this computer's role and how its partner is doing on one line: a backup and its link to
 * the primary, a primary and its backup's health, or a computer running on its own.
 */
function BackupRoleStatus() {
  const state = useStore($backupState);
  /** Says when this computer last took over on its own, after its role line. */
  const tookOverNotice = () => (
    <Show when={state().took_over_automatically_at_ms}>
      {(at) => (
        <span data-testid="backup-took-over-automatically">
          {" "}
          Took over automatically at {timeOfDay(at())}.
        </span>
      )}
    </Show>
  );
  return (
    <div
      class="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-gray-300"
      data-testid="backup-role"
    >
      <Switch
        fallback={
          <p class="flex flex-wrap items-center gap-2">
            <Badge uppercase>Standalone</Badge>
            <span>
              Not backed up.
              {tookOverNotice()}
            </span>
          </p>
        }
      >
        <Match when={state().primary_address}>
          {(primary) => (
            <>
              <p
                class="flex flex-wrap items-center gap-2"
                data-testid="backup-link-status"
              >
                <Badge tone={linkTone(state().link)} uppercase>
                  Backup
                </Badge>
                <span>
                  Following {primary()}: {describeBackupLink(state())}.
                </span>
              </p>
              <TakeOverButton />
            </>
          )}
        </Match>
        <Match when={state().backup}>
          {(backup) => (
            <p
              class="flex flex-wrap items-center gap-2"
              data-testid="backup-peer"
            >
              <Badge tone={peerTone(backup().state)} uppercase>
                Primary
              </Badge>
              <span>
                Backed up by {backup().address}: {describeBackupPeer(backup())}.
                {tookOverNotice()}
              </span>
            </p>
          )}
        </Match>
      </Switch>
    </div>
  );
}

/** Configures which primary this host follows as a backup, with the role, its partner's health and errors. */
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
        <BackupRoleStatus />
        <Show when={state().backup?.state === BackupPeerState.AlsoPrimary}>
          <Alert
            variant="caution"
            density="compact"
            class="mt-2"
            role="alert"
            data-testid="backup-both-primary"
          >
            Both computers are sending output. On the one that should stop,
            follow the other as its primary.
          </Alert>
        </Show>
        <Show
          when={
            state().primary_address &&
            state().link === BackupLinkStatus.PairingRequired
          }
        >
          <form
            class="mt-2 flex flex-wrap items-end gap-2"
            onSubmit={(event) => follow(event, state().primary_address ?? "")}
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
        <Show when={state().error}>
          {(error) => (
            <Alert
              variant="caution"
              density="compact"
              class="mt-2"
              role="alert"
            >
              {error()}
            </Alert>
          )}
        </Show>
        <div class="mt-3 flex flex-col gap-2 border-t border-gray-800 pt-3">
          <Show when={!state().primary_address}>
            <form
              class="flex flex-wrap items-end gap-2"
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
          </Show>
          <label class="flex items-start gap-2 text-xs text-gray-300">
            <Checkbox
              checked={state().auto_take_over}
              onChange={(event) => {
                const box = event.currentTarget;
                // Show what the engine applied, which a failed command leaves unchanged.
                void sendBackupCommand({
                  type: "SetAutoTakeOver",
                  data: { enabled: box.checked },
                }).then(() => {
                  box.checked = state().auto_take_over;
                });
              }}
              data-testid="backup-auto-take-over"
            />
            <span>
              Take over automatically when the primary stops answering for 3
              seconds, unless its sACN still arrives here
            </span>
          </label>
          <p class="text-xs text-gray-400">
            A backup follows another Nightfall's live show without sending over
            it, ready to take over. The primary needs external control on.{" "}
            <a
              href={documentationPageUrl(
                "user-guide/panels/io-transports.html#backup-server",
              )}
              target="_blank"
              rel="noopener noreferrer"
              class="underline"
            >
              How backups work
            </a>
          </p>
        </div>
      </section>
    </Show>
  );
}
