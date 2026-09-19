// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { CaretDownIcon } from "@squidlab/phosphor-solid/caret-down";
import { createEffect, createSignal, mergeProps } from "solid-js";
import {
  DropdownMenu,
  DropdownMenuSeparator,
} from "../../../components/ui/dropdown-menu";
import { Input } from "../../../components/ui/form-controls";
import { NumericStepper } from "../../../components/ui/numeric-stepper";
import { ToggleSwitch } from "../../../components/ui/toggle-switch";
import { Button } from "../../../components/ui/visual-language/button";
import { engineRuntime } from "../../../lib/engine-runtime";
import { setStoreAction } from "../../../lib/nanostore-action";
import { useShallowStore } from "../../../lib/use-shallow-store";
import {
  timelineBeatgridDetectionStatus,
  timelineBeatgridPreview,
  timelineBeatgridProposals,
  timelines,
} from "../../../state/appStores";
import type * as types from "../../../types";
import { createBeatModelDownload } from "../../beat-detection";
import { useTimelineContext } from "../context/timeline-context";
import { parseBeatgridBpmInput } from "../model/beatgrid-bpm";

export type BeatgridControlsProps = {
  minBpm?: number;
  maxBpm?: number;
  minBeatsPerBar?: number;
  maxBeatsPerBar?: number;
};

const defaultProps = {
  minBpm: 60,
  maxBpm: 240,
  minBeatsPerBar: 2,
  maxBeatsPerBar: 12,
};

export const BeatgridControls = (props: BeatgridControlsProps) => {
  const context = useTimelineContext();
  const mprops = mergeProps(defaultProps, props);
  const $timelines = useShallowStore(timelines);
  const $beatgridProposals = useStore(timelineBeatgridProposals);
  const $beatgridDetectionStatus = useStore(timelineBeatgridDetectionStatus);

  const [tempBpm, setTempBpm] = createSignal(context.bpm().toString());
  const [tempBeatsPerBar, setTempBeatsPerBar] = createSignal(
    context.beatsPerBar().toString(),
  );
  const [awaitingManualDetectionStart, setAwaitingManualDetectionStart] =
    createSignal(false);
  const [pendingManualDetectionRequestId, setPendingManualDetectionRequestId] =
    createSignal<string | undefined>(undefined);
  const [lastAppliedDetectionRequestId, setLastAppliedDetectionRequestId] =
    createSignal<string | undefined>(undefined);

  const timeline = () => $timelines()[context.timelineUid];

  const beatgridProposal = () => $beatgridProposals()[context.timelineUid];

  const detectionStatus = () =>
    $beatgridDetectionStatus()[context.timelineUid] ?? {
      phase: "idle",
    };

  const isDetecting = () => detectionStatus().phase === "detecting";

  const clearBeatgridPreviewState = () => {
    const nextPreview = { ...timelineBeatgridPreview.get() };
    delete nextPreview[context.timelineUid];
    setStoreAction(
      timelineBeatgridPreview,
      "Clear Beatgrid Preview State",
      nextPreview,
    );
  };

  const clearLocalProposalState = () => {
    clearBeatgridPreviewState();

    const nextProposals = { ...timelineBeatgridProposals.get() };
    delete nextProposals[context.timelineUid];
    setStoreAction(
      timelineBeatgridProposals,
      "Clear Beatgrid Proposal State",
      nextProposals,
    );

    const nextStatus = { ...timelineBeatgridDetectionStatus.get() };
    nextStatus[context.timelineUid] = { phase: "idle" };
    setStoreAction(
      timelineBeatgridDetectionStatus,
      "Reset Beatgrid Detection Status",
      nextStatus,
    );
  };

  createEffect(() => {
    setTempBpm(context.bpm().toString());
  });

  createEffect(() => {
    setTempBeatsPerBar(context.beatsPerBar().toString());
  });

  createEffect(() => {
    if (!awaitingManualDetectionStart()) return;
    const status = detectionStatus();
    if (status.phase !== "detecting" || !status.requestId) return;

    setPendingManualDetectionRequestId(status.requestId);
    setAwaitingManualDetectionStart(false);
  });

  createEffect(() => {
    const proposal = beatgridProposal();
    const status = detectionStatus();
    const timelineValue = timeline();
    if (!proposal || status.phase !== "ready") return;
    if (!timelineValue) return;

    const pendingRequestId = pendingManualDetectionRequestId();
    if (!pendingRequestId) return;
    if (status.requestId && status.requestId !== proposal.request_id) return;
    if (proposal.request_id !== pendingRequestId) return;
    if (lastAppliedDetectionRequestId() === proposal.request_id) return;

    const command: types.TimelineCommand = {
      type: "ApplyBeatgridProposal",
      data: {
        timeline_id: timelineValue.identifiers.id,
        request_id: proposal.request_id,
        beats_per_bar: context.beatsPerBar(),
        downbeat_offset: 0,
      },
    };
    engineRuntime.sendCommand({ module: "TimelineCommand", command });

    setLastAppliedDetectionRequestId(proposal.request_id);
    setPendingManualDetectionRequestId(undefined);
    clearLocalProposalState();
  });

  createEffect(() => {
    const status = detectionStatus();
    const pendingRequestId = pendingManualDetectionRequestId();
    if (status.phase !== "failed") return;

    if (!pendingRequestId && awaitingManualDetectionStart()) {
      setAwaitingManualDetectionStart(false);
      return;
    }

    if (
      pendingRequestId &&
      (!status.requestId || status.requestId === pendingRequestId)
    ) {
      setPendingManualDetectionRequestId(undefined);
      setAwaitingManualDetectionStart(false);
    }
  });

  /** Updates the tempo draft and publishes valid bounded values. */
  const handleBpmChange = (value: string) => {
    setTempBpm(value);
    const bpmValue = parseBeatgridBpmInput(value);
    if (
      bpmValue !== undefined &&
      bpmValue >= mprops.minBpm &&
      bpmValue <= mprops.maxBpm
    ) {
      context.setBpm(bpmValue);
    }
  };

  const handleBpmInputBlur = () => {
    const bpmValue = parseBeatgridBpmInput(tempBpm());
    if (
      bpmValue === undefined ||
      bpmValue < mprops.minBpm ||
      bpmValue > mprops.maxBpm
    ) {
      setTempBpm(context.bpm().toString());
    }
  };

  const handleBeatsPerBarChange = (e: InputEvent) => {
    const input = e.target as HTMLInputElement;
    setTempBeatsPerBar(input.value);

    const beatsValue = Number.parseInt(input.value, 10);
    if (
      !Number.isNaN(beatsValue) &&
      beatsValue >= mprops.minBeatsPerBar &&
      beatsValue <= mprops.maxBeatsPerBar
    ) {
      context.setBeatsPerBar(beatsValue);
    }
  };

  const handleBeatsPerBarInputBlur = () => {
    const beatsValue = Number.parseInt(tempBeatsPerBar(), 10);
    if (
      Number.isNaN(beatsValue) ||
      beatsValue < mprops.minBeatsPerBar ||
      beatsValue > mprops.maxBeatsPerBar
    ) {
      setTempBeatsPerBar(context.beatsPerBar().toString());
    }
  };

  const modelDownload = createBeatModelDownload();
  const [controlsOpen, setControlsOpen] = createSignal(false);

  /** Start analysis only after the user has an installed model. */
  const requestBeatgridDetection = () => {
    const timelineValue = timeline();
    if (!timelineValue || isDetecting()) return;

    clearLocalProposalState();
    setAwaitingManualDetectionStart(true);
    setPendingManualDetectionRequestId(undefined);

    const command: types.TimelineCommand = {
      type: "RequestBeatgridDetection",
      data: {
        timeline_id: timelineValue.identifiers.id,
      },
    };
    engineRuntime.sendCommand({ module: "TimelineCommand", command });
  };

  return (
    <div class="flex items-center gap-1">
      {modelDownload.dialog()}
      <div
        data-timeline-beatgrid-toggle="true"
        data-timeline-uid={context.timelineUid}
        class="flex min-h-[30px] items-center"
      >
        <ToggleSwitch
          ariaLabel="Use beatgrid"
          label="BPM"
          checked={context.useBeatgrid()}
          onChange={(enabled) => context.setUseBeatgrid(enabled)}
        />
      </div>

      <DropdownMenu
        open={controlsOpen()}
        onOpenChange={setControlsOpen}
        placement="below"
        align="end"
        triggerLabel="BPM controls"
        trigger={<CaretDownIcon class="size-4" aria-hidden />}
      >
        <div class="w-72 py-1" data-menu-kind="beatgrid-controls">
          <div class="flex items-center justify-between gap-3 px-3 py-2">
            <div>
              <div class="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Beatgrid
              </div>
              <div class="text-xs text-neutral-500">
                {context.useBeatgrid()
                  ? "BPM ruler active"
                  : "Time ruler active"}
              </div>
            </div>
            <Button
              size="compact"
              type="button"
              onClick={() => {
                setControlsOpen(false);
                modelDownload.request(requestBeatgridDetection);
              }}
              disabled={!timeline() || isDetecting()}
            >
              {isDetecting() ? "Detecting..." : "Detect"}
            </Button>
          </div>
          <DropdownMenuSeparator />
          <div class="space-y-3 px-3 py-2">
            <label class="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-3">
              <span class="text-xs text-neutral-300">BPM rate</span>
              <NumericStepper
                type="text"
                inputMode="decimal"
                density="compact"
                aria-label="Beatgrid BPM"
                min={mprops.minBpm}
                max={mprops.maxBpm}
                step="any"
                fallbackValue={context.bpm()}
                value={tempBpm()}
                onValueChange={handleBpmChange}
                onBlur={handleBpmInputBlur}
                decreaseLabel="Decrease BPM rate"
                increaseLabel="Increase BPM rate"
                unit="BPM"
              />
            </label>
            <label class="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-3">
              <span class="text-xs text-neutral-300">Beats/bar</span>
              <Input
                density="compact"
                type="text"
                aria-label="Beats per bar"
                value={tempBeatsPerBar()}
                onInput={handleBeatsPerBarChange}
                onBlur={handleBeatsPerBarInputBlur}
                class="w-16 text-center"
              />
            </label>
          </div>
        </div>
      </DropdownMenu>
    </div>
  );
};
