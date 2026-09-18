// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import {
  APP_BUILD_ID,
  APP_BUILD_NAME,
  APP_NAME,
  APP_VERSION,
} from "../../../lib/app-metadata";
import {
  type FaderBeatState,
  INITIAL_FADER_BEAT_STATE,
  nextFaderBeatState,
} from "../../../lib/startup-fader-animation";
import { serverVersion } from "../../../state/appStores";
import { reducedMotion } from "../../../state/reduced-motion";
import type { StartupPhase } from "./model";

const FADER_BEAT_INTERVAL_MS = 1000;
const STARTUP_SPLASH_MIN_VISIBLE_MS = 1000;
const STARTUP_SPLASH_FADE_OUT_MS = 300;

/** Renders the nightfall mark with fader caps that move together on a shared beat. */
function AnimatedSplashLogo(props: { beatState: FaderBeatState }) {
  return (
    <div
      class="rounded-[2.1rem] border border-white/10 bg-neutral-950/80 p-1 ring-1 ring-black/50 md:rounded-[2.35rem]"
      style={{
        "box-shadow":
          "0 28px 80px rgba(0, 0, 0, 0.58), 0 12px 32px rgba(0, 0, 0, 0.46), inset 0 1px 0 rgba(255, 255, 255, 0.13), 0 0 42px rgba(124, 92, 255, 0.14)",
      }}
      data-testid="startup-logo-shell"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 32 32"
        role="img"
        aria-label="nightfall logo"
        class="size-36 rounded-[1.85rem] md:size-44 md:rounded-[2.1rem]"
        data-beat={props.beatState.beat}
      >
        <style>{`
          .nightfall-splash-fader {
            transform-box: fill-box;
            transform-origin: center;
            transition: transform 220ms cubic-bezier(.4, 0, .2, 1);
            will-change: transform;
          }
          :root[data-reduced-motion="true"] {
            .nightfall-splash-fader { transition: none; }
          }
        `}</style>
        <rect width="32" height="32" rx="7" fill="#0B1020" />
        <path
          d="M7.2 1.2H24.8C28.1 1.2 30.8 3.9 30.8 7.2V8.4C25.8 5.9 19.9 4.7 13.2 4.7H1.2C2 2.6 4.1 1.2 7.2 1.2Z"
          fill="rgba(255,255,255,0.08)"
        />
        <rect x="8" y="8" width="3" height="16" rx="1.5" fill="#E6E8FF" />
        <rect x="14.5" y="8" width="3" height="16" rx="1.5" fill="#E6E8FF" />
        <rect x="21" y="8" width="3" height="16" rx="1.5" fill="#E6E8FF" />
        <rect
          class="nightfall-splash-fader nightfall-splash-fader-left"
          style={{ transform: `translateY(${props.beatState.left}px)` }}
          x="6.8"
          y="13"
          width="5.4"
          height="4"
          rx="2"
          fill="#7C5CFF"
        />
        <rect
          class="nightfall-splash-fader nightfall-splash-fader-middle"
          style={{ transform: `translateY(${props.beatState.middle}px)` }}
          x="13.3"
          y="10.5"
          width="5.4"
          height="4"
          rx="2"
          fill="#31D0AA"
        />
        <rect
          class="nightfall-splash-fader nightfall-splash-fader-right"
          style={{ transform: `translateY(${props.beatState.right}px)` }}
          x="19.8"
          y="16.5"
          width="5.4"
          height="4"
          rx="2"
          fill="#FFB020"
        />
      </svg>
    </div>
  );
}

/** Returns a reactive fader beat state for splash animation. */
function createSplashBeatState() {
  const [beatState, setBeatState] = createSignal(INITIAL_FADER_BEAT_STATE);
  const reduceMotion = useStore(reducedMotion);

  /** Starts and stops decorative fader motion as the preference changes. */
  createEffect(() => {
    if (reduceMotion()) return;
    const beatIntervalId = window.setInterval(
      () => setBeatState(nextFaderBeatState),
      FADER_BEAT_INTERVAL_MS,
    );
    onCleanup(() => window.clearInterval(beatIntervalId));
  });
  return beatState;
}

/** Renders the startup splash while backend presence and showfile state settle. */
function StartupSplash(props: { exiting: boolean; phase: StartupPhase }) {
  const version = useStore(serverVersion);
  const beatState = createSplashBeatState();

  /** Returns user-facing status text for the current startup phase. */
  const statusText = () => {
    switch (props.phase) {
      case "waiting":
        return "Initializing";
      case "checking":
        return "Listing showfiles";
      case "prompting":
        return "Recoverable draft found";
      case "loading-draft":
        return "Loading draft showfile";
      case "loading-saved":
        return "Loading saved showfile";
      case "ready":
        return "Ready";
    }
  };

  return (
    <div
      class="fixed inset-0 z-[1200] flex items-center justify-center bg-neutral-950 text-neutral-100 transition-opacity duration-300 ease-out motion-reduce:transition-none"
      classList={{
        "opacity-0 pointer-events-none": props.exiting,
        "opacity-100": !props.exiting,
      }}
      role="status"
      aria-label="Starting nightfall"
      data-testid="startup-splash"
    >
      <div class="flex flex-col items-center gap-8 px-6 pb-20 text-center">
        <div class="space-y-3">
          <h1 class="text-3xl font-semibold">{APP_NAME}</h1>
        </div>
        <AnimatedSplashLogo beatState={beatState()} />
        <div class="space-y-3">
          <p class="text-lg text-neutral-400">
            {statusText()}
            <span
              class="ml-2 inline-flex w-7 items-center justify-between align-middle"
              aria-hidden="true"
              data-testid="startup-status-dots"
            >
              <span class="startup-status-dot" />
              <span class="startup-status-dot" />
              <span class="startup-status-dot" />
            </span>
          </p>
        </div>
      </div>
      <div class="absolute bottom-6 left-0 right-0 px-4 text-center font-mono text-xs text-neutral-500">
        <p>
          v{APP_VERSION} - {APP_BUILD_NAME} ({APP_BUILD_ID})
        </p>
        <Show when={version()}>
          {(engineVersion) => <p>engine v{engineVersion()}</p>}
        </Show>
      </div>
    </div>
  );
}

/** Keeps the startup splash mounted long enough for its fade-out transition. */
export function StartupSplashTransition(props: {
  phase: StartupPhase;
  visible: boolean;
}) {
  const [rendered, setRendered] = createSignal(props.visible);
  const [exiting, setExiting] = createSignal(false);
  const [displayPhase, setDisplayPhase] = createSignal(props.phase);
  let visibleStartedAtMs: number | undefined = props.visible
    ? performance.now()
    : undefined;
  let transitionTimeoutId: number | undefined;

  createEffect(() => {
    window.clearTimeout(transitionTimeoutId);
    if (props.visible) {
      if (!rendered() || visibleStartedAtMs === undefined) {
        visibleStartedAtMs = performance.now();
      }
      setDisplayPhase(props.phase);
      setRendered(true);
      setExiting(false);
      return;
    }
    if (!rendered()) return;
    const elapsedVisibleMs =
      visibleStartedAtMs === undefined
        ? STARTUP_SPLASH_MIN_VISIBLE_MS
        : performance.now() - visibleStartedAtMs;
    const fadeDelayMs = Math.max(
      0,
      STARTUP_SPLASH_MIN_VISIBLE_MS - elapsedVisibleMs,
    );
    transitionTimeoutId = window.setTimeout(() => {
      setExiting(true);
      transitionTimeoutId = window.setTimeout(() => {
        setRendered(false);
        setExiting(false);
        visibleStartedAtMs = undefined;
        transitionTimeoutId = undefined;
      }, STARTUP_SPLASH_FADE_OUT_MS);
    }, fadeDelayMs);
  });

  onCleanup(() => window.clearTimeout(transitionTimeoutId));
  return (
    <Show when={rendered()}>
      <StartupSplash exiting={exiting()} phase={displayPhase()} />
    </Show>
  );
}
