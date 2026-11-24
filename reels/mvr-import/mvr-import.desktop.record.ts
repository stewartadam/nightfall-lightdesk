// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JSHandle, Locator, Page } from "@playwright/test";
import { expect, test } from "../../webui/e2e/playwright-fixtures";
import type { ReelCursorApi } from "../kit/record/cursor-overlay";
import { openDesktop, outDir, Take } from "../kit/record/take";

/**
 * A mid-size rig with a ground-support truss from the community MVR-Stash
 * collection, pinned to one commit and checked by hash. It is fetched at record
 * time rather than committed, since the collection carries no licence.
 */
const RIG = {
  url: "https://raw.githubusercontent.com/JMLutra/MVR-Stash/19c5c3f96ccb10d955deb4589882b71ca25a5868/Midsize%20w%20GP/Midsize%20w%20GP.zip",
  sha256: "75a5bcf4f8863c59161f43f517bc68c6d2ef65ec89dcd8c017280e62d8667b9b",
  entry: "Midsize w GP/Midsize w GP.mvr",
  name: "Midsize w GP (JMLutra).mvr",
};

/**
 * Downloads the pinned rig archive once into `out/mvr-import/`, verifies its
 * hash, and returns the MVR file's bytes from inside it.
 */
async function fetchRig(): Promise<Buffer> {
  const dir = join(outDir, "mvr-import", "rig");
  const archive = join(dir, "rig.zip");
  mkdirSync(dir, { recursive: true });
  if (!existsSync(archive)) {
    const response = await fetch(RIG.url);
    if (!response.ok)
      throw new Error(`Rig download failed: ${response.status}`);
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  }
  const digest = createHash("sha256")
    .update(readFileSync(archive))
    .digest("hex");
  if (digest !== RIG.sha256) {
    throw new Error(`Rig archive hash ${digest} does not match the pinned one`);
  }
  return execFileSync("unzip", ["-p", archive, RIG.entry], {
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** The page with the reel cursor overlay installed. */
type CursorWindow = { __reelCursor: ReelCursorApi };

/**
 * Hands the page the rig as a file in a drag's data, ready to drop. Decoding
 * the file blocks the page for a moment, so this runs before the take starts.
 */
async function rigDataTransfer(
  page: Page,
  bytes: Buffer,
): Promise<JSHandle<DataTransfer>> {
  return page.evaluateHandle(
    ({ base64, name }) => {
      const binary = atob(base64);
      const data = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(
        new File([data], name, { type: "application/octet-stream" }),
      );
      return dataTransfer;
    },
    { base64: bytes.toString("base64"), name: RIG.name },
  );
}

/**
 * Drags the rig file into `dropZone` the way a file comes in from the desktop:
 * the cursor enters from the right edge of the frame carrying a file chip
 * named after the rig, the zone lights up as it arrives, and the drop hands
 * the app the real file through the zone's own drag-and-drop handlers.
 */
async function dragFileIn(
  page: Page,
  dropZone: Locator,
  transfer: JSHandle<DataTransfer>,
): Promise<void> {
  const box = await dropZone.boundingBox();
  if (!box) throw new Error("Drop zone is not visible");
  const target = { x: box.x + box.width / 2, y: box.y + box.height * 0.55 };
  const viewport = page.viewportSize() ?? { width: 720, height: 1280 };

  // Jump the cursor off the right edge, out of view, carrying the file chip.
  await page.evaluate(
    async ({ x, y, name }) => {
      const cursor = (window as unknown as CursorWindow).__reelCursor;
      await cursor.moveTo(x, y, {
        durationMs: 1,
        overshoot: 0,
        straight: true,
      });
      const chip = document.createElement("div");
      chip.style.cssText =
        "display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:10px;background:rgba(38,38,46,.94);border:1px solid rgba(255,255,255,.22);box-shadow:0 8px 24px rgba(0,0,0,.5);color:#f5f5f5;font:500 14px system-ui,sans-serif;white-space:nowrap;will-change:transform;";
      chip.innerHTML =
        '<svg width="22" height="26" viewBox="0 0 22 26" aria-hidden="true"><path d="M2 2h12l6 6v16H2z" fill="#e8e8ee" stroke="#9aa" stroke-width="1"/><path d="M14 2v6h6" fill="#c9c9d4"/><rect x="4" y="15" width="14" height="6" rx="1.5" fill="#3b82f6"/><text x="11" y="20" font-size="5" font-family="system-ui" font-weight="700" fill="#fff" text-anchor="middle">MVR</text></svg>';
      chip.append(name);
      const drop = cursor.carry(chip, { x: 14, y: 20 });
      (window as unknown as { __reelDropChip?: () => void }).__reelDropChip =
        drop;
    },
    { x: viewport.width + 40, y: target.y + 140, name: RIG.name },
  );

  const durationMs = 1_900;
  const glide = page.evaluate(
    ({ x, y, durationMs }) =>
      (window as unknown as CursorWindow).__reelCursor.moveTo(x, y, {
        durationMs,
        overshoot: 0,
      }),
    { ...target, durationMs },
  );
  // The zone lights up once the chip is over it, near the end of the glide.
  await page.waitForTimeout(durationMs * 0.7);
  await dropZone.dispatchEvent("dragenter", { dataTransfer: transfer });
  await dropZone.dispatchEvent("dragover", { dataTransfer: transfer });
  await glide;
  await page.mouse.move(target.x, target.y);
  await page.waitForTimeout(450);
  await dropZone.dispatchEvent("drop", { dataTransfer: transfer });
  await page.evaluate(() =>
    (window as unknown as { __reelDropChip?: () => void }).__reelDropChip?.(),
  );
  await transfer.dispose();
}

/**
 * Returns the box, in CSS pixels, around the open app menu and the hamburger
 * button that opened it, so one zoom frames both clicks.
 */
async function menuArea(
  page: Page,
  menuButton: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const boxes = await Promise.all(
    [
      menuButton,
      page.getByRole("button", { name: "New Showfile" }),
      page.getByRole("button", { name: "About" }),
    ].map((locator) => locator.boundingBox()),
  );
  const present = boxes.filter((box) => box !== null);
  if (present.length !== boxes.length) throw new Error("App menu is not open");
  const left = Math.min(...present.map((box) => box.x));
  const top = Math.min(...present.map((box) => box.y));
  const right = Math.max(...present.map((box) => box.x + box.width));
  const bottom = Math.max(...present.map((box) => box.y + box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Shows the imported rig from more than one angle: the cursor drags across the
 * 3D view to the right, which orbits the camera around to the left, then
 * scrolls the wheel to pull the camera back a little.
 */
async function showOffRig(
  take: Take,
  page: Page,
  canvas: Locator,
): Promise<void> {
  const box = await canvas.boundingBox();
  if (!box) throw new Error("3D view is not visible");
  const start = await take.glideTo(canvas, {
    x: box.width * 0.3,
    y: box.height * 0.55,
  });
  await page.waitForTimeout(300);
  await Promise.all([
    take.dragTo({ x: start.x + box.width * 0.2, y: start.y }, 2_000),
    fadeBlindersUp(page, 50, 3),
  ]);
  await page.waitForTimeout(400);
  await zoomOutSmoothly(canvas, start, 200, 1_200);
}

/** The rig's ROXX blinders on the trusses, by their fixture IDs in the file. */
const BLINDERS = "fixture 601>612 .1";

/**
 * Fades the blinders' master dimmer (each blinder's first element) from dark
 * up to `percent` over `seconds`, as one engine fade sent off camera, so their
 * beams swell while the camera orbits. A single fade runs in the engine
 * without a command per step, which would hitch the 3D view.
 */
async function fadeBlindersUp(
  page: Page,
  percent: number,
  seconds: number,
): Promise<void> {
  const outcome = await page.evaluate(
    async (statement) =>
      (
        await (window as any).appStores.sendAndAwait({
          module: "EngineCommand",
          command: { type: "Eval", data: statement },
        })
      ).outcome,
    `${BLINDERS} @ ${percent} fade ${seconds}`,
  );
  if (outcome.type !== "Succeeded") {
    throw new Error(`Blinder fade failed: ${JSON.stringify(outcome)}`);
  }
}

/**
 * Pulls the 3D camera back by `totalDeltaY` worth of wheel scrolling, spread
 * over `durationMs` as one small wheel event per animation frame inside the
 * page. Playwright's own wheel waits a round trip per tick, which steps the
 * camera back in visible jumps.
 */
async function zoomOutSmoothly(
  canvas: Locator,
  at: { x: number; y: number },
  totalDeltaY: number,
  durationMs: number,
): Promise<void> {
  await canvas.evaluate(
    (element, { at, totalDeltaY, durationMs }) =>
      new Promise<void>((resolve) => {
        const begin = performance.now();
        let sent = 0;
        /** Sends the share of the scroll that is due by this frame, eased in and out. */
        const step = (now: number) => {
          const t = Math.min(1, (now - begin) / durationMs);
          const due = totalDeltaY * t * t * (3 - 2 * t);
          if (due > sent) {
            element.dispatchEvent(
              new WheelEvent("wheel", {
                deltaY: due - sent,
                clientX: at.x,
                clientY: at.y,
                bubbles: true,
                cancelable: true,
              }),
            );
            sent = due;
          }
          if (t < 1) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      }),
    { at, totalDeltaY, durationMs },
  );
}

/** Docks a single 3D visualizer filling the portrait frame. */
async function stageVisualizer(page: Page): Promise<void> {
  await page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.clear();
    api.addPanel({
      id: "promo-visualizer",
      component: "Visualizer",
      title: "3D",
    });
  });
}

/**
 * Records the MVR import reel against the desktop backend: the app menu's
 * Import Rig from MVR takes the file, summarises its fixtures, types and
 * groups, and imports the rig, which then fills the 3D view.
 */
test("record the MVR import reel", async ({ page, backendSlot }) => {
  test.setTimeout(300_000);
  const rig = await fetchRig();
  await openDesktop(page, backendSlot.backendPort);
  await stageVisualizer(page);
  const transfer = await rigDataTransfer(page, rig);
  await page.waitForTimeout(8_000);

  const take = new Take(page, "mvr-import");
  await take.start();
  await page.waitForTimeout(900);
  await take.mark("begin");

  // The edit holds one zoom on the menu from before the hamburger click until
  // a second after the item click.
  const menuButton = page.locator("button[title='Menu']");
  await page.waitForTimeout(600);
  await take.glideTo(menuButton);
  // The edit pushes in once the cursor arrives and settles half a second before the click.
  await page.waitForTimeout(1_100);
  await take.mark("menu-button", menuButton);
  await take.click();
  const menuItem = page.getByRole("button", { name: "Import Rig from MVR" });
  await expect(menuItem).toBeVisible();
  await take.mark("menu", await menuArea(page, menuButton));
  await page.waitForTimeout(900);
  await take.glideTo(menuItem);
  await page.waitForTimeout(300);
  await take.mark("menu-item", menuItem);
  await take.click();
  const itemClicked = Date.now();
  const dialog = page.getByRole("dialog", { name: "Import Rig from MVR" });
  const dropZone = dialog.getByRole("button", { name: "Choose an MVR file" });
  await expect(dropZone).toBeVisible();
  await take.mark("dialog", dialog);
  // The edit pulls out a second after the click; the drag waits a second more.
  await page.waitForTimeout(Math.max(0, itemClicked + 2_600 - Date.now()));
  await dragFileIn(page, dropZone, transfer);
  await take.mark("drop", dialog);
  const summary = dialog.getByTestId("rig-import-summary");
  await expect(summary).toContainText(RIG.name, { timeout: 60_000 });
  await take.mark("summary", summary);
  await page.waitForTimeout(2_000);

  const typesTab = dialog.getByRole("tab", { name: /^Fixture types/ });
  await take.glideAndClick(typesTab);
  await take.mark("types", typesTab);
  await page.waitForTimeout(2_000);
  const groupsTab = dialog.getByRole("tab", { name: /^Groups/ });
  await take.glideAndClick(groupsTab);
  await page.waitForTimeout(1_800);

  const importButton = dialog.getByRole("button", {
    name: "Import",
    exact: true,
  });
  await take.glideTo(importButton);
  await page.waitForTimeout(500);
  await take.mark("import", importButton);
  await take.click();
  await expect(dialog).toBeHidden({ timeout: 120_000 });
  await take.mark("rig");
  await page.waitForTimeout(1_500);
  await showOffRig(take, page, page.locator("canvas").first());
  // The final view holds still for a second before the reel ends.
  await page.waitForTimeout(1_000);
  await take.mark("finish");
  await page.waitForTimeout(500);
  await take.finish();
});
