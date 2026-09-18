// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  defaultAccent,
  visualLanguageAccents,
} from "../components/ui/visual-language/accents";
import {
  normalizeTabAlignment,
  type TabAlignment,
} from "../components/ui/visual-language/tab-alignment-select";
import { bestEffortPersistentAtom } from "../lib/best-effort-persistent-atom";
import { getLogger } from "../lib/logger";
import { setStoreAction } from "../lib/nanostore-action";

export type ReducedMotionPreference = "auto" | "on" | "off";

export interface AppearanceSettings {
  reducedMotion: ReducedMotionPreference;
  accent: (typeof visualLanguageAccents)[number]["value"];
  gridlines: boolean;
  muteUnfocusedAccents: boolean;
  tabPosition: "top" | "bottom";
  tabAlignment: TabAlignment;
}

const DEFAULT_APPEARANCE: AppearanceSettings = {
  reducedMotion: "auto",
  accent: defaultAccent.value,
  gridlines: false,
  muteUnfocusedAccents: false,
  tabPosition: "top",
  tabAlignment: "justify",
};
const log = getLogger(import.meta.url);

/** Restores supported appearance choices while defaulting malformed or missing fields. */
function decodeAppearance(value: string): AppearanceSettings {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return DEFAULT_APPEARANCE;
    const settings = parsed as Partial<AppearanceSettings>;
    return {
      reducedMotion:
        settings.reducedMotion === "on" || settings.reducedMotion === "off"
          ? settings.reducedMotion
          : "auto",
      accent:
        visualLanguageAccents.find((accent) => accent.value === settings.accent)
          ?.value ?? DEFAULT_APPEARANCE.accent,
      gridlines:
        typeof settings.gridlines === "boolean"
          ? settings.gridlines
          : DEFAULT_APPEARANCE.gridlines,
      tabPosition: settings.tabPosition === "bottom" ? "bottom" : "top",
      muteUnfocusedAccents: settings.muteUnfocusedAccents === true,
      tabAlignment: normalizeTabAlignment(settings.tabAlignment),
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

/** Browser-local appearance preferences, independent of the current showfile. */
export const appearanceSettings = bestEffortPersistentAtom<AppearanceSettings>(
  "nightfall-appearance",
  DEFAULT_APPEARANCE,
  {
    decode: decodeAppearance,
    encode: JSON.stringify,
    onSetError: (error) =>
      log.warn("Could not save appearance preferences", error),
  },
);

/** Changes one preference without overwriting the other current appearance choices. */
export function setAppearanceSetting<Key extends keyof AppearanceSettings>(
  key: Key,
  value: AppearanceSettings[Key],
): void {
  setStoreAction(appearanceSettings, "Set Appearance", {
    ...appearanceSettings.get(),
    [key]: value,
  });
}
