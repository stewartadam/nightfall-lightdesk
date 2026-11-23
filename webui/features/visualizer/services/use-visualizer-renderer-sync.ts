// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Reactive renderer-sync hook for Visualizer.
 *
 * This hook mirrors Solid signals/stores into imperative renderer calls. Each
 * concern is isolated into its own `createEffect` so updates are scoped and
 * independently reactive.
 */

import { getLogger } from "../../../lib/logger";
import type { SelectionTarget } from "../../../lib/selection-targets";
import { createEffect } from "../../../lib/solid-compat";
import { useWorkspaceActivity } from "../../../lib/workspace-activity";
import type { RenderableFixture, RenderableSceneObject } from "../model/types";
import type {
  IVisualizerRenderer,
  VisualizerCameraRotationMode,
  VisualizerInteractionMode,
} from "../rendering/renderers/renderer-api";

const log = getLogger(import.meta.url);

interface UseVisualizerRendererSyncOptions {
  renderer: () => IVisualizerRenderer | null;
  fixtures: () => readonly RenderableFixture[];
  sceneObjects: () => readonly RenderableSceneObject[];
  selectedUids: () => readonly string[];
  editSelectionUids: () => readonly string[];
  programmerValueUids: () => readonly string[];
  activeSelectionTargets: () => readonly SelectionTarget[];
  highlightSelectionEnabled: () => boolean;
  showEmitters: () => boolean;
  showGrid: () => boolean;
  showSceneObjects: () => boolean;
  showOrbitTargetIndicator: () => boolean;
  darkness: () => number;
  showLabels: () => boolean;
  toolMode: () => VisualizerInteractionMode;
  rotationMode: () => VisualizerCameraRotationMode;
}

interface FixtureSyncSnapshot {
  uid: string;
  make: string;
  model: string;
  beamType: string | undefined;
  physicalSignature: string;
  layout: RenderableFixture["layout"];
  elementSignature: string;
  geometrySignature: string;
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
}

function buildElementSignature(fixture: RenderableFixture): string {
  return fixture.elements.map((element) => element.label).join("|");
}

function buildGeometrySignature(fixture: RenderableFixture): string {
  const geometry = fixture.geometry;
  if (!geometry) {
    return "";
  }

  const meshResourceCount = geometry.meshResources
    ? Object.keys(geometry.meshResources).length
    : 0;
  return `${geometry.gdtfPath ?? ""}|n:${geometry.nodes.length}|r:${geometry.roots.length}|m:${meshResourceCount}`;
}

function toFixtureSyncSnapshot(
  fixture: RenderableFixture,
): FixtureSyncSnapshot {
  return {
    uid: fixture.uid,
    make: fixture.make,
    model: fixture.model,
    beamType: fixture.beamType,
    physicalSignature: fixture.physicalSignature,
    layout: fixture.layout,
    elementSignature: buildElementSignature(fixture),
    geometrySignature: buildGeometrySignature(fixture),
    position: fixture.position,
    rotation: fixture.rotation,
  };
}

function requiresFullFixtureSync(
  previous: FixtureSyncSnapshot,
  next: FixtureSyncSnapshot,
): boolean {
  return (
    previous.make !== next.make ||
    previous.model !== next.model ||
    previous.beamType !== next.beamType ||
    previous.physicalSignature !== next.physicalSignature ||
    previous.layout !== next.layout ||
    previous.elementSignature !== next.elementSignature ||
    previous.geometrySignature !== next.geometrySignature
  );
}

/**
 * Builds overlay label text from the same renderable data that drives the scene.
 */
export function buildVisualizerOverlayLabels(
  fixtures: readonly RenderableFixture[],
  sceneObjects: readonly RenderableSceneObject[],
): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const fixture of fixtures) {
    labels[fixture.uid] = fixture.fixtureId.toString();
  }
  for (const sceneObject of sceneObjects) {
    labels[sceneObject.uid] = sceneObject.sceneObjectId.toString();
  }
  return labels;
}

/**
 * Binds application state to renderer mutation APIs.
 */
export function useVisualizerRendererSync(
  options: UseVisualizerRendererSyncOptions,
) {
  const workspaceActive = useWorkspaceActivity();
  let previousFixtureSnapshots = new Map<string, FixtureSyncSnapshot>();
  let previousRenderer: IVisualizerRenderer | null = null;
  let fixtureSyncRun = 0;

  /**
   * Sends fixtures to the renderer: everything when the renderer or a fixture's definition
   * changes, otherwise only moved or rotated fixtures. The snapshots carry the dependencies, so
   * serializing the full fixtures never subscribes to every nested store property.
   */
  createEffect(
    () => {
      if (!workspaceActive()) return undefined;
      const r = options.renderer();
      if (!r) return null;
      const fixtures = options.fixtures();
      const nextSnapshots = new Map<string, FixtureSyncSnapshot>();
      for (const fixture of fixtures) {
        nextSnapshots.set(fixture.uid, toFixtureSyncSnapshot(fixture));
      }
      return { r, fixtures, nextSnapshots };
    },
    (sync) => {
      if (sync === undefined) return;
      const runId = ++fixtureSyncRun;
      const startMs = performance.now();
      if (!sync) {
        previousRenderer = null;
        previousFixtureSnapshots = new Map<string, FixtureSyncSnapshot>();
        log.trace(`fixture-sync run=${runId} renderer=null reset=true`);
        return;
      }
      const { r, fixtures, nextSnapshots } = sync;

      let needsFullSync = false;
      let fullSyncReason = "";
      if (r !== previousRenderer) {
        needsFullSync = true;
        fullSyncReason = "renderer_changed";
      } else if (previousFixtureSnapshots.size !== nextSnapshots.size) {
        needsFullSync = true;
        fullSyncReason = `fixture_count_changed:${previousFixtureSnapshots.size}->${nextSnapshots.size}`;
      } else {
        for (const [uid, nextSnapshot] of nextSnapshots) {
          const previousSnapshot = previousFixtureSnapshots.get(uid);
          if (!previousSnapshot) {
            needsFullSync = true;
            fullSyncReason = `missing_previous_snapshot:${uid}`;
            break;
          }
          if (requiresFullFixtureSync(previousSnapshot, nextSnapshot)) {
            needsFullSync = true;
            fullSyncReason = `fixture_definition_changed:${uid}`;
            break;
          }
        }
      }

      if (needsFullSync) {
        const setStartMs = performance.now();
        r.setFixtures(fixtures);
        const setMs = performance.now() - setStartMs;
        const totalMs = performance.now() - startMs;
        log.trace(
          `fixture-sync run=${runId} mode=full fixtures=${fixtures.length} reason=${fullSyncReason} setFixturesMs=${setMs.toFixed(2)} totalMs=${totalMs.toFixed(2)}`,
        );
      } else {
        const deltaStartMs = performance.now();
        let positionUpdates = 0;
        let rotationUpdates = 0;
        for (const fixture of fixtures) {
          const previousSnapshot = previousFixtureSnapshots.get(fixture.uid);
          if (!previousSnapshot) {
            continue;
          }

          if (
            previousSnapshot.position.x !== fixture.position.x ||
            previousSnapshot.position.y !== fixture.position.y ||
            previousSnapshot.position.z !== fixture.position.z
          ) {
            r.setFixturePosition(fixture.uid, fixture.position);
            positionUpdates += 1;
          }

          if (
            previousSnapshot.rotation.x !== fixture.rotation.x ||
            previousSnapshot.rotation.y !== fixture.rotation.y ||
            previousSnapshot.rotation.z !== fixture.rotation.z
          ) {
            r.setFixtureRotation(fixture.uid, fixture.rotation);
            rotationUpdates += 1;
          }
        }

        const deltaMs = performance.now() - deltaStartMs;
        const totalMs = performance.now() - startMs;
        log.trace(
          `fixture-sync run=${runId} mode=delta fixtures=${fixtures.length} positionUpdates=${positionUpdates} rotationUpdates=${rotationUpdates} deltaMs=${deltaMs.toFixed(2)} totalMs=${totalMs.toFixed(2)}`,
        );
      }

      previousRenderer = r;
      previousFixtureSnapshots = nextSnapshots;
    },
  );

  /**
   * Applies `read`'s value to the renderer after it changes, after renderer initialization and
   * after workspace reactivation. Nothing is sent while the workspace is hidden or no renderer
   * exists.
   */
  const syncToRenderer = <Value>(
    read: () => Value,
    apply: (renderer: IVisualizerRenderer, value: Value) => void,
  ) => {
    createEffect(
      () => {
        if (!workspaceActive()) return undefined;
        const renderer = options.renderer();
        return renderer ? { renderer, value: read() } : undefined;
      },
      (sync) => {
        if (sync) apply(sync.renderer, sync.value);
      },
    );
  };

  syncToRenderer(options.sceneObjects, (r, sceneObjects) =>
    r.setSceneObjects(sceneObjects),
  );
  syncToRenderer(
    () => [...options.selectedUids()],
    (r, uids) => r.setSelection(uids),
  );
  // Patch/scene panel edit targets drive the yellow outline pass.
  syncToRenderer(
    () => [...options.editSelectionUids()],
    (r, uids) => r.setEditSelection(uids),
  );
  // Fixtures with programmer values drive the red outline pass.
  syncToRenderer(
    () => [...options.programmerValueUids()],
    (r, uids) => r.setProgrammerValues(uids),
  );
  syncToRenderer(
    () => [...options.activeSelectionTargets()],
    (r, targets) => r.setActiveSelectionTargets(targets),
  );
  syncToRenderer(options.highlightSelectionEnabled, (r, enabled) =>
    r.setHighlightSelection(enabled),
  );
  syncToRenderer(options.showEmitters, (r, enabled) =>
    r.setEmitterDebugEnabled(enabled),
  );
  syncToRenderer(options.showGrid, (r, enabled) => r.setGridEnabled(enabled));
  syncToRenderer(options.showSceneObjects, (r, visible) =>
    r.setSceneObjectsVisible(visible),
  );
  syncToRenderer(options.showOrbitTargetIndicator, (r, enabled) =>
    r.setOrbitTargetIndicatorEnabled(enabled),
  );
  syncToRenderer(options.darkness, (r, darkness) => r.setDarkness(darkness));
  syncToRenderer(options.showLabels, (r, enabled) =>
    r.setSnapPointsEnabled(enabled),
  );
  syncToRenderer(
    () =>
      buildVisualizerOverlayLabels(options.fixtures(), options.sceneObjects()),
    (r, labels) => r.setFixtureLabels(labels),
  );
  syncToRenderer(options.toolMode, (r, mode) => r.setInteractionMode(mode));
  syncToRenderer(options.rotationMode, (r, mode) =>
    r.setCameraRotationMode(mode),
  );
}
