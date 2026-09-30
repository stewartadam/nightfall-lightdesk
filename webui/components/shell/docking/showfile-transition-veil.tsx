// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import {
  createEffect,
  createSignal,
  type JSX,
  onCleanup,
  Show,
} from "solid-js";
import { resyncComplete, resyncGeneration } from "../../../lib/engine-runtime";
import { currentShowfileRevision } from "../../../lib/showfile-loading";
import { pendingPanelComponentLoads } from "../../../state/panel-component-loads";
import {
  endShowfileTransition,
  showfileTransition,
  showfileTransitionDataReady,
} from "../../../state/showfile-transition";
import { dockviewLayoutShowfileRevision } from "./layout-readiness";

/** Longest a replacement may keep the dock hidden before it is revealed regardless. */
const MAX_HIDDEN_MS = 10_000;
/** Longest to wait for panel mounting to go quiet once the new show's data is in. */
const MAX_SETTLE_MS = 2_500;
/** Frame interval below which the main thread counts as idle. */
const QUIET_FRAME_MS = 34;
/** Consecutive idle frames that mark panel mounting as finished. */
const QUIET_FRAMES_REQUIRED = 3;
/** Duration of the veil's fade once the dock is revealed. */
const FADE_MS = 150;

/**
 * Resolves after several consecutive short animation frames with no panel
 * component module still loading, or after the settle limit, so the dock is
 * revealed once panels stop mounting and reflowing.
 *
 * The settle limit counts from the last frame with a pending panel import, so a
 * cold start that is still downloading panel code does not reveal empty panels;
 * the veil's overall hidden limit still bounds a load that never settles.
 */
function waitForQuietFrames(isCancelled: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    let settleStartedAt = performance.now();
    let previous = settleStartedAt;
    let quietFrames = 0;
    /** Counts consecutive idle frames and resolves once enough have passed. */
    const tick = (now: number) => {
      if (isCancelled()) return resolve();
      const loadingPanels = pendingPanelComponentLoads.get() > 0;
      if (loadingPanels) settleStartedAt = now;
      quietFrames =
        !loadingPanels && now - previous < QUIET_FRAME_MS ? quietFrames + 1 : 0;
      previous = now;
      if (
        quietFrames >= QUIET_FRAMES_REQUIRED ||
        now - settleStartedAt > MAX_SETTLE_MS
      ) {
        resolve();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/**
 * Keeps the dock hidden while a showfile load replaces the backend world, and
 * reveals it once the new show's data, layout, and panels have settled.
 *
 * The dock stays laid out (visibility, not display) so panels can measure and
 * render while hidden, and the operator never watches them initialize.
 */
export default function ShowfileTransitionVeil(props: {
  children: JSX.Element;
}) {
  const transition = useStore(showfileTransition);
  const showfileRevision = useStore(currentShowfileRevision);
  const layoutShowfileRevision = useStore(dockviewLayoutShowfileRevision);
  const [settling, setSettling] = createSignal(false);
  const [fading, setFading] = createSignal(false);

  /** Reveals the dock once the pending replacement's data and layout are ready. */
  createEffect(() => {
    const pending = transition();
    if (!pending) return;
    setFading(false);
    setSettling(false);
    let cancelled = false;
    const timeout = window.setTimeout(endShowfileTransition, MAX_HIDDEN_MS);
    onCleanup(() => {
      cancelled = true;
      window.clearTimeout(timeout);
    });

    /** Waits for data readiness, then for panels to finish mounting. */
    createEffect(() => {
      const ready = showfileTransitionDataReady(pending, {
        resyncComplete: resyncComplete(),
        resyncGeneration: resyncGeneration(),
        showfileRevision: showfileRevision(),
        layoutShowfileRevision: layoutShowfileRevision(),
      });
      if (!ready || settling()) return;
      setSettling(true);
      void waitForQuietFrames(() => cancelled).then(() => {
        if (!cancelled) endShowfileTransition();
      });
    });
  });

  /** Fades the veil out after the dock is revealed instead of cutting it. */
  createEffect(() => {
    if (transition() || !settling()) return;
    setFading(true);
    const timeout = window.setTimeout(() => {
      setFading(false);
      setSettling(false);
    }, FADE_MS);
    onCleanup(() => window.clearTimeout(timeout));
  });

  const hidden = () => transition() !== null;

  return (
    <div class="relative h-full min-h-0 w-full">
      <div
        class="h-full min-h-0 w-full"
        style={{ visibility: hidden() ? "hidden" : undefined }}
        aria-busy={hidden()}
      >
        {props.children}
      </div>
      <Show when={hidden() || fading()}>
        <div
          class="absolute inset-0 z-50 flex items-center justify-center bg-[#101112] text-sm text-neutral-400 transition-opacity ease-out motion-reduce:transition-none"
          classList={{ "opacity-0 pointer-events-none": !hidden() }}
          style={{ "transition-duration": `${FADE_MS}ms` }}
          role="status"
          aria-label="Loading showfile"
          data-testid="showfile-transition-veil"
        >
          Loading showfile…
        </div>
      </Show>
    </div>
  );
}
