// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { JSX } from "solid-js";
import { sendTap } from "../controllers/tempo-controller";
import "./tempo.css";

interface TempoTapButtonProps {
  /** Extra classes that size the pad for its surface. */
  class?: string;
  /** What the pad shows; a plain "Tap" when omitted. */
  children?: JSX.Element;
}

/**
 * A tap tempo pad. It registers on pointer down rather than on click, so the tap
 * lands on the attack of the press, and Enter or Space taps from the keyboard
 * without auto-repeat adding stray taps.
 */
export function TempoTapButton(props: TempoTapButtonProps) {
  return (
    <button
      type="button"
      class={`nf-tempo-tap-pad ${props.class ?? ""}`}
      aria-label="Tap tempo"
      data-testid="tempo-tap"
      onPointerDown={(event) => {
        if (event.button === 0) sendTap(event);
      }}
      onKeyDown={(event) => {
        if (event.repeat) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          sendTap(event);
        }
      }}
    >
      {props.children ?? "Tap"}
    </button>
  );
}
