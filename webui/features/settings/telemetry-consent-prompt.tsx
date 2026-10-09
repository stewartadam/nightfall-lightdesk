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
import type { TelemetryConsent } from "../../types";
import { setTelemetryConsent } from "./privacy-settings";
import { requestSettingsTab } from "./settings-tab-request";

/**
 * Asks once per page load whether this computer may send anonymous reports, until the
 * operator answers. Closing the notification without choosing asks again next launch.
 */
export function TelemetryConsentPrompt() {
  const state = useStore($telemetryState);
  const { openSettings } = useAppShell();
  let prompted = false;
  /** Applies a prompt answer unless someone already answered, possibly on another device. */
  const answer = (
    consent: Pick<TelemetryConsent, "share_usage" | "share_errors">,
  ) => {
    if ($telemetryState.get().consent.decided) return;
    setTelemetryConsent(consent);
  };

  /** Shows the persistent prompt the first time the host reports an unanswered choice. */
  createEffect(() => {
    const current = state();
    if (prompted || !current.available || current.consent.decided) return;
    prompted = true;
    pushToast(
      "info",
      "Share anonymous usage and error reports to help improve Nightfall? You can change this anytime in Settings.",
      0,
      [
        {
          label: "Share",
          onClick: () => answer({ share_usage: true, share_errors: true }),
        },
        {
          label: "Don't share",
          onClick: () => answer({ share_usage: false, share_errors: false }),
        },
        {
          label: "Details",
          onClick: () => {
            requestSettingsTab("privacy");
            openSettings();
          },
        },
      ],
      { title: "Help improve Nightfall" },
    );
  });

  return null;
}
