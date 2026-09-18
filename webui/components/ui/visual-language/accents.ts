// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Accent choices reference the canonical CSS palette rather than copying color values. */
export const visualLanguageAccents = [
  { name: "Red", value: "var(--color-accent-red)" },
  { name: "Orange", value: "var(--color-accent-orange)" },
  { name: "Amber", value: "var(--color-accent-amber)" },
  { name: "Yellow", value: "var(--color-accent-yellow)" },
  { name: "Lime", value: "var(--color-accent-lime)" },
  { name: "Green", value: "var(--color-accent-green)" },
  { name: "Mint", value: "var(--color-accent-mint)" },
  { name: "Cyan", value: "var(--color-accent-cyan)" },
  { name: "Blue", value: "var(--color-accent-blue)" },
  { name: "Indigo", value: "var(--color-accent-indigo)" },
  { name: "Violet", value: "var(--color-accent-violet)" },
  { name: "Magenta", value: "var(--color-accent-magenta)" },
] as const;

/** Initial accent shared by application preferences and the design lab. */
export const defaultAccent = visualLanguageAccents[6];
