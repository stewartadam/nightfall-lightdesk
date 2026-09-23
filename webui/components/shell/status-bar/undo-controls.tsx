// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { ArrowUUpLeftIcon } from "@squidlab/phosphor-solid/arrow-u-up-left";
import { ArrowUUpRightIcon } from "@squidlab/phosphor-solid/arrow-u-up-right";
import { CaretDownIcon } from "@squidlab/phosphor-solid/caret-down";
import { CaretUpIcon } from "@squidlab/phosphor-solid/caret-up";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
} from "solid-js";
import { Dynamic } from "solid-js/web";
import { commandFailure, commandSucceeded } from "../../../lib/command-result";
import { connectionStatus, engineRuntime } from "../../../lib/engine-runtime";
import { getLogger } from "../../../lib/logger";
import { undoState } from "../../../state/appStores";
import { DropdownMenu } from "../../ui/dropdown-menu";
import { ScrollArea } from "../../ui/scroll-area";
import { TOOLBAR_BUTTON_CLASS, ToolbarButton } from "../../ui/toolbar-button";
import { type UndoTimelineEntry, undoTimelineCommand } from "./model";
import { UndoTimelineButton, UndoTimelineCaret } from "./undo-timeline";

const log = getLogger(import.meta.url);
const UNDO_AGE_REFRESH_INTERVAL_MS = 1000;

/**
 * Undo and redo buttons plus the undo timeline popout, which jumps several
 * steps at once. `placement` says which way the timeline opens from the bar.
 */
export default function UndoControls(props: { placement: "above" | "below" }) {
  const undo = useStore(undoState);
  const [showUndoTimeline, setShowUndoTimeline] = createSignal(false);
  const [isUndoTimelineJumping, setIsUndoTimelineJumping] = createSignal(false);
  const [nowMs, setNowMs] = createSignal(Date.now());

  /** Ages the timeline entries' relative timestamps while the bar is shown. */
  const ageInterval = window.setInterval(
    () => setNowMs(Date.now()),
    UNDO_AGE_REFRESH_INTERVAL_MS,
  );
  onCleanup(() => clearInterval(ageInterval));

  /** Asks the engine to undo the latest operation. */
  const handleUndo = () => {
    engineRuntime.sendCommand({
      module: "UndoCommand",
      command: { type: "Undo", data: {} },
    });
  };

  /** Asks the engine to redo the latest undone operation. */
  const handleRedo = () => {
    engineRuntime.sendCommand({
      module: "UndoCommand",
      command: { type: "Redo", data: {} },
    });
  };

  /** Sends undo or redo commands one at a time until the clicked stack entry is reached. */
  const jumpUndoTimelineTo = async (item: UndoTimelineEntry) => {
    if (isUndoTimelineJumping()) {
      return;
    }

    const commandType = undoTimelineCommand(item.kind);
    setIsUndoTimelineJumping(true);
    try {
      for (let step = 0; step <= item.entry.order; step += 1) {
        const result = await engineRuntime.sendCommandAndAwait({
          module: "UndoCommand",
          command: { type: commandType, data: {} },
        });
        if (!commandSucceeded(result)) {
          const failure = commandFailure(result);
          log.warn("Undo timeline jump step failed", {
            commandType,
            step,
            error: failure?.message,
          });
          break;
        }
      }
      setShowUndoTimeline(false);
    } catch (error) {
      log.error("Failed to jump undo timeline", { commandType, error });
    } finally {
      setIsUndoTimelineJumping(false);
    }
  };

  /** Names the next undo operation, or explains why undo is unavailable. */
  const undoTooltipLabel = () =>
    undo().undo_description
      ? `Undo: ${undo().undo_description}`
      : "Nothing to undo";

  /** Names the next redo operation, or explains why redo is unavailable. */
  const redoTooltipLabel = () =>
    undo().redo_description
      ? `Redo: ${undo().redo_description}`
      : "Nothing to redo";

  /** Redo entries above the current-state caret, with the next redo closest to the caret. */
  const redoTimelineEntries = createMemo((): UndoTimelineEntry[] => {
    const receivedAtMs = Date.now();
    return [...undo().redo_stack]
      .reverse()
      .map((entry) => ({ kind: "redo" as const, entry, receivedAtMs }));
  });

  /** Undo traversal path below the current-state caret. */
  const undoTimelinePathEntries = createMemo((): UndoTimelineEntry[] => {
    const receivedAtMs = Date.now();
    return undo().undo_stack.map((entry) => ({
      kind: "undo" as const,
      entry,
      receivedAtMs,
    }));
  });

  /** Total entries on both sides of the current-state caret. */
  const undoTimelineTotalEntries = createMemo(
    () => undo().undo_depth + undo().redo_depth,
  );

  /** Whether the timeline popout can show at least one actionable entry. */
  const hasUndoTimelineEntries = createMemo(
    () => undoTimelineTotalEntries() > 0,
  );

  /** Close the undo timeline when connection or history state makes it irrelevant. */
  createEffect(() => {
    if (connectionStatus() !== "connected" || !hasUndoTimelineEntries()) {
      setShowUndoTimeline(false);
    }
  });

  return (
    <div class="flex items-center gap-1" data-guide-target="undo-redo">
      <ToolbarButton
        type="button"
        disabled={!undo().can_undo || isUndoTimelineJumping()}
        onClick={handleUndo}
        label={undoTooltipLabel()}
      >
        <ArrowUUpLeftIcon class="w-4 h-4" aria-hidden />
      </ToolbarButton>
      <div class="inline-flex items-center">
        <ToolbarButton
          type="button"
          disabled={!undo().can_redo || isUndoTimelineJumping()}
          onClick={handleRedo}
          label={redoTooltipLabel()}
        >
          <ArrowUUpRightIcon class="w-4 h-4" aria-hidden />
        </ToolbarButton>
        <DropdownMenu
          open={showUndoTimeline()}
          onOpenChange={setShowUndoTimeline}
          placement={props.placement}
          align="end"
          triggerDisabled={!hasUndoTimelineEntries() || isUndoTimelineJumping()}
          triggerLabel="Open undo timeline"
          triggerTitle="Undo timeline"
          triggerClass={TOOLBAR_BUTTON_CLASS}
          contentLabel="Undo timeline"
          contentClass="w-80"
          trigger={
            <Dynamic
              component={
                showUndoTimeline() === (props.placement === "above")
                  ? CaretDownIcon
                  : CaretUpIcon
              }
              class="h-3 w-3"
              aria-hidden
            />
          }
        >
          <div class="mb-1 flex items-center justify-between px-2 text-[10px] font-semibold uppercase text-gray-500">
            <span>Undo Timeline</span>
            <span>{undoTimelineTotalEntries()} total</span>
          </div>
          <ScrollArea
            class="max-h-64"
            viewportProps={{
              role: "region",
              "aria-label": "Undo timeline",
              tabIndex: 0,
            }}
          >
            <ul class="space-y-0.5">
              <For each={redoTimelineEntries()}>
                {(item) => (
                  <UndoTimelineButton
                    item={item}
                    ageMs={
                      item.entry.age_ms +
                      Math.max(0, nowMs() - item.receivedAtMs)
                    }
                    disabled={isUndoTimelineJumping()}
                    onSelect={jumpUndoTimelineTo}
                  />
                )}
              </For>
              <UndoTimelineCaret />
              <For each={undoTimelinePathEntries()}>
                {(item) => (
                  <UndoTimelineButton
                    item={item}
                    ageMs={
                      item.entry.age_ms +
                      Math.max(0, nowMs() - item.receivedAtMs)
                    }
                    disabled={isUndoTimelineJumping()}
                    onSelect={jumpUndoTimelineTo}
                  />
                )}
              </For>
            </ul>
          </ScrollArea>
        </DropdownMenu>
      </div>
    </div>
  );
}
