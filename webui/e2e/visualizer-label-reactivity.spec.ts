// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, type Page, test } from "./playwright-fixtures";
import { prepareStoreSeededTestApp } from "./showfile-startup";

type Vec3 = { x: number; y: number; z: number };

interface VisualizerLabelFixture {
  uid: string;
  panelId: string;
  position: Vec3;
  rotation: Vec3;
}

interface FixtureLabelProbe {
  fixture: Vec3;
  label: Vec3 | null;
  distance: number | null;
}

/** Waits for the main-thread visualizer debug API to expose the Three scene. */
async function waitForMainThreadVisualizerApi(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => Boolean((window as any).visualizerApi?.getScene())),
      { timeout: 15_000 },
    )
    .toBe(true);
}

/** Opens an empty disconnected app with main-thread visualizer rendering. */
async function openVisualizerLabelApp(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem(
      "nightfall-visualizer-settings",
      JSON.stringify({
        highlightSelection: true,
        snapPointsEnabled: true,
        qualityPreset: "medium",
        cameraRotationMode: "camera-locked",
        showOrbitTargetIndicator: false,
      }),
    );
  });
  await page.goto(
    "/?visualizer:offscreenCanvas=false&e2e=visualizer-label-reactivity",
  );
  await prepareStoreSeededTestApp(page);
}

/** Seeds one geometry-free moving-head fixture for label reactivity. */
async function seedVisualizerLabelFixture(
  page: Page,
): Promise<Omit<VisualizerLabelFixture, "panelId">> {
  return page.evaluate(() => {
    const stores = (window as any).appStores;
    const uid = "e2evisualizerlabel0000000000000001";
    const position = { x: 2, y: 1, z: -1 };
    const rotation = { x: 0, y: 0, z: 0 };
    stores.fixtureGeometries.set({});
    stores.fixtures.set({
      [uid]: {
        identifiers: {
          id: 990_001,
          uid,
          label: "E2E Visualizer Label",
        },
        make: "Generic",
        model: "Moving Head Spot 16ch",
        layout: "moving-head",
        mode: "Spot",
        elements: [
          {
            label: "Main",
            parameters: [
              {
                resolution: "Coarse",
                attribute: { type: "Intensity" },
                min: 0,
                max: 255,
                offset: { type: "Absolute", data: { value: 0 } },
                is_inverted: false,
                is_snap: false,
                merge_type: "HTP",
                use_grandmaster: true,
              },
            ],
          },
        ],
        placement: { position, rotation },
      },
    });
    return { uid, position, rotation };
  });
}

/** Opens and activates the scenario-owned Visualizer panel. */
async function openVisualizerPanel(page: Page): Promise<string> {
  return page.evaluate(() => {
    const api = (window as any).appStores.dockApi.get();
    api.getPanel("panel-Visualizer")?.api.close();
    api.getPanel("panel-Visualizer-label-reactivity")?.api.close();
    const panelId = "panel-Visualizer-label-reactivity";
    const panel = api.addPanel({
      id: panelId,
      component: "Visualizer",
      title: "3D Visualizer",
      params: {},
      position: {
        referencePanel: "panel-FixtureGrid",
        direction: "within",
      },
    });
    panel.api.setActive();
    panel.focus();
    return panelId;
  });
}

/** Removes the scenario-owned fixture and Visualizer panel. */
async function cleanupVisualizerLabelFixture(
  page: Page,
  fixture: VisualizerLabelFixture,
): Promise<void> {
  await page.evaluate(({ panelId }) => {
    const stores = (window as any).appStores;
    stores.dockApi.get().getPanel(panelId)?.api.close();
    stores.fixtures.set({});
    stores.fixtureGeometries.set({});
  }, fixture);
}

/** Applies a fixture placement directly to the browser fixture store. */
async function setFixturePlacement(
  page: Page,
  uid: string,
  position: Vec3,
  rotation: Vec3,
): Promise<void> {
  await page.evaluate(
    ({ uid, position, rotation }) => {
      const stores = (window as any).appStores;
      const fixtures = stores.fixtures.get();
      const fixture = fixtures[uid];
      stores.fixtures.set({
        ...fixtures,
        [uid]: {
          ...fixture,
          placement: { position, rotation },
        },
      });
    },
    { uid, position, rotation },
  );
}

/** Finds the snap-point label sprite closest to a fixture group. */
async function probeFixtureLabel(
  page: Page,
  uid: string,
): Promise<FixtureLabelProbe | null> {
  return page.evaluate((uid) => {
    const scene = (window as any).visualizerApi?.getScene?.();
    const fixtureGroup = scene?.getObjectByName?.(`Fixture_${uid}`);
    if (!scene || !fixtureGroup) return null;

    const fixtureWorld = fixtureGroup.getWorldPosition(
      new fixtureGroup.position.constructor(),
    );
    const expected = {
      x: fixtureWorld.x,
      y: fixtureWorld.y + 0.3,
      z: fixtureWorld.z,
    };
    const labels: Vec3[] = [];
    scene.traverse((object: any) => {
      if (object.type !== "Sprite" || object.renderOrder !== 1001) return;
      const world = object.getWorldPosition(new object.position.constructor());
      labels.push({ x: world.x, y: world.y, z: world.z });
    });

    let label: Vec3 | null = null;
    let distance: number | null = null;
    for (const candidate of labels) {
      const candidateDistance = Math.hypot(
        candidate.x - expected.x,
        candidate.y - expected.y,
        candidate.z - expected.z,
      );
      if (distance === null || candidateDistance < distance) {
        distance = candidateDistance;
        label = candidate;
      }
    }

    return {
      fixture: { x: fixtureWorld.x, y: fixtureWorld.y, z: fixtureWorld.z },
      label,
      distance,
    };
  }, uid);
}

/** Returns the largest visible canvas for visual evidence attachments. */
async function largestVisibleCanvasBox(page: Page) {
  return page.evaluate(() => {
    const boxes = Array.from(document.querySelectorAll("canvas"))
      .map((canvas) => {
        const rect = canvas.getBoundingClientRect();
        const x = Math.max(0, rect.left);
        const y = Math.max(0, rect.top);
        const right = Math.min(window.innerWidth, rect.right);
        const bottom = Math.min(window.innerHeight, rect.bottom);
        return {
          x,
          y,
          width: Math.max(0, right - x),
          height: Math.max(0, bottom - y),
          area: Math.max(0, right - x) * Math.max(0, bottom - y),
        };
      })
      .filter((rect) => rect.width > 0 && rect.height > 0);
    if (boxes.length === 0) throw new Error("No visible canvas found");
    return boxes.sort((a, b) => b.area - a.area)[0];
  });
}

test("visualizer labels follow fixture placement edits", async ({
  page,
}, testInfo) => {
  await openVisualizerLabelApp(page);
  const fixture = await seedVisualizerLabelFixture(page);
  const panelId = await openVisualizerPanel(page);
  const ownedFixture = { ...fixture, panelId };
  try {
    await expect(
      page.getByText("3D Visualizer", { exact: true }).first(),
    ).toBeVisible();
    await expect(page.locator(".fps-label")).toBeVisible({ timeout: 15_000 });
    await waitForMainThreadVisualizerApi(page);

    await expect
      .poll(
        async () =>
          (await probeFixtureLabel(page, ownedFixture.uid))?.distance ?? null,
      )
      .toBeLessThan(0.05);

    const before = await probeFixtureLabel(page, ownedFixture.uid);
    expect(before?.label).not.toBeNull();
    await testInfo.attach("visualizer-labels-before", {
      body: await page.screenshot({
        clip: await largestVisibleCanvasBox(page),
      }),
      contentType: "image/png",
    });

    const nextPosition = {
      x: ownedFixture.position.x + 4,
      y: ownedFixture.position.y,
      z: ownedFixture.position.z + 1,
    };
    await setFixturePlacement(
      page,
      ownedFixture.uid,
      nextPosition,
      ownedFixture.rotation,
    );

    await expect
      .poll(async () => {
        const probe = await probeFixtureLabel(page, ownedFixture.uid);
        return (
          probe !== null &&
          probe.label !== null &&
          probe.distance !== null &&
          probe.distance < 0.05 &&
          Math.abs(probe.fixture.x - nextPosition.x) < 0.05 &&
          Math.abs(probe.fixture.z - nextPosition.z) < 0.05
        );
      })
      .toBe(true);

    const after = await probeFixtureLabel(page, ownedFixture.uid);
    expect(
      Math.abs((after?.label?.x ?? 0) - (before?.label?.x ?? 0)),
    ).toBeGreaterThan(2);
    await testInfo.attach("visualizer-labels-after", {
      body: await page.screenshot({
        clip: await largestVisibleCanvasBox(page),
      }),
      contentType: "image/png",
    });
  } finally {
    await cleanupVisualizerLabelFixture(page, ownedFixture);
  }
});
