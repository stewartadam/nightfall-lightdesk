// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { AppWindowIcon } from "@squidlab/phosphor-solid/app-window";
import { ArrowUUpLeftIcon } from "@squidlab/phosphor-solid/arrow-u-up-left";
import { ArrowUUpRightIcon } from "@squidlab/phosphor-solid/arrow-u-up-right";
import { CaretDownIcon } from "@squidlab/phosphor-solid/caret-down";
import { CaretLeftIcon } from "@squidlab/phosphor-solid/caret-left";
import { CaretRightIcon } from "@squidlab/phosphor-solid/caret-right";
import { CaretUpIcon } from "@squidlab/phosphor-solid/caret-up";
import { CodeIcon } from "@squidlab/phosphor-solid/code";
import { FileArrowDownIcon } from "@squidlab/phosphor-solid/file-arrow-down";
import { FilePlusIcon } from "@squidlab/phosphor-solid/file-plus";
import { FileTextIcon } from "@squidlab/phosphor-solid/file-text";
import { FolderOpenIcon } from "@squidlab/phosphor-solid/folder-open";
import { GearIcon } from "@squidlab/phosphor-solid/gear";
import { HardDrivesIcon } from "@squidlab/phosphor-solid/hard-drives";
import { InfoIcon } from "@squidlab/phosphor-solid/info";
import { ListIcon } from "@squidlab/phosphor-solid/list";
import { QuestionIcon } from "@squidlab/phosphor-solid/question";
import { WifiHighIcon } from "@squidlab/phosphor-solid/wifi-high";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { Dynamic } from "solid-js/web";
import { SelectionFlattenConfirmModal } from "../../../features/selection";
import { AboutDialog, SettingsOverlay } from "../../../features/settings";
import { APP_BUILD_ID, APP_BUILD_NAME } from "../../../lib/app-metadata";
import { commandFailure, commandSucceeded } from "../../../lib/command-result";
import { connectionStatus, engineRuntime } from "../../../lib/engine-runtime";
import { openFeedbackPage } from "../../../lib/feedback";
import { getLogger } from "../../../lib/logger";
import { isEmbeddedDemoRuntime } from "../../../lib/runtime-config";
import {
  newShowfile,
  promptForNewShowfileName,
  saveShowfile,
} from "../../../lib/showfile-actions";
import { currentShowfileName } from "../../../lib/showfile-loading";
import { isTauriRuntime } from "../../../lib/tauri";
import { invokeTauriMenuAction } from "../../../lib/tauri-menu";
import {
  frameStats,
  smoothedEngineMetrics,
  undoState,
  wsLatency,
  wsStats,
} from "../../../state/appStores";
import { useAppShell } from "../../providers/app-shell";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSubmenu,
} from "../../ui/dropdown-menu";
import { ScrollArea } from "../../ui/scroll-area";
import { TOOLBAR_BUTTON_CLASS, ToolbarButton } from "../../ui/toolbar-button";
import Tooltip from "../../ui/tooltip";
import BrowserDemoBanner from "../runtime/browser-demo-banner";
import {
  smoothStatusMetric,
  type UndoTimelineEntry,
  undoTimelineCommand,
} from "./model";
import { UndoTimelineButton, UndoTimelineCaret } from "./undo-timeline";

const log = getLogger(import.meta.url);
const STATUS_METRIC_DISPLAY_INTERVAL_MS = 1000;
const STATUS_ICON_SLOT_CLASS =
  "inline-flex size-6 shrink-0 items-center justify-center rounded p-1";
const STATUS_ICON_GROUP_CLASS = "flex items-center gap-1";

/** Renders connection health, optional metrics, and showfile controls. */
export default function StatusBar() {
  const [currentTime, setCurrentTime] = createSignal(
    new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  );
  const [nowMs, setNowMs] = createSignal(Date.now());
  const [displayedLatencyMs, setDisplayedLatencyMs] = createSignal(0);
  const [displayedDeliveryLagMs, setDisplayedDeliveryLagMs] = createSignal(0);
  const [displayedFps, setDisplayedFps] = createSignal(0);
  const [displayedFrontendFps, setDisplayedFrontendFps] = createSignal(0);
  const [showMetrics, setShowMetrics] = createSignal(false);
  const latency = useStore(wsLatency);
  const websocketStats = useStore(wsStats);
  const backendMetrics = useStore(smoothedEngineMetrics);
  const frontendFrameStats = useStore(frameStats);
  const undo = useStore(undoState);
  const showfileName = useStore(currentShowfileName);
  const connStatus = connectionStatus;
  const [showUndoTimeline, setShowUndoTimeline] = createSignal(false);
  const [isUndoTimelineJumping, setIsUndoTimelineJumping] = createSignal(false);

  // Update intervals
  let timeInterval: number;

  /** Main-thread websocket delivery lag before status-bar display sampling. */
  const currentDeliveryLagMs = () =>
    websocketStats()?.main.avgDeliveryLagMs ?? latency();

  /** Backend frame rate before status-bar display sampling. */
  const currentFps = () => backendMetrics().fps;

  /** Browser frame rate before status-bar display sampling. */
  const currentFrontendFps = () => frontendFrameStats()?.fps ?? 0;

  /** Refreshes status-bar performance values at a stable display cadence. */
  const refreshDisplayedMetrics = () => {
    setDisplayedLatencyMs((current) => smoothStatusMetric(current, latency()));
    setDisplayedDeliveryLagMs((current) =>
      smoothStatusMetric(current, currentDeliveryLagMs()),
    );
    setDisplayedFps((current) => smoothStatusMetric(current, currentFps()));
    setDisplayedFrontendFps((current) =>
      smoothStatusMetric(current, currentFrontendFps()),
    );
  };

  onMount(() => {
    log.trace("mounting");
    refreshDisplayedMetrics();

    // Update time every second
    timeInterval = window.setInterval(() => {
      setNowMs(Date.now());
      refreshDisplayedMetrics();
      setCurrentTime(
        new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
      );
    }, STATUS_METRIC_DISPLAY_INTERVAL_MS);
  });

  onCleanup(() => {
    log.trace("unmounting");
    clearInterval(timeInterval);
  });

  /** Whether websocket delivery is connected but falling behind on the main thread. */
  const isConnectionDegraded = () =>
    connStatus() === "connected" &&
    (websocketStats()?.main.backlogLagging ?? false);

  /** Connection status styles */
  const getStatusColor = () => {
    if (isConnectionDegraded()) {
      return "bg-yellow-500";
    }

    switch (connStatus()) {
      case "connected":
        return "bg-green-500";
      case "connecting":
        return "bg-yellow-500";
      case "disconnected":
        return "bg-red-500";
      default:
        return "bg-gray-500";
    }
  };

  /** Describes the connection health for the indicator label and tooltip. */
  const getStatusText = () => {
    if (isConnectionDegraded()) {
      return "Degraded";
    }

    switch (connStatus()) {
      case "connected":
        return "Connected";
      case "connecting":
        return "Connecting...";
      case "disconnected":
        return "Disconnected";
      default:
        return "Unknown";
    }
  };

  const {
    openAbout,
    openDiagnostics,
    openSettings,
    showShortcutsPopup,
    showOpenShowfileModal,
    showShowfileImportModal,
    showShowfileExportModal,
  } = useAppShell();

  /** Prompts for a show name before starting a fresh showfile. */
  const promptAndNewShowfile = () => {
    void (async () => {
      const showfileName = await promptForNewShowfileName();
      if (!showfileName) return;
      newShowfile(showfileName);
    })();
  };

  const handleUndo = () => {
    engineRuntime.sendCommand({
      module: "UndoCommand",
      command: { type: "Undo", data: {} },
    });
  };

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
    if (connStatus() !== "connected" || !hasUndoTimelineEntries()) {
      setShowUndoTimeline(false);
    }
  });

  return (
    <div
      aria-label="Application status bar"
      class="nf-status-bar w-full h-8 shrink-0 px-4 flex items-center justify-between text-xs"
      role="region"
    >
      <div class={STATUS_ICON_GROUP_CLASS}>
        <DropdownMenu
          triggerLabel="Menu"
          triggerTitle="Menu"
          triggerClass={TOOLBAR_BUTTON_CLASS}
          trigger={<ListIcon class="size-4 text-gray-400" aria-hidden />}
        >
          <DropdownMenuItem
            icon={FilePlusIcon}
            shortcut="⌘⇧N"
            onClick={promptAndNewShowfile}
          >
            New Showfile
          </DropdownMenuItem>
          <DropdownMenuItem
            icon={FolderOpenIcon}
            shortcut="⌘O"
            onClick={() => {
              showOpenShowfileModal();
            }}
          >
            Open Showfile
          </DropdownMenuItem>
          <DropdownMenuItem
            icon={FileArrowDownIcon}
            onClick={showShowfileImportModal}
          >
            Import Showfile
          </DropdownMenuItem>
          <DropdownMenuItem
            icon={FileArrowDownIcon}
            shortcut="⌘S"
            onClick={saveShowfile}
          >
            Save Showfile
          </DropdownMenuItem>
          <DropdownMenuItem
            icon={FileArrowDownIcon}
            onClick={showShowfileExportModal}
          >
            Export Showfile
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            icon={GearIcon}
            onClick={openSettings}
            shortcut="⌘,"
          >
            Settings
          </DropdownMenuItem>
          <DropdownMenuItem
            icon={QuestionIcon}
            onClick={showShortcutsPopup}
            shortcut="⇧?"
          >
            Keyboard Shortcuts
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem icon={InfoIcon} onClick={openAbout}>
            About
          </DropdownMenuItem>
          <DropdownMenuItem
            icon={QuestionIcon}
            onClick={() => openFeedbackPage("feedback")}
          >
            Give Feedback
          </DropdownMenuItem>
          <DropdownMenuSubmenu label="Troubleshooting" icon={GearIcon}>
            <Show when={isTauriRuntime()}>
              <DropdownMenuItem
                icon={FileTextIcon}
                onClick={() => {
                  void invokeTauriMenuAction("view.open_log").catch(
                    (error: unknown) => {
                      log.error("Could not open the application log", {
                        error,
                      });
                    },
                  );
                }}
              >
                Open Log
              </DropdownMenuItem>
            </Show>
            <DropdownMenuItem
              icon={QuestionIcon}
              onClick={() => openFeedbackPage("bug")}
            >
              Report a Bug
            </DropdownMenuItem>
            <DropdownMenuItem icon={FileTextIcon} onClick={openDiagnostics}>
              Collect Diagnostics
            </DropdownMenuItem>
          </DropdownMenuSubmenu>
        </DropdownMenu>

        <Tooltip content={getStatusText}>
          <span
            role="status"
            aria-label={getStatusText()}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need access to the connection tooltip.
            tabIndex={0}
            class={`${STATUS_ICON_SLOT_CLASS} focus-visible:outline-2 focus-visible:outline-offset-2`}
          >
            <span
              class={`inline-block size-2 rounded-full ${getStatusColor()}`}
            />
          </span>
        </Tooltip>
        <Show when={connStatus() === "connected"}>
          <div class="flex items-center gap-2">
            <ToolbarButton
              label={showMetrics() ? "Hide metrics" : "Show metrics"}
              aria-expanded={showMetrics()}
              aria-controls="status-metrics"
              onClick={() => setShowMetrics((visible) => !visible)}
            >
              <Dynamic
                component={showMetrics() ? CaretLeftIcon : CaretRightIcon}
                class="size-4"
                aria-hidden
              />
            </ToolbarButton>
            <div
              id="status-metrics"
              hidden={!showMetrics()}
              class="items-center gap-3 font-mono text-xs"
              classList={{ flex: showMetrics() }}
            >
              <span class="inline-flex items-center gap-1">
                <WifiHighIcon class="size-4 text-gray-500" aria-hidden />
                {`${displayedLatencyMs().toFixed(1)}ms / ${displayedDeliveryLagMs().toFixed(1)}ms`}
              </span>
              <span class="inline-flex items-center gap-1">
                <HardDrivesIcon class="size-4 text-gray-500" aria-hidden />
                {`${displayedFps().toFixed(0)} Hz`}
              </span>
              <span class="inline-flex items-center gap-1">
                <AppWindowIcon class="size-4 text-gray-500" aria-hidden />
                {`${displayedFrontendFps().toFixed(0)} FPS`}
              </span>
              <span
                aria-hidden="true"
                class="h-4 w-px shrink-0 bg-gray-700"
                data-testid="status-metrics-separator"
              />
            </div>
          </div>
        </Show>
      </div>

      <BrowserDemoBanner />

      <div class="flex items-center gap-2">
        <Tooltip content={() => `Showfile: ${showfileName()}`}>
          <div
            data-testid="status-showfile-name"
            class="inline-flex min-w-0 max-w-64 items-center gap-1 px-2 py-0.5 font-mono text-xs text-gray-400"
          >
            <FileTextIcon class="size-3.5 shrink-0 text-gray-500" aria-hidden />
            <span class="min-w-0 truncate">{showfileName()}</span>
          </div>
        </Tooltip>
        <Show when={import.meta.env.DEV && !isEmbeddedDemoRuntime()}>
          <Tooltip content={() => `${APP_BUILD_NAME} (${APP_BUILD_ID})`}>
            <div
              data-testid="status-build-name"
              class="inline-flex min-w-0 max-w-80 items-center gap-1 px-2 py-0.5 font-mono text-xs text-gray-400"
            >
              <CodeIcon class="size-3.5 shrink-0 text-gray-500" aria-hidden />
              <span class="min-w-0 truncate">{APP_BUILD_NAME}</span>
            </div>
          </Tooltip>
        </Show>
        <div
          aria-hidden="true"
          class="h-4 w-px bg-gray-700"
          data-testid="status-build-separator"
        />
        <Show when={connStatus() === "connected"}>
          <div class="contents">
            <div class={STATUS_ICON_GROUP_CLASS}>
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
                  placement="above"
                  align="end"
                  triggerDisabled={
                    !hasUndoTimelineEntries() || isUndoTimelineJumping()
                  }
                  triggerLabel="Open undo timeline"
                  triggerTitle="Undo timeline"
                  triggerClass={TOOLBAR_BUTTON_CLASS}
                  contentLabel="Undo timeline"
                  contentClass="w-80"
                  trigger={
                    <Dynamic
                      component={
                        showUndoTimeline() ? CaretDownIcon : CaretUpIcon
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
            <div
              aria-hidden="true"
              class="h-4 w-px bg-gray-700"
              data-testid="status-undo-separator"
            />
          </div>
        </Show>
        <div class="flex items-center" data-testid="status-clock">
          {currentTime()}
        </div>
      </div>

      <AboutDialog />
      <SettingsOverlay />
      <SelectionFlattenConfirmModal />
    </div>
  );
}
