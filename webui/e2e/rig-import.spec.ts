// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { crc32 } from "node:zlib";
import { prepareFreshBackendShowfile } from "./backend-showfile";
import { testGdtfArchive } from "./gdtf-archive";
import { expect, type Locator, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const FIRST_ID = 97_101;
const SECOND_ID = 97_102;

test.describe.configure({ timeout: 120_000 });

/**
 * Packs files into an uncompressed ZIP archive, which is all an MVR file needs to be readable.
 */
function storedZip(files: Record<string, string | Buffer>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = typeof text === "string" ? Buffer.from(text, "utf8") : text;
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/**
 * Builds a GLB model of one box from `min` to `max`, in glTF's Y-up metres, the way MVR
 * stores GLB geometry.
 */
function boxGlb(
  min: [number, number, number],
  max: [number, number, number],
): Buffer {
  const corners: number[] = [];
  for (let corner = 0; corner < 8; corner += 1) {
    corners.push(
      corner & 1 ? max[0] : min[0],
      corner & 2 ? max[1] : min[1],
      corner & 4 ? max[2] : min[2],
    );
  }
  const faces = [
    [0, 2, 3, 1],
    [4, 5, 7, 6],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 4, 6, 2],
    [1, 3, 7, 5],
  ];
  const indices = faces.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]);
  const positions = Buffer.from(new Float32Array(corners).buffer);
  const indexBytes = Buffer.from(new Uint16Array(indices).buffer);
  const binary = Buffer.concat([
    positions,
    indexBytes,
    Buffer.alloc((4 - (indexBytes.length % 4)) % 4),
  ]);
  const json = JSON.stringify({
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: binary.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.length },
      {
        buffer: 0,
        byteOffset: positions.length,
        byteLength: indexBytes.length,
      },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: "VEC3", min, max },
      {
        bufferView: 1,
        componentType: 5123,
        count: indices.length,
        type: "SCALAR",
      },
    ],
  });
  const jsonBytes = Buffer.from(json + " ".repeat((4 - (json.length % 4)) % 4));
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBytes.length + 8 + binary.length, 8);
  const chunk = (type: number, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(data.length, 0);
    head.writeUInt32LE(type, 4);
    return Buffer.concat([head, data]);
  };
  return Buffer.concat([
    header,
    chunk(0x4e4f534a, jsonBytes),
    chunk(0x004e4942, binary),
  ]);
}

/**
 * Builds an MVR file with the two washes of {@link washRig} hung under a six metre truss,
 * and a stage deck on a layer of its own.
 */
function trussRig(): Buffer {
  const scenery = `
      <Layer uuid="2C4E6A80-1B3D-4F5A-8C7E-9D0B1A2C3E4F" name="Rigging">
        <ChildList>
          <Truss uuid="5E1F2A3B-4C5D-4E6F-8A7B-9C0D1E2F3A4B" name="LX 1 truss">
            <Matrix>{1,0,0}{0,1,0}{0,0,1}{0,2000,6300}</Matrix>
            <Geometries><Geometry3D fileName="truss.glb"/></Geometries>
          </Truss>
        </ChildList>
      </Layer>
      <Layer uuid="3D5F7B91-2C4E-4A6B-9D8F-0E1C2B3D4F5A" name="Stage">
        <ChildList>
          <SceneObject uuid="6F2A3B4C-5D6E-4F7A-8B9C-0D1E2F3A4B5C" name="Deck">
            <Geometries><Geometry3D fileName="deck.glb"/></Geometries>
          </SceneObject>
        </ChildList>
      </Layer>`;
  return washRig(2000, "200.233", scenery, {
    "truss.glb": boxGlb([-3, -0.15, -0.15], [3, 0.15, 0.15]),
    "deck.glb": boxGlb([-4, 0, -1], [4, 1, 3]),
  });
}

/**
 * Builds an MVR file with two hung washes on the LX 1 truss whose fixture type is not in the
 * file, so the import has to borrow a stand-in from the library. The right wash's position
 * and address can be moved to stand for the designer's next revision of the rig.
 */
function washRig(
  rightX = 2000,
  rightAddress = "200.233",
  extraLayers = "",
  extraFiles: Record<string, Buffer> = {},
): Buffer {
  const fixture = (
    uuid: string,
    name: string,
    id: number,
    x: number,
    address: string,
  ) => `
          <Fixture uuid="${uuid}" name="${name}">
            <Matrix>{1,0,0}{0,-1,0}{0,0,-1}{${x},2000,6000}</Matrix>
            <GDTFSpec>Acme@Wash.gdtf</GDTFSpec>
            <GDTFMode>Standard</GDTFMode>
            <Position>0E2DC6B1-7C42-4B3F-9D0B-7D1C8C2F2A11</Position>
            <FixtureID>${id}</FixtureID>
            <Addresses><Address break="0">${address}</Address></Addresses>
          </Fixture>`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GeneralSceneDescription verMajor="1" verMinor="6" provider="Playwright">
  <Scene>
    <AUXData><Position uuid="0E2DC6B1-7C42-4B3F-9D0B-7D1C8C2F2A11" name="LX 1"/></AUXData>
    <Layers>
      <Layer uuid="83A405B6-8378-482D-9F72-AAD2EE51AABE" name="Rig">
        <ChildList>${fixture("9D1C0D7E-0000-4000-8000-000000000001", "Wash left", FIRST_ID, -2000, "200.1")}${fixture("9D1C0D7E-0000-4000-8000-000000000002", "Wash right", SECOND_ID, rightX, rightAddress)}
        </ChildList>
      </Layer>${extraLayers}
    </Layers>
  </Scene>
</GeneralSceneDescription>`;
  return storedZip({ "GeneralSceneDescription.xml": xml, ...extraFiles });
}

/** Reads the X position of the fixture with `id`, in metres. */
async function fixtureX(page: Page, id: number): Promise<number | undefined> {
  return page.evaluate((wanted) => {
    const fixtures = (window as any).appStores?.fixtures?.get?.() ?? {};
    const fixture = Object.values(fixtures).find(
      (candidate: any) => candidate?.identifiers?.id === wanted,
    ) as any;
    return fixture?.placement?.position?.x as number | undefined;
  }, id);
}

/** Reads the names of the show's groups. */
async function groupNames(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const groups = (window as any).appStores?.groups?.get?.() ?? {};
    return Object.values(groups).map(
      (group: any) => group?.identifiers?.label as string,
    );
  });
}

/** Reads which of the test's fixture IDs the show now has. */
async function importedFixtureIds(page: Page): Promise<number[]> {
  return page.evaluate(
    (ids) => {
      const fixtures = (window as any).appStores?.fixtures?.get?.() ?? {};
      const present = new Set(
        Object.values(fixtures).map(
          (fixture: any) => fixture?.identifiers?.id as number | undefined,
        ),
      );
      return ids.filter((id) => present.has(id));
    },
    [FIRST_ID, SECOND_ID],
  );
}

/**
 * Walks the import from the app menu: upload, choose a stand-in type, review, import, and
 * check the fixtures and their hanging position group land in the show. Then imports a
 * revision of the file that moves and repatches one wash, which updates that fixture in place
 * and leaves the group, which already holds both washes, alone.
 */
test("imports a rig from an MVR file and updates it from a revision", async ({
  backendSlot,
  page,
}) => {
  await prepareFreshBackendShowfile(backendSlot.backendPort);
  await page.goto("/?e2e=1");
  await waitForDockviewApp(page);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores?.fixtureLibrary?.get?.().length ?? 0,
      ),
    )
    .toBeGreaterThan(0);

  await page.locator("button[title='Menu']").click();
  await page.getByRole("button", { name: "Import Rig from MVR" }).click();
  const dialog = page.getByRole("dialog", { name: "Import Rig from MVR" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Drop an .mvr file here")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("1-pick.png") });

  await dialog.getByTestId("rig-import-file").setInputFiles({
    name: "wash-rig.mvr",
    mimeType: "application/octet-stream",
    buffer: washRig(),
  });
  const summary = dialog.getByTestId("rig-import-summary");
  await expect(summary).toContainText("wash-rig.mvr");
  await expect(summary).toContainText("0 of 2 fixtures will be added");
  await expect(
    dialog.getByRole("tab", { name: "Fixture types (1)" }),
    "a type that needs a choice opens the review on its tab",
  ).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("cell", { name: "Missing" })).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Import", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByTestId("rig-import-blocked"),
    "the banner says why the import is disabled",
  ).toContainText("2 fixtures have a fixture type Nightfall can't load");
  await dialog
    .getByTestId("rig-import-blocked")
    .evaluate((alert) =>
      Promise.all(alert.getAnimations().map((animation) => animation.finished)),
    );
  await page.screenshot({ path: test.info().outputPath("2-missing-type.png") });

  await dialog.getByRole("button", { name: "Back" }).click();
  await expect(dialog.getByText("Drop an .mvr file here")).toBeVisible();
  await dialog.getByTestId("rig-import-file").setInputFiles({
    name: "wash-rig.mvr",
    mimeType: "application/octet-stream",
    buffer: washRig(),
  });
  await expect(summary).toContainText("0 of 2 fixtures will be added");

  const typeSelect = dialog.getByLabel("Library fixture for Acme@Wash.gdtf");
  await typeSelect.selectOption({ label: "Generic Moving Head RGBW" });
  await expect(summary).toContainText("2 of 2 fixtures will be added");
  await expect(dialog.getByRole("cell", { name: "Stand-in" })).toBeVisible();
  await expect(dialog.getByTestId("rig-import-blocked")).toBeHidden();
  await dialog.getByRole("tab", { name: "Fixtures (2)" }).click();
  await expect(dialog.getByRole("cell", { name: "200.1" })).toBeVisible();
  await expect(dialog.getByRole("cell", { name: "200.233" })).toBeVisible();
  const groupsTab = dialog.getByRole("tab", { name: /^Groups/ });
  await groupsTab.click();
  const groups = dialog.getByRole("table", { name: "Groups the import makes" });
  await expect(groups.getByRole("cell", { name: "LX 1" })).toBeVisible();
  await expect(groups.getByRole("cell", { name: "New" })).toBeVisible();
  await dialog.getByRole("tab", { name: "Fixtures (2)" }).click();

  await dialog.getByLabel("Fixture numbering").selectOption("Offset");
  await dialog.getByLabel("ID offset").fill("0");
  await dialog.getByLabel("ID offset").blur();
  await settleTabPanel(dialog);
  await page.screenshot({ path: test.info().outputPath("3-ready.png") });

  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(() => importedFixtureIds(page))
    .toEqual([FIRST_ID, SECOND_ID]);
  await expect.poll(() => groupNames(page)).toContain("LX 1");
  await page.screenshot({ path: test.info().outputPath("4-imported.png") });

  await page.locator("button[title='Menu']").click();
  await page.getByRole("button", { name: "Import Rig from MVR" }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("rig-import-file").setInputFiles({
    name: "wash-rig-v2.mvr",
    mimeType: "application/octet-stream",
    buffer: washRig(3000, "200.301"),
  });
  await expect(summary).toContainText(
    "0 of 2 fixtures will be added, 1 updated",
  );
  await dialog.getByRole("tab", { name: "Fixtures (2)" }).click();
  await expect(
    dialog.getByRole("cell", { name: "Update (moved, repatched)" }),
  ).toBeVisible();
  await expect(dialog.getByRole("cell", { name: "Unchanged" })).toBeVisible();
  await expect(groupsTab, "LX 1 already holds both washes").toBeHidden();
  await expect(
    dialog.getByLabel("Update fixtures already in the show to match the file"),
  ).toBeChecked();
  await settleTabPanel(dialog);
  await page.screenshot({ path: test.info().outputPath("5-reimport.png") });

  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => fixtureX(page, SECOND_ID)).toBeCloseTo(3);
  expect(await fixtureX(page, FIRST_ID)).toBeCloseTo(-2);
  await page.screenshot({ path: test.info().outputPath("6-updated.png") });
});

/** Waits for the review's tab panel to finish sliding in, so a screenshot shows its table. */
async function settleTabPanel(dialog: Locator): Promise<void> {
  await dialog.getByRole("tabpanel").evaluate(async (panel) => {
    // The entrance starts on the frame after the tab changes, so let it begin first.
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    await Promise.all(
      panel.getAnimations().map((animation) => animation.finished),
    );
  });
}

/** Reads the show's scene objects with their labels, heights (to the centimetre) and model settings. */
async function sceneObjectSummaries(page: Page): Promise<
  {
    label: string;
    y: number;
    keepModelOrigin?: boolean;
  }[]
> {
  return page.evaluate(() => {
    const objects = (window as any).appStores?.sceneObjects?.get?.() ?? {};
    return Object.values(objects).map((object: any) => ({
      label: object?.identifiers?.label as string,
      y: Math.round((object?.placement?.position?.y ?? 0) * 100) / 100,
      keepModelOrigin: object?.properties?.data?.keepModelOrigin as
        | boolean
        | undefined,
    }));
  });
}

/**
 * Imports a rig whose washes hang under a truss above a stage deck: the review lists the
 * truss and the deck's layer as scenery, and after the import both are scene objects drawn
 * where the file puts them, with the washes under the truss.
 */
test("imports trusses and scenery as scene objects", async ({
  backendSlot,
  page,
}) => {
  // The waits for the slow headless visualizer push this past the default timeout.
  test.setTimeout(120_000);
  await prepareFreshBackendShowfile(backendSlot.backendPort);
  await page.goto("/?e2e=1");
  await waitForDockviewApp(page);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).appStores?.fixtureLibrary?.get?.().length ?? 0,
      ),
    )
    .toBeGreaterThan(0);

  await page.locator("button[title='Menu']").click();
  await page.getByRole("button", { name: "Import Rig from MVR" }).click();
  const dialog = page.getByRole("dialog", { name: "Import Rig from MVR" });
  await dialog.getByTestId("rig-import-file").setInputFiles({
    name: "truss-rig.mvr",
    mimeType: "application/octet-stream",
    buffer: trussRig(),
  });
  const summary = dialog.getByTestId("rig-import-summary");
  await expect(summary).toContainText("with 2 scenery objects");
  await dialog
    .getByLabel("Library fixture for Acme@Wash.gdtf")
    .selectOption({ label: "Generic Moving Head RGBW" });
  await dialog.getByLabel("Fixture numbering").selectOption("Offset");
  await dialog.getByLabel("ID offset").fill("0");
  await dialog.getByLabel("ID offset").blur();
  await dialog.getByRole("tab", { name: "Scenery (2)" }).click();
  const scenery = dialog.getByRole("table", { name: "Scenery in the rig" });
  await expect(scenery.getByRole("cell", { name: "LX 1 truss" })).toBeVisible();
  await expect(
    scenery.getByRole("cell", { name: "Layer scenery" }),
  ).toBeVisible();
  await expect(scenery.getByRole("cell", { name: "New" })).toHaveCount(2);
  await expect(dialog.getByLabel("Import trusses and scenery")).toBeChecked();
  await settleTabPanel(dialog);
  await page.screenshot({ path: test.info().outputPath("1-scenery.png") });

  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(() => sceneObjectSummaries(page))
    .toEqual(
      expect.arrayContaining([
        { label: "LX 1 truss", y: 6.3, keepModelOrigin: true },
        { label: "Stage", y: 0, keepModelOrigin: true },
      ]),
    );
  await expect
    .poll(() => importedFixtureIds(page))
    .toEqual([FIRST_ID, SECOND_ID]);
  // The headless visualizer renders only a few frames a second, so give it time to draw
  // the loaded models before the screenshot.
  await page.waitForTimeout(15_000);
  await page.screenshot({ path: test.info().outputPath("2-visualizer.png") });

  const sceneryToggle = page.getByRole("button", {
    name: "Hide Scenery (O)",
  });
  await sceneryToggle.click();
  await expect(
    page.getByRole("button", { name: "Show Scenery (O)" }),
  ).toHaveAttribute("aria-pressed", "false");
  await page.waitForTimeout(5_000);
  await page.screenshot({
    path: test.info().outputPath("3-scenery-hidden.png"),
  });
  await page.getByRole("button", { name: "Show Scenery (O)" }).click();

  await page.locator("button[title='Menu']").click();
  await page.getByRole("button", { name: "Import Rig from MVR" }).click();
  await dialog.getByTestId("rig-import-file").setInputFiles({
    name: "truss-rig.mvr",
    mimeType: "application/octet-stream",
    buffer: trussRig(),
  });
  await dialog.getByRole("tab", { name: "Scenery (2)" }).click();
  await expect(scenery.getByRole("cell", { name: "Unchanged" })).toHaveCount(2);
  await dialog.getByRole("button", { name: "Close rig import dialog" }).click();
});

/**
 * A rig whose fixture type comes as a GDTF without 3D model files gets that type flagged in
 * the review, so the user knows its fixtures will be drawn as simple shapes.
 */
test("flags fixture types without 3D models", async ({ backendSlot, page }) => {
  await prepareFreshBackendShowfile(backendSlot.backendPort);
  await page.goto("/?e2e=1");
  await waitForDockviewApp(page);

  await page.locator("button[title='Menu']").click();
  await page.getByRole("button", { name: "Import Rig from MVR" }).click();
  const dialog = page.getByRole("dialog", { name: "Import Rig from MVR" });
  await dialog.getByTestId("rig-import-file").setInputFiles({
    name: "bare-rig.mvr",
    mimeType: "application/octet-stream",
    buffer: washRig(2000, "200.233", "", {
      "Acme@Wash.gdtf": testGdtfArchive({
        manufacturer: "Acme",
        model: "Bare Wash",
        fixtureTypeId: "6A1E3C52-7B1D-4F0B-9E57-2C0D5A1B7E01",
      }),
    }),
  });
  await expect(dialog.getByTestId("rig-import-summary")).toContainText(
    "2 of 2 fixtures will be added",
  );
  await dialog.getByRole("tab", { name: "Fixture types (1)" }).click();
  await expect(dialog.getByText("Missing 3D")).toBeVisible();
  await settleTabPanel(dialog);
  await page.screenshot({ path: test.info().outputPath("1-no-3d-model.png") });
  await dialog.getByRole("button", { name: "Close rig import dialog" }).click();
});
