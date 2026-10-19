// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ArrowFatUpIcon } from "@squidlab/phosphor-solid/arrow-fat-up";
import { BackspaceIcon } from "@squidlab/phosphor-solid/backspace";
import { CaretUpIcon } from "@squidlab/phosphor-solid/caret-up";
import { CommandIcon } from "@squidlab/phosphor-solid/command";
import { OptionIcon } from "@squidlab/phosphor-solid/option";
import { createMemo, For, type JSX, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { describeKey, type KeyGlyph, parseShortcut } from "./kbd-keys";

export {
  describeKey,
  formatShortcutLabel,
  IS_APPLE_PLATFORM,
  parseShortcut,
} from "./kbd-keys";

/** Key cap scale: `default` for reference lists and dialogs, `compact` for dense rows and hints. */
export type KbdSize = "default" | "compact";

/** Key cap emphasis: `muted` dims the label for inactive or disabled shortcuts. */
export type KbdTone = "default" | "muted";

/**
 * Shared key cap surface, border and typography. `relative` contains the screen-reader label so
 * it cannot add overflow inside multi-column lists such as the shortcuts overlay.
 */
const BASE_CLASS =
  "relative inline-flex shrink-0 items-center justify-center border border-neutral-600 bg-neutral-800 font-mono leading-none";

/** Dimensions and type size for each key cap scale. */
const SIZE_CLASS: Record<KbdSize, string> = {
  default: "min-h-7 min-w-7 rounded-md px-1.5 py-1 text-sm",
  compact: "min-h-5 min-w-5 rounded px-1 py-0.5 text-[11px]",
};

/** Label color for each key cap emphasis. */
const TONE_CLASS: Record<KbdTone, string> = {
  default: "text-neutral-200",
  muted: "text-neutral-400",
};

/** Glyph icon size for each key cap scale, in pixels. */
const GLYPH_SIZE: Record<KbdSize, number> = { default: 13, compact: 11 };

/** Icons drawn for platform modifier glyphs. */
const GLYPH_ICONS: Record<
  KeyGlyph,
  (props: { size: number; "aria-hidden": "true" }) => JSX.Element
> = {
  command: CommandIcon,
  control: CaretUpIcon,
  option: OptionIcon,
  shift: ArrowFatUpIcon,
  backspace: BackspaceIcon,
};

interface KbdProps {
  /**
   * Key name in shortcut syntax, such as `$mod`, `Shift`, `KeyP` or `ArrowUp`. The cap resolves it
   * to the platform glyph or label. Omit it to show `children` verbatim.
   */
  keyName?: string;
  /** Literal cap content, used when `keyName` is absent. */
  children?: JSX.Element;
  size?: KbdSize;
  tone?: KbdTone;
  class?: string;
}

/**
 * Renders one keyboard key as a key cap.
 *
 * With `keyName`, modifier keys draw their platform glyph (Command, Option, Shift, Control on
 * Apple platforms) and Backspace draws its icon, each keeping the key's name for assistive
 * technology and as a tooltip; other keys show their conventional label. Without it, the cap shows its children as written.
 */
export function Kbd(props: KbdProps) {
  /** Resolved face for `keyName`, or undefined for a literal cap. */
  const face = createMemo(() =>
    props.keyName === undefined ? undefined : describeKey(props.keyName),
  );
  const size = () => props.size ?? "default";
  return (
    <kbd
      class={`${BASE_CLASS} ${SIZE_CLASS[size()]} ${TONE_CLASS[props.tone ?? "default"]} ${props.class ?? ""}`}
      title={face()?.title ?? (face()?.glyph ? face()?.label : undefined)}
      data-kbd-key={props.keyName}
    >
      <Show when={face()} fallback={props.children}>
        {(resolved) => (
          <Show when={resolved().glyph} fallback={resolved().label}>
            {(glyph) => (
              <>
                <Dynamic
                  component={GLYPH_ICONS[glyph()]}
                  size={GLYPH_SIZE[size()]}
                  aria-hidden="true"
                />
                <span class="sr-only">{resolved().label}</span>
              </>
            )}
          </Show>
        )}
      </Show>
    </kbd>
  );
}

interface KbdShortcutProps {
  /** Shortcut syntax, such as `$mod+Shift+P`, `Control+KeyM` or the chord `$mod+k w`. */
  shortcut: string;
  size?: KbdSize;
  tone?: KbdTone;
  class?: string;
}

/**
 * Renders a key combination or chord as a row of key caps.
 *
 * Keys within a combination sit side by side; the steps of a chord are separated by a wider gap.
 * The row is a nested `<kbd>`, the HTML convention for a key combination.
 */
export function KbdShortcut(props: KbdShortcutProps) {
  /** Steps of the shortcut, each a list of key names. */
  const steps = createMemo(() => parseShortcut(props.shortcut));
  return (
    <kbd
      class={`inline-flex shrink-0 flex-nowrap items-center gap-2 whitespace-nowrap font-sans ${props.class ?? ""}`}
      data-kbd-shortcut={props.shortcut}
    >
      <For each={steps()}>
        {(keys) => (
          <span class="inline-flex items-center gap-1">
            <For each={keys}>
              {(key) => (
                <Kbd keyName={key} size={props.size} tone={props.tone} />
              )}
            </For>
          </span>
        )}
      </For>
    </kbd>
  );
}
