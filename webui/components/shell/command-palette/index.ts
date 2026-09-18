// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Core exports

export * from "../../providers/command-registry";
// Components
export {
  CommandPaletteUI,
  CommandPaletteUI as CommandPalette,
} from "./command-palette";
export { default as OpenCommandPalette } from "./commands/open-command-palette";
// Context and hooks
export { CommandPaletteProvider } from "./provider";
