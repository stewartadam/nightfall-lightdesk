// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createEffect } from "solid-js";
import { commandClient } from "../../lib/engine-commands";
import {
  connectionStatus,
  EngineRuntimeStatus,
} from "../../lib/engine-runtime";
import { getLogger } from "../../lib/logger";
import { isTauriRuntime } from "../../lib/tauri";
import { $telemetryState } from "../../state/settings";
import type { GraphicsReport } from "../../types";

const log = getLogger(import.meta.url);

/** The part of the WebGPU API this module reads; not every web view provides it. */
type GpuNavigator = Navigator & {
  gpu?: {
    requestAdapter(): Promise<{
      info?: { vendor?: string; architecture?: string; description?: string };
    } | null>;
  };
};

/**
 * Names the graphics processor through WebGL's debug renderer string, which most web views
 * expose, and releases the probe context straight away.
 */
function webglRenderer(): { available: boolean; renderer: string | null } {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2");
  if (!gl) return { available: false, renderer: null };
  const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = debugInfo
    ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) ?? "")
    : "";
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return { available: true, renderer: renderer || null };
}

/**
 * Describes the graphics hardware this window renders with: the rendering API the visualizer
 * can use (WebGPU when an adapter is available, otherwise WebGL 2) and the processor's name
 * when the web view reveals it.
 */
export async function collectGraphicsReport(): Promise<GraphicsReport> {
  const gpu = (navigator as GpuNavigator).gpu;
  const adapter = gpu ? await gpu.requestAdapter().catch(() => null) : null;
  const webgl = webglRenderer();
  const adapterName = [adapter?.info?.vendor, adapter?.info?.description]
    .filter(Boolean)
    .join(" ");
  return {
    gpu: webgl.renderer ?? (adapterName || undefined),
    backend: adapter ? "WebGPU" : webgl.available ? "WebGL 2" : "None",
  };
}

/**
 * Tells the engine which graphics hardware the desktop app's window uses, once per
 * connection, so usage reports can include it. Only the desktop app's own window reports,
 * since browsers on other devices describe their device rather than the desk's, and only
 * while the operator shares usage reports.
 */
export function GraphicsReporter() {
  const state = useStore($telemetryState);
  let reportedForConnection = false;

  /** Sends the report after each connection once sharing is on, and re-arms on disconnect. */
  createEffect(() => {
    const connected = connectionStatus() === EngineRuntimeStatus.Connected;
    if (!connected) {
      reportedForConnection = false;
      return;
    }
    const { available, consent } = state();
    if (
      reportedForConnection ||
      !isTauriRuntime() ||
      !available ||
      !consent.share_usage
    ) {
      return;
    }
    reportedForConnection = true;
    void collectGraphicsReport()
      .then((report) =>
        commandClient.emit("SettingsCommand", {
          type: "ReportGraphics",
          data: report,
        }),
      )
      .catch((error: unknown) => {
        log.warn("Could not report graphics hardware", { error });
      });
  });

  return null;
}
