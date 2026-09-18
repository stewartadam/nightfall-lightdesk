// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { Checkbox, NativeSelect } from "../../components/ui/form-controls";
import { AccentPicker } from "../../components/ui/visual-language/accent-picker";
import { TabAlignmentSelect } from "../../components/ui/visual-language/tab-alignment-select";
import {
  appearanceSettings,
  type ReducedMotionPreference,
  setAppearanceSetting,
} from "../../state/appearance";

/** Edits persistent UI appearance and previews each change throughout the application. */
export function AppearanceSettings() {
  const appearance = useStore(appearanceSettings);
  return (
    <section class="space-y-6" aria-label="Appearance preferences">
      <AccentPicker
        value={appearance().accent}
        onChange={(accent) => setAppearanceSetting("accent", accent.value)}
      />
      <label class="flex items-center justify-between gap-3 text-sm text-gray-300">
        <span>Table gridlines</span>
        <Checkbox
          checked={appearance().gridlines}
          onChange={(event) =>
            setAppearanceSetting("gridlines", event.currentTarget.checked)
          }
        />
      </label>
      <label class="block">
        <span class="flex items-center justify-between gap-3 text-sm text-gray-300">
          <span>Mute accents in unfocused panels</span>
          <Checkbox
            checked={appearance().muteUnfocusedAccents}
            onChange={(event) =>
              setAppearanceSetting(
                "muteUnfocusedAccents",
                event.currentTarget.checked,
              )
            }
          />
        </span>
      </label>
      <label class="block">
        <span class="text-sm text-gray-300">Panel tab position</span>
        <NativeSelect
          value={appearance().tabPosition}
          onChange={(event) =>
            setAppearanceSetting(
              "tabPosition",
              event.currentTarget.value === "bottom" ? "bottom" : "top",
            )
          }
          class="mt-1"
        >
          <option value="top">Top</option>
          <option value="bottom">Bottom</option>
        </NativeSelect>
      </label>
      <TabAlignmentSelect
        value={appearance().tabAlignment}
        onChange={(alignment) =>
          setAppearanceSetting("tabAlignment", alignment)
        }
      />
      <label class="block">
        <span class="text-sm text-gray-300">Reduced motion</span>
        <NativeSelect
          value={appearance().reducedMotion}
          aria-label="Reduced motion"
          onChange={(event) =>
            setAppearanceSetting(
              "reducedMotion",
              event.currentTarget.value as ReducedMotionPreference,
            )
          }
          class="mt-1"
          aria-describedby="reduced-motion-help"
        >
          <option value="auto">Auto</option>
          <option value="on">On</option>
          <option value="off">Off</option>
        </NativeSelect>
      </label>
      <p id="reduced-motion-help" class="text-xs text-gray-500">
        Auto follows your system preference. On reduces animations; Off allows
        them.
      </p>
      <p class="text-xs text-gray-500">
        Appearance changes apply immediately and are saved on this device.
      </p>
    </section>
  );
}
