# Three.js WebGPU timing fixes

`three@0.186.1.patch` is registered under `patchedDependencies` in
`pnpm-workspace.yaml`, so `pnpm install` applies it and fails if it no longer
applies. pnpm records the patch hash in its installed lockfile
(`node_modules/.pnpm/lock.yaml`), which Vite includes in its
[dependency cache key](https://vite.dev/guide/dep-pre-bundling.html#caching),
so a previously optimized, unpatched Three.js bundle cannot survive a patch
change. Restart any running Vite server after changing a patch.

Edit the patch with `pnpm patch three@0.186.1`, change the extracted copy, then
run `pnpm patch-commit <directory>`.

The Three.js version is pinned so an upgrade requires checking this patch. The
patch covers the upstream source and both unminified WebGPU distribution entry
points; Nightfall imports `three/webgpu`, which resolves to
`build/three.webgpu.js`. The minified distribution files are not used by
Nightfall.

The patch clears `timestampWrites` before `initTimestampQuery` returns when
tracking is disabled. Three reuses the canvas render-pass descriptor without
resetting it; otherwise a sampled frame leaves GPU timestamp writes enabled on
subsequent unsampled frames. Nightfall samples at 10 Hz to limit profiling
overhead. The regression test in `scripts/three-timestamp-query.node.test.mjs`
checks enabled/disabled/enabled sampling with a reused descriptor against the
source and both distribution entry points, without requiring a GPU.

Timestamp readback also preserves copied raw interval bounds before unmapping:
`lastInterval` covers the sampled batch and `frameIntervals` separates frames
when the developer inspector resolves several together. Nightfall reports GPU
work using the earliest start and latest end across render and compute passes.
Summing individual durations can double-count overlapping work. Missing bounds
remain unavailable, and each readback replaces the frame map to bound retention.
