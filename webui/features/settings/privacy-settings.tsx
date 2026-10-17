// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { ArrowClockwiseIcon } from "@squidlab/phosphor-solid/arrow-clockwise";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  onCleanup,
  Show,
} from "solid-js";
import { Alert } from "../../components/ui/alert";
import { SettingsRow, SettingsSection } from "../../components/ui/settings-row";
import { ToggleSwitch } from "../../components/ui/toggle-switch";
import Tooltip from "../../components/ui/tooltip";
import { Button } from "../../components/ui/visual-language/button";
import { writeClipboardText } from "../../lib/clipboard";
import {
  $desktopUpdate,
  setDesktopUpdateChecks,
} from "../../lib/desktop-updates";
import { engineRuntime } from "../../lib/engine-runtime";
import { setStoreAction } from "../../lib/nanostore-action";
import { PRIVACY_POLICY_URL } from "../../lib/privacy";
import { $telemetryState } from "../../state/settings";
import type { TelemetryConsent } from "../../types";

/** What usage statistics contain, shown so operators can judge them before agreeing. */
const USAGE_CONTENTS = [
  "App version, operating system and basic hardware information",
  "Showfile metadata, like counts of object types",
  "Make and model of patched fixtures or I/O hardware.",
];

/** How long the reset button confirms that the prior Install ID was copied (ms). */
const COPY_CONFIRMATION_MS = 2000;

/** What an error report contains. */
const ERROR_CONTENTS = [
  "The error, its stack trace and recent warnings",
  "App version, operating system, and processor information",
];

/**
 * Sends the complete consent record, marking the prompt as answered. The local store is
 * updated first so a second toggle made before the backend echoes the first one builds on
 * it instead of reverting it; the backend's broadcast then confirms or corrects the value.
 */
export function setTelemetryConsent(patch: Partial<TelemetryConsent>): void {
  const state = $telemetryState.get();
  const consent = { ...state.consent, ...patch, decided: true };
  setStoreAction($telemetryState, "Set TelemetryConsent", {
    ...state,
    consent,
  });
  engineRuntime.sendCommand({
    module: "SettingsCommand",
    command: { type: "SetTelemetryConsent", data: consent },
  });
}

/**
 * Titles a Privacy section with its switch as a settings row whose title is the section's
 * heading, with the description beneath it and the switch on the right. `details` runs full
 * width beneath, such as what a report contains.
 */
function SectionSwitch(props: {
  label: string;
  description: string;
  checked: boolean;
  details?: JSX.Element;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <SettingsRow
      heading
      label={props.label}
      description={props.description}
      details={props.details}
    >
      {(field) => (
        <ToggleSwitch
          id={field.id}
          describedBy={field.describedBy}
          ariaLabel={props.label}
          layout="switch-only"
          checked={props.checked}
          onChange={props.onChange}
        />
      )}
    </SettingsRow>
  );
}

/** Lists what a kind of report includes, beneath its switch. */
function ReportContents(props: { items: string[] }) {
  return (
    <div class="space-y-1.5 text-xs text-gray-400">
      <p>Includes information such as:</p>
      <ul class="list-disc space-y-1 pl-5">
        <For each={props.items}>{(item) => <li>{item}</li>}</For>
      </ul>
    </div>
  );
}

/** Edits host-scoped telemetry consent and explains exactly what each report contains. */
export function PrivacySettings() {
  return (
    <>
      <div class="space-y-2 text-xs text-gray-400">
        <p>
          The Nightfall app can share data to help fix errors and prioritize
          feature development. Sharing data is optional and can be disabled at
          any time.
        </p>
        <p>
          These privacy choices are saved on this computer, independently of
          your showfile.
        </p>
        <p>
          See the{" "}
          <a
            class="text-blue-300 underline"
            href={PRIVACY_POLICY_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            Nightfall privacy policy
          </a>{" "}
          for what data is captured, where it is stored, and how long it is
          kept.
        </p>
      </div>
      <SettingsSection>
        <UpdateSettings />
        <TelemetrySettings />
      </SettingsSection>
    </>
  );
}

/** Explains and edits the two kinds of anonymous reports and the Install ID. */
function TelemetrySettings() {
  const state = useStore($telemetryState);
  /**
   * Choices the switches show. Before the operator answers, they show the proposed choice of
   * sharing both, so turning one off here records the other as shared.
   */
  const shown = createMemo(() => {
    const { consent } = state();
    return consent.decided
      ? { share_usage: consent.share_usage, share_errors: consent.share_errors }
      : { share_usage: true, share_errors: true };
  });
  /** Records the full choice with one switch changed, which also answers the first-run notice. */
  const change = (patch: Partial<ReturnType<typeof shown>>) =>
    setTelemetryConsent({ ...shown(), ...patch });
  /** Counts successful copies of a prior ID; each change flashes the confirmation tooltip. */
  const [copies, setCopies] = createSignal(0);
  /**
   * Whether the reset button's tooltip shows the copy confirmation instead of its "Reset ID"
   * hint. One tooltip carries both, so the hint shown on hover or focus never overlaps the
   * confirmation the click produces.
   */
  const [confirming, setConfirming] = createSignal(false);
  let confirmTimeoutId: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(confirmTimeoutId));
  /** Shows the copy confirmation for as long as the tooltip flashes it, then the hint again. */
  const confirmCopy = () => {
    clearTimeout(confirmTimeoutId);
    setConfirming(true);
    setCopies((count) => count + 1);
    confirmTimeoutId = setTimeout(
      () => setConfirming(false),
      COPY_CONFIRMATION_MS,
    );
  };
  /** A replaced Install ID that could not be copied, shown so the operator can note it down. */
  const [uncopiedId, setUncopiedId] = createSignal<string>();
  /** The Install ID a reset was requested for, until the backend reports its replacement. */
  const [resettingId, setResettingId] = createSignal<string>();
  /**
   * Re-enables Reset ID once the backend reports an ID other than the one being replaced, or
   * reports an error, so a failed reset can be retried. On error the ID was not replaced, so
   * any "keep a note of the prior ID" prompt for it is withdrawn.
   */
  createEffect(() => {
    const current = state();
    if (current.error) {
      setResettingId(undefined);
      setUncopiedId(undefined);
    } else if (current.install_id !== resettingId()) {
      setResettingId(undefined);
    }
  });
  /**
   * Replaces the Install ID so future reports cannot be linked to past ones. The old ID is
   * copied to the clipboard, since it is needed to request deletion of data sent under it and
   * nothing links it to the new one. Success is confirmed by a brief tooltip over the button,
   * since toasts render beneath the Settings dialog; if copying fails, the old ID stays shown
   * below the Install ID row instead. The copy starts within the click, as browsers require,
   * but the reset does not wait for it, so a stalled clipboard permission prompt cannot block it.
   */
  const resetInstallId = () => {
    const previousId = state().install_id;
    if (!previousId || resettingId()) return;
    setResettingId(previousId);
    setUncopiedId(undefined);
    const copied = writeClipboardText(previousId);
    engineRuntime.sendCommand({
      module: "SettingsCommand",
      command: { type: "ResetTelemetryInstallId" },
    });
    copied.then(confirmCopy, () => setUncopiedId(previousId));
  };

  return (
    <Show
      when={state().available}
      fallback={
        <p class="py-2.5 text-sm text-gray-400">
          Sharing data is not supported in this version of Nightfall.
        </p>
      }
    >
      <section aria-label="Usage statistics">
        <SectionSwitch
          label="Share usage statistics"
          description="Information about how Nightfall is setup to help decide what to build next."
          checked={shown().share_usage}
          onChange={(share_usage) => change({ share_usage })}
          details={<ReportContents items={USAGE_CONTENTS} />}
        />
      </section>
      <section aria-label="Error reports">
        <SectionSwitch
          label="Share error reports"
          description="Send error information and logs when something goes wrong, to help find and fix bugs."
          checked={shown().share_errors}
          onChange={(share_errors) => change({ share_errors })}
          details={<ReportContents items={ERROR_CONTENTS} />}
        />
      </section>
      <section aria-label="Install ID">
        <SettingsRow
          heading
          label="Install ID"
          labelControl={false}
          description="A random ID for this Nightfall installation sent with every report. It is used only to group reports sent by Nightfall and is not tied to you as a person."
          details={
            <div class="space-y-1.5 text-xs text-gray-400">
              <Show when={uncopiedId()}>
                {(id) => (
                  <Alert variant="warning" density="compact" role="alert">
                    <p>
                      Could not copy the prior ID to the clipboard. Keep a note
                      of it:{" "}
                      <code class="select-all text-gray-100">{id()}</code>
                    </p>
                  </Alert>
                )}
              </Show>
              <p>
                Keep a record of your prior Install ID if you wish to request
                data deletion. Nothing links the old and new ID.
              </p>
            </div>
          }
        >
          {() => (
            <>
              <code
                class="truncate text-xs text-gray-300"
                data-testid="telemetry-install-id"
              >
                {state().install_id}
              </code>
              <Tooltip
                content={() =>
                  confirming() ? "✅ Prior ID copied to clipboard" : "Reset ID"
                }
                flash={copies}
                flashMs={COPY_CONFIRMATION_MS}
              >
                <Button
                  size="icon"
                  variant="subtle"
                  class="size-6!"
                  aria-label="Reset ID"
                  onClick={resetInstallId}
                  disabled={!state().install_id || resettingId() !== undefined}
                >
                  <ArrowClockwiseIcon class="size-3.5" aria-hidden />
                </Button>
              </Tooltip>
            </>
          )}
        </SettingsRow>
      </section>
      <Show when={state().error}>
        {(error) => (
          <Alert
            variant="caution"
            density="compact"
            role="alert"
            class="my-2.5"
          >
            <p>{error()}</p>
          </Alert>
        )}
      </Show>
    </Show>
  );
}

/**
 * Lets the operator turn update checks off entirely, including the check in the About dialog,
 * where update status and installs are managed. Shown in the desktop app only, since browsers
 * and other devices have nothing to update.
 */
function UpdateSettings() {
  const update = useStore($desktopUpdate);
  /** Error from the last switch change, cleared by the next attempt. */
  const [actionError, setActionError] = createSignal<string>();
  /** Saves the update check choice and shows why it failed, if it does. */
  const setChecks = (enabled: boolean) => {
    setActionError(undefined);
    setDesktopUpdateChecks(enabled).catch((error) =>
      setActionError(String(error)),
    );
  };

  return (
    <Show when={update()}>
      {(current) => (
        <section aria-label="Updates">
          <SectionSwitch
            label="Allow update checks"
            description="When enabled, Nightfall can check nightfall.live for new app versions. Choose how updates are managed in the About dialog."
            checked={current().checkForUpdates}
            onChange={setChecks}
            details={
              actionError() ? (
                <Alert variant="caution" density="compact" role="alert">
                  <p>{actionError()}</p>
                </Alert>
              ) : undefined
            }
          />
        </section>
      )}
    </Show>
  );
}
