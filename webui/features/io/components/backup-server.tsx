// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createSignal, Match, Show, Switch } from "solid-js";
import { useAppShell } from "../../../components/providers/app-shell";
import { Alert } from "../../../components/ui/alert";
import { Badge, type BadgeTone } from "../../../components/ui/badge";
import {
  Dialog,
  DialogBody,
  DialogFooter,
} from "../../../components/ui/dialog";
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
    case BackupLinkStatus.WaitingForShow:
      return "Waiting for the primary to open a show";
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
        message="This Nightfall stops following the primary and outputs the copied show at the show's own priority. If the primary is still running, or comes back, it is asked to step down and becomes this computer's backup."
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

/**
 * Asks before stopping following, since this computer then sends the copied show as its own;
 * opening a show replaces it.
 */
function StopFollowingButton(props: { size?: "compact" | "inline" }) {
  const [confirming, setConfirming] = createSignal(false);
  return (
    <>
      <Button
        size={props.size ?? "compact"}
        type="button"
        data-testid="backup-stop-following"
        onClick={() => setConfirming(true)}
      >
        Stop following
      </Button>
      <DeleteConfirmModal
        isOpen={confirming()}
        title="Stop following"
        message="This Nightfall stops following the primary and runs on its own with the copied show, sending its output. Unlike a takeover, it does not ask the primary to step down, so stop or reconfigure the primary's output first if it is still running."
        confirmLabel="Stop following"
        focusCancel
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          void sendBackupCommand({ type: "StopFollowing" });
        }}
      />
    </>
  );
}

/**
 * Asks before leaving the backup pair, since following the other computer again then needs its
 * PIN.
 */
function LeavePairButton(props: { size?: "compact" | "inline" }) {
  const state = useStore($backupState);
  const [confirming, setConfirming] = createSignal(false);
  /** Names the other computer of the pair for the confirmation. */
  const partner = () =>
    state().primary_address ?? state().backup?.address ?? "the other computer";
  return (
    <>
      <Button
        size={props.size ?? "compact"}
        type="button"
        data-testid="backup-leave-pair"
        onClick={() => setConfirming(true)}
      >
        Leave the pair
      </Button>
      <DeleteConfirmModal
        isOpen={confirming()}
        title="Leave the backup pair"
        message={`This Nightfall forgets ${partner()} and runs on its own, sending its output. Pairing the two again needs the other computer's PIN.`}
        confirmLabel="Leave the pair"
        focusCancel
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          void sendBackupCommand({ type: "LeavePair" });
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
          <span class="flex gap-2">
            <StopFollowingButton />
            <TakeOverButton />
          </span>
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
              <span class="flex gap-2">
                <StopFollowingButton />
                <TakeOverButton />
              </span>
            </>
          )}
        </Match>
        <Match when={state().backup}>
          {(backup) => (
            <>
              <p
                class="flex flex-wrap items-center gap-2"
                data-testid="backup-peer"
              >
                <Badge tone={peerTone(backup().state)} uppercase>
                  Primary
                </Badge>
                <span>
                  Backed up by {backup().address}:{" "}
                  {describeBackupPeer(backup())}.{tookOverNotice()}
                </span>
              </p>
              <LeavePairButton />
            </>
          )}
        </Match>
      </Switch>
    </div>
  );
}

/** Renders the pairing PIN field shared by following and pairing again. */
function PinField(props: { value: string; onInput: (pin: string) => void }) {
  return (
    <label class="flex flex-col gap-1 text-xs text-gray-400">
      Pairing PIN
      <Input
        density="compact"
        inputmode="numeric"
        autocomplete="off"
        class="w-24"
        value={props.value}
        onInput={(event) => props.onInput(event.currentTarget.value)}
        data-testid="backup-primary-pin"
      />
    </label>
  );
}

/**
 * Follows a primary: checks it answers and pairs with the PIN first, so a wrong address or PIN
 * leaves this computer as it was and shows why. Calls `onFollowed` once this computer follows it.
 */
export function FollowPrimaryForm(props: { onFollowed?: () => void }) {
  const state = useStore($backupState);
  const [address, setAddress] = createSignal("");
  const [pin, setPin] = createSignal("");
  /** Sends the follow command and clears the PIN once the primary accepted it. */
  const follow = (event: SubmitEvent) => {
    event.preventDefault();
    void sendBackupCommand({
      type: "FollowPrimary",
      data: {
        address: address(),
        pin: pin().trim() || undefined,
      },
    }).then((applied) => {
      if (!applied) return;
      setPin("");
      props.onFollowed?.();
    });
  };
  return (
    <div class="flex flex-col gap-2" data-testid="backup-follow-form">
      <form class="flex flex-wrap items-end gap-2" onSubmit={follow}>
        <label class="flex flex-col gap-1 text-xs text-gray-400">
          Primary address
          <Input
            density="compact"
            placeholder="192.168.1.20:3030"
            value={address()}
            onInput={(event) => setAddress(event.currentTarget.value)}
            data-testid="backup-primary-address"
          />
        </label>
        <PinField value={pin()} onInput={setPin} />
        <Button
          size="compact"
          type="submit"
          disabled={!address().trim() || !!state().checking_address}
          data-testid="backup-follow"
        >
          {state().checking_address ? "Connecting…" : "Follow primary"}
        </Button>
      </form>
      <Show when={!state().primary_address && state().error}>
        {(error) => (
          <Alert
            variant="caution"
            density="compact"
            role="alert"
            data-testid="backup-follow-error"
          >
            {error()}
          </Alert>
        )}
      </Show>
      <p class="text-xs text-gray-400">
        This computer then copies the primary's live show and follows it without
        sending output, ready to take over. The primary needs External control
        on. Opening a show stops following.{" "}
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
  );
}

/**
 * The Showfiles dialog's section for following a primary: the follow form, or, while this
 * computer is a backup, its link and a way to stop following.
 */
export function FollowPrimarySection(props: { onFollowed?: () => void }) {
  const state = useStore($backupState);
  return (
    <Show when={state().available}>
      <section
        class="mt-4 rounded border border-gray-700 p-3"
        aria-label="Follow a primary"
        data-testid="showfiles-follow-primary"
      >
        <h3 class="mb-2 text-sm font-semibold text-gray-200">
          Follow a primary
        </h3>
        <Show
          when={state().primary_address}
          fallback={<FollowPrimaryForm onFollowed={props.onFollowed} />}
        >
          {(primary) => (
            <div class="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-300">
              <p class="flex flex-wrap items-center gap-2">
                <Badge tone={linkTone(state().link)} uppercase>
                  Backup
                </Badge>
                <span>
                  Following {primary()}: {describeBackupLink(state())}. Opening
                  a show stops following.
                </span>
              </p>
              <StopFollowingButton />
            </div>
          )}
        </Show>
      </section>
    </Show>
  );
}

/** Shows this computer's backup role, its partner's health, and the automatic takeover setting. */
export function BackupServerSettings() {
  const state = useStore($backupState);
  const appShell = useAppShell();
  const [pin, setPin] = createSignal("");
  /** Pairs again with the primary this computer follows, using the typed PIN. */
  const pairAgain = (event: SubmitEvent) => {
    event.preventDefault();
    void sendBackupCommand({
      type: "FollowPrimary",
      data: {
        address: state().primary_address ?? "",
        pin: pin().trim() || undefined,
      },
    }).then((applied) => {
      if (applied) setPin("");
    });
  };

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
            Both computers are sending output. On the one that should stop, open
            the Showfiles dialog and follow the other as its primary.
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
            onSubmit={pairAgain}
          >
            <PinField value={pin()} onInput={setPin} />
            <Button
              size="compact"
              type="submit"
              disabled={!pin().trim() || !!state().checking_address}
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
            To make this computer a backup, follow a primary from the{" "}
            <button
              type="button"
              class="underline"
              onClick={() => appShell.showOpenShowfileModal()}
              data-testid="backup-open-showfiles"
            >
              Showfiles dialog
            </button>
            .{" "}
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

/**
 * Startup dialog for a computer in a backup pair, shown instead of the showfile prompt. A backup
 * sees its link to the primary and opens once it holds the primary's show, or takes over or
 * leaves the pair. A primary sees its backup and continues as primary, follows its backup when
 * that one took over and should keep the show, or leaves the pair. The view follows the role, so
 * a primary that steps down for its backup switches to the backup's view on its own.
 */
export function BackupPairStartupDialog(props: {
  open: boolean;
  onContinueAsPrimary: () => void;
}) {
  const state = useStore($backupState);
  /** Follows this primary's backup with the key the two share, so no PIN is needed. */
  const followBackup = (address: string) => {
    void sendBackupCommand({
      type: "FollowPrimary",
      data: { address, pin: undefined },
    });
  };
  /** Continues as primary from Enter, but only in the primary's view. */
  const submitDefault = () => {
    if (!state().primary_address && state().backup) props.onContinueAsPrimary();
  };
  return (
    <Dialog
      kind="required"
      isOpen={props.open}
      title="Backup server"
      onSubmit={submitDefault}
      class="max-w-[560px]"
    >
      <DialogBody
        class="space-y-3 text-sm text-neutral-300"
        data-testid="backup-pair-startup"
      >
        <Switch>
          <Match when={state().primary_address}>
            {(primary) => (
              <>
                <p
                  class="flex flex-wrap items-center gap-2"
                  data-testid="backup-pair-startup-link"
                >
                  <Badge tone={linkTone(state().link)} uppercase>
                    Backup
                  </Badge>
                  <span>
                    Following {primary()}: {describeBackupLink(state())}.
                  </span>
                </p>
                <p class="text-xs text-neutral-400">
                  This computer opens once it holds the primary's show, and
                  sends no output until it takes over. Take over to send the
                  show copied last, or leave the pair to open a show of its own.
                </p>
              </>
            )}
          </Match>
          <Match when={state().backup}>
            {(backup) => (
              <>
                <p
                  class="flex flex-wrap items-center gap-2"
                  data-testid="backup-pair-startup-peer"
                >
                  <Badge tone={peerTone(backup().state)} uppercase>
                    Primary
                  </Badge>
                  <span>
                    Backed up by {backup().address}:{" "}
                    {describeBackupPeer(backup())}.
                  </span>
                </p>
                <p class="text-xs text-neutral-400">
                  Continue as the primary to open a show, which{" "}
                  {backup().address} then follows. If {backup().address} took
                  over and should keep the show, follow it instead. Leave the
                  pair to run on your own.
                </p>
              </>
            )}
          </Match>
        </Switch>
        <Show when={state().error}>
          {(error) => (
            <Alert
              variant="caution"
              density="compact"
              role="alert"
              data-testid="backup-pair-startup-error"
            >
              {error()}
            </Alert>
          )}
        </Show>
      </DialogBody>
      <DialogFooter style={{ "justify-content": "space-between" }}>
        <LeavePairButton />
        <div class="flex items-center justify-end gap-x-2">
          <Switch>
            <Match when={state().primary_address}>
              <TakeOverButton />
            </Match>
            <Match when={state().backup}>
              {(backup) => (
                <>
                  <Button
                    size="compact"
                    type="button"
                    disabled={!!state().checking_address}
                    onClick={() => followBackup(backup().address)}
                    data-testid="backup-pair-startup-follow"
                  >
                    {state().checking_address
                      ? "Connecting…"
                      : `Follow ${backup().address}`}
                  </Button>
                  <Button
                    size="compact"
                    variant="primary"
                    type="button"
                    autofocus
                    onClick={() => props.onContinueAsPrimary()}
                    data-testid="backup-pair-startup-continue"
                  >
                    Continue as primary
                  </Button>
                </>
              )}
            </Match>
          </Switch>
        </div>
      </DialogFooter>
    </Dialog>
  );
}
