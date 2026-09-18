// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
} from "solid-js";
import { Input, NativeSelect } from "../../../components/ui/form-controls";
import { Button } from "../../../components/ui/visual-language/button";
import { normalizeFixtureUid } from "../../../lib/binding-utils";
import {
  sendFixtureColorPathDefault,
  sendFixturePlacementUpdate,
  sendFixturePlacementUpdates,
} from "../../../lib/fixture-service";
import {
  colorPathDefaults,
  colorPaths,
  fixtures,
  programmerSelection,
} from "../../../state/appStores";
import type * as types from "../../../types";

interface NumericCommitInputProps {
  label: string;
  value: number;
  step?: number;
  onCommit: (value: number) => void;
}

const NumericCommitInput: Component<NumericCommitInputProps> = (props) => {
  const [draft, setDraft] = createSignal(String(props.value));

  createEffect(() => {
    setDraft(String(props.value));
  });

  const commit = () => {
    const parsed = Number(draft());
    if (Number.isFinite(parsed)) {
      props.onCommit(parsed);
    } else {
      setDraft(String(props.value));
    }
  };

  return (
    <label class="flex flex-col gap-1">
      <span class="text-xs uppercase tracking-wide text-neutral-400">
        {props.label}
      </span>
      <Input
        density="compact"
        type="number"
        step={props.step ?? 0.1}
        value={draft()}
        class="w-full"
        onInput={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            setDraft(String(props.value));
            (event.currentTarget as HTMLInputElement).blur();
          }
        }}
      />
    </label>
  );
};

function getPlacement(fixture: types.Fixture): types.FixturePlacement {
  return (
    fixture.placement ?? {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    }
  );
}

function applyPositionAxisUpdate(
  fixture: types.Fixture,
  axis: "x" | "y" | "z",
  value: number,
): void {
  const axisType = axis.toUpperCase() as "X" | "Y" | "Z";
  sendFixturePlacementUpdate(fixture.identifiers.id, {
    type: axisType,
    data: value,
  });
}

function applyRotationAxisUpdate(
  fixture: types.Fixture,
  axis: "x" | "y" | "z",
  value: number,
): void {
  const axisType = axis.toUpperCase() as "X" | "Y" | "Z";
  sendFixturePlacementUpdate(fixture.identifiers.id, undefined, {
    type: axisType,
    data: value,
  });
}

function formatNum(value: number): string {
  return value.toFixed(2);
}

/** Returns the whole-fixture color path default for a selected fixture. */
function fixtureColorPathDefault(
  defaults: readonly types.ColorPathDefault[],
  fixture: types.Fixture,
): number | undefined {
  const fixtureUid = normalizeFixtureUid(fixture.identifiers.uid);
  return defaults.find(
    (entry) =>
      normalizeFixtureUid(entry.fixture.fixture_uid) === fixtureUid &&
      entry.fixture.index == null,
  )?.color_path_id;
}

/** Returns the element-scoped color path default for a selected fixture element. */
function fixtureElementColorPathDefault(
  defaults: readonly types.ColorPathDefault[],
  fixture: types.Fixture,
  elementIndex: number,
): number | undefined {
  const fixtureUid = normalizeFixtureUid(fixture.identifiers.uid);
  return defaults.find(
    (entry) =>
      normalizeFixtureUid(entry.fixture.fixture_uid) === fixtureUid &&
      entry.fixture.index === elementIndex,
  )?.color_path_id;
}

const VisualizerProperties: Component = () => {
  const $fixtures = useStore(fixtures);
  const $selection = useStore(programmerSelection);
  const $colorPaths = useStore(colorPaths);
  const $colorPathDefaults = useStore(colorPathDefaults);

  /** Lists available color paths in a stable display order. */
  const colorPathList = createMemo(() =>
    Object.values($colorPaths()).sort(
      (left, right) => left.identifiers.id - right.identifiers.id,
    ),
  );

  /** Resolves fixtures currently selected in the visualizer. */
  const selectedFixtures = createMemo(() =>
    $selection()
      .map((uid) => $fixtures()[uid])
      .filter((fixture): fixture is types.Fixture => !!fixture),
  );

  /** Returns the selected fixture only when exactly one fixture is selected. */
  const singleFixture = createMemo(() => {
    const current = selectedFixtures();
    return current.length === 1 ? current[0] : null;
  });

  /** Computes the shared position center for selected fixtures. */
  const centroidPosition = createMemo(() => {
    const current = selectedFixtures();
    if (current.length === 0) return null;
    const totals = current.reduce(
      (acc, fixture) => {
        const placement = getPlacement(fixture);
        acc.x += placement.position.x;
        acc.y += placement.position.y;
        acc.z += placement.position.z;
        return acc;
      },
      { x: 0, y: 0, z: 0 },
    );
    return {
      x: totals.x / current.length,
      y: totals.y / current.length,
      z: totals.z / current.length,
    };
  });

  /** Resolves the selected fixture's whole-fixture color path default. */
  const selectedFixtureColorPathDefault = createMemo(() => {
    const fixture = singleFixture();
    if (!fixture) return undefined;
    return fixtureColorPathDefault($colorPathDefaults(), fixture);
  });

  const [positionDeltaX, setPositionDeltaX] = createSignal(0);
  const [positionDeltaY, setPositionDeltaY] = createSignal(0);
  const [positionDeltaZ, setPositionDeltaZ] = createSignal(0);
  const [rotationDeltaX, setRotationDeltaX] = createSignal(0);
  const [rotationDeltaY, setRotationDeltaY] = createSignal(0);
  const [rotationDeltaZ, setRotationDeltaZ] = createSignal(0);

  const applyPositionDelta = () => {
    const fixturesToUpdate = selectedFixtures();
    const dx = positionDeltaX();
    const dy = positionDeltaY();
    const dz = positionDeltaZ();
    if (fixturesToUpdate.length === 0 || (!dx && !dy && !dz)) {
      return;
    }
    const updates: types.FixturePlacementUpdateEntry[] = [];
    for (const fixture of fixturesToUpdate) {
      const placement = getPlacement(fixture);
      updates.push({
        id: fixture.identifiers.id,
        position: {
          type: "All",
          data: {
            x: placement.position.x + dx,
            y: placement.position.y + dy,
            z: placement.position.z + dz,
          },
        },
      });
    }
    sendFixturePlacementUpdates(updates);
    setPositionDeltaX(0);
    setPositionDeltaY(0);
    setPositionDeltaZ(0);
  };

  const applyRotationDelta = () => {
    const fixturesToUpdate = selectedFixtures();
    const dx = rotationDeltaX();
    const dy = rotationDeltaY();
    const dz = rotationDeltaZ();
    if (fixturesToUpdate.length === 0 || (!dx && !dy && !dz)) {
      return;
    }
    const updates: types.FixturePlacementUpdateEntry[] = [];
    for (const fixture of fixturesToUpdate) {
      const placement = getPlacement(fixture);
      updates.push({
        id: fixture.identifiers.id,
        rotation: {
          type: "All",
          data: {
            x: placement.rotation.x + dx,
            y: placement.rotation.y + dy,
            z: placement.rotation.z + dz,
          },
        },
      });
    }
    sendFixturePlacementUpdates(updates);
    setRotationDeltaX(0);
    setRotationDeltaY(0);
    setRotationDeltaZ(0);
  };

  return (
    <div class="flex h-full flex-col gap-4 p-4 text-neutral-200">
      <Show
        when={selectedFixtures().length > 0}
        fallback={
          <div class="text-sm text-neutral-500">No fixtures selected</div>
        }
      >
        <div class="text-xs uppercase tracking-wide text-neutral-400">
          Selected Fixtures: {selectedFixtures().length}
        </div>

        <Show when={singleFixture()}>
          {(fixture) => {
            const placement = createMemo(() => getPlacement(fixture()));
            return (
              <>
                <div class="rounded border border-neutral-800 bg-neutral-900 p-3 text-sm">
                  <div>ID: {fixture().identifiers.id}</div>
                  <div>UID: {fixture().identifiers.uid}</div>
                </div>

                <label class="flex flex-col gap-1">
                  <span class="text-xs uppercase tracking-wide text-neutral-400">
                    Fixture Color Path
                  </span>
                  <NativeSelect
                    density="compact"
                    class="w-full"
                    value={selectedFixtureColorPathDefault() ?? ""}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      sendFixtureColorPathDefault(
                        { fixture_uid: fixture().identifiers.uid },
                        value === "" ? undefined : Number.parseInt(value, 10),
                      );
                    }}
                  >
                    <option value="">Native</option>
                    <For each={colorPathList()}>
                      {(path) => (
                        <option value={path.identifiers.id}>
                          {path.identifiers.id} - {path.identifiers.label}
                        </option>
                      )}
                    </For>
                  </NativeSelect>
                </label>

                <Show when={fixture().elements.length > 0}>
                  <div class="space-y-2">
                    <h3 class="text-sm font-medium text-neutral-300">
                      Element Color Paths
                    </h3>
                    <div class="space-y-2">
                      <For each={fixture().elements}>
                        {(element, index) => {
                          /** Resolves the one-based fixture element index used by backend FixtureRef values. */
                          const elementIndex = createMemo(() => index() + 1);
                          /** Resolves the selected element's explicit default, falling back visually to the fixture default. */
                          const elementDefault = createMemo(() =>
                            fixtureElementColorPathDefault(
                              $colorPathDefaults(),
                              fixture(),
                              elementIndex(),
                            ),
                          );
                          return (
                            <label class="grid grid-cols-[minmax(0,1fr)_minmax(8rem,12rem)] items-center gap-2">
                              <span class="truncate text-xs text-neutral-400">
                                {element.label || `Element ${elementIndex()}`}
                              </span>
                              <NativeSelect
                                density="compact"
                                aria-label={`Element ${elementIndex()} Color Path`}
                                class="w-full"
                                value={elementDefault() ?? ""}
                                onChange={(event) => {
                                  const value = event.currentTarget.value;
                                  sendFixtureColorPathDefault(
                                    {
                                      fixture_uid: fixture().identifiers.uid,
                                      index: elementIndex(),
                                    },
                                    value === ""
                                      ? undefined
                                      : Number.parseInt(value, 10),
                                  );
                                }}
                              >
                                <option value="">Fixture default</option>
                                <For each={colorPathList()}>
                                  {(path) => (
                                    <option value={path.identifiers.id}>
                                      {path.identifiers.id} -{" "}
                                      {path.identifiers.label}
                                    </option>
                                  )}
                                </For>
                              </NativeSelect>
                            </label>
                          );
                        }}
                      </For>
                    </div>
                  </div>
                </Show>

                <div class="space-y-2">
                  <h3 class="text-sm font-medium text-neutral-300">Position</h3>
                  <div class="grid grid-cols-3 gap-2">
                    <NumericCommitInput
                      label="X"
                      value={placement().position.x}
                      onCommit={(value) =>
                        applyPositionAxisUpdate(fixture(), "x", value)
                      }
                    />
                    <NumericCommitInput
                      label="Y"
                      value={placement().position.y}
                      onCommit={(value) =>
                        applyPositionAxisUpdate(fixture(), "y", value)
                      }
                    />
                    <NumericCommitInput
                      label="Z"
                      value={placement().position.z}
                      onCommit={(value) =>
                        applyPositionAxisUpdate(fixture(), "z", value)
                      }
                    />
                  </div>
                </div>

                <div class="space-y-2">
                  <h3 class="text-sm font-medium text-neutral-300">
                    Rotation (deg)
                  </h3>
                  <div class="grid grid-cols-3 gap-2">
                    <NumericCommitInput
                      label="X"
                      value={placement().rotation.x}
                      onCommit={(value) =>
                        applyRotationAxisUpdate(fixture(), "x", value)
                      }
                    />
                    <NumericCommitInput
                      label="Y"
                      value={placement().rotation.y}
                      onCommit={(value) =>
                        applyRotationAxisUpdate(fixture(), "y", value)
                      }
                    />
                    <NumericCommitInput
                      label="Z"
                      value={placement().rotation.z}
                      onCommit={(value) =>
                        applyRotationAxisUpdate(fixture(), "z", value)
                      }
                    />
                  </div>
                </div>
              </>
            );
          }}
        </Show>

        <Show when={selectedFixtures().length > 1}>
          <div class="space-y-4">
            <div class="rounded border border-neutral-800 bg-neutral-900 p-3 text-sm">
              <div class="text-neutral-300">Group Transform</div>
              <Show when={centroidPosition()}>
                {(centroid) => (
                  <div class="mt-1 text-xs text-neutral-400">
                    Centroid: ({formatNum(centroid().x)},{" "}
                    {formatNum(centroid().y)}, {formatNum(centroid().z)})
                  </div>
                )}
              </Show>
            </div>

            <div class="space-y-2">
              <h3 class="text-sm font-medium text-neutral-300">
                Translate Delta
              </h3>
              <div class="grid grid-cols-3 gap-2">
                <NumericCommitInput
                  label="dX"
                  value={positionDeltaX()}
                  onCommit={setPositionDeltaX}
                />
                <NumericCommitInput
                  label="dY"
                  value={positionDeltaY()}
                  onCommit={setPositionDeltaY}
                />
                <NumericCommitInput
                  label="dZ"
                  value={positionDeltaZ()}
                  onCommit={setPositionDeltaZ}
                />
              </div>
              <Button size="compact" type="button" onClick={applyPositionDelta}>
                Apply Translation
              </Button>
            </div>

            <div class="space-y-2">
              <h3 class="text-sm font-medium text-neutral-300">
                Rotate Delta (deg)
              </h3>
              <div class="grid grid-cols-3 gap-2">
                <NumericCommitInput
                  label="dX"
                  value={rotationDeltaX()}
                  onCommit={setRotationDeltaX}
                />
                <NumericCommitInput
                  label="dY"
                  value={rotationDeltaY()}
                  onCommit={setRotationDeltaY}
                />
                <NumericCommitInput
                  label="dZ"
                  value={rotationDeltaZ()}
                  onCommit={setRotationDeltaZ}
                />
              </div>
              <Button size="compact" type="button" onClick={applyRotationDelta}>
                Apply Rotation
              </Button>
            </div>
          </div>
        </Show>
      </Show>
    </div>
  );
};

export default VisualizerProperties;
