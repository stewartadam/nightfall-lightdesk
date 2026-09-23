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
      const ownershipPath = "/features/visualizer/rendering/mesh-ownership.ts";
      const { disposeFixtureMesh } = await import(ownershipPath);
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
      const originalMaterial = original.children[0].material;
      const copiedMaterial = copy.children[0].material;
      copiedMaterial.opacity = 0.25;
      let geometryDisposals = 0;
      original.children[0].geometry.addEventListener("dispose", () => {
        geometryDisposals++;
      });
      disposeFixtureMesh(copy);
      const { firstWidth, secondWidth, renderer } = renderMeshRevisionPreview(
        original,
        updated,
      );
      (window as any).__meshRevisionRenderer = renderer;
      return {
        firstWidth,
        secondWidth,
        separateInstances: original !== copy,
        separateMaterials: originalMaterial !== copiedMaterial,
        originalOpacity: originalMaterial.opacity,
        geometryDisposals,
      };
    },
    { firstRevision, secondRevision },
  );
  expect(sizes).toEqual({
    firstWidth: 0.75,
    secondWidth: 2,
    separateInstances: true,
    separateMaterials: true,
    originalOpacity: 1,
    geometryDisposals: 0,
  });
  expect(requests).toHaveLength(2);
  expect(
    Buffer.from(requests[0].split("/")[3], "base64url").toString("utf8"),
  ).toBe("/fixtures/灯 modèle.gdtf");
  await page.screenshot({ path: testInfo.outputPath("mesh-revisions.png") });
  await page.evaluate(() => (window as any).__meshRevisionRenderer.dispose());
});

/** Removing an instance while a shared mesh request is pending must not attach its late result or break the surviving copy. */
test("removed fixture ignores a late shared mesh load", async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/mesh-lifecycle-check", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body></body></html>",
    }),
  );
  await page.route("**/api/mesh/**", async (route) => {
    await pending;
    await route.fulfill({
      contentType: "model/gltf-binary",
      body: triangleGlb(2),
    });
  });
  await page.goto("/mesh-lifecycle-check");
  await page.evaluate(async () => {
    const builderPath = "/features/visualizer/rendering/geometry-builder.ts";
    const { buildGeometryTree, disposeFixtureInstance } = await import(
      builderPath
    );
    const source = {
      path: "/fixtures/lifecycle.gdtf",
      archiveSha256: "c".repeat(64),
      mode: "Basic",
    };
    const geometry = {
      gdtf: source,
      roots: [0],
      nodes: [
        {
          name: "Body",
          geometryType: "generic",
          parentIndex: -1,
          children: [],
          transform: {
            elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          },
          model: {
            name: "body",
            primitiveType: "cube",
            width: 1,
            height: 1,
            length: 1,
            meshFile: "body",
          },
        },
      ],
    };
    const removed = buildGeometryTree("removed", geometry);
    const survivor = buildGeometryTree("survivor", geometry);
    disposeFixtureInstance(removed);
    (window as any).__meshLifecycle = {
      removed,
      survivor,
      source,
      disposeFixtureInstance,
    };
  });
  release();
  const result = await page.evaluate(async () => {
    const { removed, survivor, source, disposeFixtureInstance } = (
      window as any
    ).__meshLifecycle;
    const loaderPath = "/features/visualizer/rendering/mesh-loader.ts";
    const ownershipPath = "/features/visualizer/rendering/mesh-ownership.ts";
    const { loadMesh } = await import(loaderPath);
    const { disposeFixtureMesh } = await import(ownershipPath);
    const extra = await loadMesh(source, "body");
    const result = {
      removedHasMesh: !!removed.group.getObjectByName("Body_mesh"),
      survivorHasMesh: !!survivor.group.getObjectByName("Body_mesh"),
      cacheStillUsable: !!extra,
    };
    if (extra) disposeFixtureMesh(extra);
    disposeFixtureInstance(survivor);
    return result;
  });
  expect(result).toEqual({
    removedHasMesh: false,
    survivorHasMesh: true,
    cacheStillUsable: true,
  });
});
