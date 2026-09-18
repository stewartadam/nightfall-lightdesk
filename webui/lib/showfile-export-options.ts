// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

export type ShowfileExportPolicy =
  | "showfileOnly"
  | "showfileReferences"
  | "allReferences";

/** Reference choices shared by standalone showfile exports and diagnostic packages. */
export const showfileExportOptions = [
  {
    value: "showfileOnly",
    label: "Showfile only",
    description:
      "Includes the current showfile and its manifest without supporting files. Show names, file paths, and fixture definitions are included.",
  },
  {
    value: "showfileReferences",
    label: "Showfile references",
    description:
      "Includes the current showfile and all files in its showfile directory. External library assets are excluded.",
  },
  {
    value: "allReferences",
    label: "All references",
    description:
      "Includes the current showfile directory and referenced external audio, fixture definitions (including GDTF), models, and FX modules. These files may be large or contain private content.",
  },
] as const;
