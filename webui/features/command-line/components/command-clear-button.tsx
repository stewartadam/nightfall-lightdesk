// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { EraserIcon } from "@squidlab/phosphor-solid/eraser";
import { Button } from "../../../components/ui/visual-language/button";

interface CommandClearButtonProps {
  variant: "panel" | "nav";
  onClear: () => void;
}

/** Renders the shared programmer action and preserves command-input focus when clicked. */
export const CommandClearButton = (props: CommandClearButtonProps) => {
  return (
    <Button
      size="icon"
      type="button"
      class="shrink-0"
      style={{ height: "auto" }}
      aria-label="Clear programmer"
      title="Clear programmer (Shift+Esc)"
      data-command-programmer-clear
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => props.onClear()}
    >
      <EraserIcon class="size-4" aria-hidden />
    </Button>
  );
};
