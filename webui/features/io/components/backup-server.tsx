// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import {
  createEffect,
  createSignal,
  type JSX,
  Match,
  onCleanup,
  Show,
  Switch,
  untrack,
} from "solid-js";
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
import { backendAppState } from "../../../lib/engine-runtime";
import { documentationPageUrl } from "../../../lib/feedback";
import { getLogger } from "../../../lib/logger";
import { $backupState } from "../../../state/settings";
import {
  AppState,
  type BackupCommand,
  BackupLinkStatus,
  type BackupPeer,
  BackupPeerState,
  type BackupState,
} from "../../../types";

const log = getLogger(import.meta.url);

/** Longest wait for the failover show to open before startup asks which show to open. */
const FAILOVER_SHOW_OPEN_TIMEOUT_MS = 120_000;

/** Appends the last measured round trip to a status, while the other computer answers. */
function withLatency(status: string, latencyMs?: number | null): string {
  return latencyMs == null ? status : `${status}, ${latencyMs} ms latency`;
}

/** Describes the link to the primary in a few words, with its latency while it answers. */
export function describeBackupLink(state: BackupState): string {
  switch (state.link) {
    case BackupLinkStatus.Connecting:
      return "connecting";
    case BackupLinkStatus.WaitingForShow:
      return withLatency("waiting for a show", state.latency_ms);
    case BackupLinkStatus.Loading:
      return withLatency("loading the show", state.latency_ms);
    case BackupLinkStatus.Synced:
      return withLatency("synchronized", state.latency_ms);
    case BackupLinkStatus.PairingRequired:
      return "needs its PIN";
    case BackupLinkStatus.Unreachable:
      return "unreachable, holding the last copied show";
    default:
      return "not connected";
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
        message="This Nightfall instance will stop following the primary and send the copied show at the show's own priority. If the primary is still running, or comes back, it is asked to step down and becomes this instance's backup."
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
 * Asks before leaving the backup pair, since following the other computer again then needs its
 * PIN, and a backup closes the copied show and returns to the welcome screen.
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
        title="Leave the pair"
        message={
          state().primary_address
            ? `This Nightfall instance will unpair from ${partner()}, close the copied show without sending it, and return to the welcome screen. Pairing the two again needs a PIN.`
            : `This Nightfall instance will unpair from ${partner()} and keep sending its show, with no backup. ${partner()} closes its copy of the show and returns to the welcome screen. Pairing the two again needs a PIN.`
        }
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
            off on this instance, and its sACN runs one priority below the
            primary.
          </span>
          <span class="flex gap-2">
            <LeavePairButton />
            <TakeOverButton />
          </span>
        </div>
      )}
    </Show>
  );
}

/** Describes how this primary's backup is doing, with its latency while it answers. */
function describeBackupPeer(peer: BackupPeer): string {
  const since = peer.last_seen_ms ? timeOfDay(peer.last_seen_ms) : undefined;
  switch (peer.state) {
    case BackupPeerState.InStep:
      return withLatency("synchronized", peer.latency_ms);
    case BackupPeerState.NotInStep:
      return withLatency(
        since ? `pending sync since ${since}` : "pending sync",
        peer.latency_ms,
      );
    case BackupPeerState.Unreachable:
      return since ? `unreachable since ${since}` : "unreachable";
    case BackupPeerState.AlsoPrimary:
      return withLatency("also sending as primary", peer.latency_ms);
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

/** One row of the pair: a role badge, then this machine or the other computer and its status. */
function RoleRow(props: {
  label: string;
  tone: BadgeTone;
  testId: string;
  children: JSX.Element;
}) {
  return (
    <>
      <Badge tone={props.tone} uppercase class="justify-self-start">
        {props.label}
      </Badge>
      <span data-testid={props.testId}>{props.children}</span>
    </>
  );
}

/**
 * Lists both computers of the pair, one row per role, with this machine named as such and the
 * other computer's address, sync state and latency; or this machine alone when it runs on its
 * own. Shared by the Failover settings and the startup dialog.
 */
function PairRoleRows() {
  const state = useStore($backupState);
  /** Says when this computer last took over on its own, after its row. */
  const tookOverNotice = () => (
    <Show when={state().took_over_automatically_at_ms}>
      {(at) => (
        <span data-testid="backup-took-over-automatically">
          {", "}
          took over automatically at {timeOfDay(at())}
        </span>
      )}
    </Show>
  );
  return (
    <div
      class="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-2 gap-y-1"
      data-testid="backup-role"
    >
      <Switch
        fallback={
          <RoleRow
            label="Standalone"
            tone="neutral"
            testId="backup-this-machine"
          >
            this machine, not paired{tookOverNotice()}
          </RoleRow>
        }
      >
        <Match when={state().primary_address}>
          {(primary) => (
            <>
              <RoleRow
                label="Primary"
                tone={linkTone(state().link)}
                testId="backup-link-status"
              >
                {primary()}: {describeBackupLink(state())}
              </RoleRow>
              <RoleRow
                label="Backup"
                tone="neutral"
                testId="backup-this-machine"
              >
                this machine
              </RoleRow>
            </>
          )}
        </Match>
        <Match when={state().backup}>
          {(backup) => (
            <>
              <RoleRow
                label="Primary"
                tone="neutral"
                testId="backup-this-machine"
              >
                this machine{tookOverNotice()}
              </RoleRow>
              <RoleRow
                label="Backup"
                tone={peerTone(backup().state)}
                testId="backup-peer"
              >
                {backup().address}: {describeBackupPeer(backup())}
              </RoleRow>
            </>
          )}
        </Match>
      </Switch>
    </div>
  );
}

/** The actions for this computer's role: leave the pair, or take over as its backup. */
function PairActions() {
  const state = useStore($backupState);
  return (
    <Show when={state().primary_address || state().backup}>
      <span class="flex gap-2">
        <LeavePairButton />
        <Show when={state().primary_address}>
          <TakeOverButton />
        </Show>
      </span>
    </Show>
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
            "user-guide/panels/io-transports.html#failover",
          )}
          target="_blank"
          rel="noopener noreferrer"
          class="underline"
        >
          How failover works
        </a>
      </p>
    </div>
  );
}

/**
 * The Showfiles dialog's section for following a primary: the follow form, or, while this
 * computer is a backup, its link. Opening a show from the dialog ends the role.
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
            <div class="text-xs text-gray-300">
              <p class="flex flex-wrap items-center gap-2">
                <Badge tone={linkTone(state().link)} uppercase>
                  Backup
                </Badge>
                <span>
                  Following {primary()}: {describeBackupLink(state())}. Opening
                  a show stops following.
                </span>
              </p>
            </div>
          )}
        </Show>
      </section>
    </Show>
  );
}

/** Link to the user guide's failover section. */
function FailoverGuideLink() {
  return (
    <a
      href={documentationPageUrl(
        "user-guide/panels/io-transports.html#failover",
      )}
      target="_blank"
      rel="noopener noreferrer"
      class="underline"
    >
      How failover works
    </a>
  );
}

/**
 * Turns automatic takeover on or off. The setting belongs to this computer, so a primary keeps it
 * for whenever it becomes a backup; it is only offered while this computer is one.
 */
function AutoTakeOverCheckbox() {
  const state = useStore($backupState);
  return (
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
        Take over automatically when the primary stops answering for 3 seconds,
        unless its sACN still arrives here
      </span>
    </label>
  );
}

/** Shows both computers of the pair, the actions for this computer's role, and its settings. */
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
        aria-label="Failover"
        data-testid="backup-server-settings"
      >
        <h4 class="text-xs font-semibold text-gray-200">Failover</h4>
        <div class="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-gray-300">
          <PairRoleRows />
          <PairActions />
        </div>
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
          <Show when={state().primary_address}>
            <AutoTakeOverCheckbox />
          </Show>
          <p class="text-xs text-gray-400">
            <Show when={!state().primary_address && !state().backup}>
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
            </Show>
            <FailoverGuideLink />
          </p>
        </div>
      </section>
    </Show>
  );
}

/**
 * Startup dialog for a computer in a failover pair, shown instead of the showfile prompt. Both
 * computers are listed with their roles. A backup opens once it holds the primary's show, or
 * takes over or leaves the pair. A primary continues as primary, follows its backup when that
 * one took over and should keep the show, or leaves the pair. The view follows the role, so a
 * primary that steps down for its backup switches to the backup's view on its own.
 */
export function BackupPairStartupDialog(props: {
  open: boolean;
  onContinueAsPrimary: () => void;
}) {
  const state = useStore($backupState);
  const [openingFailoverShow, setOpeningFailoverShow] = createSignal(false);
  /** Follows this primary's backup with the key the two share, so no PIN is needed. */
  const followBackup = (address: string) => {
    void sendBackupCommand({
      type: "FollowPrimary",
      data: { address, pin: undefined },
    });
  };
  /**
   * Continues as primary. When this instance last ran the pair's show, it opens that show from
   * the failover folder and the dialog closes once it is open; otherwise, or when the show can
   * no longer be opened, startup goes on to the usual show prompt.
   */
  const continueAsPrimary = async () => {
    if (!state().failover_show) {
      props.onContinueAsPrimary();
      return;
    }
    setOpeningFailoverShow(true);
    const opened = await sendBackupCommand({ type: "OpenFailoverShow" });
    if (!opened) {
      giveUpOpeningFailoverShow();
      return;
    }
    clearTimeout(openTimer);
    openTimer = setTimeout(
      giveUpOpeningFailoverShow,
      FAILOVER_SHOW_OPEN_TIMEOUT_MS,
    );
  };
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let sawShowLoading = false;
  onCleanup(() => clearTimeout(openTimer));
  /** Goes on to the usual show prompt when the failover show could not be opened. */
  const giveUpOpeningFailoverShow = () => {
    clearTimeout(openTimer);
    sawShowLoading = false;
    if (!untrack(openingFailoverShow)) return;
    setOpeningFailoverShow(false);
    if (untrack(() => props.open)) props.onContinueAsPrimary();
  };
  /**
   * Notices a failover show load that fails: the backend starts loading, then returns to having
   * no show open.
   */
  createEffect(() => {
    if (!openingFailoverShow()) return;
    const appState = backendAppState();
    if (appState === AppState.ShowLoading) sawShowLoading = true;
    else if (sawShowLoading && appState === AppState.Initialized) {
      giveUpOpeningFailoverShow();
    }
  });
  /** Ends the wait once the dialog closes, as when the show opened. */
  createEffect(() => {
    if (!props.open) {
      clearTimeout(openTimer);
      setOpeningFailoverShow(false);
    }
  });
  /** Continues as primary from Enter, but only in the primary's view. */
  const submitDefault = () => {
    if (!state().primary_address && state().backup && !openingFailoverShow()) {
      void continueAsPrimary();
    }
  };
  return (
    <Dialog
      kind="required"
      isOpen={props.open}
      title="Failover"
      onSubmit={submitDefault}
      class="max-w-[560px]"
    >
      <DialogBody
        class="space-y-3 text-sm text-neutral-300"
        data-testid="backup-pair-startup"
      >
        <PairRoleRows />
        <p class="text-xs text-neutral-400">
          <Switch>
            <Match when={state().primary_address}>
              This instance opens once it holds the primary's show, and sends no
              output until it takes over.
            </Match>
            <Match when={state().backup}>
              {(backup) => (
                <>
                  <Show
                    when={state().failover_show}
                    fallback={"Continue as primary to open a show, "}
                  >
                    {(show) => (
                      <>
                        Continue as primary to open{" "}
                        <strong class="text-neutral-200">
                          {show().name ?? "default"}
                        </strong>
                        , the pair's show this instance ran last,{" "}
                      </>
                    )}
                  </Show>
                  which {backup().address} then follows. If {backup().address}{" "}
                  took over and should keep the show, follow it instead.
                </>
              )}
            </Match>
          </Switch>
        </p>
        <Show when={state().primary_address}>
          <AutoTakeOverCheckbox />
        </Show>
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
                    disabled={openingFailoverShow()}
                    onClick={() => void continueAsPrimary()}
                    data-testid="backup-pair-startup-continue"
                  >
                    {openingFailoverShow()
                      ? "Opening the show…"
                      : "Continue as primary"}
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
