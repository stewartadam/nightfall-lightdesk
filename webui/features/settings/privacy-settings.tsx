// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createMemo, For, Show } from "solid-js";
import { ToggleSwitch } from "../../components/ui/toggle-switch";
import { Button } from "../../components/ui/visual-language/button";
import { writeClipboardText } from "../../lib/clipboard";
import { engineRuntime } from "../../lib/engine-runtime";
import { setStoreAction } from "../../lib/nanostore-action";
import { pushToast } from "../../state/notifications";
import { $telemetryState } from "../../state/settings";
import type { TelemetryConsent } from "../../types";

/** Public privacy policy describing what Nightfall shares and where it goes. */
export const PRIVACY_POLICY_URL = "https://nightfall.live/privacy";

/** Contact address for privacy questions and data deletion requests. */
export const PRIVACY_CONTACT_EMAIL = "hello@nightfall.live";

/** What usage statistics contain, shown so operators can judge them before agreeing. */
const USAGE_CONTENTS = [
  "App version and operating system information",
  "Basic hardware information like your CPU, GPU and memory",
  "Make and model of library fixtures in your patch (custom fixtures names are not recorded)",
  "How many of each object type your show contains",
  "Input/output transports in use, and make and model of hardware nodes",
  "Your Install ID, and a random session ID that changes each time Nightfall starts",
  "Approximate location (country, region, and city) estimated from your IP address. The IP address itself is not stored.",
];

/** What an error report contains. */
const ERROR_CONTENTS = [
  "Error with stack trace, along with warnings logged shortly before the error",
  "App version and operating system information",
  "Computer model and processor architecture",
  "Your Install ID, and a random session ID that changes each time Nightfall starts",
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

/** Edits host-scoped telemetry consent and explains exactly what each report contains. */
export function PrivacySettings() {
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
  /**
   * Replaces the Install ID so future reports cannot be linked to past ones. The old ID is
   * copied to the clipboard first, since it is needed to request deletion of data sent under
   * it and nothing links it to the new one. If copying fails, the old ID is shown in a
   * notification that stays until dismissed.
   */
  const resetInstallId = async () => {
    const previousId = state().install_id;
    try {
      await writeClipboardText(previousId);
      pushToast("success", `Copied previous Install ID ${previousId}`);
    } catch {
      pushToast(
        "warning",
        `Could not copy the previous Install ID. Keep a note of it to request deletion of data sent under it: ${previousId}`,
        0,
      );
    }
    engineRuntime.sendCommand({
      module: "SettingsCommand",
      command: { type: "ResetTelemetryInstallId" },
    });
  };

  return (
    <Show
      when={state().available}
      fallback={
        <p class="text-sm text-gray-400">
          Anonymous reports are not available in this version of Nightfall.
        </p>
      }
    >
      <p class="text-xs text-gray-400">
        The Nightfall app can automatically share two kinds of data to help fix
        errors and prioritize feature development: error reports and usage
        statistics. Each has its own switch, and both can be changed at any
        time.
      </p>
      <p class="text-xs text-gray-400">
        These choices are saved on this computer, independently of your
        showfile. See the{" "}
        <a
          class="text-blue-300 underline"
          href={PRIVACY_POLICY_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          Nightfall privacy policy
        </a>{" "}
        for where data is stored and how long it is kept.
      </p>
      <section aria-label="Usage statistics">
        <h3 class="text-sm font-medium text-gray-300 mb-2">Usage statistics</h3>
        <p class="mt-2 text-xs text-gray-400">
          A snapshot of how Nightfall is set up, used to decide what to build
          next.
        </p>
        <ToggleSwitch
          label="Share usage statistics"
          ariaLabel="Share usage statistics"
          checked={shown().share_usage}
          onChange={(share_usage) => change({ share_usage })}
          class="mt-6 mb-3"
        />
        <p class="mt-2 text-xs text-gray-400">Includes information such as:</p>
        <ul class="mt-2 list-disc space-y-1 pl-5 text-xs text-gray-400">
          <For each={USAGE_CONTENTS}>{(item) => <li>{item}</li>}</For>
        </ul>
      </section>
      <section aria-label="Error reports">
        <h3 class="text-sm font-medium text-gray-300 mb-2">Error reports</h3>
        <p class="mt-2 text-xs text-gray-400">
          Sent when something goes wrong, so bugs can be found and fixed.
          Turning error reports off also deletes any reports still waiting to be
          sent.
        </p>
        <ToggleSwitch
          label="Share error reports"
          ariaLabel="Share error reports"
          checked={shown().share_errors}
          onChange={(share_errors) => change({ share_errors })}
          class="mt-6 mb-3"
        />
        <p class="mt-2 text-xs text-gray-400">Includes information such as:</p>
        <ul class="mt-2 list-disc space-y-1 pl-5 text-xs text-gray-400">
          <For each={ERROR_CONTENTS}>{(item) => <li>{item}</li>}</For>
        </ul>
      </section>
      <section aria-label="Install ID">
        <h3 class="text-sm font-medium text-gray-300 mb-2">Install ID</h3>
        <p class="text-xs text-gray-400">
          A random ID created for this Nightfall installation. It is used only
          to group reports sent from here and is not tied to you as a person.
        </p>
        <div class="mt-2 flex items-center justify-between gap-3">
          <code
            class="truncate text-xs text-gray-300"
            data-testid="telemetry-install-id"
          >
            {state().install_id}
          </code>
          <Button size="compact" onClick={resetInstallId}>
            Reset ID
          </Button>
        </div>
        <p class="mt-2 text-xs text-gray-400">
          If you reset your Install ID, you may wish to keep a record of the
          prior ID. Nothing links the old and new IDs, so data sent under the
          old ID can only be deleted if you include it in your request.
        </p>
      </section>
      <Show when={state().error}>
        {(error) => (
          <p class="text-xs text-red-300" role="alert">
            {error()}
          </p>
        )}
      </Show>
    </Show>
  );
}
