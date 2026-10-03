// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { DockviewApi, EdgeGroupPosition } from "dockview";

/** One open Dockview panel as the guide sees it. */
export interface GuidePanel {
  component: string;
  timelineUid?: string;
  sequenceUid?: string;
  stepFxUid?: string;
  /** Active in its tab group and not inside a collapsed group. */
  visible: boolean;
  /** Visible and actually unobstructed on screen, ignoring the guide card, dialogs, and menus. */
  onScreen: boolean;
}

/** Snapshot of the workspace published to the guide whenever panels or geometry change. */
export interface GuidePanelSnapshot {
  panels: GuidePanel[];
  activeComponent?: string;
}

const EDGE_POSITIONS: readonly EdgeGroupPosition[] = [
  "left",
  "right",
  "top",
  "bottom",
];
/** Fraction of sampled points that must hit the panel for it to count as on screen. */
const ON_SCREEN_SHARE = 0.5;
/** Sample grid size along each axis of a panel's content. */
const SAMPLES_PER_AXIS = 3;
/** Delays for follow-up measurements while edge-group and dialog transitions settle. */
const SETTLE_DELAYS_MS = [100, 300, 600];
/**
 * Surfaces that cover panels only while the user works in them: the guide card, dialogs, menus,
 * and dropdown lists. They never make a lesson panel count as hidden.
 */
const TRANSIENT_OVERLAYS =
  '.nf-welcome-guide, .nf-dialog-backdrop, [role="menu"], [role="listbox"], [data-hs-select-dropdown]';
/** Interval for remeasuring occlusion changes that Dockview does not announce. */
const POLL_MS = 750;

/**
 * Reports whether most of an element is unobstructed in the viewport.
 * Samples a grid of points and ignores transient overlays, so the card or a dialog cannot hide a prerequisite.
 */
export function isElementOnScreen(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return false;
  let hits = 0;
  for (let column = 0; column < SAMPLES_PER_AXIS; column++) {
    for (let row = 0; row < SAMPLES_PER_AXIS; row++) {
      const x = rect.left + (rect.width * (column + 0.5)) / SAMPLES_PER_AXIS;
      const y = rect.top + (rect.height * (row + 0.5)) / SAMPLES_PER_AXIS;
      if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight)
        continue;
      const topmost = document
        .elementsFromPoint(x, y)
        .find((hit) => !hit.closest(TRANSIENT_OVERLAYS));
      if (topmost && element.contains(topmost)) hits++;
    }
  }
  return hits >= SAMPLES_PER_AXIS * SAMPLES_PER_AXIS * ON_SCREEN_SHARE;
}

/** Reads every panel's identity, Dockview visibility, and on-screen state. */
function readPanels(api: DockviewApi): GuidePanel[] {
  return api.panels.map((entry) => {
    const visible = entry.api.isVisible && !entry.group.api.isCollapsed();
    return {
      component: entry.api.component,
      timelineUid: entry.params?.initialTimelineUid,
      sequenceUid: entry.params?.initialSequenceUid,
      stepFxUid: entry.params?.initialStepFxUid,
      visible,
      onScreen: visible && isElementOnScreen(entry.view.content.element),
    };
  });
}

/**
 * Publishes panel snapshots from Dockview's lifecycle events and remeasures after geometry settles.
 * Edge groups are replaced when a layout is restored, so their collapse listeners are rebound on every change.
 */
export function trackGuidePanels(
  api: DockviewApi | undefined,
  publish: (snapshot: GuidePanelSnapshot) => void,
): () => void {
  if (!api) {
    publish({ panels: [] });
    return () => {};
  }
  const edgeGroups = new Map<
    EdgeGroupPosition,
    { group: unknown; subscription: { dispose(): void } }
  >();
  let frame: number | undefined;
  let settles: ReturnType<typeof setTimeout>[] = [];
  let published = "";
  /** Publishes the current workspace state, skipping measurements that changed nothing. */
  const measure = () => {
    frame = undefined;
    const snapshot = {
      panels: readPanels(api),
      activeComponent: api.activePanel?.api.component,
    };
    const key = JSON.stringify(snapshot);
    if (key === published) return;
    published = key;
    publish(snapshot);
  };
  /** Follows replacement edge groups so collapsing a restored edge still reports. */
  const bindEdgeGroups = () => {
    for (const position of EDGE_POSITIONS) {
      const group = api.getEdgeGroup(position);
      const bound = edgeGroups.get(position);
      if (bound?.group === group) continue;
      bound?.subscription.dispose();
      edgeGroups.delete(position);
      if (group)
        edgeGroups.set(position, {
          group,
          subscription: group.onDidCollapsedChange(schedule),
        });
    }
  };
  /**
   * Measures right away, so a panel shown only briefly still counts as visited, then again on the
   * next frame and a few times while transitions run, so covering settles to its final state.
   */
  function schedule() {
    bindEdgeGroups();
    measure();
    if (frame === undefined) frame = requestAnimationFrame(measure);
    for (const settle of settles) clearTimeout(settle);
    settles = SETTLE_DELAYS_MS.map((delay) => setTimeout(measure, delay));
  }
  const subscriptions = [
    api.onDidLayoutChange(schedule),
    api.onDidLayoutFromJSON(schedule),
    api.onDidActivePanelChange(schedule),
    api.onDidAddPanel(schedule),
    api.onDidRemovePanel(schedule),
    api.onDidTabGroupCollapsedChange(schedule),
  ];
  window.addEventListener("resize", schedule);
  // Dialogs, popovers, and overlays can uncover panels without any Dockview event.
  const poll = window.setInterval(() => {
    bindEdgeGroups();
    measure();
  }, POLL_MS);
  bindEdgeGroups();
  measure();
  schedule();
  return () => {
    for (const subscription of subscriptions) subscription.dispose();
    for (const { subscription } of edgeGroups.values()) subscription.dispose();
    window.removeEventListener("resize", schedule);
    window.clearInterval(poll);
    if (frame !== undefined) cancelAnimationFrame(frame);
    for (const settle of settles) clearTimeout(settle);
  };
}

/**
 * Collapses expanded edge groups that cover an element, keeping groups that hold a required panel.
 * Returns whether anything was collapsed.
 */
export function collapseCoveringEdgeGroups(
  api: DockviewApi,
  element: Element,
  keep: readonly string[],
): boolean {
  const target = element.getBoundingClientRect();
  let collapsed = false;
  for (const position of EDGE_POSITIONS) {
    const group = api.getEdgeGroup(position);
    if (!group || group.isCollapsed()) continue;
    const panels = api.panels.filter((panel) => panel.group.api === group);
    if (panels.some((panel) => keep.includes(panel.api.component))) continue;
    const covers = panels.some((panel) => {
      const rect = panel.group.element.getBoundingClientRect();
      return (
        rect.left < target.right &&
        rect.right > target.left &&
        rect.top < target.bottom &&
        rect.bottom > target.top
      );
    });
    if (!covers) continue;
    group.collapse();
    collapsed = true;
  }
  return collapsed;
}
