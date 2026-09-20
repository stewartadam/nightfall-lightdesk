# Three.js WebGPU lighting lookup

`three+0.185.1.patch` materializes the two-channel DFG lookup as a TSL variable
before the lighting code reads its individual components. This preserves the
lookup texture, coordinates, values, and BRDF calculations, while emitting
`pair = sample.xy; pair.x` instead of `sample.xy.x`.

Chromium 153.0.8010.12 on macOS fails the latter form during Metal shader
compilation with `swizzle view instruction still has usages after lowering`.
This affects standard materials even in an empty visualizer scene. The patch
covers the upstream source and both unminified WebGPU distribution entry points;
Nightfall imports `three/webgpu`, which resolves to `build/three.webgpu.js`.

`npm install` / `npm ci` apply the patch through `patch-package --error-on-fail`.
The Three.js version is pinned so an upgrade requires checking this patch.
The minified distribution files are not used by Nightfall.

Regression coverage:

- `webui/e2e/browser-demo.spec.ts` checks the real demo flow without filtering
  console errors and captures the lit sample rig.
- `webui/e2e/visualizer-render.spec.ts` checks main-thread and worker rendering,
  fixture appearance and output, and rejects shader/pipeline diagnostics.

When upgrading Three.js or Chromium, reproduce without the patch before removing
it. The latest published release checked during investigation, r186, still has
the same lookup and nested-swizzle generation. Upstream source:
https://github.com/mrdoob/three.js/blob/r186/src/nodes/functions/BSDF/DFGLUT.js
