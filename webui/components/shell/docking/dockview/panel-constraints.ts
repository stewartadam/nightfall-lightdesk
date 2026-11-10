// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { DockviewApi, DockviewGroupPanel } from "dockview";
import { findPanelDefinitionByName } from "../../../../lib/panel-definitions";
import { bindGridMinimum, setEdgeGroupMinimum } from "./edge-group-constraints";

/**
 * Smallest share of their declared minimums grid groups shrink to in a cramped
 * window. Below half size a panel stops being usable, so the grid stops
 * shrinking there and the edge groups cover it instead; collapsing an edge
 * group then makes room.
 */
const MINIMUM_GRID_SCALE = 0.5;

/** How far the fitted grid scale may drift before the grid groups are re-constrained. */
const GRID_SCALE_TOLERANCE = 0.001;

interface GroupConstraintState {
  /** Largest declared member minimum width, before the gutter reserve. */
  minWidth: number;
  /** Largest declared member minimum height, before the gutter reserve. */
  minHeight: number;
  /** Where the group sat when its constraints were last applied. */
  location: string;
  /** Minimum width last handed to Dockview, after gutter and grid scaling. */
  appliedWidth: number;
  /** Minimum height last handed to Dockview, after gutter and grid scaling. */
  appliedHeight: number;
  subscriptions: { dispose(): void }[];
}

/**
 * Enforces descriptor-owned minimums across group membership and layout restoration.
 *
 * Edge groups always keep their declared minimums. Grid groups keep theirs
 * while the grid fits beside the edge groups; when the combined minimum is
 * wider or taller than that space, every grid group's minimum on that axis
 * shrinks by the same share, down to half, so the whole grid stays inside the
 * dock instead of pushing panels off screen. They return to full size once
 * there is room again.
 */
export function bindPanelConstraints(api: DockviewApi, gap: number) {
  const tracked = new Map<DockviewGroupPanel, GroupConstraintState>();
  const scale = { width: 1, height: 1 };
  let frame: number | undefined;
  let disposed = false;
  /** Whether a layout mutation, not just a shell resize, is waiting to be reconciled. */
  let mutated = false;
  const gridMinimum = bindGridMinimum(api, scheduleResize);

  /** Defers sizing until Dockview finishes its current layout or membership mutation. */
  function schedule() {
    mutated = true;
    scheduleResize();
  }

  /**
   * Defers a re-fit after the shell resizes. Resizes alone re-clamp the shell
   * only when the grid scale changes, so a window drag adds no extra layout.
   */
  function scheduleResize() {
    if (disposed || frame !== undefined) return;
    frame = requestAnimationFrame(reconcile);
  }

  /**
   * Hands Dockview a group's minimums when they differ from what it holds.
   * Dockview subtracts split gutters from allocated view sizes, so one gutter
   * is reserved for the rendered panel to meet its declared minimum. Only grid
   * groups take the fitted grid scale; edge, floating and popout groups keep
   * their full declared minimums. Returns whether anything changed.
   */
  function applyGroupConstraints(
    group: DockviewGroupPanel,
    state: GroupConstraintState,
  ) {
    const grid = group.api.location.type === "grid";
    const minimumWidth = (state.minWidth + gap) * (grid ? scale.width : 1);
    const minimumHeight = (state.minHeight + gap) * (grid ? scale.height : 1);
    if (
      state.appliedWidth === minimumWidth &&
      state.appliedHeight === minimumHeight
    )
      return false;
    state.appliedWidth = minimumWidth;
    state.appliedHeight = minimumHeight;
    group.api.setConstraints({ minimumWidth, minimumHeight });
    return true;
  }

  /**
   * Picks the per-axis share of the declared minimums that fits the grid's
   * space. Every grid group carries the current share, and Dockview's grid
   * minimum is a sum or maximum of group minimums, so dividing it by that share
   * gives the unscaled minimum to fit.
   */
  function fittedScale() {
    const { width, height } = gridMinimum.fit();
    /** Fits one axis's unscaled grid minimum into the space beside the edge groups. */
    const fit = (
      current: number,
      axis: { minimum: number; available: number },
    ) => {
      const natural = axis.minimum / current;
      if (natural <= 0 || natural <= axis.available) return 1;
      return Math.max(MINIMUM_GRID_SCALE, axis.available / natural);
    };
    return {
      width: fit(scale.width, width),
      height: fit(scale.height, height),
    };
  }

  /**
   * Whether the fitted share should replace the current one. Any shrink is
   * taken at once so the grid never overflows; growth waits for a real change
   * so subpixel jitter doesn't re-constrain every group.
   */
  function shouldRescale(current: number, fitted: number) {
    return fitted < current || fitted - current > GRID_SCALE_TOLERANCE;
  }

  /** Applies the largest member minimum to grid groups and edge splitviews, then re-clamps the shell around the grid's new combined minimum. */
  function reconcile() {
    frame = undefined;
    const groups = new Set(api.groups);
    let constrained = mutated;
    mutated = false;
    for (const [group, state] of tracked) {
      if (groups.has(group)) continue;
      for (const subscription of state.subscriptions) subscription.dispose();
      tracked.delete(group);
    }
    const resized: [DockviewGroupPanel, GroupConstraintState][] = [];
    for (const group of groups) {
      let state = tracked.get(group);
      if (!state) {
        state = {
          minWidth: 0,
          minHeight: 0,
          location: "",
          appliedWidth: 0,
          appliedHeight: 0,
          subscriptions: [
            group.api.onDidLocationChange(schedule),
            // Collapsing or hiding an edge group changes the grid's room.
            group.api.onDidCollapsedChange(schedule),
            group.api.onDidVisibilityChange(schedule),
          ],
        };
        tracked.set(group, state);
      }
      const definitions = group.panels.map((panel) =>
        findPanelDefinitionByName(panel.api.component),
      );
      const minWidth = Math.max(
        100,
        ...definitions.map((definition) => definition?.minWidth ?? 100),
      );
      const minHeight = Math.max(
        100,
        ...definitions.map((definition) => definition?.minHeight ?? 100),
      );
      const location = group.api.location;
      const locationKey =
        location.type === "edge" ? `edge:${location.position}` : location.type;
      const changed =
        state.minWidth !== minWidth ||
        state.minHeight !== minHeight ||
        state.location !== locationKey;
      state.location = locationKey;
      state.minWidth = minWidth;
      state.minHeight = minHeight;
      if (applyGroupConstraints(group, state)) constrained = true;
      if (location.type === "edge") {
        if (!changed) continue;
        constrained = true;
        const horizontal =
          location.position === "left" || location.position === "right";
        setEdgeGroupMinimum(
          api,
          location.position,
          horizontal ? minWidth : minHeight,
        );
      } else if (changed) {
        resized.push([group, state]);
      }
    }

    const fitted = fittedScale();
    if (
      shouldRescale(scale.width, fitted.width) ||
      shouldRescale(scale.height, fitted.height)
    ) {
      scale.width = fitted.width;
      scale.height = fitted.height;
      for (const [group, state] of tracked) {
        if (applyGroupConstraints(group, state)) constrained = true;
      }
    }

    for (const [group, state] of resized) {
      const width = Math.max(group.api.width, state.appliedWidth);
      const height = Math.max(group.api.height, state.appliedHeight);
      if (width !== group.api.width || height !== group.api.height)
        group.api.setSize({ width, height });
    }
    if (constrained) gridMinimum.reclamp();
  }

  const subscriptions = [
    api.onDidAddGroup(schedule),
    api.onDidRemoveGroup(schedule),
    api.onDidAddPanel(schedule),
    api.onDidRemovePanel(schedule),
    api.onDidMovePanel(schedule),
    api.onDidLayoutFromJSON(schedule),
  ];
  schedule();
  return {
    /** Releases group listeners and pending work before Dockview is disposed. */
    dispose() {
      disposed = true;
      gridMinimum.dispose();
      if (frame !== undefined) cancelAnimationFrame(frame);
      for (const subscription of subscriptions) subscription.dispose();
      for (const state of tracked.values()) {
        for (const subscription of state.subscriptions) subscription.dispose();
      }
      tracked.clear();
    },
  };
}
