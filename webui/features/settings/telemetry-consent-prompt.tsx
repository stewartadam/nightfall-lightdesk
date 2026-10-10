// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createEffect } from "solid-js";
import { useAppShell } from "../../components/providers/app-shell";
import { pushToast } from "../../state/notifications";
import { $telemetryState } from "../../state/settings";
import { setTelemetryConsent } from "./privacy-settings";
import { requestSettingsTab } from "./settings-tab-request";

/**
 * Asks once per page load whether this computer may send anonymous reports. Nothing is shared
 * until the operator answers: the notice has no close button and stays until they pick OK,
 * which shares both kinds of reports, or make a choice in Settings > Privacy, which Customize
 * opens.
 */
export function TelemetryConsentPrompt() {
  const state = useStore($telemetryState);
  const { openSettings } = useAppShell();
  let prompted = false;
  let closeNotice: (() => void) | undefined;

  /**
   * Shows the notice the first time the host reports an unanswered choice, and withdraws it
   * once a choice is recorded, whether from the notice, Settings, or another device.
   */
  createEffect(() => {
    const current = state();
    if (current.consent.decided) {
      closeNotice?.();
      closeNotice = undefined;
      return;
    }
    if (prompted || !current.available) return;
    prompted = true;
    closeNotice = pushToast(
      "info",
      "Nightfall can send anonymous usage and error reports to help fix problems and decide what to build next.",
      0,
      [
        {
          label: "OK",
          onClick: () => {
            if ($telemetryState.get().consent.decided) return;
            setTelemetryConsent({ share_usage: true, share_errors: true });
          },
        },
        {
          label: "Customize",
          dismissOnClick: false,
          onClick: () => {
            requestSettingsTab("privacy");
            openSettings();
          },
        },
      ],
      { title: "Help improve Nightfall", closable: false },
    );
  });

  return null;
}
