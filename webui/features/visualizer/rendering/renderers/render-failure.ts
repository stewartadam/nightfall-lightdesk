// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Describes renderer failures so the panel can recover from them instead of
 * the render loop throwing on every frame.
 */

/** What stopped the renderer. */
export type VisualizerRenderFailureKind =
  /** Creating the renderer failed. */
  | "init-error"
  /** A frame threw while rendering. */
  | "render-error"
  /** The GPU device was lost, for example after a driver reset. */
  | "device-lost";

/** A renderer failure, in a shape that crosses the worker boundary. */
export interface VisualizerRenderFailure {
  kind: VisualizerRenderFailureKind;
  message: string;
  stack?: string;
}

/** Turns a thrown value into a failure that can be posted between threads. */
export function describeRenderFailure(
  kind: VisualizerRenderFailureKind,
  error: unknown,
): VisualizerRenderFailure {
  if (error instanceof Error) {
    return {
      kind,
      message: `${error.name}: ${error.message}`,
      stack: error.stack,
    };
  }
  return { kind, message: String(error) };
}

/** Receives the renderer's failure. */
export type VisualizerRenderFailureCallback = (
  failure: VisualizerRenderFailure,
) => void;

/**
 * Reports a renderer's first failure exactly once. A failure that happens
 * before anyone listens is held and delivered when a callback is set, because
 * the first frame can fail before the panel finishes wiring the renderer up.
 */
export class RenderFailureLatch {
  private failure: VisualizerRenderFailure | null = null;
  private callback: VisualizerRenderFailureCallback | null = null;
  private delivered = false;

  /** Whether the renderer has failed and must not render again. */
  get failed(): boolean {
    return this.failure !== null;
  }

  /** Records the first failure and delivers it; later failures are ignored. */
  report(failure: VisualizerRenderFailure): void {
    if (this.failure) return;
    this.failure = failure;
    this.deliver();
  }

  /** Sets or clears the listener, delivering a held failure to a new one. */
  setCallback(callback: VisualizerRenderFailureCallback | null): void {
    this.callback = callback;
    this.deliver();
  }

  /** Hands the recorded failure to the listener once both exist. */
  private deliver(): void {
    if (!this.failure || !this.callback || this.delivered) return;
    this.delivered = true;
    this.callback(this.failure);
  }
}

/** Describes three.js's device-lost report as a renderer failure. */
export function describeDeviceLoss(info: {
  message: string;
  reason: string | null;
}): VisualizerRenderFailure {
  return {
    kind: "device-lost",
    message: info.reason
      ? `GPU device lost (${info.reason}): ${info.message}`
      : `GPU device lost: ${info.message}`,
  };
}

/** A failure a renderer fakes for testing, as passed in its init config. */
export type SimulatedRenderFailureKind = "render" | "device-lost";

/** Frames a renderer draws before a simulated failure fires, so the scene shows first. */
const SIMULATED_FAILURE_FRAMES = 10;

/**
 * Fakes a renderer failure after a few frames, for testing recovery. A
 * simulated render error throws from the frame like a real one; a simulated
 * device loss is returned for the caller to report like three.js's own.
 */
export class SimulatedRenderFailure {
  private frames = 0;

  /** @param kind The failure to fake, or undefined to never fail. */
  constructor(private readonly kind: SimulatedRenderFailureKind | undefined) {}

  /** Counts a rendered frame, failing once enough frames have been drawn. */
  tick(): VisualizerRenderFailure | null {
    if (!this.kind) return null;
    this.frames += 1;
    if (this.frames < SIMULATED_FAILURE_FRAMES) return null;
    if (this.kind === "render") {
      throw new Error("Simulated visualizer render failure");
    }
    return describeDeviceLoss({
      message: "Simulated GPU device loss",
      reason: null,
    });
  }
}
