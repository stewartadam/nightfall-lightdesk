// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { crc32 } from "node:zlib";
import { prepareFreshBackendShowfile } from "./backend-showfile";
import { expect, type Page, test } from "./playwright-fixtures";
import { waitForDockviewApp } from "./showfile-startup";

const FIRST_ID = 97_101;
const SECOND_ID = 97_102;

test.describe.configure({ timeout: 120_000 });

/**
 * Packs files into an uncompressed ZIP archive, which is all an MVR file needs to be readable.
 */
function storedZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.from(text, "utf8");
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
 * Builds an MVR file with two hung washes on a truss whose fixture type is not in the file, so
 * the import has to borrow a stand-in from the library.
 */
function washRig(): Buffer {
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
        <ChildList>${fixture("9D1C0D7E-0000-4000-8000-000000000001", "Wash left", FIRST_ID, -2000, "200.1")}${fixture("9D1C0D7E-0000-4000-8000-000000000002", "Wash right", SECOND_ID, 2000, "200.233")}
        </ChildList>
      </Layer>
    </Layers>
  </Scene>
</GeneralSceneDescription>`;
  return storedZip({ "GeneralSceneDescription.xml": xml });
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
 * Walks the import from the app menu on a blank show: upload, choose a stand-in type, review,
 * import, and check the fixtures land in the show.
 */
test("imports a rig from an MVR file with a stand-in fixture type", async ({
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
  await expect(dialog.getByRole("cell", { name: "Missing" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("2-missing-type.png") });

  const typeSelect = dialog.getByLabel("Library fixture for Acme@Wash.gdtf");
  await typeSelect.selectOption({ index: 1 });
  await expect(summary).toContainText("2 of 2 fixtures will be added");
  await expect(dialog.getByRole("cell", { name: "Stand-in" })).toBeVisible();
  await expect(dialog.getByRole("cell", { name: "200.1" })).toBeVisible();
  await expect(dialog.getByRole("cell", { name: "200.233" })).toBeVisible();

  await dialog.getByLabel("Fixture numbering").selectOption("Offset");
  await dialog.getByLabel("ID offset").fill("0");
  await dialog.getByLabel("ID offset").blur();
  await page.screenshot({ path: test.info().outputPath("3-ready.png") });

  await dialog.getByRole("button", { name: "Import 2 fixtures" }).click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(() => importedFixtureIds(page))
    .toEqual([FIRST_ID, SECOND_ID]);
  await page.screenshot({ path: test.info().outputPath("4-imported.png") });
});
