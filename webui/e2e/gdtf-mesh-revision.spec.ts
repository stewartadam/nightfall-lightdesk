// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";

/** Build a tiny owned GLB triangle whose width distinguishes archive revisions without private fixture assets. */
function triangleGlb(width: number): Buffer {
  const binary = Buffer.alloc(72);
  const values = [0, 0, 0, width, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1];
  values.forEach((value, index) => {
    binary.writeFloatLE(value, index * 4);
  });
  const document = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 } }] }],
    buffers: [{ byteLength: binary.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 36 },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: "VEC3",
        min: [0, 0, 0],
        max: [width, 1, 0],
      },
      { bufferView: 1, componentType: 5126, count: 3, type: "VEC3" },
    ],
  };
  const encoded = Buffer.from(JSON.stringify(document));
  const json = Buffer.alloc(Math.ceil(encoded.length / 4) * 4, 0x20);
  encoded.copy(json);
  const result = Buffer.alloc(12 + 8 + json.length + 8 + binary.length);
  result.writeUInt32LE(0x46546c67, 0);
  result.writeUInt32LE(2, 4);
  result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(json.length, 12);
  result.writeUInt32LE(0x4e4f534a, 16);
  json.copy(result, 20);
  result.writeUInt32LE(binary.length, 20 + json.length);
  result.writeUInt32LE(0x004e4942, 24 + json.length);
  binary.copy(result, 28 + json.length);
  return result;
}

/** Exercise the production loader and cache in a browser, with owned resource responses and a rendered preview. */
test("GDTF mesh cache separates source revisions", async ({
  page,
}, testInfo) => {
  const firstRevision = "a".repeat(64);
  const secondRevision = "b".repeat(64);
  const requests: string[] = [];
  await page.route("**/mesh-revision-check", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body style='margin:0;background:#101820;color:white;font:18px sans-serif'><p>Original revision (left) / Updated revision (right)</p></body></html>",
    }),
  );
  await page.route("**/api/mesh/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    const revision = path.split("/")[4];
    expect([firstRevision, secondRevision]).toContain(revision);
    await route.fulfill({
      contentType: "model/gltf-binary",
      body: triangleGlb(revision === firstRevision ? 0.75 : 2),
    });
  });
  await page.goto("/mesh-revision-check");
  const sizes = await page.evaluate(
    async ({ firstRevision, secondRevision }) => {
      const loaderPath = "/features/visualizer/rendering/mesh-loader.ts";
      const previewPath = "/e2e/fixtures/gdtf-mesh-preview.ts";
      const { loadMesh } = await import(loaderPath);
      const { renderMeshRevisionPreview } = await import(previewPath);
      const source = {
        path: "/fixtures/灯 modèle.gdtf",
        archiveSha256: firstRevision,
        mode: "Basic",
      };
      const original = await loadMesh(source, "Body + lens");
      const copy = await loadMesh(
        { ...source, path: "/copy/unit.gdtf" },
        "Body + lens",
      );
      const updated = await loadMesh(
        { ...source, archiveSha256: secondRevision },
        "Body + lens",
      );
      if (!original || !copy || !updated)
        throw new Error("Expected all revision meshes to load");
      const { firstWidth, secondWidth, renderer } = renderMeshRevisionPreview(
        original,
        updated,
      );
      (window as any).__meshRevisionRenderer = renderer;
      return { firstWidth, secondWidth, separateInstances: original !== copy };
    },
    { firstRevision, secondRevision },
  );
  expect(sizes).toEqual({
    firstWidth: 0.75,
    secondWidth: 2,
    separateInstances: true,
  });
  expect(requests).toHaveLength(2);
  expect(
    Buffer.from(requests[0].split("/")[3], "base64url").toString("utf8"),
  ).toBe("/fixtures/灯 modèle.gdtf");
  await page.screenshot({ path: testInfo.outputPath("mesh-revisions.png") });
  await page.evaluate(() => (window as any).__meshRevisionRenderer.dispose());
});
