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
    "/?engine=embedded-demo&startup:draftRecovery=false&e2e=1&visualizer:defaultPanel=false",
  );
  await waitForDockviewApp(page);
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

  /** Clicks where the cursor is, with the ripple drawn at the same moment. */
  async click(): Promise<void> {
    await Promise.all([
      this.page.evaluate(() =>
        (window as unknown as CursorWindow).__promoCursor.ripple(),
      ),
      this.page.mouse.down().then(() => this.page.mouse.up()),
    ]);
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
