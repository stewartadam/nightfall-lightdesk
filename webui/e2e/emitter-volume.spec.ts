// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { expect, frontendOnlyTest as test } from "./playwright-fixtures";

/** Decodes owned PNG masks and verifies atlas growth preserves existing patterns and shared slots. */
test("gobo atlas decodes and grows without losing masks", async ({ page }) => {
  await page.route("**/__gobo-test__", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<html><body></body></html>",
    }),
  );
  await page.goto("/__gobo-test__");
  const result = await page.evaluate(async () => {
    const { GoboAtlas } = await import(
      "/features/visualizer/rendering/effects/gobo-atlas.ts"
    );
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "white";
    context.fillRect(0, 0, 16, 32);
    const url = canvas.toDataURL("image/png");
    const atlas = new GoboAtlas();
    const first = atlas.load(url);
    const shared = atlas.load(url) === first;
    const slots = [
      first,
      ...Array.from({ length: 16 }, (_, i) => atlas.load(`${url}#${i}`)),
    ];
    const deadline = performance.now() + 10000;
    while (
      slots.some((slot) => slot.status === "loading") &&
      performance.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    const image = atlas.texture.image;
    const stride = atlas.tilesPerRow;
    const samples = slots.map((slot) => {
      const x = (slot.index % stride) * 256;
      const y = Math.floor(slot.index / stride) * 256 + 128;
      return [
        image.data![y * image.width + x + 64],
        image.data![y * image.width + x + 192],
      ];
    });
    const states = slots.map((slot) => slot.status);
    atlas.dispose();
    return { shared, width: image.width, states, samples };
  });
  expect(result.shared).toBe(true);
  expect(result.width).toBe(2048);
  expect(result.states.every((state) => state === "ready")).toBe(true);
  expect(
    result.samples.every(([white, black]) => white === 255 && black === 0),
  ).toBe(true);
});

for (const forceWebGL of [false, true]) {
  /** Exercises instance growth, live buffer updates, and camera-depth occlusion on both backends. */
  test(`batched emitters update and respect opaque depth (${forceWebGL ? "WebGL" : "WebGPU"})`, async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.route("**/__optics-batch__", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<html><body style="margin:0;background:black"><canvas width="800" height="600"></canvas></body></html>',
      }),
    );
    await page.goto("/__optics-batch__");
    const results = await page.evaluate(async (forceWebGL) => {
      const THREE = await import("/e2e/fixtures/three-api.ts");
      const { EmitterVolumeBatch } = await import(
        "/features/visualizer/rendering/effects/emitter-volume-batch.ts"
      );
      const { createOpticalRenderContext } = await import(
        "/features/visualizer/rendering/effects/optical-render-context.ts"
      );
      const renderer = new THREE.WebGPURenderer({
        canvas: document.querySelector("canvas")!,
        forceWebGL,
      });
      renderer.setSize(800, 600);
      await renderer.init();
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0);
      const camera = new THREE.PerspectiveCamera(50, 800 / 600, 0.1, 100);
      camera.position.set(4, 2, 4);
      camera.lookAt(0, 0, -8);
      const opaque = THREE.pass(scene, camera);
      const context = createOpticalRenderContext(scene, opaque.getViewZNode());
      const atmosphere = THREE.pass(context.scene, camera).setResolutionScale(
        0.5,
      );
      const pipeline = new THREE.RenderPipeline(renderer);
      pipeline.outputNode = opaque
        .getTextureNode()
        .add(atmosphere.getTextureNode());
      const batch = new EmitterVolumeBatch(scene);
      const parent = new THREE.Object3D();
      const optics = {
        shape: "round" as const,
        radius: 0.02,
        slopeX: 0.08,
        slopeY: 0.08,
        halfPowerRatio: 0.5,
        distributionPower: 4,
        lumens: 1000,
      };
      const blue = { red: 0, green: 0, blue: 1, intensity: 0.1 };
      for (let i = 0; i < 300; i++) {
        parent.position.x = ((i % 60) - 29.5) * 0.025;
        batch.update(`fixture:${i}`, parent, optics, blue);
      }
      /** Captures channel sums after the pipeline has submitted fresh instance data. */
      const capture = async () => {
        await new Promise<void>((resolve) => {
          let frames = 0;
          renderer.setAnimationLoop(() => {
            pipeline.render();
            if (++frames === 4) {
              renderer.setAnimationLoop(null);
              resolve();
            }
          });
        });
        const copy = document.createElement("canvas");
        copy.width = 800;
        copy.height = 600;
        const ctx = copy.getContext("2d")!;
        ctx.drawImage(renderer.domElement, 0, 0);
        const data = ctx.getImageData(0, 0, 800, 600).data;
        let red = 0;
        let blue = 0;
        let edgeEnergy = 0;
        for (let i = 0; i < data.length; i += 4) {
          red += data[i];
          blue += data[i + 2];
          if ((i / 4) % 800 !== 0)
            edgeEnergy += Math.abs(data[i] - data[i - 4]);
        }
        return { red, blue, edgeEnergy };
      };
      const lit = await capture();
      const draws = context.scene.children.length;
      for (let i = 0; i < 300; i++) batch.remove(`fixture:${i}`);
      parent.position.x = 0;
      batch.update("fixture:red", parent, optics, {
        red: 1,
        green: 0,
        blue: 0,
        intensity: 10,
      });
      const updated = await capture();
      batch.update("fixture:red", parent, optics, {
        red: 1,
        green: 0,
        blue: 0,
        secondaryRed: 0,
        secondaryGreen: 0,
        secondaryBlue: 1,
        intensity: 10,
      });
      const splitColor = await capture();
      const { compilePrismFacet } = await import(
        "/features/visualizer/rendering/effects/prism-optics.ts"
      );
      const facets = [-6, 0, 6].map(
        (x) =>
          compilePrismFacet({
            transform: [1, 0, 0, 0, 1, 0, x, 0, 1],
            colorCie: [0.3127, 0.329, 100],
          })!,
      );
      batch.update(
        "fixture:red",
        parent,
        optics,
        { red: 1, green: 0, blue: 0, intensity: 10 },
        30,
        1,
        0,
        0,
        facets,
      );
      const split = await capture();
      const splitCount = (
        context.scene.children[0] as InstanceType<typeof THREE.InstancedMesh>
      ).count;
      const prismCopy = document.createElement("canvas");
      prismCopy.width = 800;
      prismCopy.height = 600;
      prismCopy.getContext("2d")!.drawImage(renderer.domElement, 0, 0);
      const prismImage = prismCopy.toDataURL("image/png");
      const { EmitterOpticalState } = await import(
        "/features/visualizer/rendering/effects/emitter-optical-state.ts"
      );
      const stackState = new EmitterOpticalState(
        {
          mesh: new THREE.Mesh(),
          controlledElement: "Head",
          opticalWheels: [2, 3].map((count, index) => ({
            name: `Wheel${index}`,
            slots: [
              {
                facets: Array.from({ length: count }, (_, i) => ({
                  transform: [
                    1,
                    0,
                    0,
                    0,
                    1,
                    0,
                    index === 0 ? (i - 0.5) * 6 : 0,
                    index === 1 ? (i - 1) * 6 : 0,
                    1,
                  ],
                  colorCie: [0.3127, 0.329, 100],
                })),
              },
            ],
          })),
          opticalChannels: [0, 1].map((i) => ({
            geometry: "Head",
            attribute: `Prism${i + 1}`,
            parameterKey: `Prism${i + 1}`,
            dmxMax: 255,
            functions: [
              {
                attribute: `Prism${i + 1}`,
                wheel: `Wheel${i}`,
                dmxFrom: 0,
                dmxTo: 255,
                physicalFrom: 0,
                physicalTo: 1,
                sets: [
                  {
                    dmxFrom: 0,
                    dmxTo: 255,
                    physicalFrom: 0,
                    physicalTo: 1,
                    wheelSlot: 1,
                  },
                ],
              },
            ],
          })),
        },
        () => {
          throw new Error("Prisms must not request images");
        },
      );
      stackState.update(
        new Map([
          [
            "Head",
            {
              red: 1,
              green: 0,
              blue: 0,
              intensity: 10,
              "optical:Prism1": 1,
              "optical:Prism2": 1,
            },
          ],
        ]),
      );
      batch.reserve("fixture:red", stackState.maxFacetCount);
      batch.update(
        "fixture:red",
        parent,
        optics,
        { red: 1, green: 0, blue: 0, intensity: 10 },
        30,
        1,
        0,
        0,
        stackState.prism,
        stackState.prismRotation,
      );
      const stacked = await capture();
      const stackedCount = (
        context.scene.children[0] as InstanceType<typeof THREE.InstancedMesh>
      ).count;
      prismCopy.getContext("2d")!.drawImage(renderer.domElement, 0, 0);
      const stackedImage = prismCopy.toDataURL("image/png");
      const maskCanvas = document.createElement("canvas");
      maskCanvas.width = 32;
      maskCanvas.height = 32;
      const maskContext = maskCanvas.getContext("2d")!;
      maskContext.fillStyle = "black";
      maskContext.fillRect(0, 0, 32, 32);
      const blockedSlot = batch.goboAtlas.load(
        maskCanvas.toDataURL("image/png"),
      );
      const deadline = performance.now() + 10000;
      while (blockedSlot.status === "loading" && performance.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      if (blockedSlot.status !== "ready") throw new Error("Gobo did not load");
      batch.update(
        "fixture:red",
        parent,
        optics,
        { red: 1, green: 0, blue: 0, intensity: 10 },
        30,
        1,
        blockedSlot.index,
      );
      const goboBlocked = await capture();
      maskContext.fillStyle = "white";
      for (let x = 0; x < 32; x += 4) maskContext.fillRect(x, 0, 2, 32);
      const stripes = batch.goboAtlas.load(maskCanvas.toDataURL("image/png"));
      const focusDeadline = performance.now() + 10000;
      while (stripes.status === "loading" && performance.now() < focusDeadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      if (stripes.status !== "ready")
        throw new Error("Focus gobo did not load");
      batch.update(
        "fixture:red",
        parent,
        optics,
        { red: 1, green: 0, blue: 0, intensity: 10 },
        30,
        1,
        stripes.index,
      );
      const sharp = await capture();
      prismCopy.getContext("2d")!.drawImage(renderer.domElement, 0, 0);
      const sharpImage = prismCopy.toDataURL("image/png");
      batch.update(
        "fixture:red",
        parent,
        optics,
        { red: 1, green: 0, blue: 0, intensity: 10 },
        30,
        1,
        0,
        0,
        undefined,
        0,
        0,
        [
          { slot: blockedSlot.index, rotation: 0 },
          { slot: stripes.index, rotation: Math.PI / 2 },
        ],
      );
      const stackedGoboBlocked = await capture();
      batch.update(
        "fixture:red",
        parent,
        optics,
        { red: 1, green: 0, blue: 0, intensity: 10 },
        30,
        1,
        0,
        0,
        undefined,
        0,
        0,
        [
          { slot: stripes.index, rotation: 0 },
          { slot: stripes.index, rotation: Math.PI / 2 },
        ],
      );
      const crossedGobos = await capture();
      prismCopy.getContext("2d")!.drawImage(renderer.domElement, 0, 0);
      const crossedGobosImage = prismCopy.toDataURL("image/png");
      batch.update(
        "fixture:red",
        parent,
        optics,
        { red: 1, green: 0, blue: 0, intensity: 10 },
        30,
        1,
        stripes.index,
        0,
        undefined,
        0,
        0.1,
      );
      const defocused = await capture();
      prismCopy.getContext("2d")!.drawImage(renderer.domElement, 0, 0);
      const defocusedImage = prismCopy.toDataURL("image/png");
      batch.update(
        "fixture:red",
        parent,
        optics,
        { red: 1, green: 0, blue: 0, intensity: 10, frost: 1 },
        30,
        1,
        stripes.index,
      );
      const frosted = await capture();
      prismCopy.getContext("2d")!.drawImage(renderer.domElement, 0, 0);
      const frostedImage = prismCopy.toDataURL("image/png");
      batch.update("fixture:red", parent, optics, {
        red: 1,
        green: 0,
        blue: 0,
        intensity: 10,
      });
      const wall = new THREE.Mesh(
        new THREE.PlaneGeometry(100, 100),
        new THREE.MeshBasicNodeMaterial({ color: 0 }),
      );
      wall.position
        .copy(camera.position)
        .addScaledVector(camera.getWorldDirection(new THREE.Vector3()), 0.5);
      wall.quaternion.copy(camera.quaternion);
      scene.add(wall);
      const occluded = await capture();
      wall.visible = false;
      batch.clear();
      const blackout = await capture();
      batch.update("fixture:red", parent, optics, {
        red: 1,
        green: 0,
        blue: 0,
        intensity: 10,
      });
      await capture();
      (window as any).__disposeBatch = () => {
        batch.dispose();
        opaque.dispose();
        atmosphere.dispose();
        pipeline.dispose();
        renderer.dispose();
      };
      return {
        lit,
        updated,
        splitColor,
        split,
        splitCount,
        prismImage,
        stacked,
        stackedCount,
        stackedImage,
        goboBlocked,
        stackedGoboBlocked,
        crossedGobos,
        crossedGobosImage,
        sharp,
        defocused,
        frosted,
        frostedImage,
        sharpImage,
        defocusedImage,
        occluded,
        blackout,
        draws,
      };
    }, forceWebGL);
    await testInfo.attach("batch-pixels.json", {
      body: JSON.stringify({
        ...results,
        prismImage: undefined,
        crossedGobosImage: undefined,
        stackedImage: undefined,
        sharpImage: undefined,
        defocusedImage: undefined,
        frostedImage: undefined,
      }),
      contentType: "application/json",
    });
    await testInfo.attach("prism-volume.png", {
      body: Buffer.from(results.prismImage.split(",")[1], "base64"),
      contentType: "image/png",
    });
    await testInfo.attach("stacked-prism-volume.png", {
      body: Buffer.from(results.stackedImage.split(",")[1], "base64"),
      contentType: "image/png",
    });
    await testInfo.attach("crossed-gobos-volume.png", {
      body: Buffer.from(results.crossedGobosImage.split(",")[1], "base64"),
      contentType: "image/png",
    });
    await testInfo.attach("sharp-volume.png", {
      body: Buffer.from(results.sharpImage.split(",")[1], "base64"),
      contentType: "image/png",
    });
    await testInfo.attach("defocused-volume.png", {
      body: Buffer.from(results.defocusedImage.split(",")[1], "base64"),
      contentType: "image/png",
    });
    await testInfo.attach("frosted-volume.png", {
      body: Buffer.from(results.frostedImage.split(",")[1], "base64"),
      contentType: "image/png",
    });
    await page.screenshot({ path: testInfo.outputPath("batched-volume.png") });
    await page.evaluate(() => (window as any).__disposeBatch());
    expect(errors).toEqual([]);
    expect(results.draws).toBe(1);
    expect(results.lit.blue).toBeGreaterThan(10000);
    expect(results.updated.red).toBeGreaterThan(10000);
    expect(results.updated.blue).toBe(0);
    expect(results.splitColor.red).toBeGreaterThan(1000);
    expect(results.splitColor.blue).toBeGreaterThan(1000);
    expect(results.splitCount).toBe(3);
    expect(results.stackedCount).toBe(6);
    expect(results.stacked.red).toBeGreaterThan(1000);
    expect(results.stacked.red).not.toBe(results.split.red);
    expect(results.split.red).toBeGreaterThan(10000);
    expect(results.split.red).not.toBe(results.updated.red);
    expect(results.goboBlocked.red).toBe(0);
    expect(results.stackedGoboBlocked.red).toBe(0);
    expect(results.crossedGobos.red).toBeGreaterThan(0);
    expect(results.crossedGobos.red).toBeLessThan(results.sharp.red);
    expect(results.sharp.red).toBeGreaterThan(1000);
    expect(results.defocused.red).toBeGreaterThan(1000);
    expect(results.frosted.red).toBeGreaterThan(1000);
    expect(results.frosted.edgeEnergy / results.frosted.red).toBeLessThan(
      results.sharp.edgeEnergy / results.sharp.red,
    );
    expect(results.defocused.edgeEnergy / results.defocused.red).toBeLessThan(
      results.sharp.edgeEnergy / results.sharp.red,
    );
    expect(results.occluded.red).toBe(0);
    expect(results.blackout.red).toBe(0);
  });
}

/** Compiles the optical integrator on a real device and retains its rendered output for visual QA. */
test("resolved rectangular emitter renders a volumetric distribution", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.route("**/__optics-test__", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><body style="margin:0;background:black"><canvas id="volume" width="800" height="600"></canvas></body></html>',
    }),
  );
  await page.goto("/__optics-test__");
  const shaders = await page.evaluate(async () => {
    const THREE = await import("/e2e/fixtures/three-api.ts");
    const { BeamType } = await import("/types/index.ts");
    const { createEmitterVolumeMaterial, updateEmitterVolumeOptics } =
      await import(
        "/features/visualizer/rendering/effects/emitter-volume-material.ts"
      );
    const { resolveEmitterOptics } = await import(
      "/features/visualizer/rendering/effects/emitter-optics.ts"
    );
    const renderer = new THREE.WebGPURenderer({
      canvas: document.querySelector("canvas")!,
    });
    renderer.setSize(800, 600);
    await renderer.init();
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 800 / 600, 0.01, 100);
    camera.position.set(4, 2, 4);
    camera.lookAt(0, 0, -8);
    const optics = resolveEmitterOptics({
      radius: 0.02,
      throwRatio: 2,
      rectangleRatio: 8,
      physical: {
        beamType: BeamType.Rectangle,
        beamAngle: 4,
        fieldAngle: 8,
        lumens: 1000,
      },
    })!;
    const volume = createEmitterVolumeMaterial();
    updateEmitterVolumeOptics(volume, optics);
    volume.radiance.value.set(0.2, 0.7, 1);
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      volume.material,
    );
    mesh.position.z = -15;
    mesh.scale.set(
      4 * (optics.radius + 30 * optics.slopeX),
      4 * (optics.radius + 30 * optics.slopeY),
      30,
    );
    scene.add(mesh);
    await renderer.compileAsync(scene, camera);
    const maxBlue = await new Promise<number>((resolve) => {
      let frames = 0;
      renderer.setAnimationLoop(() => {
        renderer.render(scene, camera);
        if (++frames === 20) {
          const copy = document.createElement("canvas");
          copy.width = 800;
          copy.height = 600;
          const context = copy.getContext("2d")!;
          context.drawImage(renderer.domElement, 0, 0);
          const pixels = context.getImageData(0, 0, 800, 600).data;
          let maximum = 0;
          for (let index = 2; index < pixels.length; index += 4)
            maximum = Math.max(maximum, pixels[index]);
          resolve(maximum);
        }
      });
    });
    (window as any).__disposeOptics = () => {
      renderer.setAnimationLoop(null);
      renderer.dispose();
    };
    return {
      shaders: await renderer.debug.getShaderAsync(scene, camera, mesh),
      maxBlue,
    };
  });
  await testInfo.attach("volume-shader.json", {
    body: JSON.stringify(shaders),
    contentType: "application/json",
  });
  await page.screenshot({
    path: testInfo.outputPath("rectangular-volume.png"),
  });
  await page.evaluate(() => (window as any).__disposeOptics());
  expect(shaders.maxBlue).toBeGreaterThan(1);
  expect(errors).toEqual([]);
});
