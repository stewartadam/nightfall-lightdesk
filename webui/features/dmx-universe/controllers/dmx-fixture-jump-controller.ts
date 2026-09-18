// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  type Accessor,
  createEffect,
  createSignal,
  type Setter,
} from "solid-js";
import { useKeyboardShortcut } from "../../../lib/keyboardShortcuts";
import { DmxIoMode } from "../../../types";
import type { FixtureJumpTarget } from "../model/dmx-universe-model";
import {
  normalizeFixtureJumpAttributeSearch,
  parseFixtureJumpQuery,
} from "../model/dmx-universe-model";

interface DmxFixtureJumpControllerOptions {
  panelId: string | undefined;
  ioMode: Accessor<DmxIoMode>;
  targets: Accessor<FixtureJumpTarget[]>;
  selectedUniverse: Accessor<number | null>;
  setSelectedUniverse: Setter<number | null>;
}

/** Owns fixture-jump parsing, preview navigation, and viewport restoration. */
export function createDmxFixtureJumpController(
  options: DmxFixtureJumpControllerOptions,
) {
  const [active, setActive] = createSignal(false);
  const [text, setText] = createSignal("");
  const [highlight, setHighlight] = createSignal<{
    universeId: number;
    address: number;
  }>();
  let scrollElement: HTMLDivElement | undefined;
  let inputElement: HTMLInputElement | undefined;
  let origin:
    | { universeId: number | null; scrollTop: number; scrollLeft: number }
    | undefined;

  /** Returns the best fixture, element, or attribute target for typed text. */
  const findTarget = (query: string): FixtureJumpTarget | undefined => {
    const parsed = parseFixtureJumpQuery(query);
    if (!parsed) return undefined;
    const targets = options.targets();
    const exact = targets.filter(
      (target) => String(target.fixtureId) === parsed.fixtureIdText,
    );
    const candidates =
      exact.length > 0
        ? exact
        : targets.filter((target) =>
            String(target.fixtureId).startsWith(parsed.fixtureIdText),
          );
    if (parsed.attributeQuery) {
      const attributeQuery = normalizeFixtureJumpAttributeSearch(
        parsed.attributeQuery,
      );
      const attributes = candidates.filter(
        (target) =>
          target.targetKind === "attribute" &&
          (parsed.elementIndex === undefined ||
            target.elementIndex === parsed.elementIndex),
      );
      return (
        attributes.find(
          (target) => target.attributeSearchText === attributeQuery,
        ) ??
        attributes.find((target) =>
          target.attributeSearchText?.startsWith(attributeQuery),
        )
      );
    }
    if (parsed.elementIndex !== undefined) {
      return candidates.find(
        (target) =>
          target.targetKind === "element" &&
          target.elementIndex === parsed.elementIndex,
      );
    }
    return candidates.find((target) => target.targetKind === "fixture");
  };

  /** Selects and centers the channel tile belonging to a jump target. */
  const scrollTargetIntoView = (target: FixtureJumpTarget) => {
    options.setSelectedUniverse(target.universeId);
    setHighlight({
      universeId: target.universeId,
      address: target.address,
    });
    requestAnimationFrame(() => {
      if (!scrollElement) return;
      const tile = scrollElement.querySelector<HTMLElement>(
        `[data-dmx-channel-address="${target.address}"]`,
      );
      if (!tile) return;
      const scrollRect = scrollElement.getBoundingClientRect();
      const tileRect = tile.getBoundingClientRect();
      const centeredTop =
        scrollElement.scrollTop +
        tileRect.top -
        scrollRect.top -
        (scrollElement.clientHeight - tileRect.height) / 2;
      const maxTop = Math.max(
        0,
        scrollElement.scrollHeight - scrollElement.clientHeight,
      );
      scrollElement.scrollTop = Math.max(0, Math.min(centeredTop, maxTop));
      if (tileRect.left < scrollRect.left) {
        scrollElement.scrollLeft += tileRect.left - scrollRect.left;
      } else if (tileRect.right > scrollRect.right) {
        scrollElement.scrollLeft += tileRect.right - scrollRect.right;
      }
    });
  };

  /** Updates typed text and previews its current best matching target. */
  const updateText = (nextText: string) => {
    setText(nextText);
    const target = findTarget(nextText);
    if (target) scrollTargetIntoView(target);
    else setHighlight(undefined);
  };

  /** Restores the universe and viewport captured before jump mode opened. */
  const restoreOrigin = () => {
    if (!origin) return;
    options.setSelectedUniverse(origin.universeId);
    const captured = origin;
    requestAnimationFrame(() => {
      if (!scrollElement) return;
      scrollElement.scrollTop = captured.scrollTop;
      scrollElement.scrollLeft = captured.scrollLeft;
    });
  };

  /** Completes or cancels jump mode and clears transient highlights. */
  const finish = (restore: boolean) => {
    if (restore) restoreOrigin();
    setHighlight(undefined);
    setActive(false);
    setText("");
    origin = undefined;
  };

  /** Activates jump mode after capturing the current DMX viewport. */
  const activate = () => {
    if (options.ioMode() !== DmxIoMode.Output || options.targets().length === 0)
      return false;
    origin = {
      universeId: options.selectedUniverse(),
      scrollTop: scrollElement?.scrollTop ?? 0,
      scrollLeft: scrollElement?.scrollLeft ?? 0,
    };
    setText("");
    setActive(true);
    return true;
  };

  /** Captures the channel-grid scroll element used for jump navigation. */
  const setScrollElement = (element: HTMLDivElement) => {
    scrollElement = element;
  };

  /** Captures the jump input used for focus management. */
  const setInputElement = (element: HTMLInputElement) => {
    inputElement = element;
  };

  useKeyboardShortcut({
    key: "$mod+g",
    handler: activate,
    description: "Jump to fixture ID",
    componentId: options.panelId,
    group: "Console DMX",
  });

  /** Focuses and selects fixture-jump text whenever jump mode opens. */
  createEffect(() => {
    if (!active()) return;
    inputElement?.focus();
    inputElement?.select();
  });

  return {
    active,
    text,
    highlight,
    updateText,
    finish,
    setScrollElement,
    setInputElement,
  };
}
