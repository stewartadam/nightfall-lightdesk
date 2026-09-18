// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { CopySimpleIcon } from "@squidlab/phosphor-solid/copy-simple";
import { PlusIcon } from "@squidlab/phosphor-solid/plus";
import { TrashIcon } from "@squidlab/phosphor-solid/trash";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { useRevealObjectCapability } from "../../../components/providers/panel-capabilities/context-core";
import { Input, NativeSelect } from "../../../components/ui/form-controls";
import PanelToolbar from "../../../components/ui/panel-toolbar";
import { ToolbarButton } from "../../../components/ui/toolbar-button";
import {
  colorPathRoutePoints,
  hexToRgb,
  resolvedInterpolationSpace,
  rgbToHex,
} from "../../../lib/color-path-preview";
import {
  createDefaultColorPath,
  deleteColorPath,
  storeColorPath,
} from "../../../lib/color-path-service";
import type { BasePanelComponentProps } from "../../../lib/panel-registry";
import { colorPaths } from "../../../state/appStores";
import type * as types from "../../../types";
import { FadeCurve, HueDirection } from "../../../types";
import {
  ColorPathGradientCanvas,
  PreviewColorInput,
  TimingComponentEditor,
} from "../components/color-path-preview";
import { RouteOverlay } from "../components/color-path-route";
import {
  cloneColorPath,
  EDITABLE_INTERPOLATION_SPACES,
  isBuiltinColorPath,
  nextColorPathId,
  normalizedColorPath,
  PREVIEW_SAMPLE_COUNT,
  percentInputFraction,
  percentInputValue,
  previewPointWithDisplayColors,
  type RouteAnchor,
} from "../model/color-path-model";

export default function ColorPathPanel(props: BasePanelComponentProps) {
  const $colorPaths = useStore(colorPaths);
  const [selectedUid, setSelectedUid] = createSignal<string | null>(null);
  const [draft, setDraft] = createSignal<types.ColorPath | null>(null);
  const [startHex, setStartHex] = createSignal("#ff0000");
  const [endHex, setEndHex] = createSignal("#0000ff");

  /** Sorts color paths by numeric ID for stable list and editor navigation. */
  const pathList = createMemo(() =>
    Object.values($colorPaths()).sort(
      (left, right) => left.identifiers.id - right.identifiers.id,
    ),
  );

  /** Returns the currently selected persisted path, if it still exists. */
  const selectedPath = createMemo(() => {
    const uid = selectedUid();
    return uid ? ($colorPaths()[uid] ?? null) : null;
  });

  /** Returns whether the local draft represents a built-in read-only profile. */
  const draftReadOnly = createMemo(() => {
    const path = draft();
    return path ? isBuiltinColorPath(path) : false;
  });

  /** Computes the unified CIE preview model for swatches, controls, and route geometry. */
  const previewPoints = createMemo(() => {
    const path = draft();
    if (!path) return [];
    return colorPathRoutePoints(
      path,
      hexToRgb(startHex()),
      hexToRgb(endHex()),
      PREVIEW_SAMPLE_COUNT,
    ).map(previewPointWithDisplayColors);
  });

  /** Returns the fixture-space color shown for the source color control. */
  const startDisplayHex = createMemo(
    () => previewPoints()[0]?.fixtureHex ?? startHex(),
  );

  /** Returns the fixture-space color shown for the destination color control. */
  const endDisplayHex = createMemo(() => {
    const points = previewPoints();
    return points[points.length - 1]?.fixtureHex ?? endHex();
  });

  /** Keeps selection anchored to an available path as snapshots arrive. */
  createEffect(() => {
    const paths = pathList();
    if (paths.length === 0) {
      setSelectedUid(null);
      setDraft(null);
      return;
    }
    const uid = selectedUid();
    const selectedDraftUid = draft()?.identifiers.uid;
    if (
      !uid ||
      (!paths.some((path) => path.identifiers.uid === uid) &&
        selectedDraftUid !== uid)
    ) {
      setSelectedUid(paths[0].identifiers.uid);
    }
  });

  /** Refreshes the edit draft when the selected persisted path changes. */
  createEffect(() => {
    const path = selectedPath();
    if (!path) return;
    setDraft(cloneColorPath(path));
  });

  /** Selects and reveals a color path requested by the showfile object palette. */
  useRevealObjectCapability(
    props.id,
    (request) => {
      const path = $colorPaths()[request.uid];
      if (!path) return;
      setSelectedUid(path.identifiers.uid);
      setTimeout(() => {
        document
          .querySelector(`[data-color-path-uid="${path.identifiers.uid}"]`)
          ?.scrollIntoView({ block: "nearest" });
      }, 0);
    },
    { accepts: (payload) => payload.type === "colorPath" },
  );

  /** Updates the local draft and immediately persists editable color path definitions. */
  const updateDraft = (updater: (path: types.ColorPath) => types.ColorPath) => {
    if (draftReadOnly()) return;
    const current = draft();
    if (!current) return;
    const next = updater(cloneColorPath(current));
    setDraft(next);
    storeColorPath(normalizedColorPath(next));
  };

  /** Updates the source or destination preview color from a dragged CIE anchor. */
  const updatePreviewAnchorColor = (
    anchor: RouteAnchor,
    color: types.ColorPathRgb,
  ) => {
    if (anchor === "start") {
      setStartHex(rgbToHex(color));
    } else {
      setEndHex(rgbToHex(color));
    }
  };

  /** Creates a new custom color path with the next unused ID. */
  const handleCreate = () => {
    const nextId = nextColorPathId(pathList());
    const path = createDefaultColorPath(nextId);
    storeColorPath(path);
    setSelectedUid(path.identifiers.uid);
    setDraft(cloneColorPath(path));
  };

  /** Duplicates the current draft into a new custom color path. */
  const handleDuplicate = () => {
    const current = draft();
    if (!current) return;
    const nextId = nextColorPathId(pathList());
    const duplicate: types.ColorPath = {
      ...cloneColorPath(current),
      identifiers: {
        id: nextId,
        uid: crypto.randomUUID().replace(/-/g, ""),
        label: `${current.identifiers.label} Copy`,
      },
      interpolation_space: resolvedInterpolationSpace(current),
    };
    storeColorPath(duplicate);
    setSelectedUid(duplicate.identifiers.uid);
    setDraft(cloneColorPath(duplicate));
  };

  /** Deletes the current non-built-in color path. */
  const handleDelete = () => {
    const current = draft();
    if (!current || isBuiltinColorPath(current)) return;
    deleteColorPath(current.identifiers.id);
    setSelectedUid(null);
  };

  /** Stores a top-level timing component on the local draft. */
  const setTimingComponent = (
    key: "in_color" | "out_color",
    component: types.ColorPathTimingComponent | undefined,
  ) => {
    updateDraft((path) => ({
      ...path,
      timing: {
        ...path.timing,
        [key]: component,
      },
    }));
  };

  /** Updates the midpoint brightness scale on the local draft. */
  const updateMidpointBrightness = (value: string) => {
    const brightness = percentInputFraction(value);
    updateDraft((path) => ({
      ...path,
      timing: {
        ...path.timing,
        brightness_percent:
          Math.abs(brightness - 1) <= Number.EPSILON ? undefined : brightness,
      },
    }));
  };

  return (
    <div
      class="flex h-full min-h-0 flex-col bg-neutral-950 text-neutral-100"
      data-component="ColorPathPanel"
    >
      <PanelToolbar
        left={
          <>
            <ToolbarButton
              tooltip={"New color path"}
              type="button"
              label="New color path"
              onClick={handleCreate}
            >
              <PlusIcon class="size-4" aria-hidden />
            </ToolbarButton>
            <ToolbarButton
              tooltip={"Duplicate selected path"}
              type="button"
              label="Duplicate selected path"
              disabled={!draft()}
              onClick={handleDuplicate}
            >
              <CopySimpleIcon class="size-4" aria-hidden />
            </ToolbarButton>
            <ToolbarButton
              variant="danger"
              tooltip={"Delete selected path"}
              type="button"
              label="Delete selected path"
              disabled={
                !draft() || (draft() ? isBuiltinColorPath(draft()!) : true)
              }
              onClick={handleDelete}
            >
              <TrashIcon class="size-4" aria-hidden />
            </ToolbarButton>
          </>
        }
      />
      <div class="grid min-h-0 flex-1 grid-cols-[200px_minmax(0,1fr)] overflow-hidden">
        <div class="min-h-0 overflow-auto border-neutral-800 border-r">
          <For each={pathList()}>
            {(path) => {
              const selected = () => selectedUid() === path.identifiers.uid;
              return (
                <button
                  type="button"
                  data-color-path-uid={path.identifiers.uid}
                  class={`flex w-full items-center gap-3 border-neutral-800 border-b px-3 py-2 text-left hover:bg-neutral-900 ${
                    selected() ? "bg-neutral-900" : "bg-neutral-950"
                  }`}
                  onClick={() => setSelectedUid(path.identifiers.uid)}
                >
                  <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-neutral-700 bg-neutral-900 font-mono text-xs">
                    {path.identifiers.id}
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-sm">
                      {path.identifiers.label}
                    </span>
                    <span class="block truncate text-neutral-500 text-xs">
                      {resolvedInterpolationSpace(path)} interpolation
                      <Show when={isBuiltinColorPath(path)}> - Built-in</Show>
                    </span>
                  </span>
                </button>
              );
            }}
          </For>
        </div>
        <Show
          when={draft()}
          fallback={
            <div class="flex min-h-0 items-center justify-center text-neutral-500 text-sm">
              No color paths
            </div>
          }
        >
          {(currentDraft) => (
            <div class="@container min-h-0 overflow-auto">
              <div class="grid grid-cols-1 gap-5 p-4 @xl:grid-cols-2">
                <section class="min-w-0 space-y-4">
                  <div class="grid gap-3">
                    <label class="block space-y-1 text-sm">
                      <span class="text-neutral-400">Label</span>
                      <Input
                        density="compact"
                        class="w-full"
                        disabled={draftReadOnly()}
                        value={currentDraft().identifiers.label}
                        onInput={(event) =>
                          updateDraft((path) => ({
                            ...path,
                            identifiers: {
                              ...path.identifiers,
                              label: event.currentTarget.value,
                            },
                          }))
                        }
                      />
                    </label>
                  </div>
                  <div class="grid gap-3">
                    <label class="block space-y-1 text-sm">
                      <span class="text-neutral-400">Interpolation</span>
                      <NativeSelect
                        density="compact"
                        class="w-full"
                        disabled={draftReadOnly()}
                        value={resolvedInterpolationSpace(currentDraft())}
                        onInput={(event) =>
                          updateDraft((path) => ({
                            ...path,
                            interpolation_space: event.currentTarget
                              .value as types.ColorInterpolationSpace,
                          }))
                        }
                      >
                        <For each={EDITABLE_INTERPOLATION_SPACES}>
                          {(space) => <option value={space}>{space}</option>}
                        </For>
                      </NativeSelect>
                    </label>
                    <label class="block space-y-1 text-sm">
                      <span class="text-neutral-400">Hue Route</span>
                      <NativeSelect
                        density="compact"
                        class="w-full"
                        disabled={draftReadOnly()}
                        value={currentDraft().hue_direction}
                        onInput={(event) =>
                          updateDraft((path) => ({
                            ...path,
                            hue_direction: event.currentTarget
                              .value as types.HueDirection,
                          }))
                        }
                      >
                        <For each={Object.values(HueDirection)}>
                          {(direction) => (
                            <option value={direction}>{direction}</option>
                          )}
                        </For>
                      </NativeSelect>
                    </label>
                    <label class="block space-y-1 text-sm">
                      <span class="text-neutral-400">Curve</span>
                      <NativeSelect
                        density="compact"
                        class="w-full"
                        disabled={draftReadOnly()}
                        value={currentDraft().curve}
                        onInput={(event) =>
                          updateDraft((path) => ({
                            ...path,
                            curve: event.currentTarget.value as types.FadeCurve,
                          }))
                        }
                      >
                        <For each={Object.values(FadeCurve)}>
                          {(curve) => <option value={curve}>{curve}</option>}
                        </For>
                      </NativeSelect>
                    </label>
                  </div>
                  <section class="space-y-3 border-neutral-800 border-t pt-4">
                    <h2 class="font-semibold text-neutral-200 text-sm">
                      Timing
                    </h2>
                    <TimingComponentEditor
                      label="In Color"
                      mode="in"
                      component={currentDraft().timing.in_color}
                      disabled={draftReadOnly()}
                      onChange={(component) =>
                        setTimingComponent("in_color", component)
                      }
                    />
                    <TimingComponentEditor
                      label="Out Color"
                      mode="out"
                      component={currentDraft().timing.out_color}
                      disabled={draftReadOnly()}
                      onChange={(component) =>
                        setTimingComponent("out_color", component)
                      }
                    />
                    <label class="grid grid-cols-[130px_1fr_48px] items-center gap-3 text-sm">
                      <span class="text-neutral-300">
                        Brightness
                        <span class="block text-neutral-500 text-xs">
                          Midpoint
                        </span>
                      </span>
                      <input
                        data-testid="color-path-midpoint-brightness"
                        class="accent-cyan-400 disabled:opacity-50"
                        disabled={draftReadOnly()}
                        type="range"
                        min="0"
                        max="200"
                        value={percentInputValue(
                          currentDraft().timing.brightness_percent,
                          1,
                        )}
                        onInput={(event) =>
                          updateMidpointBrightness(event.currentTarget.value)
                        }
                      />
                      <span class="text-right font-mono text-neutral-400 text-xs">
                        {percentInputValue(
                          currentDraft().timing.brightness_percent,
                          1,
                        )}
                        %
                      </span>
                    </label>
                  </section>
                </section>
                <aside class="min-w-0 space-y-4">
                  <section class="space-y-3">
                    <div class="grid grid-cols-2 gap-3">
                      <PreviewColorInput
                        anchor="start"
                        label="Start"
                        value={startHex()}
                        fixtureHex={startDisplayHex()}
                        onInput={setStartHex}
                      />
                      <PreviewColorInput
                        anchor="end"
                        label="Destination"
                        value={endHex()}
                        fixtureHex={endDisplayHex()}
                        onInput={setEndHex}
                      />
                    </div>
                    <ColorPathGradientCanvas
                      path={currentDraft()}
                      start={hexToRgb(startHex())}
                      end={hexToRgb(endHex())}
                    />
                    <RouteOverlay
                      points={previewPoints()}
                      onAnchorColorChange={updatePreviewAnchorColor}
                    />
                  </section>
                </aside>
              </div>
            </div>
          )}
        </Show>
      </div>
    </div>
  );
}
