// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal, type JSX, onMount, Show, splitProps } from "solid-js";
import { Portal } from "solid-js/web";
import { overlayHost } from "./modal/dialog-stack";
import { ScrollIndicators } from "./scroll-area";
import "./toolbar.css";

interface PanelToolbarProps extends JSX.HTMLAttributes<HTMLDivElement> {
  left?: JSX.Element;
  right?: JSX.Element;
  leftClass?: string;
  rightClass?: string;
  position?: "header" | "footer";
}

/**
 * Arranges panel actions into shared left and right groups. Docked panels wrap
 * the groups onto more rows. Where the surrounding layout makes the toolbar
 * scroll sideways instead (the compact shell does), caret and blur cues mark
 * the edges that hide more.
 */
export default function PanelToolbar(props: PanelToolbarProps) {
  const [local, rest] = splitProps(props, [
    "left",
    "right",
    "leftClass",
    "rightClass",
    "class",
    "position",
    "ref",
  ]);
  const [scrolls, setScrolls] = createSignal(false);
  let toolbar!: HTMLDivElement;

  /**
   * Shows scroll cues only for a toolbar styled to scroll. The compact shell
   * remounts panels when the viewport crosses its breakpoint, so reading the
   * style once at mount stays correct, and docked toolbars pay no observer cost.
   */
  onMount(() => {
    const overflow = getComputedStyle(toolbar).overflowX;
    setScrolls(overflow === "auto" || overflow === "scroll");
  });
  return (
    <>
      <div
        ref={(element) => {
          toolbar = element;
          if (typeof local.ref === "function") local.ref(element);
        }}
        class={`nf-panel-toolbar ${local.class ?? ""}`}
        data-component="PanelToolbar"
        data-position={local.position}
        {...rest}
      >
        <div
          class={`nf-toolbar-group ${local.leftClass ?? ""}`}
          data-slot="left"
        >
          {local.left}
        </div>
        <div
          class={`nf-toolbar-group ${local.rightClass ?? ""}`}
          data-slot="right"
        >
          {local.right}
        </div>
      </div>
      <Show when={scrolls()}>
        <Portal mount={overlayHost(toolbar)}>
          <ScrollIndicators
            viewport={toolbar}
            fixed
            class="nf-panel-toolbar-scroll"
          />
        </Portal>
      </Show>
    </>
  );
}

/** Visually separates related action groups without entering the keyboard focus order. */
export function ToolbarSeparator() {
  return <div class="nf-toolbar-separator" aria-hidden="true" />;
}
