// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Collapsible } from "../../../components/ui/collapsible";
import { MIN_CONTROLS_HEIGHT } from "../state/controls-layout";
import { Controls, type ControlsProps } from "./controls";

interface ClipControlsSectionProps {
  collapsed: boolean;
  transitioning: boolean;
  height: number;
  visibleHeight: number;
  clipStates: ControlsProps["clipStates"];
  onResizeStart: (event: PointerEvent) => void;
  onResizeKeyDown: (event: KeyboardEvent) => void;
  onToggleCollapsed: () => void;
}

/** Renders the props-driven resizable controls section beneath the clip list. */
export function ClipControlsSection(props: ClipControlsSectionProps) {
  return (
    <div
      class="flex min-h-0 shrink-0 flex-col overflow-hidden border-t border-neutral-700 bg-neutral-900"
      classList={{
        "transition-[height] duration-200 ease-in-out": props.transitioning,
      }}
      data-clip-controls-section=""
      data-collapsed={props.collapsed}
      style={{ height: `${props.visibleHeight}px` }}
    >
      <div
        class="group h-2 shrink-0 touch-none bg-neutral-800/70 transition-colors hover:bg-blue-500/40"
        classList={{
          "cursor-row-resize": !props.collapsed,
          "cursor-default": props.collapsed,
        }}
        data-clip-controls-resize-handle=""
        aria-label="Resize controls"
        role="separator"
        aria-orientation="horizontal"
        aria-valuemin={MIN_CONTROLS_HEIGHT}
        aria-valuenow={props.height}
        tabIndex={props.collapsed ? -1 : 0}
        onPointerDown={props.onResizeStart}
        onKeyDown={props.onResizeKeyDown}
      >
        <div class="mx-auto mt-[3px] h-px w-14 rounded bg-neutral-500 group-hover:bg-blue-200" />
      </div>
      <Collapsible
        variant="plain"
        lazy
        forceMount={props.transitioning}
        open={!props.collapsed}
        onOpenChange={props.onToggleCollapsed}
        title="Controls"
        class="flex min-h-0 flex-1 flex-col"
        headerClass="h-9 shrink-0 border-b border-neutral-800 px-3"
        triggerClass="flex-1 self-stretch text-xs font-medium uppercase tracking-wide"
        contentClass="mt-0 min-h-0 flex-1 overflow-hidden p-3"
      >
        <Controls controlCount={10} clipStates={props.clipStates} />
      </Collapsible>
    </div>
  );
}
