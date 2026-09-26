// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Node-side helpers shared by the optics and visualizer GPU specs. Browser-side
 * counterparts live in `fixtures/optics-harness.ts`.
 */

import { type Page, type TestInfo, test } from "@playwright/test";
import { WEBGPU_UNAVAILABLE } from "./fixtures/optics-constants";

/** URL of the blank canvas page every optics fixture renders into. */
export const OPTICS_FIXTURE_URL = "/e2e/fixtures/optics.html";

/**
 * Attaches diagnostics even for passing tests when set to `1`; by default images and
 * metrics are attached only when a test fails.
 */
export const ALWAYS_ATTACH_ARTIFACTS =
  process.env.NIGHTFALL_OPTICS_ARTIFACTS === "1";

/** Human-readable label used in test titles for a backend variant. */
export function backendLabel(forceWebGL: boolean): "WebGL" | "WebGPU" {
  return forceWebGL ? "WebGL" : "WebGPU";
}

/**
 * Collects uncaught page errors and, unless disabled, console errors (optionally only
 * those matching `consoleFilter`). Assert the returned array is empty at the end of a test.
 */
export function collectPageErrors(
  page: Page,
  options: { consoleErrors?: boolean; consoleFilter?: RegExp } = {},
): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  if (options.consoleErrors ?? true) {
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        (!options.consoleFilter || options.consoleFilter.test(message.text()))
      )
        errors.push(message.text());
    });
  }
  return errors;
}

/**
 * Opens the shared optics fixture page and returns an error collector bound to it,
 * registered before navigation so module-load failures are captured.
 */
export async function openOpticsFixture(
  page: Page,
  query = "",
): Promise<string[]> {
  const errors = collectPageErrors(page);
  await page.goto(`${OPTICS_FIXTURE_URL}${query}`);
  return errors;
}

/**
 * Runs a browser scenario that creates its renderer through the fixture harness and
 * converts the harness's WebGPU-unavailable signal into a skipped test, so WebGPU
 * variants never pass silently on the WebGL fallback.
 */
export async function evaluateOnBackend<Result, Argument>(
  page: Page,
  scenario: (argument: Argument) => Promise<Result>,
  argument: Argument,
): Promise<Result> {
  // Playwright's `Unboxed<Arg>` cannot be resolved for a generic argument type.
  const evaluate = page.evaluate.bind(page) as (
    scenario: (argument: Argument) => Promise<Result>,
    argument: Argument,
  ) => Promise<Result>;
  try {
    return await evaluate(scenario, argument);
  } catch (error) {
    if (error instanceof Error && error.message.includes(WEBGPU_UNAVAILABLE))
      test.skip(true, "WebGPU is unavailable in this browser");
    throw error;
  }
}

/** Records which backend a default-backend scenario ran on in the test report. */
export function annotateBackend(testInfo: TestInfo, backend: string): void {
  testInfo.annotations.push({ type: "backend", description: backend });
}

/** Artifact payloads: JSON-serialisable values, raw buffers, or PNG data URLs. */
export type Artifacts = Record<string, unknown>;

/** Attaches artifacts, decoding `data:image/png` URLs and serialising other values as JSON. */
async function attachArtifacts(
  testInfo: TestInfo,
  artifacts: Artifacts,
): Promise<void> {
  for (const [name, value] of Object.entries(artifacts)) {
    if (value === undefined) continue;
    if (Buffer.isBuffer(value)) {
      await testInfo.attach(name, {
        body: value,
        contentType: name.endsWith(".png")
          ? "image/png"
          : "application/octet-stream",
      });
    } else if (
      typeof value === "string" &&
      value.startsWith("data:image/png;base64,")
    ) {
      await testInfo.attach(name, {
        body: Buffer.from(value.split(",")[1], "base64"),
        contentType: "image/png",
      });
    } else {
      await testInfo.attach(name, {
        body: typeof value === "string" ? value : JSON.stringify(value),
        contentType: "application/json",
      });
    }
  }
}

/** Attaches every canvas retained by the browser harness's `retainCanvas`. */
async function attachRetainedCanvases(
  page: Page,
  testInfo: TestInfo,
): Promise<void> {
  if (page.isClosed()) return;
  const images = await page
    .evaluate(async () => {
      const { encodeRetainedCanvases } = await import(
        "/e2e/fixtures/optics-harness.ts"
      );
      return encodeRetainedCanvases();
    })
    .catch(() => ({}) as Record<string, string>);
  for (const [name, base64] of Object.entries(images))
    await testInfo.attach(name.endsWith(".png") ? name : `${name}.png`, {
      body: Buffer.from(base64, "base64"),
      contentType: "image/png",
    });
}

/**
 * Runs `assertions` and attaches `artifacts` (plus canvases the page retained) only
 * when an assertion throws or records a soft failure, or when
 * `NIGHTFALL_OPTICS_ARTIFACTS=1`. Passing runs therefore write no images or metrics.
 */
export async function expectWithArtifacts(
  testInfo: TestInfo,
  options: { page?: Page; artifacts?: Artifacts },
  assertions: () => void | Promise<void>,
): Promise<void> {
  const softErrors = testInfo.errors.length;
  /** Attaches the diagnostics once, tolerating a page closed by the failure. */
  const attach = async () => {
    await attachArtifacts(testInfo, options.artifacts ?? {});
    if (options.page) await attachRetainedCanvases(options.page, testInfo);
  };
  try {
    await assertions();
  } catch (error) {
    await attach();
    throw error;
  }
  if (ALWAYS_ATTACH_ARTIFACTS || testInfo.errors.length > softErrors)
    await attach();
}
