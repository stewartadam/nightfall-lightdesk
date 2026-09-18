// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { writeFile } from "node:fs/promises";
import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

test.setTimeout(90_000);

// Chromium CompositorAnimations::FailureReason values are persisted in tracing.
const FILTER_MOVES_PIXELS = 1 << 12;
const AFFECTS_IMPORTANT_PROPERTY = 1 << 18;

/** Verifies compositor eligibility and records rendered motion under identical main-thread contention. */
test("keeps layout slides composited without the shared entrance filter", async ({
  page,
  backendSlot,
  browserName,
}, testInfo) => {
  test.skip(
    browserName !== "chromium",
    "Compositor failure flags are exposed by Chromium tracing.",
  );
  await prepareFreshBackendShowfile(backendSlot.backendPort);
  await page.goto("/?startup:draftRecovery=false");
  await waitForDockviewApp(page);
  const cdp = await page.context().newCDPSession(page);
  const events: {
    name: string;
    args?: { data?: { compositeFailed?: number } };
  }[] = [];
  cdp.on("Tracing.dataCollected", ({ value }) =>
    events.push(...(value as unknown as typeof events)),
  );
  let trial = "";
  const frames: { trial: string; timestamp: number; data: string }[] = [];
  cdp.on("Page.screencastFrame", (event) => {
    frames.push({
      trial,
      timestamp: event.metadata.timestamp ?? 0,
      data: event.data,
    });
    void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId });
  });
  await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
  const results: Record<string, unknown> = {};
  for (const variant of ["stock", "override", "fixed", "waapi"] as const) {
    trial = variant;
    events.length = 0;
    await cdp.send("Tracing.start", {
      categories: "devtools.timeline,blink.animations",
    });
    const result = await page.evaluate(async (variant) => {
      const { createLayoutEntrance } = await import(
        "/components/shell/docking/dockview/layout-entrance.ts"
      );
      const element = document.querySelector<HTMLElement>(
        '[data-workspace-active="true"]',
      )!;
      await Promise.all(
        element
          .getAnimations()
          .map((animation) => animation.finished.catch(() => {})),
      );
      const marker = document.createElement("div");
      marker.style.cssText =
        "position:absolute;top:20px;left:50px;width:4px;height:60px;background:rgb(255,0,255);z-index:99999";
      element.append(marker);
      const classes = [
        "animate-in",
        "duration-[220ms]",
        "ease-[cubic-bezier(0.2,0,0.2,1)]",
        "fill-mode-backwards",
        "slide-in-from-right-8",
      ];
      let animation: Animation;
      let dispose: () => void;
      if (variant === "fixed") {
        const entrance = createLayoutEntrance(element, 1)!;
        animation = entrance.animation;
        dispose = entrance.dispose;
      } else if (variant === "waapi") {
        animation = element.animate(
          [{ transform: "translateX(32px)" }, { transform: "translateX(0)" }],
          {
            duration: 220,
            easing: "cubic-bezier(0.2,0,0.2,1)",
            fill: "backwards",
          },
        );
        dispose = () => animation.cancel();
      } else {
        if (variant === "override") classes.push("filter-none!");
        element.classList.add(...classes);
        animation = element
          .getAnimations()
          .find(
            (candidate) =>
              candidate instanceof CSSAnimation &&
              candidate.animationName === "enter",
          )!;
        dispose = () => {
          element.classList.remove(...classes);
          element.getAnimations();
        };
      }
      const keyframes = (animation.effect as KeyframeEffect).getKeyframes();
      animation.pause();
      animation.currentTime = 0;
      await new Promise(requestAnimationFrame);
      animation.play();
      const block = await new Promise<{ start: number; end: number }>(
        (resolve) => {
          // Deliberately hold the main thread mid-slide to expose non-composited motion.
          setTimeout(() => {
            const start = Date.now() / 1000;
            const until = performance.now() + 120;
            while (performance.now() < until) {
              /* Controlled rendering contention. */
            }
            resolve({ start, end: Date.now() / 1000 });
          }, 50);
        },
      );
      await animation.finished;
      dispose();
      marker.remove();
      return { keyframes, block };
    }, variant);
    const complete = new Promise<void>((resolve) =>
      cdp.once("Tracing.tracingComplete", () => resolve()),
    );
    await cdp.send("Tracing.end");
    await complete;
    const failures = events
      .filter(
        (event) =>
          event.name === "Animation" &&
          event.args?.data?.compositeFailed !== undefined,
      )
      .map((event) => event.args!.data!.compositeFailed!);
    results[variant] = { ...result, failures };
    await writeFile(
      testInfo.outputPath(`${variant}-trace.json`),
      JSON.stringify(events),
    );
    expect(failures.length).toBeGreaterThan(0);
    if (variant === "stock")
      expect(
        failures.some((flags) => (flags & FILTER_MOVES_PIXELS) !== 0),
      ).toBe(true);
    else if (variant === "override")
      expect(
        failures.some((flags) => (flags & AFFECTS_IMPORTANT_PROPERTY) !== 0),
      ).toBe(true);
    else expect(failures.every((flags) => flags === 0)).toBe(true);
  }
  await cdp.send("Page.stopScreencast");
  for (const [index, frame] of frames.entries()) {
    await writeFile(
      testInfo.outputPath(`${frame.trial}-${index}.png`),
      Buffer.from(frame.data, "base64"),
    );
  }
  await writeFile(
    testInfo.outputPath("comparison.json"),
    JSON.stringify(
      { results, frames: frames.map(({ data: _data, ...frame }) => frame) },
      null,
      2,
    ),
  );
});
