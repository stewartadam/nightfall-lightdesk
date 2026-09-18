// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Checkbox } from "../../../components/ui/form-controls";

type FixturesPropertiesProps = {
  filterZero: boolean;
  onFilterZeroToggle: (enabled: boolean) => void;
  showReleasedOutput: boolean;
  onShowReleasedOutputToggle: (enabled: boolean) => void;
};

/** Properties panel for FixturesPanel filter */
export default function FixturesProperties(props: FixturesPropertiesProps) {
  return (
    <div class="p-4">
      <label class="inline-flex items-center">
        <Checkbox
          class="mr-2"
          checked={props.filterZero}
          onInput={(e) =>
            props.onFilterZeroToggle((e.target as HTMLInputElement).checked)
          }
        />
        Hide fixtures without asserted values
      </label>
      <br />
      <label class="mt-3 inline-flex items-center">
        <Checkbox
          class="mr-2"
          checked={props.showReleasedOutput}
          onInput={(e) =>
            props.onShowReleasedOutputToggle(
              (e.target as HTMLInputElement).checked,
            )
          }
        />
        Always show DMX values
      </label>
    </div>
  );
}
