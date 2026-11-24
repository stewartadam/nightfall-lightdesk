// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Locator, Page } from "@playwright/test";
import { prepareFreshBackendShowfile } from "../../webui/e2e/backend-showfile";
import { waitForDockviewApp } from "../../webui/e2e/showfile-startup";
import type { RecordingManifest, RecordingMarker } from "../shared/edit";
import { installPromoCursor, type PromoCursorApi } from "./cursor-overlay";
import { ScreencastRecorder } from "./screencast";

/** The promo package root, its git-ignored output folder, and the repository root. */
export const promoDir = join(dirname(fileURLToPath(import.meta.url)), "..");
export const outDir = join(promoDir, "out");
export const repoRoot = join(promoDir, "..");

/** Device pixels per CSS pixel; the 720x1280 viewport (see playwright.config.ts) records at 1080x1920. */
const SCALE = 1.5;
const OUTPUT = { width: 720 * SCALE, height: 1280 * SCALE };
const FPS = 60;

/** Element box in CSS pixels, as Playwright reports it. */
type Box = { x: number; y: number; width: number; height: number };

/** The fake cursor's API inside the page. */
type CursorWindow = { __promoCursor: PromoCursorApi };

/**
 * Opens the embedded demo engine with its bundled sample show and the fake
 * cursor installed, so every take starts from the same state.
 */
export async function openDemo(page: Page, baseURL: string | undefined) {
  // The dev server's routed documents need loopback access for Vite's HMR socket.
  await page
    .context()
    .grantPermissions(["local-network-access"], { origin: baseURL });
  await page.addInitScript(() => {
    localStorage.setItem("nightfall.currentShowfileName", "local-show");
  });
  await page.addInitScript(installPromoCursor);
  await page.goto(
    `/?engine=embedded-demo&startup:draftRecovery=false&e2e=1&visualizer:defaultPanel=false${qualityParam()}`,
  );
  await waitForDockviewApp(page);
  await hideDiagnostics(page);
}

/**
 * Hides on-screen diagnostics a viewer shouldn't see: the visualizer's frame
 * rate badge, and the git branch test builds name in the status bar.
 */
async function hideDiagnostics(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `div:has(> .fps-label),
      [data-testid="status-build-name"],
      [data-testid="status-build-separator"] { display: none !important; }`,
  });
}

/**
 * The visualizer quality override from `PROMO_VISUALIZER_QUALITY` (low,
 * medium or high) as a URL parameter, or nothing to keep the app's default.
 * Machines without a GPU record with `low` so the 3D view keeps up with the
 * rest of the page.
 */
function qualityParam(): string {
  const quality = process.env.PROMO_VISUALIZER_QUALITY;
  return quality
    ? `&visualizer:beamQuality=${encodeURIComponent(quality)}`
    : "";
}

/**
 * Opens the app against the desktop backend Playwright started, with a fresh
 * empty show and the fake cursor installed. For features the browser demo
 * hides, such as GDTF Share and MVR import. Name such a reel's script
 * `<reel>.desktop.record.ts` so `scripts/record.mjs` starts that backend.
 */
export async function openDesktop(
  page: Page,
  backendPort: number,
): Promise<void> {
  await prepareFreshBackendShowfile(backendPort);
  await page.addInitScript(installPromoCursor);
  await page.goto(`/?e2e=1&startup:draftRecovery=false${qualityParam()}`);
  await waitForDockviewApp(page);
  await hideDiagnostics(page);
  await clearFixtures(page);
}

/**
 * Deletes every fixture the test backend seeds into its fresh show, so a
 * desktop reel starts from an empty patch and imports land on free addresses.
 */
async function clearFixtures(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const stores = (window as any).appStores;
    const fixtures = Object.values(stores.fixtures.get()) as any[];
    for (const fixture of fixtures) {
      const { outcome } = await stores.sendAndAwait({
        module: "FixtureCommand",
        command: { type: "DeleteFixture", data: fixture.identifiers.id },
      });
      if (outcome.type !== "Succeeded") {
        throw new Error(`DeleteFixture failed: ${JSON.stringify(outcome)}`);
      }
    }
  });
}

/**
 * One recorded take of a reel: captures the page from `start()`, logs named
 * markers relative to the first frame, drives the fake cursor, and on
 * `finish()` writes `out/<reel>/recording.mp4` and `recording.json` for the
 * reel's edit to cut from.
 */
export class Take {
  readonly markers: RecordingMarker[] = [];
  private readonly dir: string;
  private readonly recorder: ScreencastRecorder;
  private origin = 0;

  /** Prepares a take for the reel with this id (its folder under `reels/`). */
  constructor(
    private readonly page: Page,
    private readonly reel: string,
  ) {
    this.dir = join(outDir, reel);
    mkdirSync(this.dir, { recursive: true });
    this.recorder = new ScreencastRecorder(
      page,
      join(this.dir, "frames"),
      OUTPUT,
    );
  }

  /** Starts capturing; marker times count from this moment's first frame. */
  async start(): Promise<void> {
    this.origin = await this.recorder.start();
  }

  /**
   * Records a marker now, with an optional element box converted to recording
   * pixels. `backdate` moves it earlier by that many seconds, for moments only
   * noticed after the fact.
   */
  async mark(
    name: string,
    target?: Locator | Box,
    {
      backdate = 0,
      ...extra
    }: Partial<RecordingMarker> & { backdate?: number } = {},
  ): Promise<void> {
    const t = Date.now() / 1000 - this.origin - backdate;
    const box =
      target && "boundingBox" in target ? await target.boundingBox() : target;
    const rect = box && {
      x: box.x * SCALE,
      y: box.y * SCALE,
      width: box.width * SCALE,
      height: box.height * SCALE,
    };
    this.markers.push({ name, t, ...(rect ? { rect } : {}), ...extra });
  }

  /**
   * Glides the fake cursor to the center (or an offset from the top-left) of
   * `target`, then moves the real pointer there so hover states follow.
   */
  async glideTo(
    target: Locator,
    offset?: { x: number; y: number },
  ): Promise<{ x: number; y: number }> {
    const box = await target.boundingBox();
    if (!box) throw new Error("Cursor target is not visible");
    const point = {
      x: box.x + (offset?.x ?? box.width / 2),
      y: box.y + (offset?.y ?? box.height / 2),
    };
    await this.page.evaluate(
      ({ x, y }) =>
        (window as unknown as CursorWindow).__promoCursor.moveTo(x, y),
      point,
    );
    await this.page.mouse.move(point.x, point.y);
    return point;
  }

  /**
   * Clicks where the cursor is, with the ripple drawn at the same moment. The
   * ripple plays on without holding the script, so clicks can follow each
   * other faster than it lasts, as taps on a tempo pad do.
   */
  async click(): Promise<void> {
    await Promise.all([
      this.page.evaluate(() => {
        void (window as unknown as CursorWindow).__promoCursor.ripple();
      }),
      this.page.mouse.down().then(() => this.page.mouse.up()),
    ]);
  }

  /**
   * Presses where the cursor is and drags in a straight line to `to` (CSS
   * pixels) over `durationMs`, moving the real pointer in small steps alongside
   * the fake cursor so the app sees a continuous drag, then releases.
   */
  async dragTo(to: { x: number; y: number }, durationMs = 1200): Promise<void> {
    const from = await this.page.evaluate(() =>
      (window as unknown as CursorWindow).__promoCursor.position(),
    );
    await this.page.mouse.down();
    const glide = this.page.evaluate(
      ({ x, y, durationMs }) =>
        (window as unknown as CursorWindow).__promoCursor.moveTo(x, y, {
          durationMs,
          overshoot: 0,
          straight: true,
        }),
      { ...to, durationMs },
    );
    const steps = Math.max(8, Math.round(durationMs / 50));
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      // Ease in and out, close to the overlay's own easing without overshoot.
      const eased = t * t * (3 - 2 * t);
      await this.page.mouse.move(
        from.x + (to.x - from.x) * eased,
        from.y + (to.y - from.y) * eased,
      );
      await this.page.waitForTimeout(durationMs / steps);
    }
    await glide;
    await this.page.mouse.up();
  }

  /** Glides to `target`, pauses briefly as a person would, and clicks it. */
  async glideAndClick(
    target: Locator,
    offset?: { x: number; y: number },
  ): Promise<void> {
    await this.glideTo(target, offset);
    await this.page.waitForTimeout(120);
    await this.click();
  }

  /**
   * Stops capturing and writes the take: the 60 fps video, the manifest and,
   * when given, a copy of the music the reel lays underneath.
   */
  async finish({ soundtrack }: { soundtrack?: string } = {}): Promise<void> {
    const stoppedAt = await this.recorder.stop();
    this.recorder.encode(join(this.dir, "recording.mp4"), FPS, this.origin);
    const soundtrackPath =
      soundtrack && `${this.reel}/soundtrack${extname(soundtrack)}`;
    if (soundtrack && soundtrackPath) {
      copyFileSync(soundtrack, join(outDir, soundtrackPath));
    }
    const manifest: RecordingManifest = {
      video: `${this.reel}/recording.mp4`,
      ...(soundtrackPath ? { soundtrack: soundtrackPath } : {}),
      width: OUTPUT.width,
      height: OUTPUT.height,
      fps: FPS,
      durationSeconds: stoppedAt - this.origin,
      markers: this.markers,
    };
    writeFileSync(
      join(this.dir, "recording.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    console.log(
      `promo: captured ${this.recorder.averageFps().toFixed(1)} fps on average over ${manifest.durationSeconds.toFixed(1)} s`,
    );
  }
}
