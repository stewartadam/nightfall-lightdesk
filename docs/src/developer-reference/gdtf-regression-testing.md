# GDTF regression testing

GDTF import is tested in layers, from cheap synthetic checks that run on every
pull request to real-archive checks that run on demand. Every layer is
stateless: tests compare against committed expectations and never depend on
results from earlier runs.

| Layer | What it proves | Runs |
| --- | --- | --- |
| Synthetic archives | Each edge case (references, breaks, sparse fine bytes, virtual channels, functions, wheels, emitters) converts as specified | Every PR (`cargo test`) |
| Structural invariants | No two parameters share a slot, footprints fit a universe, the geometry is a well-formed tree, beams and joints bind to real elements | Every PR, bench and sweep |
| Reference decoder | Bytes the engine writes land where the GDTF file says, checked by an independent decoder | Every PR (synthetic and 64 random layouts), bench |
| Scene-graph tests | World-space beam directions and pivots for rest poses, nested pan/tilt, independent heads, mounting and smoothing | Every PR (`npm run test:webui-node`) |
| Curated bench | 18 pinned archives: every mode converts, invariants and reference decoder agree, channel charts match | On demand |
| Visual bench | Real archives render with loaded meshes; unlit bodies match reviewed baselines | On demand |
| Corpus sweep | Every archive in a collection is rejected cleanly or converts without violations | On demand |

## Synthetic archives

`nightfall_fixture_library::testing::GdtfBuilder` writes spec-shaped archives
in memory (enable the crate's `test-support` feature from other crates).
Prefer a synthetic test for any new behavior: it isolates the case and needs
no redistributable assets. `testing::invariants::check_invariants` and
`testing::reference::reference_mode_channels` are available to every test.

## Curated bench

The bench manifest in `crates/fixture-library/tests/gdtf-bench/manifest.json`
pins each archive's SHA-256, provenance and exact mode names. Expectations in
`tests/gdtf-bench/expectations/` hold per-mode channel charts for
representative modes and the invariant violations known per mode (currently
none).

```sh
NIGHTFALL_GDTF_BENCH_DIR=/path/to/bench npm run test:gdtf-bench
```

A missing directory, missing archive, changed hash or changed mode list fails.
After an intended converter change, regenerate the expectations with
`NIGHTFALL_GDTF_BENCH_UPDATE=1` and review the diff. A chart is only
authoritative once checked against the manufacturer's documentation for the
pinned revision; the `jdc1` archive is a visualization-only profile and is not
a DMX reference.

## Visual bench

```sh
NIGHTFALL_GDTF_BENCH_DIR=/path/to/bench \
NIGHTFALL_GDTF_BENCH_SCREENSHOTS=1 \
npm run test:webui-playwright -- webui/e2e/gdtf-bench-visual.spec.ts
```

The spec installs bench archives into an isolated backend, drives fixtures
through console commands, and asserts world-space beam directions, independent
head movement, pixel expansion, color wheel tint, gobo activation and that
archive meshes loaded. Captures use a fixed camera and are attached to the
report.

Only unlit body captures are compared with baselines
(`gdtf-bench-visual.spec.ts-snapshots/*-<platform>.png`): volumetric beams and
floor lighting differ between identical runs. Record baselines with
`--update-snapshots`, review every image, and commit them per platform. Only
macOS baselines are committed so far.

`webui/e2e/gdtf-bench-evaluation.spec.ts` uses the same bench directory to
check channel semantics numerically: console output of relation followers
(virtual dimmer chains) and the emitter colors the visualizer derives from
it. Shared bench setup lives in `webui/e2e/gdtf-bench-support.ts`.

## Corpus sweep

```sh
NIGHTFALL_GDTF_CORPUS_DIR=/path/to/collection \
NIGHTFALL_GDTF_CORPUS_REPORT=sweep.json \
npm run test:gdtf-sweep
```

`NIGHTFALL_GDTF_CORPUS_DIR` is a platform path list searched recursively. Each
archive must either be rejected with an error or convert every mode without
invariant violations; panics, timeouts and violations fail. The JSON report
(per-stage counts, rejection reasons, per-archive outcomes) is informational
and never compared between runs. To guard a behavior found in the sweep, add a
synthetic test or a bench archive rather than recording sweep results.

Conversion diagnostics (`GdtfDiagnostic`) record faults the converter
tolerates: unreachable channels, dangling or cyclic references, duplicate
geometry names, channels outside one universe (dropped) and channels reusing
another channel's slots (kept as virtual parameters).

Archives that `gdtf-rs` rejects are retried after load-time repairs
(`gdtf_repair`): NaN placeholders in optional attributes are dropped (required
colors become white), missing `FeatureGroup@Pretty` and `DMXChannel@Offset`
are filled, braced gamut point lists are rewritten, channel sets starting
below DMX 0 are dropped, and laser geometries import as plain geometries.
Archives that parse as published are never rewritten. Repairs are logged as
warnings. The gamut and laser repairs work around parser limitations and can
be removed once `gdtf-rs` reads those constructs.

## Continuous integration

No CI workflow runs the bench, visual bench or sweep yet. They need
manufacturer archives that cannot be redistributed, and CI policy
(`scripts/ci-security.node.test.mjs`) keeps secrets and repository
permissions out of build and test jobs. Workflow artifacts on this public
repository would also make fetched archives downloadable. Run these layers
locally before changing the converter or visualizer.
