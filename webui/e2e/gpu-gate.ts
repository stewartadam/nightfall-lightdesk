// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type {
  Browser,
  Page,
  PlaywrightWorkerArgs,
  TestInfo,
} from "@playwright/test";

/**
 * Tag for tests that assert on pixels the 3D visualizer rasterized. They need a GPU or
 * Mesa's llvmpipe/lavapipe, and are skipped on renderers that do not reproduce the
 * visualizer's output reliably: SwiftShader (Chromium's built-in fallback), Windows WARP,
 * or no WebGL at all.
 */
export const GPU_TAG = "@gpu";

/** Environment switch that runs `@gpu` tests even on a renderer the gate would skip. */
export const RUN_GPU_SPECS_ENV = "NIGHTFALL_PLAYWRIGHT_RUN_GPU_SPECS";

/** Whether the browser can run `@gpu` tests, with the evidence for the test report. */
export type GpuProbe = {
  /** True when the renderer the visualizer will use is a GPU or llvmpipe/lavapipe. */
  capable: boolean;
  /** Summary of the WebGL renderer and WebGPU adapter, or why the probe failed. */
  description: string;
};

/**
 * Renderer and adapter names the gate skips: SwiftShader, Mesa softpipe and Windows WARP.
 * Mesa llvmpipe and lavapipe are deliberately absent, since the visualizer specs pass on
 * them in GPU-less cloud containers.
 */
const UNSUPPORTED_RENDERER = /swiftshader|softpipe|basic render driver/iu;

/** Mesa CPU renderers that run `@gpu` tests although Chromium reports them as fallbacks. */
const MESA_CPU_RENDERER = /llvmpipe|lavapipe/iu;

/**
 * Probe page URL. `navigator.gpu` exists only in secure contexts, which `about:blank`
 * in a new page is not, so the probe loads an HTTPS page fulfilled by a route.
 */
const PROBE_URL = "https://gpu-probe.invalid/";

/** Upper bound for the whole probe, since adapter requests can hang in broken GPU stacks. */
const PROBE_TIMEOUT_MS = 15_000;

/** Raw renderer details reported by the probe page. */
type RendererReport = {
  /** Unmasked WebGL renderer string, or null without a WebGL context. */
  webgl: string | null;
  /** WebGPU adapter details, or null without an adapter. */
  webgpu: { fallback: boolean; identity: string } | null;
};

/**
 * Reads the WebGL2 renderer and the default WebGPU adapter in a secure blank page.
 * The visualizer renders through WebGPU when an adapter exists and falls back to
 * WebGL2 otherwise, so both backends are inspected; WebGL1 alone cannot run it.
 */
async function readRenderers(page: Page): Promise<RendererReport> {
  await page.route(PROBE_URL, (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.goto(PROBE_URL);
  return await page.evaluate(async (): Promise<RendererReport> => {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    let webgl: string | null = null;
    if (gl) {
      const debug = gl.getExtension("WEBGL_debug_renderer_info");
      webgl = String(
        gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
      );
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
    type Adapter = {
      info?: Record<string, unknown>;
      isFallbackAdapter?: boolean;
    };
    const gpu = (
      navigator as { gpu?: { requestAdapter(): Promise<Adapter | null> } }
    ).gpu;
    const adapter = gpu ? await gpu.requestAdapter().catch(() => null) : null;
    if (!adapter) return { webgl, webgpu: null };
    const info = adapter.info ?? {};
    return {
      webgl,
      webgpu: {
        fallback: Boolean(info.isFallbackAdapter ?? adapter.isFallbackAdapter),
        identity: ["vendor", "architecture", "device", "description"]
          .map((key) => info[key])
          .filter((value) => typeof value === "string" && value !== "")
          .join(" / "),
      },
    };
  });
}

/**
 * Decides whether a WebGPU adapter can run `@gpu` tests. Chromium flags every CPU
 * adapter as a fallback, including lavapipe, so a fallback adapter is accepted only
 * when it names Mesa's llvmpipe or lavapipe; SwiftShader and WARP never are.
 */
function webgpuAdapterSupported({
  fallback,
  identity,
}: NonNullable<RendererReport["webgpu"]>): boolean {
  if (UNSUPPORTED_RENDERER.test(identity)) return false;
  return !fallback || MESA_CPU_RENDERER.test(identity);
}

/**
 * Decides whether the renderer the visualizer will use can run `@gpu` tests. With a
 * WebGPU adapter the visualizer renders through it, so the adapter alone decides.
 * Without one it falls back to WebGL2, which must exist and not be an unsupported
 * renderer.
 */
function classify({ webgl, webgpu }: RendererReport): GpuProbe {
  const webgpuLabel = webgpu
    ? `${webgpu.fallback ? "fallback " : ""}${webgpu.identity || "unnamed adapter"}`
    : "no adapter";
  const description = `WebGL2: ${webgl ?? "unavailable"}; WebGPU: ${webgpuLabel}`;
  const capable = webgpu
    ? webgpuAdapterSupported(webgpu)
    : webgl !== null && !UNSUPPORTED_RENDERER.test(webgl);
  return { capable, description };
}

/**
 * Probes the worker's browser renderer. A probe that throws or exceeds
 * {@link PROBE_TIMEOUT_MS} counts as incapable, so a broken GPU stack skips `@gpu`
 * tests instead of failing or hanging them.
 */
export async function probeGpu(browser: Browser): Promise<GpuProbe> {
  let page: Page | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${PROBE_TIMEOUT_MS} ms`)),
      PROBE_TIMEOUT_MS,
    );
  });
  try {
    const probe = browser.newPage().then((created) => {
      page = created;
      return readRenderers(created);
    });
    return classify(await Promise.race([probe, timeout]));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { capable: false, description: `GPU probe failed: ${reason}` };
  } finally {
    clearTimeout(timer);
    // Closing also abandons an adapter request that never settled.
    await page?.close().catch(() => undefined);
  }
}

/** True when {@link RUN_GPU_SPECS_ENV} is set to a truthy value such as `1` or `true`. */
function gpuSpecsForced(): boolean {
  const value = process.env[RUN_GPU_SPECS_ENV]?.trim().toLowerCase() ?? "";
  return ["1", "true", "yes", "on"].includes(value);
}

let cachedProbe: Promise<GpuProbe> | undefined;

/**
 * Skips a `@gpu`-tagged test when the browser's renderer cannot run it, unless
 * {@link RUN_GPU_SPECS_ENV} forces it to run. The probe runs at most once per worker
 * and only for tagged tests, so untagged specs never pay for it.
 */
async function skipUnsupportedGpuTest(
  browser: Browser,
  testInfo: TestInfo,
): Promise<void> {
  if (!testInfo.tags.includes(GPU_TAG)) return;
  if (gpuSpecsForced()) return;
  cachedProbe ??= probeGpu(browser);
  const probe = await cachedProbe;
  testInfo.annotations.push({ type: "gpu", description: probe.description });
  testInfo.skip(
    !probe.capable,
    `${GPU_TAG} needs a GPU or llvmpipe (${probe.description}). Set ${RUN_GPU_SPECS_ENV}=1 to run it anyway.`,
  );
}

/** Test-scoped fixture set that gates `@gpu`-tagged tests. */
export type GpuGateFixtures = {
  /** Skips `@gpu`-tagged tests when the browser's renderer cannot run them. */
  gpuGate: undefined;
};

/**
 * Auto fixture body for {@link GpuGateFixtures}. Auto fixtures set up before the
 * fixtures a test requests, so a skipped test never runs its `beforeEach` hooks.
 * Playwright still runs `afterEach` hooks, and sets up the fixtures they request,
 * for a test skipped this way.
 */
export async function gpuGateFixture(
  { browser }: Pick<PlaywrightWorkerArgs, "browser">,
  use: (value: undefined) => Promise<void>,
  testInfo: TestInfo,
): Promise<void> {
  await skipUnsupportedGpuTest(browser, testInfo);
  await use(undefined);
}
