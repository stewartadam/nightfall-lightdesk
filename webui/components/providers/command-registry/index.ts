// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

export * from "./command-types";
export { CommandPaletteContext, useCommandPalette } from "./context";
export {
  $uiActionCatalog,
  $uiActions,
  describeUiAction,
  executeUiAction,
  registerUiAction,
  UI_ACTION_PREFIX,
  type UiActionDescriptor,
  type UiActionOutcome,
  uiActionId,
} from "./ui-action-registry";
export { useUiAction } from "./use-ui-action";
