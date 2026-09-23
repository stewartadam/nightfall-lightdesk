// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createMemo, For, Show } from "solid-js";
import { Input, NativeSelect } from "../../../components/ui/form-controls";
import ColorPicker from "../../../components/widgets/color-picker";
import {
  colorStringToHsv,
  hsvToRgb,
} from "../../../components/widgets/color-picker/model";
import { blueprints } from "../../../state/appStores";
import type * as types from "../../../types";
import {
  resolvedStepFxColor,
  stepFxBlueprintColor,
  stepFxColorComponentTrack,
  stepFxColorCss,
} from "../model/step-fx-color-model";
import {
  buildStepFxWaveformModel,
  sampleStepFxWaveform,
} from "../model/step-fx-waveform-model";

const BUTTON =
  "rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-700 disabled:opacity-40";

/** Edits whole-color targets and shared step shapes while keeping Blueprint values read-only. */
export function StepFxColorLaneEditor(props: {
  lane: types.FxColorLane;
  onChange: (lane: types.FxColorLane) => void;
}) {
  const storedBlueprints = useStore(blueprints);
  /** Keeps referenced swatches in sync with the Blueprint store. */
  const allBlueprints = createMemo(() => Object.values(storedBlueprints()));
  /** Offers only Blueprints with a complete absolute RGB color. */
  const colorBlueprints = createMemo(() =>
    allBlueprints().filter((blueprint) => stepFxBlueprintColor(blueprint)),
  );
  /** Samples the same shaped RGB component tracks used by the engine's color interpolation. */
  const preview = createMemo(() => {
    const models = (["red", "green", "blue"] as const).map((component) =>
      buildStepFxWaveformModel(
        stepFxColorComponentTrack(props.lane, component, allBlueprints()),
      ),
    );
    return Array.from({ length: 160 }, (_, index) => {
      const values = models.map((model) =>
        model
          ? (sampleStepFxWaveform(model, (model.totalBeats * index) / 160)
              ?.value ?? 0)
          : 0,
      );
      return stepFxColorCss({
        red: values[0],
        green: values[1],
        blue: values[2],
      });
    });
  });
  /** Applies an immutable change so editor undo/save and preview observe one complete draft. */
  function edit(change: (steps: types.FxColorStep[]) => void): void {
    const lane = structuredClone(props.lane);
    change(lane.steps);
    props.onChange(lane);
  }
  /** Copies a step after its source while assigning a fresh identity. */
  function duplicate(index: number): void {
    edit((steps) =>
      steps.splice(index + 1, 0, {
        ...structuredClone(steps[index]),
        uid: crypto.randomUUID(),
      }),
    );
  }

  return (
    <div
      class="flex min-h-0 flex-1 flex-col overflow-auto"
      data-step-fx-color-editor
    >
      <div class="flex h-12 shrink-0 items-center gap-3 border-b border-neutral-700 px-3">
        <button
          type="button"
          class={BUTTON}
          onClick={() => duplicate(props.lane.steps.length - 1)}
          disabled={!props.lane.steps.length}
        >
          Add color step
        </button>
        <span class="text-xs text-neutral-400">
          Absolute color · shared speed and spread
        </span>
      </div>
      <div class="space-y-4 p-4">
        <For each={props.lane.steps.map((step) => step.uid.replace(/-/g, ""))}>
          {(uid, index) => {
            /** Retrieves the current immutable step without remounting the picker while dragging. */
            const step = () =>
              props.lane.steps.find(
                (candidate) => candidate.uid.replace(/-/g, "") === uid,
              )!;
            /** Reads the live referenced color or the authored inline target. */
            const color = () => resolvedStepFxColor(step(), allBlueprints());
            /** Normalizes UUID wire formats before matching native select option values. */
            const blueprintUid = () =>
              step().blueprint_uid?.replace(/-/g, "").toLowerCase() ?? "";
            return (
              <section
                class="rounded border border-neutral-700 bg-neutral-900 p-3"
                aria-label={`Color step ${index() + 1}`}
              >
                <div class="mb-3 flex items-center gap-2">
                  <span class="text-sm font-medium">Step {index() + 1}</span>
                  <NativeSelect
                    aria-label={`Step ${index() + 1} color source`}
                    class="ml-2 min-w-0 flex-1"
                    value={blueprintUid()}
                    onChange={(event) => {
                      const uid = event.currentTarget.value;
                      if (!uid && step().blueprint_uid) return;
                      const blueprint = colorBlueprints().find(
                        (item) =>
                          item.identifiers.uid
                            .replace(/-/g, "")
                            .toLowerCase() === uid,
                      );
                      edit((steps) => {
                        steps[index()].blueprint_uid = uid || undefined;
                        if (blueprint)
                          steps[index()].target =
                            stepFxBlueprintColor(blueprint)!;
                      });
                    }}
                  >
                    <Show when={!step().blueprint_uid}>
                      <option value="">Custom color</option>
                    </Show>
                    <Show
                      when={
                        step().blueprint_uid &&
                        !colorBlueprints().some(
                          (item) =>
                            item.identifiers.uid
                              .replace(/-/g, "")
                              .toLowerCase() === blueprintUid(),
                        )
                      }
                    >
                      <option value={blueprintUid()}>
                        Unavailable Blueprint (saved color)
                      </option>
                    </Show>
                    <For each={colorBlueprints()}>
                      {(blueprint) => (
                        <option
                          value={blueprint.identifiers.uid
                            .replace(/-/g, "")
                            .toLowerCase()}
                        >
                          {blueprint.identifiers.id}:{" "}
                          {blueprint.identifiers.label}
                        </option>
                      )}
                    </For>
                  </NativeSelect>
                  <button
                    type="button"
                    class={BUTTON}
                    aria-label={`Move color step ${index() + 1} up`}
                    disabled={index() === 0}
                    onClick={() =>
                      edit((steps) => {
                        const [moved] = steps.splice(index(), 1);
                        steps.splice(index() - 1, 0, moved);
                      })
                    }
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    class={BUTTON}
                    aria-label={`Duplicate color step ${index() + 1}`}
                    onClick={() => duplicate(index())}
                  >
                    Duplicate
                  </button>
                  <button
                    type="button"
                    class={BUTTON}
                    aria-label={`Delete color step ${index() + 1}`}
                    disabled={props.lane.steps.length <= 2}
                    onClick={() =>
                      edit((steps) => {
                        steps.splice(index(), 1);
                      })
                    }
                  >
                    Delete
                  </button>
                </div>
                <Show
                  when={!step().blueprint_uid}
                  fallback={
                    <div class="flex items-center gap-3">
                      <span
                        class="h-9 w-16 rounded border border-neutral-600"
                        style={{ background: stepFxColorCss(color()) }}
                      />
                      <span class="text-xs text-neutral-400">
                        Live Blueprint reference — edit the Blueprint to change
                        this color.
                      </span>
                    </div>
                  }
                >
                  <details class="mb-3">
                    <summary
                      class="flex cursor-pointer items-center gap-3 text-sm"
                      aria-label={`Edit step ${index() + 1} color`}
                    >
                      <span
                        class="h-9 w-16 rounded border border-neutral-600"
                        style={{ background: stepFxColorCss(color()) }}
                      />
                      Choose color
                    </summary>
                    <div class="mt-3 max-w-sm">
                      <ColorPicker
                        value={colorStringToHsv(stepFxColorCss(color()))}
                        onChange={(value) => {
                          const [red, green, blue] = hsvToRgb(value).map(
                            (component) => component / 255,
                          );
                          edit((steps) => {
                            steps[index()].target = { red, green, blue };
                          });
                        }}
                      />
                    </div>
                  </details>
                </Show>
                <div class="mt-3 grid grid-cols-4 gap-3">
                  <label class="text-xs text-neutral-400">
                    Width (beats)
                    <Input
                      aria-label={`Color step ${index() + 1} width`}
                      type="number"
                      min="0.001"
                      step="0.1"
                      value={step().width_beats}
                      onChange={(event) => {
                        const value = event.currentTarget.valueAsNumber;
                        if (value > 0)
                          edit((steps) => {
                            steps[index()].width_beats = value;
                          });
                      }}
                    />
                  </label>
                  <For each={["start", "end"] as const}>
                    {(edge) => (
                      <label class="text-xs text-neutral-400">
                        Ramp {edge} (%)
                        <Input
                          aria-label={`Color step ${index() + 1} ramp ${edge}`}
                          type="number"
                          min="0"
                          max="100"
                          value={step().transition[edge] * 100}
                          onChange={(event) => {
                            const value =
                              event.currentTarget.valueAsNumber / 100;
                            if (
                              Number.isFinite(value) &&
                              value >= 0 &&
                              value <= 1
                            )
                              edit((steps) => {
                                steps[index()].transition[edge] = value;
                              });
                          }}
                        />
                      </label>
                    )}
                  </For>
                  <label class="text-xs text-neutral-400">
                    Shape
                    <NativeSelect
                      aria-label={`Color step ${index() + 1} shape`}
                      value={step().curve.type}
                      onChange={(event) =>
                        edit((steps) => {
                          const type = event.currentTarget.value;
                          steps[index()].curve =
                            type === "Bezier"
                              ? {
                                  type: "Bezier",
                                  data: {
                                    cp1: { x: 0.42, y: 0 },
                                    cp2: { x: 0.58, y: 1 },
                                  },
                                }
                              : type === "Snap"
                                ? { type: "Snap", data: {} }
                                : { type: "Linear", data: {} };
                        })
                      }
                    >
                      <option value="Linear">Linear</option>
                      <option value="Snap">Snap</option>
                      <option value="Bezier">Smooth</option>
                    </NativeSelect>
                  </label>
                </div>
              </section>
            );
          }}
        </For>
        <div>
          <div class="mb-2 text-xs text-neutral-400">
            Forward color cycle · previous color → step target
          </div>
          <div
            class="flex h-12 overflow-hidden rounded border border-neutral-700"
            role="img"
            aria-label="Color cycle preview"
          >
            <For each={preview()}>
              {(color) => (
                <span class="min-w-0 flex-1" style={{ background: color }} />
              )}
            </For>
          </div>
        </div>
      </div>
    </div>
  );
}
