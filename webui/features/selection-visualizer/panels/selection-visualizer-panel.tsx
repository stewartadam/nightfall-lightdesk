// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { Input, NativeSelect } from "../../../components/ui/form-controls";
import { Button } from "../../../components/ui/visual-language/button";
import { engineRuntime } from "../../../lib/engine-runtime";
import { setStoreAction } from "../../../lib/nanostore-action";
import {
  activeSelectionSpanTargets,
  type FixtureMap,
  fixtures,
  programmerResolvedSelection,
  programmerSelection,
  programmerSpatialSelection,
} from "../../../state/appStores";
import type * as types from "../../../types";
import { SpatialSelectionField } from "../../selection";
import {
  buildSelectionGridLayer,
  clampSelectionStep,
  deriveSelectionGridBounds,
  formatFixtureRefLabel,
  getSelectionIndexAtStep,
  listSelectionZLayers,
  selectionTargetsForStep,
} from "../model/selection-grid";

/** Build editable fixture syntax from resolved fixture refs in selection order. */
function selectionExprFromFixtureRefs(
  fixtureRefs: readonly types.FixtureRef[],
  fixtureMap: FixtureMap,
): types.SelectionExpr | null {
  const fixtureSelections = fixtureRefs.map((fixtureRef) => {
    const fixture = fixtureMap[fixtureRef.fixture_uid];
    if (!fixture) return null;
    return {
      type: "Fixture",
      data: {
        fixture_id: fixture.identifiers.id,
        element_index: fixtureRef.index,
      },
    } satisfies types.SelectionExpr;
  });

  if (fixtureSelections.length === 0) return null;
  if (fixtureSelections.some((selection) => selection === null)) return null;

  const [firstSelection, ...remainingSelections] =
    fixtureSelections as types.SelectionExpr[];
  return remainingSelections.reduce<types.SelectionExpr>(
    (lhs, rhs) => ({
      type: "Add",
      data: { lhs, rhs },
    }),
    firstSelection,
  );
}

/** Build editable fixture syntax from the active programmer selection order. */
function selectionExprFromProgrammerSelection(
  selectedUids: readonly string[],
  fixtureMap: FixtureMap,
  resolvedFixtureRefs: readonly types.FixtureRef[] = [],
): types.SelectionExpr | null {
  const resolvedRefsByUid = new Map<string, types.FixtureRef[]>();
  for (const fixtureRef of resolvedFixtureRefs) {
    const refs = resolvedRefsByUid.get(fixtureRef.fixture_uid) ?? [];
    refs.push(fixtureRef);
    resolvedRefsByUid.set(fixtureRef.fixture_uid, refs);
  }
  const fixtureRefs =
    selectedUids.length > 0
      ? selectedUids.flatMap(
          (fixture_uid) =>
            resolvedRefsByUid.get(fixture_uid) ?? [{ fixture_uid }],
        )
      : resolvedFixtureRefs;

  return selectionExprFromFixtureRefs(fixtureRefs, fixtureMap);
}

/** Prefer editable fixture syntax over generic resolved-selection text. */
function selectionWithEditableProgrammerSource(
  selection: types.SpatialSelection | null,
  selectedUids: readonly string[],
  fixtureMap: FixtureMap,
): types.SpatialSelection | null {
  if (!selection) {
    const editableSource = selectionExprFromProgrammerSelection(
      selectedUids,
      fixtureMap,
    );
    if (!editableSource) return null;

    return {
      source: editableSource,
      clauses: [],
    };
  }

  if (selection.source.type !== "Resolved") return selection;

  const editableSource = selectionExprFromProgrammerSelection(
    selectedUids,
    fixtureMap,
    selection.source.data,
  );
  if (!editableSource) return selection;

  return {
    ...selection,
    source: editableSource,
  };
}

/** Render a dockable inspector for the active programmer spatial selection. */
export default function SelectionVisualizerPanel() {
  const $fixtures = useStore(fixtures);
  const $programmerSelection = useStore(programmerSelection);
  const $spatialSelection = useStore(programmerSpatialSelection);
  const $resolvedSelection = useStore(programmerResolvedSelection);
  const [activeStep, setActiveStep] = createSignal(0);
  const [activeZ, setActiveZ] = createSignal(0);

  /** Exposes the programmer source without suppressing in-place store updates. */
  const editableSelection = (): types.SpatialSelection | null =>
    selectionWithEditableProgrammerSource(
      $spatialSelection(),
      $programmerSelection(),
      $fixtures(),
    );

  /** Keep the selected step and z layer inside the resolved selection bounds. */
  createEffect(() => {
    const resolved = $resolvedSelection();
    const nextStep = clampSelectionStep(activeStep(), resolved);
    if (nextStep !== activeStep()) setActiveStep(nextStep);

    const layers = listSelectionZLayers(resolved);
    if (layers.length === 0) {
      if (activeZ() !== 0) setActiveZ(0);
      return;
    }
    if (!layers.includes(activeZ())) setActiveZ(layers[0]);
  });

  /** Publish the active step targets so the visualizer can highlight them. */
  createEffect(() => {
    setStoreAction(
      activeSelectionSpanTargets,
      "Update Selection Span Targets",
      selectionTargetsForStep($resolvedSelection(), activeStep()),
    );
  });

  onCleanup(() =>
    setStoreAction(
      activeSelectionSpanTargets,
      "Clear Selection Span Targets",
      [],
    ),
  );

  const zLayers = createMemo(() => listSelectionZLayers($resolvedSelection()));
  const bounds = createMemo(() =>
    deriveSelectionGridBounds($resolvedSelection()),
  );
  const stepCount = createMemo(() => $resolvedSelection()?.indexes.length ?? 0);
  const activeSelectionIndex = createMemo(() =>
    getSelectionIndexAtStep($resolvedSelection(), activeStep()),
  );
  const gridLayer = createMemo(() =>
    buildSelectionGridLayer($resolvedSelection(), activeZ(), activeStep()),
  );

  /** Clamp and set the active step used by the panel and visualizer span highlight. */
  const setStep = (step: number) =>
    setActiveStep(clampSelectionStep(step, $resolvedSelection()));

  /** Applies shared-field parser output to the active programmer selection. */
  const applySpatialSelection = (parsed: types.SpatialSelection): void => {
    const command: types.ProgrammerCommand = {
      type: "SetProgrammerSpatialSelection",
      data: parsed,
    };
    engineRuntime.sendCommand({ module: "ProgrammerCommand", command });
  };

  const hasResolvedSelection = createMemo(
    () => ($resolvedSelection()?.indexes.length ?? 0) > 0,
  );

  return (
    <div class="flex h-full min-h-0 flex-col bg-neutral-950 text-neutral-100">
      <div class="flex min-h-0 flex-1 flex-col gap-3 p-4">
        <div class="space-y-2 rounded border border-neutral-800 bg-neutral-900/60 p-3">
          <div class="flex items-center justify-between gap-3">
            <div>
              <h3 class="text-xs uppercase tracking-wider text-neutral-400">
                Spatial Selection
              </h3>
              <p class="text-xs text-neutral-500">
                Edit the active programmer selection.
              </p>
            </div>
            <div class="text-xs text-neutral-500">
              {$programmerSelection().length} fixture
              {$programmerSelection().length === 1 ? "" : "s"}
            </div>
          </div>

          <SpatialSelectionField
            selection={editableSelection()}
            revision={JSON.stringify(editableSelection())}
            onChange={applySpatialSelection}
            label="Spatial selection"
            variant="expanded"
            placeholder="Fixture 1>8 | Grid 4 | Wings 2"
          />
        </div>

        <Show
          when={$spatialSelection() && $resolvedSelection()}
          fallback={
            <div class="rounded border border-dashed border-neutral-800 p-3 text-sm text-neutral-500">
              No active spatial selection. Select fixtures in the programmer to
              inspect their resolved grid positions.
            </div>
          }
        >
          <Show
            when={hasResolvedSelection()}
            fallback={
              <div class="rounded border border-dashed border-neutral-800 p-3 text-sm text-neutral-500">
                The active spatial selection resolved to no indexes.
              </div>
            }
          >
            <div class="flex flex-wrap items-center gap-2 rounded border border-neutral-800 bg-neutral-900/70 p-2">
              <Button
                size="compact"
                type="button"
                disabled={stepCount() === 0}
                onClick={() => setStep(0)}
              >
                First
              </Button>
              <Button
                size="compact"
                type="button"
                disabled={stepCount() === 0}
                onClick={() => setStep(activeStep() - 1)}
              >
                Previous
              </Button>
              <Button
                size="compact"
                type="button"
                disabled={stepCount() === 0}
                onClick={() => setStep(activeStep() + 1)}
              >
                Next
              </Button>
              <Button
                size="compact"
                type="button"
                disabled={stepCount() === 0}
                onClick={() => setStep(stepCount() - 1)}
              >
                Last
              </Button>
              <label class="ml-2 flex items-center gap-2 text-xs text-neutral-400">
                Step
                <Input
                  density="compact"
                  type="number"
                  min="1"
                  max={Math.max(1, stepCount())}
                  value={stepCount() === 0 ? 0 : activeStep() + 1}
                  class="w-16"
                  onInput={(event) =>
                    setStep(Number(event.currentTarget.value) - 1)
                  }
                />
                <span>/ {stepCount()}</span>
              </label>
              <label class="ml-auto flex items-center gap-2 text-xs text-neutral-400">
                Z
                <NativeSelect
                  density="compact"
                  value={activeZ()}
                  onChange={(event) =>
                    setActiveZ(Number(event.currentTarget.value))
                  }
                >
                  <For each={zLayers()}>
                    {(z) => <option value={z}>{z}</option>}
                  </For>
                </NativeSelect>
              </label>
            </div>

            <div class="grid gap-3 lg:grid-cols-[minmax(0,1fr)_12rem]">
              <div
                data-testid="selection-grid-scroll"
                class="min-w-0 overflow-auto rounded border border-neutral-800 bg-neutral-900/40 p-3"
              >
                <Show when={gridLayer()}>
                  {(layer) => (
                    <div class="inline-block min-w-full">
                      <div
                        data-testid="selection-grid-header"
                        class="sticky top-0 z-20 -mx-3 -mt-3 grid gap-1 bg-neutral-900/95 px-3 pt-3 pb-1"
                        style={{
                          "grid-template-columns": `2.5rem repeat(${layer().xValues.length}, minmax(5rem, 1fr))`,
                        }}
                      >
                        <div class="sticky left-0 z-30 rounded bg-neutral-950" />
                        <For each={layer().xValues}>
                          {(x) => (
                            <div class="rounded bg-neutral-950 px-2 py-1 text-center text-xs text-neutral-500">
                              X {x}
                            </div>
                          )}
                        </For>
                      </div>
                      <div
                        class="grid gap-1"
                        style={{
                          "grid-template-columns": `2.5rem repeat(${layer().xValues.length}, minmax(5rem, 1fr))`,
                        }}
                      >
                        <For each={layer().rows}>
                          {(row) => (
                            <>
                              <div
                                data-testid="selection-grid-y-label"
                                class="sticky left-0 z-10 flex items-start justify-center rounded bg-neutral-950 px-2 py-2 text-xs text-neutral-500"
                              >
                                Y {row.y}
                              </div>
                              <For each={row.cells}>
                                {(cell) => (
                                  <button
                                    data-testid="selection-grid-cell"
                                    type="button"
                                    class={`flex min-h-20 flex-col items-stretch justify-start rounded border p-2 text-left text-xs transition-colors ${cell.active ? "border-blue-400 bg-blue-500/20 text-blue-50" : cell.occupied ? "border-neutral-700 bg-neutral-900 text-neutral-100 hover:bg-neutral-800" : "border-dashed border-neutral-800 bg-neutral-950/70 text-neutral-600"} ${cell.inverted ? "ring-1 ring-amber-400/70" : ""} ${cell.fixtureElement ? "shadow-[inset_0_0_0_1px_rgba(34,197,94,0.35)]" : ""}`}
                                    onClick={() => {
                                      const firstMember = cell.members[0];
                                      if (firstMember)
                                        setStep(firstMember.index);
                                    }}
                                  >
                                    <Show
                                      when={cell.occupied}
                                      fallback={<span>Empty</span>}
                                    >
                                      <div class="space-y-1">
                                        <For each={cell.members}>
                                          {(member) => (
                                            <div class="truncate">
                                              <span class="font-medium">
                                                {formatFixtureRefLabel(
                                                  $fixtures(),
                                                  member.fixture,
                                                )}
                                              </span>
                                              <span class="ml-1 text-neutral-500">
                                                #{member.index}
                                              </span>
                                            </div>
                                          )}
                                        </For>
                                        <div class="flex flex-wrap gap-1 pt-1">
                                          <Show when={cell.inverted}>
                                            <span class="rounded bg-amber-500/20 px-1 text-amber-200">
                                              inverted
                                            </span>
                                          </Show>
                                          <Show when={cell.fixtureElement}>
                                            <span class="rounded bg-emerald-500/20 px-1 text-emerald-200">
                                              element
                                            </span>
                                          </Show>
                                        </div>
                                      </div>
                                    </Show>
                                  </button>
                                )}
                              </For>
                            </>
                          )}
                        </For>
                      </div>
                    </div>
                  )}
                </Show>
              </div>

              <aside class="space-y-3 rounded border border-neutral-800 bg-neutral-900/60 p-3 text-xs text-neutral-300">
                <div>
                  <h3 class="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">
                    Active Span
                  </h3>
                  <Show when={activeSelectionIndex()}>
                    {(selectionIndex) => (
                      <div class="space-y-2">
                        <div class="grid grid-cols-2 gap-2">
                          <span class="text-neutral-500">Index</span>
                          <span>{selectionIndex().index}</span>
                          <span class="text-neutral-500">Members</span>
                          <span>{selectionIndex().members.length}</span>
                          <span class="text-neutral-500">Inverted</span>
                          <span>{selectionIndex().invert ? "Yes" : "No"}</span>
                          <span class="text-neutral-500">Layer</span>
                          <span>Z {activeZ()}</span>
                        </div>
                        <div class="space-y-1">
                          <For each={selectionIndex().members}>
                            {(member) => (
                              <div class="rounded bg-neutral-950 px-2 py-1">
                                {formatFixtureRefLabel(
                                  $fixtures(),
                                  member.fixture,
                                )}{" "}
                                @ ({member.projected_coord.x},{" "}
                                {member.projected_coord.y},{" "}
                                {member.projected_coord.z})
                              </div>
                            )}
                          </For>
                        </div>
                      </div>
                    )}
                  </Show>
                </div>
                <div>
                  <h3 class="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">
                    Bounds
                  </h3>
                  <Show when={bounds()}>
                    {(b) => (
                      <div class="grid grid-cols-2 gap-2">
                        <span class="text-neutral-500">X</span>
                        <span>
                          {b().minX} … {b().maxX}
                        </span>
                        <span class="text-neutral-500">Y</span>
                        <span>
                          {b().minY} … {b().maxY}
                        </span>
                        <span class="text-neutral-500">Z</span>
                        <span>
                          {b().minZ} … {b().maxZ}
                        </span>
                      </div>
                    )}
                  </Show>
                </div>
              </aside>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  );
}
