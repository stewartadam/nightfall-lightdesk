// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { NativeSelect } from "../../components/ui/form-controls";
import { SettingsRow, SettingsSection } from "../../components/ui/settings-row";
import { ToggleSwitch } from "../../components/ui/toggle-switch";
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
    <SettingsSection footer="Appearance changes apply immediately and are saved on this device.">
      <div class="pb-3">
        <AccentPicker
          value={appearance().accent}
          onChange={(accent) => setAppearanceSetting("accent", accent.value)}
        />
      </div>
      <SettingsRow
        label="Table gridlines"
        description="Draws lines between the rows and columns of tables."
      >
        {(field) => (
          <ToggleSwitch
            id={field.id}
            describedBy={field.describedBy}
            ariaLabel="Table gridlines"
            layout="switch-only"
            checked={appearance().gridlines}
            onChange={(enabled) => setAppearanceSetting("gridlines", enabled)}
          />
        )}
      </SettingsRow>
      <SettingsRow
        label="Mute accents in unfocused panels"
        description="Shows panels you are not working in with a grey accent, so the focused one stands out."
      >
        {(field) => (
          <ToggleSwitch
            id={field.id}
            describedBy={field.describedBy}
            ariaLabel="Mute accents in unfocused panels"
            layout="switch-only"
            checked={appearance().muteUnfocusedAccents}
            onChange={(enabled) =>
              setAppearanceSetting("muteUnfocusedAccents", enabled)
            }
          />
        )}
      </SettingsRow>
      <SettingsRow
        label="Panel tab position"
        description="Shows panel tabs above or below their content."
      >
        {(field) => (
          <NativeSelect
            id={field.id}
            aria-describedby={field.describedBy}
            value={appearance().tabPosition}
            onChange={(event) =>
              setAppearanceSetting(
                "tabPosition",
                event.currentTarget.value === "bottom" ? "bottom" : "top",
              )
            }
          >
            <option value="top">Top</option>
            <option value="bottom">Bottom</option>
          </NativeSelect>
        )}
      </SettingsRow>
      <SettingsRow
        label="Tab alignment"
        description="Places tabs along each panel group's tab strip. Justify fills the strip."
      >
        {(field) => (
          <TabAlignmentSelect
            id={field.id}
            describedBy={field.describedBy}
            value={appearance().tabAlignment}
            onChange={(alignment) =>
              setAppearanceSetting("tabAlignment", alignment)
            }
          />
        )}
      </SettingsRow>
      <SettingsRow
        label="Reduced motion"
        description="Auto follows your system preference. On reduces animations; Off allows them."
      >
        {(field) => (
          <NativeSelect
            id={field.id}
            aria-describedby={field.describedBy}
            value={appearance().reducedMotion}
            onChange={(event) =>
              setAppearanceSetting(
                "reducedMotion",
                event.currentTarget.value as ReducedMotionPreference,
              )
            }
          >
            <option value="auto">Auto</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </NativeSelect>
        )}
      </SettingsRow>
    </SettingsSection>
  );
}
