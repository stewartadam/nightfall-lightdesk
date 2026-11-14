// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { isWholeNumberInRange } from "../../../lib/number-draft";
import {
  CONSOLE_UNIVERSE_SIZE,
  type ConsolePatchPlacement,
} from "./console-patch-allocation";

/**
 * Most fixtures one run of the wizard creates. Bounds the per-fixture lists the wizard builds,
 * so a typed "1e9" can't freeze the page.
 */
export const MAX_PATCH_QUANTITY = 1000;

/** The numeric fields of the patch wizard's configure step, each as typed (null when blank). */
export interface PatchWizardNumberFields {
  quantity: number | null;
  firstFixtureId: number | null;
  universeId: number | null;
  startAddress: number | null;
}

/** Whether each typed configure-step field holds a usable value. */
export interface PatchWizardFieldValidity {
  /** A whole number of fixtures from 1 to {@link MAX_PATCH_QUANTITY}. */
  quantity: boolean;
  /** Blank (use the suggested ID) or a whole number from 1. */
  firstFixtureId: boolean;
  /** A whole universe number from 1. */
  universe: boolean;
  /** A whole channel from 1 to the universe size. */
  startAddress: boolean;
}

/**
 * Checks the configure step's typed numbers. The wizard stores what the user typed rather than
 * the last valid value, so an out-of-range entry stays visible, reports its error and blocks
 * Next instead of quietly patching at an earlier keystroke's value.
 */
export function validatePatchWizardFields(
  fields: PatchWizardNumberFields,
): PatchWizardFieldValidity {
  return {
    quantity: isWholeNumberInRange(fields.quantity, 1, MAX_PATCH_QUANTITY),
    firstFixtureId:
      fields.firstFixtureId === null ||
      isWholeNumberInRange(fields.firstFixtureId, 1),
    universe: isWholeNumberInRange(fields.universeId, 1),
    startAddress: isWholeNumberInRange(
      fields.startAddress,
      1,
      CONSOLE_UNIVERSE_SIZE,
    ),
  };
}

/** Returns the typed console start when both its universe and address are valid, else null. */
export function validConsolePatchStart(
  fields: Pick<PatchWizardNumberFields, "universeId" | "startAddress">,
): ConsolePatchPlacement | null {
  const { universeId, startAddress } = fields;
  return isWholeNumberInRange(universeId, 1) &&
    isWholeNumberInRange(startAddress, 1, CONSOLE_UNIVERSE_SIZE)
    ? { universe: universeId, address: startAddress }
    : null;
}
