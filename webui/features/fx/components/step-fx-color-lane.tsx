// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ArrowDownIcon } from "@squidlab/phosphor-solid/arrow-down";
import { ArrowUpIcon } from "@squidlab/phosphor-solid/arrow-up";
import { CopySimpleIcon } from "@squidlab/phosphor-solid/copy-simple";
import { DivideIcon } from "@squidlab/phosphor-solid/divide";
import { LinkIcon } from "@squidlab/phosphor-solid/link";
import { PlusIcon } from "@squidlab/phosphor-solid/plus";
import { TrashIcon } from "@squidlab/phosphor-solid/trash";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { DropdownMenu } from "../../../components/ui/dropdown-menu";
import { Input, NativeSelect } from "../../../components/ui/form-controls";
import { Table } from "../../../components/ui/table";
import { ToolbarButton } from "../../../components/ui/toolbar-button";
import ColorPicker from "../../../components/widgets/color-picker";
import { colorStringToHsv } from "../../../components/widgets/color-picker/model";
import { durationToSeconds } from "../../../lib/duration";
import type * as types from "../../../types";
import { ColorInterpolationSpace, HueDirection } from "../../../types";
import {
  blueprintStepFxColor,
  createStepFxColorStep,
  findBlueprint,
  resolvedStepFxColor,
  STEP_FX_COLOR_SPACES,
  stepFxColorCycleGradient,
  stepFxColorFromHex,
  stepFxColorLaneStepIndexAt,
  stepFxColorToHex,
} from "../model/step-fx-color-model";
import {
  deleteStepFxSteps,
  distributeStepFxWidthsEvenly,
  duplicateStepFxSteps,
  editStepFxSteps,
  formatStepFxWidthBeats,
  reorderStepFxSteps,
  roundStepFxWidthBeats,
  stepFxPhaseSlots,
} from "../model/step-fx-editor-model";
import { stepFxColorPreviewCyclePosition } from "../model/step-fx-preview-clock";
import {
  StepFxCurveSelect,
  StepFxOverridesControl,
} from "./step-fx-step-controls";

const FIELD_CLASS = "nf-form-control min-w-0";

/** Operator-facing names for the supported interpolation spaces. */
const SPACE_LABELS: Record<string, string> = {
  [ColorInterpolationSpace.Rgb]: "RGB",
  [ColorInterpolationSpace.Hsv]: "HSV",
  [ColorInterpolationSpace.Cmy]: "CMY",
};

/** Operator-facing names for hue routes. */
const HUE_DIRECTION_LABELS: Record<string, string> = {
  [HueDirection.Shortest]: "Shortest",
  [HueDirection.Clockwise]: "Clockwise",
  [HueDirection.CounterClockwise]: "Counter-clockwise",
};

/** One Blueprint that carries a color, with its resolved swatch. */
interface ColorBlueprint {
  blueprint: types.Blueprint;
  color: types.ColorPathRgb;
}

export interface StepFxColorLaneEditorProps {
  /** Complete draft, supplying direction and the effect-wide timing and phase. */
  stepFx: types.StepFx;
  /** Color lane being edited. */
  lane: types.FxColorLane;
  /** Labels of the non-empty selection indexes, in phase order. */
  selectionLabels: readonly string[];
  /** Blueprints available as live color sources. */
  blueprints: Record<string, types.Blueprint>;
  /** Localized draft validation messages keyed by model path. */
  issuesByPath: ReadonlyMap<string, string[]>;
  /** Whether the lane overrides menu is open. */
  overridesOpen: boolean;
  /** Requests the lane overrides menu open or closed. */
  onOverridesOpenChange: (isOpen: boolean) => void;
  /** Publishes a complete replacement lane. */
  onChange: (lane: types.FxColorLane) => void;
  /** Whether this editor's preview session is running. */
  previewActive: boolean;
  /** Backend clock anchor for this editor's preview session, once it has published one. */
  previewStatus?: types.StepFxPreviewPlaybackStatus;
}

/** Edits the color lane: its steps, interpolation space, overrides, and cycle preview. */
export function StepFxColorLaneEditor(props: StepFxColorLaneEditorProps) {
  const [selectedUids, setSelectedUids] = createSignal<ReadonlySet<string>>(
    new Set(),
  );

  /** Lists Blueprints holding a color, ordered by their numeric ID. */
  const colorBlueprints = createMemo<ColorBlueprint[]>(() =>
    Object.values(props.blueprints)
      .flatMap((blueprint) => {
        const color = blueprintStepFxColor(blueprint);
        return color ? [{ blueprint, color }] : [];
      })
      .sort(
        (left, right) =>
          left.blueprint.identifiers.id - right.blueprint.identifiers.id,
      ),
  );

  /** Resolves one start position per selection index from the lane's effective phase. */
  const startPositions = createMemo(() =>
    stepFxPhaseSlots(
      props.lane.phase_override ?? props.stepFx.phase,
      Math.max(1, props.selectionLabels.length),
    ),
  );

  const [previewEpochMs, setPreviewEpochMs] = createSignal(Date.now());
  let previewFrame: number | undefined;

  /** Refreshes browser time each frame so the playhead interpolates between backend anchors. */
  const animatePreview = (): void => {
    setPreviewEpochMs(Date.now());
    previewFrame = requestAnimationFrame(animatePreview);
  };

  /** Runs the playhead clock only while this session's preview has a backend anchor. */
  createEffect(() => {
    if (!props.previewActive || !props.previewStatus) {
      if (previewFrame !== undefined) cancelAnimationFrame(previewFrame);
      previewFrame = undefined;
      return;
    }
    if (previewFrame === undefined)
      previewFrame = requestAnimationFrame(animatePreview);
  });

  /** Stops the playhead clock when the editor unmounts. */
  onCleanup(() => {
    if (previewFrame !== undefined) cancelAnimationFrame(previewFrame);
  });

  /** Shared elapsed cycle position marking "now" on every fixture's gradient, while previewing. */
  const playheadPosition = createMemo(() => {
    if (!props.previewActive) return undefined;
    const passBeats = props.lane.steps.reduce(
      (total, step) => total + step.width_beats,
      0,
    );
    return stepFxColorPreviewCyclePosition(
      props.previewStatus,
      passBeats,
      durationToSeconds(
        (props.lane.timing_override ?? props.stepFx.timing).beat_duration,
      ),
      previewEpochMs(),
      props.stepFx.direction,
      props.stepFx.cycle_scale,
    );
  });

  /** Step the first selection index is playing, highlighted in the step table. */
  const liveStepIndex = createMemo(() => {
    const position = playheadPosition();
    if (position === undefined) return undefined;
    return stepFxColorLaneStepIndexAt(
      props.lane,
      props.stepFx.direction,
      position,
      startPositions()[0] ?? 0,
    );
  });

  /** Keeps only selected steps that still exist in the lane. */
  const liveSelection = createMemo(() => {
    const uids = new Set(props.lane.steps.map((step) => step.uid));
    return new Set([...selectedUids()].filter((uid) => uids.has(uid)));
  });

  /** Replaces the lane's steps while preserving its other fields. */
  const setSteps = (steps: types.FxColorStep[]): void =>
    props.onChange({ ...structuredClone(props.lane), steps });

  /** Applies one edit to a single step by identity. */
  const editStep = (
    uid: string,
    edit: (step: types.FxColorStep) => types.FxColorStep,
  ): void => setSteps(editStepFxSteps(props.lane, new Set([uid]), edit).steps);

  /** Selects one step, extending or toggling the selection with modifier keys. */
  const toggleStep = (uid: string, toggle: boolean): void => {
    if (!toggle) {
      setSelectedUids(new Set([uid]));
      return;
    }
    const next = new Set(liveSelection());
    if (next.has(uid)) next.delete(uid);
    else next.add(uid);
    setSelectedUids(next);
  };

  /** Appends a step after the selection, copying the last selected step when there is one. */
  const addStep = (color?: types.ColorPathRgb, blueprintUid?: string): void => {
    const steps = props.lane.steps.map((step) => structuredClone(step));
    const selectedIndexes = steps
      .map((step, index) => (liveSelection().has(step.uid) ? index : -1))
      .filter((index) => index >= 0);
    const anchor =
      selectedIndexes.length > 0
        ? selectedIndexes[selectedIndexes.length - 1]
        : steps.length - 1;
    const source = steps[anchor];
    const step = source
      ? { ...structuredClone(source), uid: crypto.randomUUID() }
      : createStepFxColorStep({ red: 1, green: 1, blue: 1 });
    if (color) {
      step.color = { ...color };
      step.blueprint_uid = blueprintUid;
    }
    steps.splice(anchor + 1, 0, step);
    setSteps(steps);
    setSelectedUids(new Set([step.uid]));
  };

  /**
   * Applies a Blueprint color: selected steps take it as their live source, otherwise it is
   * appended as a new step so consecutive clicks build the sequence.
   */
  const applyBlueprint = (entry: ColorBlueprint): void => {
    const uid = entry.blueprint.identifiers.uid;
    if (liveSelection().size === 0) {
      const steps = props.lane.steps.map((step) => structuredClone(step));
      const step =
        steps.length > 0
          ? {
              ...structuredClone(steps[steps.length - 1]),
              uid: crypto.randomUUID(),
            }
          : createStepFxColorStep(entry.color);
      step.color = { ...entry.color };
      step.blueprint_uid = uid;
      steps.push(step);
      setSteps(steps);
      return;
    }
    setSteps(
      editStepFxSteps(props.lane, liveSelection(), (step) => ({
        ...step,
        color: { ...entry.color },
        blueprint_uid: uid,
      })).steps,
    );
  };

  /** Duplicates the selected steps directly after their originals. */
  const duplicateSteps = (): void => {
    const result = duplicateStepFxSteps(props.lane, liveSelection());
    setSteps(result.track.steps);
    setSelectedUids(result.selectedUids);
  };

  /** Deletes the selected steps and keeps the nearest survivor selected. */
  const deleteSteps = (): void => {
    const result = deleteStepFxSteps(props.lane, liveSelection());
    setSteps(result.track.steps);
    setSelectedUids(result.selectedUids);
  };

  /** Moves the selected steps one position earlier or later. */
  const moveSteps = (direction: -1 | 1): void =>
    setSteps(reorderStepFxSteps(props.lane, liveSelection(), direction).steps);

  /** Shares the selected (or all) step widths evenly. */
  const distributeWidths = (): void =>
    setSteps(distributeStepFxWidthsEvenly(props.lane, liveSelection()).steps);

  /**
   * Stable row keys: string uids compare by value, so rebuilt step objects keep their
   * row (and any open color picker) instead of remounting it.
   */
  const stepUids = createMemo(() => props.lane.steps.map((step) => step.uid));

  /** Returns the first validation message at a step path or any of its fields. */
  const issueAt = (path: string): string | undefined =>
    [...props.issuesByPath.entries()].find(
      ([issuePath]) => issuePath === path || issuePath.startsWith(`${path}.`),
    )?.[1][0];

  const hasSelection = () => liveSelection().size > 0;

  return (
    <div class="flex min-h-0 flex-1 flex-col" data-step-fx-color-lane>
      <div
        class="flex h-12 min-w-0 shrink-0 items-center gap-0.5 border-b border-neutral-700 bg-neutral-900 px-2"
        role="toolbar"
        aria-label="Color step actions"
      >
        <ToolbarButton label="Add color step" onClick={() => addStep()}>
          <PlusIcon class="size-4" weight="bold" aria-hidden />
        </ToolbarButton>
        <ToolbarButton
          label="Move selected color steps up"
          onClick={() => moveSteps(-1)}
          disabled={!hasSelection()}
          classList={{ "cursor-not-allowed opacity-40": !hasSelection() }}
        >
          <ArrowUpIcon class="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton
          label="Move selected color steps down"
          onClick={() => moveSteps(1)}
          disabled={!hasSelection()}
          classList={{ "cursor-not-allowed opacity-40": !hasSelection() }}
        >
          <ArrowDownIcon class="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton
          label="Duplicate selected color steps"
          onClick={duplicateSteps}
          disabled={!hasSelection()}
          classList={{ "cursor-not-allowed opacity-40": !hasSelection() }}
        >
          <CopySimpleIcon class="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton
          label="Divide color step widths evenly"
          onClick={distributeWidths}
          disabled={props.lane.steps.length < 2}
          classList={{
            "cursor-not-allowed opacity-40": props.lane.steps.length < 2,
          }}
        >
          <DivideIcon class="size-4" aria-hidden />
        </ToolbarButton>
        <ToolbarButton
          label="Delete selected color steps"
          onClick={deleteSteps}
          disabled={!hasSelection()}
          classList={{
            "bg-red-500/20 text-red-100 hover:bg-red-500/30": hasSelection(),
            "cursor-not-allowed opacity-40": !hasSelection(),
          }}
        >
          <TrashIcon class="size-4" aria-hidden />
        </ToolbarButton>
        <div class="ml-auto flex min-w-0 items-center gap-1">
          <NativeSelect
            density="compact"
            aria-label="Color interpolation space"
            class="h-8 w-24 min-w-0 shrink rounded border border-neutral-700 bg-neutral-800 px-2 pe-7 text-xs text-neutral-200"
            value={props.lane.interpolation_space}
            onChange={(event) =>
              props.onChange({
                ...structuredClone(props.lane),
                interpolation_space: event.currentTarget
                  .value as types.ColorInterpolationSpace,
              })
            }
          >
            <For each={STEP_FX_COLOR_SPACES}>
              {(space) => <option value={space}>{SPACE_LABELS[space]}</option>}
            </For>
          </NativeSelect>
          <Show
            when={
              props.lane.interpolation_space === ColorInterpolationSpace.Hsv
            }
          >
            <NativeSelect
              density="compact"
              aria-label="Hue direction"
              class="h-8 w-32 min-w-0 shrink rounded border border-neutral-700 bg-neutral-800 px-2 pe-7 text-xs text-neutral-200"
              value={props.lane.hue_direction}
              onChange={(event) =>
                props.onChange({
                  ...structuredClone(props.lane),
                  hue_direction: event.currentTarget
                    .value as types.HueDirection,
                })
              }
            >
              <For each={Object.values(HueDirection)}>
                {(direction) => (
                  <option value={direction}>
                    {HUE_DIRECTION_LABELS[direction]}
                  </option>
                )}
              </For>
            </NativeSelect>
          </Show>
          <span class="mx-1 h-6 w-px shrink-0 bg-neutral-700" aria-hidden />
          <div class="shrink-0">
            <StepFxOverridesControl
              lane={props.lane}
              overall={props.stepFx}
              open={props.overridesOpen}
              onOpenChange={props.onOverridesOpenChange}
              onLaneChange={props.onChange}
            />
          </div>
        </div>
      </div>

      <div
        class="flex min-h-9 shrink-0 items-center gap-1.5 overflow-x-auto border-b border-neutral-800 px-2 py-1.5"
        role="group"
        aria-label="Color Blueprints"
        data-step-fx-color-blueprints
      >
        <span class="shrink-0 text-[11px] uppercase tracking-wider text-neutral-500">
          Blueprints
        </span>
        <Show
          when={colorBlueprints().length > 0}
          fallback={
            <span class="text-xs text-neutral-500">
              Store Blueprints with color values to add steps with one click.
            </span>
          }
        >
          <For each={colorBlueprints()}>
            {(entry) => (
              <button
                type="button"
                class="flex shrink-0 items-center gap-1.5 rounded border border-neutral-700 bg-neutral-800 px-1.5 py-1 text-xs text-neutral-200 hover:border-neutral-500"
                title={
                  hasSelection()
                    ? `Use ${entry.blueprint.identifiers.label} for the selected steps`
                    : `Add a ${entry.blueprint.identifiers.label} step`
                }
                onClick={() => applyBlueprint(entry)}
                data-step-fx-color-blueprint={entry.blueprint.identifiers.id}
              >
                <span
                  class="size-4 rounded-sm border border-black/40"
                  style={{ background: stepFxColorToHex(entry.color) }}
                  aria-hidden
                />
                <span class="max-w-28 truncate">
                  {entry.blueprint.identifiers.label ||
                    `Blueprint ${entry.blueprint.identifiers.id}`}
                </span>
              </button>
            )}
          </For>
        </Show>
      </div>

      <div class="min-h-0 flex-1 overflow-auto" data-step-fx-color-sheet>
        <Table class="w-full table-fixed border-collapse text-sm">
          <colgroup>
            <col class="w-12" />
            <col />
            <col class="w-24" />
            <col class="w-24" />
            <col class="w-24" />
            <col class="w-32" />
          </colgroup>
          <thead class="sticky top-0 z-10 bg-neutral-900 text-left text-xs text-neutral-400">
            <tr>
              <th class="px-2 py-1.5 font-normal">Step</th>
              <th class="px-2 py-1.5 font-normal">Color</th>
              <th class="px-2 py-1.5 font-normal">Width</th>
              <th class="px-2 py-1.5 font-normal">Ramp start</th>
              <th class="px-2 py-1.5 font-normal">Ramp end</th>
              <th class="px-2 py-1.5 font-normal">Curve</th>
            </tr>
          </thead>
          <tbody>
            <For each={stepUids()}>
              {(uid, index) => {
                /** Reads this row's current step; rows are keyed by uid so edits keep open popovers mounted. */
                const step = () => props.lane.steps[index()];
                const path = () => `color.steps.${index()}`;
                const color = () =>
                  resolvedStepFxColor(step(), props.blueprints);
                const blueprint = () => {
                  const blueprintUid = step().blueprint_uid;
                  return blueprintUid
                    ? findBlueprint(props.blueprints, blueprintUid)
                    : undefined;
                };
                return (
                  <tr
                    class="border-b border-neutral-800 transition-shadow duration-200 ease-out motion-reduce:transition-none"
                    classList={{
                      "bg-[var(--accent-soft)]": liveSelection().has(uid),
                      "ring-1 ring-inset ring-amber-300/70":
                        liveStepIndex() === index(),
                    }}
                    aria-current={
                      liveStepIndex() === index() ? "step" : undefined
                    }
                    data-step-fx-color-step={index()}
                    data-live={liveStepIndex() === index() ? "true" : undefined}
                  >
                    <td class="px-2 py-1">
                      <button
                        type="button"
                        class="size-7 rounded border text-xs"
                        classList={{
                          "border-[var(--accent)] text-[var(--accent)]":
                            liveSelection().has(uid),
                          "border-neutral-700 bg-neutral-800 text-neutral-300":
                            !liveSelection().has(uid),
                          "border-red-500 text-red-200": Boolean(
                            issueAt(path()),
                          ),
                        }}
                        aria-pressed={liveSelection().has(uid)}
                        aria-label={`Select color step ${index() + 1}`}
                        title={issueAt(path())}
                        onClick={(event) =>
                          toggleStep(
                            uid,
                            event.metaKey || event.ctrlKey || event.shiftKey,
                          )
                        }
                      >
                        {index() + 1}
                      </button>
                    </td>
                    <td class="px-2 py-1">
                      <DropdownMenu
                        placement="below"
                        triggerLabel={`Step ${index() + 1} color`}
                        triggerClass="block w-full min-w-0"
                        contentLabel={`Step ${index() + 1} color`}
                        trigger={
                          <span class="flex min-w-0 items-center gap-2 rounded px-1 py-0.5 hover:bg-neutral-800">
                            <span
                              class="h-6 w-10 shrink-0 rounded border border-black/40"
                              style={{ background: stepFxColorToHex(color()) }}
                              data-step-fx-color-swatch={stepFxColorToHex(
                                color(),
                              )}
                            />
                            <span class="min-w-0 truncate text-xs text-neutral-300">
                              {blueprint()?.identifiers.label ??
                                stepFxColorToHex(color())}
                            </span>
                            <Show when={step().blueprint_uid}>
                              <LinkIcon
                                class="size-3.5 shrink-0 text-sky-300"
                                aria-label="Linked to a Blueprint"
                              />
                            </Show>
                          </span>
                        }
                      >
                        <div class="w-72 p-3" data-menu-kind="step-fx-color">
                          <ColorPicker
                            value={colorStringToHsv(stepFxColorToHex(color()))}
                            onChange={(value) =>
                              editStep(uid, (current) => ({
                                ...current,
                                color: stepFxColorFromHex(value.hex),
                                blueprint_uid: undefined,
                              }))
                            }
                          />
                        </div>
                      </DropdownMenu>
                    </td>
                    <td class="px-2 py-1">
                      <Input
                        density="compact"
                        type="number"
                        min="0.001"
                        step="0.25"
                        aria-label={`Step ${index() + 1} width in beats`}
                        class={`${FIELD_CLASS} w-full`}
                        value={formatStepFxWidthBeats(step().width_beats)}
                        onChange={(event) => {
                          const value = Number(event.currentTarget.value);
                          if (!Number.isFinite(value) || value <= 0) return;
                          editStep(uid, (current) => ({
                            ...current,
                            width_beats: roundStepFxWidthBeats(value),
                          }));
                        }}
                      />
                    </td>
                    <td class="px-2 py-1">
                      <Input
                        density="compact"
                        type="number"
                        min="0"
                        max="100"
                        aria-label={`Step ${index() + 1} ramp start percent`}
                        class={`${FIELD_CLASS} w-full`}
                        value={Math.round(step().transition.start * 100)}
                        onChange={(event) => {
                          const value = Number(event.currentTarget.value) / 100;
                          if (!Number.isFinite(value)) return;
                          editStep(uid, (current) => ({
                            ...current,
                            transition: {
                              start: Math.max(
                                0,
                                Math.min(current.transition.end, value),
                              ),
                              end: current.transition.end,
                            },
                          }));
                        }}
                      />
                    </td>
                    <td class="px-2 py-1">
                      <Input
                        density="compact"
                        type="number"
                        min="0"
                        max="100"
                        aria-label={`Step ${index() + 1} ramp end percent`}
                        class={`${FIELD_CLASS} w-full`}
                        value={Math.round(step().transition.end * 100)}
                        onChange={(event) => {
                          const value = Number(event.currentTarget.value) / 100;
                          if (!Number.isFinite(value)) return;
                          editStep(uid, (current) => ({
                            ...current,
                            transition: {
                              start: current.transition.start,
                              end: Math.min(
                                1,
                                Math.max(current.transition.start, value),
                              ),
                            },
                          }));
                        }}
                      />
                    </td>
                    <td class="px-2 py-1">
                      <StepFxCurveSelect
                        stepNumber={index() + 1}
                        curve={step().curve}
                        onChange={(curve) =>
                          editStep(uid, (current) => ({
                            ...current,
                            curve,
                          }))
                        }
                      />
                    </td>
                  </tr>
                );
              }}
            </For>
          </tbody>
        </Table>
      </div>

      <section
        class="max-h-[40%] shrink-0 overflow-y-auto border-t border-neutral-700 bg-neutral-900/60 px-2 py-2"
        aria-label="Color cycle preview"
        data-step-fx-color-preview
      >
        <div class="mb-1 text-[11px] uppercase tracking-wider text-neutral-500">
          One cycle per selection index
        </div>
        <div class="flex flex-col gap-1">
          <For each={startPositions()}>
            {(startPosition, index) => (
              <div class="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-2">
                <span class="truncate text-[11px] text-neutral-400">
                  {props.selectionLabels[index()] ?? `Index ${index() + 1}`}
                </span>
                <div
                  class="relative h-4 rounded-sm border border-black/40"
                  style={{
                    background: stepFxColorCycleGradient(
                      props.lane,
                      props.stepFx.direction,
                      startPosition,
                      props.blueprints,
                    ),
                  }}
                  data-step-fx-color-preview-row={index()}
                >
                  <Show when={playheadPosition() !== undefined}>
                    <span
                      class="pointer-events-none absolute -inset-y-0.5 w-0.5 -translate-x-1/2 rounded-full bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
                      style={{ left: `${(playheadPosition() ?? 0) * 100}%` }}
                      data-step-fx-color-playhead
                      aria-hidden
                    />
                  </Show>
                </div>
              </div>
            )}
          </For>
        </div>
      </section>
    </div>
  );
}
