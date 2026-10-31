// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Modifier and editing-key glyphs that key caps draw as icons instead of text. */
export type KeyGlyph =
  | "command"
  | "control"
  | "option"
  | "shift"
  | "backspace"
  | "enter"
  | "arrow-up"
  | "arrow-down"
  | "arrow-left"
  | "arrow-right";

/** How one key of a shortcut appears on its key cap. */
export interface KeyCapFace {
  /** Text shown on the cap, and the accessible name when the cap draws a glyph. */
  label: string;
  /** Icon drawn in place of the label, for platform modifier keys. */
  glyph?: KeyGlyph;
  /** Full key name for a tooltip, when the label abbreviates it. */
  title?: string;
}

/**
 * Whether the browser runs on an Apple platform, where `$mod` means Command and
 * Alt is labeled Option.
 */
export const IS_APPLE_PLATFORM =
  typeof navigator !== "undefined" &&
  /Mac|iPod|iPhone|iPad/.test(navigator.platform);

/** Key names whose caps show a short symbol or abbreviation, with the full name as a tooltip. */
const NAMED_KEYS: Record<string, KeyCapFace> = {
  ArrowUp: { label: "Up arrow", glyph: "arrow-up" },
  ArrowDown: { label: "Down arrow", glyph: "arrow-down" },
  ArrowLeft: { label: "Left arrow", glyph: "arrow-left" },
  ArrowRight: { label: "Right arrow", glyph: "arrow-right" },
  Backspace: { label: "Backspace", glyph: "backspace" },
  Enter: { label: "Enter", glyph: "enter" },
  Escape: { label: "Esc", title: "Escape" },
  PageUp: { label: "PgUp", title: "Page Up" },
  PageDown: { label: "PgDn", title: "Page Down" },
};

/**
 * Splits one key combination such as `$mod+Shift+P` into its key names.
 *
 * A literal `+` key is kept, so `Shift++` yields `Shift` and `+`.
 */
function parseCombination(combination: string): string[] {
  return Array.from(
    combination.matchAll(/([^+]+|\+)(?:\+|$)/g),
    (match) => match[1],
  );
}

/**
 * Parses shortcut syntax into a sequence of key combinations.
 *
 * Steps of a chord such as `$mod+k w` are separated by whitespace, and keys within
 * a step by `+`, matching the syntax of the shortcut registry and stored keybindings.
 */
export function parseShortcut(shortcut: string): string[][] {
  return shortcut
    .trim()
    .split(/\s+/)
    .filter((step) => step.length > 0)
    .map(parseCombination);
}

/**
 * Describes how a single key name appears on a key cap for the given platform.
 *
 * Resolves the `$mod` placeholder and platform modifiers to their conventional glyph
 * or abbreviation, strips the `Key`/`Digit` prefixes of physical key codes, shows
 * single letters in upper case, and abbreviates arrows and other long key names.
 */
export function describeKey(
  key: string,
  applePlatform: boolean = IS_APPLE_PLATFORM,
): KeyCapFace {
  switch (key) {
    case "$mod":
      return applePlatform
        ? { label: "Command", glyph: "command" }
        : { label: "Ctrl", title: "Control" };
    case "Meta":
      return applePlatform
        ? { label: "Command", glyph: "command" }
        : { label: "Meta" };
    case "Control":
      return applePlatform
        ? { label: "Control", glyph: "control" }
        : { label: "Ctrl", title: "Control" };
    case "Alt":
      return applePlatform
        ? { label: "Option", glyph: "option" }
        : { label: "Alt" };
    case "Shift":
      return { label: "Shift", glyph: "shift" };
  }
  const named = NAMED_KEYS[key];
  if (named) return named;
  const label = key.replace(/^Key(?=[A-Z]$)/, "").replace(/^Digit(?=\d$)/, "");
  return { label: /^[a-z]$/.test(label) ? label.toUpperCase() : label };
}

/**
 * Spells a shortcut out as plain text with the same key names its key caps carry, such as
 * `Ctrl + Shift + P` or the chord `Ctrl + K then W`, for accessible names and prose.
 */
export function formatShortcutLabel(
  shortcut: string,
  applePlatform: boolean = IS_APPLE_PLATFORM,
): string {
  return parseShortcut(shortcut)
    .map((keys) =>
      keys.map((key) => describeKey(key, applePlatform).label).join(" + "),
    )
    .join(" then ");
}

/** Typographic symbols Apple menus print for keys whose caps draw a glyph icon. */
const GLYPH_SYMBOLS: Record<KeyGlyph, string> = {
  command: "⌘",
  control: "⌃",
  option: "⌥",
  shift: "⇧",
  backspace: "⌫",
  enter: "↵",
  "arrow-up": "↑",
  "arrow-down": "↓",
  "arrow-left": "←",
  "arrow-right": "→",
};

/** Order Apple menus print modifier symbols in: Control, Option, Shift, Command, then keys. */
const APPLE_MODIFIER_ORDER: KeyGlyph[] = [
  "control",
  "option",
  "shift",
  "command",
];

/** Ranks a key cap by Apple's modifier order, placing every non-modifier key last. */
function appleModifierRank(face: KeyCapFace): number {
  const rank = face.glyph ? APPLE_MODIFIER_ORDER.indexOf(face.glyph) : -1;
  return rank === -1 ? APPLE_MODIFIER_ORDER.length : rank;
}

/**
 * Spells a shortcut out as the compact hint text a menu item shows beside its label.
 *
 * Apple platforms follow the native menu convention of run-together symbols in Control, Option, Shift,
 * Command order, such as `⇧⌘P`;
 * other platforms join key names with `+`, such as `Ctrl+Shift+P`. Chord steps are separated
 * by a space.
 */
export function formatShortcutHint(
  shortcut: string,
  applePlatform: boolean = IS_APPLE_PLATFORM,
): string {
  return parseShortcut(shortcut)
    .map((keys) => {
      const faces = keys.map((key) => describeKey(key, applePlatform));
      if (!applePlatform) return faces.map((face) => face.label).join("+");
      return faces
        .map((face, index) => ({ face, index }))
        .sort(
          (a, b) =>
            appleModifierRank(a.face) - appleModifierRank(b.face) ||
            a.index - b.index,
        )
        .map(({ face }) =>
          face.glyph ? GLYPH_SYMBOLS[face.glyph] : face.label,
        )
        .join("");
    })
    .join(" ");
}
