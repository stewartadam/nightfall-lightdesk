// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Locator, Page } from "@playwright/test";
import {
  expect,
  frontendOnlyTest as test,
} from "../../webui/e2e/playwright-fixtures";
import { openDemo, Take } from "../kit/record/take";

/** A clip on the board: its ID in the sample show and its button colour. */
type Look = { id: number; color: string };

/** The chases row: the three colour chases and the rainbow cycle. */
const CHASES: Look[] = [
  { id: 6, color: "#e5484d" },
  { id: 7, color: "#3e63dd" },
  { id: 8, color: "#30a46c" },
  { id: 100, color: "#8e4ec6" },
];
/** The looks row: the sample show's other busking clips. */
const LOOKS: Look[] = [
  { id: 33, color: "#f5d90a" },
  { id: 102, color: "#d4d4d8" },
  { id: 405, color: "#f76b15" },
  { id: 101, color: "#12a594" },
];
/** Speed masters the speed buttons toggle, by master ID, level and colour. */
const RATES = [
  { id: 41, label: "Half time", level: 50, color: "#ffb224" },
  { id: 42, label: "Normal time", level: 100, color: "#ffb224" },
  { id: 43, label: "Double time", level: 200, color: "#ffb224" },
];
/** The chases the take restyles to follow the show tempo. */
const BEAT_CHASES = [6, 7, 8];
/** The tempo the take taps in, in beats per minute. */
const TAPPED_BPM = 80;

/** Every board button's size in 24 px board cells: four across fill the portrait frame. */
const BUTTON = { width: 7, height: 4 };

/** A fresh 32-character UID the engine accepts. */
function uid(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** Sends one engine command and fails the take if the engine refuses it. */
async function send(page: Page, module: string, command: unknown) {
  const outcome = await page.evaluate(
    async ({ module, command }) =>
      (await (window as any).appStores.sendAndAwait({ module, command }))
        .outcome,
    { module, command },
  );
  if (outcome.type !== "Succeeded") {
    throw new Error(`${module} failed: ${JSON.stringify(outcome)}`);
  }
}

/**
 * The pixel tape rows, bottom up, by wing as the camera sees them, in screen
 * order. The camera looks at the rig from behind, so the 32x wing (positive X)
 * sits on screen left.
 */
const TAPE_ROWS = [0, 1, 2, 3].map((row) => ({
  left: [323, 322, 321, 320].map((id) => id + row * 20),
  right: [310, 311, 312, 313].map((id) => id + row * 20),
}));
/** Pixels on each sample show tape. */
const TAPE_PIXELS = 40;
/** Beats of show tempo one sweep across the rig takes before any speed change. */
const SWEEP_BEATS = 6;

/**
 * Orders every tape pixel left to right on screen along each row. Pixels on the
 * screen-left wing count toward the screen's left edge, so that wing is read in
 * reverse.
 */
async function leftToRightPixels(page: Page): Promise<unknown[]> {
  const uidById = await page.evaluate(() => {
    const fixtures = Object.values(
      (window as any).appStores.fixtures.get(),
    ) as any[];
    return Object.fromEntries(
      fixtures.map((fixture) => [
        fixture.identifiers.id,
        fixture.identifiers.uid as string,
      ]),
    );
  });
  /** One tape's pixel refs, first pixel first or reversed. */
  const tape = (id: number, reversed: boolean) =>
    Array.from({ length: TAPE_PIXELS }, (_, offset) => ({
      fixture_uid: uidById[id],
      index: reversed ? TAPE_PIXELS - offset : offset + 1,
    }));
  return TAPE_ROWS.flatMap(({ left, right }) => [
    ...left.flatMap((id) => tape(id, true)),
    ...right.flatMap((id) => tape(id, false)),
  ]);
}

/**
 * Turns the sample show's slow sine chases into hard-edged ones timed in beats
 * of the show tempo: a block a quarter of the rig wide sweeps left to right
 * along every row at once, one sweep per `SWEEP_BEATS`, so speed changes and
 * tapped tempos read clearly on camera.
 */
async function sharpenChases(page: Page): Promise<void> {
  const pixels = await leftToRightPixels(page);
  const chases = await page.evaluate((ids) => {
    const fx = Object.values((window as any).appStores.fx.get()) as any[];
    return fx
      .map((entry) => entry?.[0] ?? entry)
      .filter((def) => ids.includes(def.identifiers.id));
  }, BEAT_CHASES);
  for (const chase of chases) {
    chase.timebase = "Beats";
    chase.selection = {
      source: { type: "Resolved", data: pixels },
      clauses: [],
    };
    for (const attribute of Object.values(chase.attributes) as any[]) {
      attribute.params = {
        kind: "square",
        min: 0,
        max: 255,
        duty_cycle: 0.25,
      };
      // One full waveform per row, so the rows sweep in step.
      attribute.phase_range = [0, 2 * Math.PI * TAPE_ROWS.length];
      attribute.cycle_length = { secs: SWEEP_BEATS, nanos: 0 };
    }
    await send(page, "FxCommand", { type: "StoreFx", data: chase });
  }
}

/** The rainbow effect the take restyles to follow the show tempo. */
const BEAT_RAINBOW = 100;
/** Beats of show tempo one pass through the rainbow takes. */
const RAINBOW_BEATS = 8;

/**
 * Times the sample show's Rainbow Cycle in beats of the show tempo, one pass
 * per `RAINBOW_BEATS`, so a tapped tempo visibly speeds it up. As shipped it
 * runs in seconds and ignores the tempo.
 */
async function beatRainbow(page: Page): Promise<void> {
  const rainbow = await page.evaluate((id) => {
    const stepFx = Object.values(
      (window as any).appStores.stepFx.get(),
    ) as any[];
    return stepFx
      .map((entry) => entry?.[0] ?? entry)
      .find((def) => def.identifiers.id === id);
  }, BEAT_RAINBOW);
  rainbow.timebase = "Beats";
  rainbow.cycle_scale = { type: "Fixed", data: RAINBOW_BEATS };
  await send(page, "StepFxCommand", { type: "Store", data: rainbow });
}

/**
 * Builds the busking board off camera: a solo frame of chases, a solo frame of
 * looks, a solo frame of half, normal and double time buttons backed by toggle
 * speed masters, and a tap tempo pad. Each button carries its look's colour.
 * Returns the board's UID.
 */
async function stageBoard(page: Page): Promise<string> {
  for (const rate of RATES) {
    await send(page, "MasterCommand", {
      type: "StoreMaster",
      data: {
        identifiers: { id: rate.id, uid: uid(), label: rate.label },
        kind: "PlaybackSpeed",
        target: { type: "Instances", data: { type: "All" } },
        mode: { type: "Toggle", data: { active: false } },
        level_percent: rate.level,
      },
    });
  }
  const { clipUids, masterUids } = await page.evaluate(
    ({ clipIds, rateIds }) => {
      const stores = (window as any).appStores;
      const clips = Object.values(stores.clips.get()) as any[];
      const masters = Object.values(stores.masters.get()) as any[];
      return {
        clipUids: clipIds.map(
          (id) =>
            clips.find((entry) => entry[0].identifiers.id === id)[0].identifiers
              .uid as string,
        ),
        masterUids: rateIds.map(
          (id) =>
            masters.find((master) => master.identifiers.id === id).identifiers
              .uid as string,
        ),
      };
    },
    {
      clipIds: [...CHASES, ...LOOKS].map((look) => look.id),
      rateIds: RATES.map((rate) => rate.id),
    },
  );
  /** A coloured button pinned to one object, in board cells. */
  const button = (
    objectType: string,
    targetUid: string,
    color: string,
    x: number,
    y: number,
  ) => ({
    uid: uid(),
    cell: { x, y, ...BUTTON },
    show_title: true,
    color,
    kind: {
      type: "Target",
      data: { target: { object_type: objectType, uid: targetUid } },
    },
  });
  /** A solo frame with a title, one row of buttons high, in board cells. */
  const frame = (label: string, y: number, buttons: number) => ({
    uid: uid(),
    cell: { x: 0, y, width: BUTTON.width * buttons, height: BUTTON.height + 1 },
    show_title: true,
    label,
    kind: { type: "Frame", data: { exclusive: true } },
  });
  /** Top row of each frame; a frame's title takes the first cell row. */
  const rows = [0, 1, 2].map((row) => row * (BUTTON.height + 2));
  const chaseUids = clipUids.slice(0, CHASES.length);
  const lookUids = clipUids.slice(CHASES.length);
  const boardUid = uid();
  await send(page, "BoardCommand", {
    type: "StoreBoard",
    data: {
      identifiers: { id: 1, uid: boardUid, label: "Busk" },
      shown_in_switcher: false,
      elements: [
        frame("Chases", rows[0], CHASES.length),
        ...chaseUids.map((clip, index) =>
          button(
            "Clip",
            clip,
            CHASES[index].color,
            index * BUTTON.width,
            rows[0] + 1,
          ),
        ),
        frame("Looks", rows[1], LOOKS.length),
        ...lookUids.map((clip, index) =>
          button(
            "Clip",
            clip,
            LOOKS[index].color,
            index * BUTTON.width,
            rows[1] + 1,
          ),
        ),
        frame("Speed", rows[2], RATES.length),
        ...masterUids.map((master, index) =>
          button(
            "Master",
            master,
            RATES[index].color,
            index * BUTTON.width,
            rows[2] + 1,
          ),
        ),
        {
          uid: uid(),
          cell: {
            x: BUTTON.width * RATES.length,
            y: rows[2] + 1,
            ...BUTTON,
          },
          show_title: true,
          kind: { type: "Tempo" },
        },
      ],
    },
  });
  return boardUid;
}

/** Docks the board on top, the visualizer below, sized for a portrait frame. */
async function stageWorkspace(page: Page, boardUid: string): Promise<void> {
  await page.evaluate((boardUid) => {
    const api = (window as any).appStores.dockApi.get();
    api.clear();
    const board = api.addPanel({
      id: "promo-board",
      component: "BoardPanel",
      title: "Busk",
      params: { boardId: boardUid },
    });
    api.addPanel({
      id: "promo-visualizer",
      component: "Visualizer",
      title: "3D",
      position: { referencePanel: "promo-board", direction: "below" },
    });
    board.group.api.setSize({ height: 530 });
  }, boardUid);
}

/**
 * Frames the rig closer than the visualizer's default view: fits the camera to
 * every fixture, then pulls it in toward the rig so the pixel tapes fill the
 * panel's width.
 */
async function frameRig(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const api = (window as any).visualizerApi;
    api.zoomToFit();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const { position, target } = await api.getCameraState();
    const pull = 0.68;
    api.setCameraState({
      position: {
        x: target.x + (position.x - target.x) * pull,
        y: target.y + (position.y - target.y) * pull,
        z: target.z + (position.z - target.z) * pull,
      },
      target,
    });
  });
}

/** The board button captioned `label`. */
function boardButton(page: Page, label: string): Locator {
  return page
    .locator('[data-panel-kind="boards"] .nf-board-button')
    .filter({ hasText: label })
    .first();
}

/** The board's tap tempo pad. */
function tempoPad(page: Page): Locator {
  return page
    .locator('[data-panel-kind="boards"]')
    .getByRole("button", { name: "Tap tempo" })
    .first();
}

/**
 * Taps where the cursor is `count` times at `bpm`, scheduling each tap from
 * the first so the click's own latency doesn't drift the tempo.
 */
async function tapTempo(
  page: Page,
  take: Take,
  bpm: number,
  count: number,
): Promise<void> {
  const interval = 60_000 / bpm;
  const started = Date.now();
  for (let tap = 0; tap < count; tap++) {
    const wait = started + tap * interval - Date.now();
    if (wait > 0) await page.waitForTimeout(wait);
    await take.click();
  }
}

/**
 * Records the busking reel on the embedded demo: starts Red Chase from the
 * board, doubles its speed and puts it back to normal, switches to Rainbow
 * Cycle, then taps a slower tempo on the tempo pad, with the 3D view below.
 */
test("record the busking reel", async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  await openDemo(page, baseURL);
  await sharpenChases(page);
  await beatRainbow(page);
  await stageWorkspace(page, await stageBoard(page));
  await expect(boardButton(page, "Red Chase")).toBeVisible();
  // The visualizer needs a while to load its models in software rendering.
  await page.waitForTimeout(15_000);
  await frameRig(page);
  // The floor grid and its axis labels crowd the close framing.
  await page.getByRole("button", { name: "Hide Grid (G)" }).click();
  // Leave the grid button so its tooltip doesn't open the take.
  await page.mouse.move(360, 1000);
  await page.waitForTimeout(5_000);

  const take = new Take(page, "busking");
  await take.start();
  await page.waitForTimeout(900);
  await take.mark("begin");
  await page.waitForTimeout(1_500);

  await take.glideAndClick(boardButton(page, "Red Chase"));
  await take.mark("chase", boardButton(page, "Red Chase"));
  await page.waitForTimeout(3_500);

  await take.glideAndClick(boardButton(page, "Double time"));
  await take.mark("double", boardButton(page, "Double time"));
  await page.waitForTimeout(3_200);
  await take.glideAndClick(boardButton(page, "Normal time"));
  await take.mark("normal", boardButton(page, "Normal time"));
  await page.waitForTimeout(3_000);

  await take.glideAndClick(boardButton(page, "Rainbow Cycle"));
  await take.mark("swap", boardButton(page, "Rainbow Cycle"));
  await page.waitForTimeout(4_500);

  await take.glideTo(tempoPad(page));
  await page.waitForTimeout(300);
  await take.mark("tap", tempoPad(page));
  await tapTempo(page, take, TAPPED_BPM, 4);
  await page.waitForTimeout(5_000);
  await take.mark("finish");
  await page.waitForTimeout(500);
  await take.finish();
});
