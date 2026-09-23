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

import { createEffect } from "solid-js";
import { getLogger } from "../../../lib/logger";
import type { SelectionTarget } from "../../../lib/selection-targets";
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
  showOrbitTargetIndicator: () => boolean;
  showLabels: () => boolean;
  toolMode: () => VisualizerInteractionMode;
  rotationMode: () => VisualizerCameraRotationMode;
}

interface FixtureSyncSnapshot {
  uid: string;
  make: string;
  model: string;
  beamType: string | undefined;
  layout: RenderableFixture["layout"];
  elementSignature: string;
  geometrySignature: string;
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
}

function buildElementSignature(fixture: RenderableFixture): string {
  return fixture.elements.map((element) => element.label).join("|");
}

/** Rebuild geometry when its archive revision or selected mode changes, even with identical node counts. */
function buildGeometrySignature(fixture: RenderableFixture): string {
  const geometry = fixture.geometry;
  if (!geometry) {
    return "";
  }

  const meshResourceCount = geometry.meshResources
    ? Object.keys(geometry.meshResources).length
    : 0;
  const source = geometry.gdtf
    ? JSON.stringify([geometry.gdtf.archiveSha256, geometry.gdtf.mode])
    : "";
  return `${source}|n:${geometry.nodes.length}|r:${geometry.roots.length}|m:${meshResourceCount}`;
}

function toFixtureSyncSnapshot(
  fixture: RenderableFixture,
): FixtureSyncSnapshot {
  return {
    uid: fixture.uid,
    make: fixture.make,
    model: fixture.model,
    beamType: fixture.beamType,
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

  createEffect(() => {
    if (!workspaceActive()) return;
    const runId = ++fixtureSyncRun;
    const startMs = performance.now();
    const r = options.renderer();
    if (!r) {
      previousRenderer = null;
      previousFixtureSnapshots = new Map<string, FixtureSyncSnapshot>();
      log.trace(`fixture-sync run=${runId} renderer=null reset=true`);
      return;
    }

    const fixtures = options.fixtures();
    const nextSnapshots = new Map<string, FixtureSyncSnapshot>();
    for (const fixture of fixtures) {
      nextSnapshots.set(fixture.uid, toFixtureSyncSnapshot(fixture));
    }

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
  });

  createEffect(() => {
    if (!workspaceActive()) return;
    const r = options.renderer();
    r?.setSceneObjects(options.sceneObjects());
  });

  createEffect(() => {
    if (!workspaceActive()) return;
    const r = options.renderer();
    r?.setSelection([...options.selectedUids()]);
  });

  /** Mirrors patch/scene panel edit targets into the yellow outline pass. */
  createEffect(() => {
    if (!workspaceActive()) return;
    const r = options.renderer();
    r?.setEditSelection([...options.editSelectionUids()]);
  });

  /** Mirrors fixtures with programmer values into the red outline pass. */
  createEffect(() => {
    if (!workspaceActive()) return;
    const r = options.renderer();
    r?.setProgrammerValues([...options.programmerValueUids()]);
  });

  createEffect(() => {
    if (!workspaceActive()) return;
    const r = options.renderer();
    r?.setActiveSelectionTargets([...options.activeSelectionTargets()]);
  });

  createEffect(() => {
    if (!workspaceActive()) return;
    const r = options.renderer();
    r?.setHighlightSelection(options.highlightSelectionEnabled());
  });

  createEffect(() => {
    if (!workspaceActive()) return;
    const r = options.renderer();
    r?.setEmitterDebugEnabled(options.showEmitters());
  });

  createEffect(() => {
    if (!workspaceActive()) return;
    const r = options.renderer();
    r?.setGridEnabled(options.showGrid());
  });

  createEffect(() => {
    if (!workspaceActive()) return;
    const r = options.renderer();
    r?.setOrbitTargetIndicatorEnabled(options.showOrbitTargetIndicator());
  });

  createEffect(() => {
    if (!workspaceActive()) return;
    const r = options.renderer();
    r?.setSnapPointsEnabled(options.showLabels());
  });

  createEffect(() => {
    if (!workspaceActive()) return;
    const r = options.renderer();
    const fixtures = options.fixtures();
    const sceneObjects = options.sceneObjects();
    r?.setFixtureLabels(buildVisualizerOverlayLabels(fixtures, sceneObjects));
  });

  createEffect(() => {
    if (!workspaceActive()) return;
    const r = options.renderer();
    r?.setInteractionMode(options.toolMode());
  });

  createEffect(() => {
    if (!workspaceActive()) return;
    const r = options.renderer();
    r?.setCameraRotationMode(options.rotationMode());
  });
}
