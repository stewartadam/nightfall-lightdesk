// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { For, Show } from "solid-js";
import { ToggleSwitch } from "../../components/ui/toggle-switch";
import { Button } from "../../components/ui/visual-language/button";
import { engineRuntime } from "../../lib/engine-runtime";
import { setStoreAction } from "../../lib/nanostore-action";
import { $telemetryState } from "../../state/settings";
import type { TelemetryConsent } from "../../types";

/** What a usage report contains, shown so operators can judge it before agreeing. */
const USAGE_CONTENTS = [
  "App version, operating system, and whether Nightfall runs as the desktop app or headless",
  "CPU and GPU model, core count, and memory rounded to a size bucket",
  "Make and model of library fixtures in your patch; custom fixtures only as a count",
  "How many of each object type your show contains, never their names",
  "Output and input protocols and interface models in use",
  "Frame timing, missed DMX output deadlines, startup time, and session length",
];

/** What an error report contains. */
const ERROR_CONTENTS = [
  "Error message and stack trace, with your home folder, showfile names and network addresses removed",
  "Warnings logged shortly before the error",
  "App version, operating system, processor architecture, and the anonymous ID below",
  "Reports not sent yet are deleted as soon as you stop sharing",
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
  /** Replaces the anonymous identifier so future reports cannot be linked to past ones. */
  const resetInstallId = () => {
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
      <section aria-label="Usage reports">
        <ToggleSwitch
          label="Share anonymous usage reports"
          ariaLabel="Share anonymous usage reports"
          checked={state().consent.share_usage}
          onChange={(share_usage) => setTelemetryConsent({ share_usage })}
        />
        <p class="mt-2 text-xs text-gray-400">
          Sent at most once a day. Helps decide which fixtures, hardware and
          features to support next.
        </p>
        <ul class="mt-2 list-disc space-y-1 pl-5 text-xs text-gray-400">
          <For each={USAGE_CONTENTS}>{(item) => <li>{item}</li>}</For>
        </ul>
      </section>
      <section aria-label="Error reports">
        <ToggleSwitch
          label="Share error reports"
          ariaLabel="Share error reports"
          checked={state().consent.share_errors}
          onChange={(share_errors) => setTelemetryConsent({ share_errors })}
        />
        <p class="mt-2 text-xs text-gray-400">
          Sent automatically when something goes wrong, so problems get fixed
          without you filing a report.
        </p>
        <ul class="mt-2 list-disc space-y-1 pl-5 text-xs text-gray-400">
          <For each={ERROR_CONTENTS}>{(item) => <li>{item}</li>}</For>
        </ul>
      </section>
      <section aria-label="Anonymous identifier">
        <h3 class="text-sm font-medium text-gray-300 mb-2">
          Anonymous identifier
        </h3>
        <p class="text-xs text-gray-400">
          A random ID groups reports from this computer, so monthly installs can
          be counted. It contains nothing about you. Reports are queued while
          you are offline and sent later. These choices are saved on this
          computer, independently of your showfile.
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
