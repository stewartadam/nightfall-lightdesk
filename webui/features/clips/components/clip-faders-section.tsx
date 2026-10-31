// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Collapsible } from "../../../components/ui/collapsible";
import { MIN_FADERS_HEIGHT } from "../state/faders-layout";
import { Faders, type FadersProps } from "./faders";

interface ClipFadersSectionProps {
  collapsed: boolean;
  transitioning: boolean;
  height: number;
  visibleHeight: number;
  clipStates: FadersProps["clipStates"];
  onResizeStart: (event: PointerEvent) => void;
  onResizeKeyDown: (event: KeyboardEvent) => void;
  onToggleCollapsed: () => void;
}

/** Renders the props-driven resizable faders section beneath the clip list. */
export function ClipFadersSection(props: ClipFadersSectionProps) {
  return (
    <div
      class="flex min-h-0 shrink-0 flex-col overflow-hidden border-t border-neutral-700 bg-neutral-900"
      classList={{
        "transition-[height] duration-200 ease-in-out": props.transitioning,
      }}
      data-clip-faders-section=""
      data-collapsed={props.collapsed}
      style={{ height: `${props.visibleHeight}px` }}
    >
      <div
        class="group h-2 shrink-0 touch-none bg-neutral-800/70 transition-colors hover:bg-blue-500/40"
        classList={{
          "cursor-row-resize": !props.collapsed,
          "cursor-default": props.collapsed,
        }}
        data-clip-faders-resize-handle=""
        aria-label="Resize faders"
        role="separator"
        aria-orientation="horizontal"
        aria-valuemin={MIN_FADERS_HEIGHT}
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
        title="Faders"
        class="flex min-h-0 flex-1 flex-col"
        headerClass="h-9 shrink-0 border-b border-neutral-800 px-3"
        triggerClass="flex-1 self-stretch text-xs font-medium uppercase tracking-wide"
        contentClass="mt-0 min-h-0 flex-1 overflow-hidden p-3"
      >
        <Faders faderCount={10} clipStates={props.clipStates} />
      </Collapsible>
    </div>
  );
}
