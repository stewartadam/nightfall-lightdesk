# GDTF compatibility and rendering implementation plan

## Objective and scope

Implement reliable GDTF behavior from archive import through operator controls,
DMX input/output, saved shows, and visualization. The
[17-model, 18-archive test bench](gdtf-test-bench.md) is the acceptance corpus.
Multi-geometry fixtures and nested tilt are examples within this broader effort.

This is a proposed implementation design, not delivered support. Beads epic
`nightfall-lightdesk-oaa` and its phase issues hold live implementation status.
This document defines design, dependencies, scope, and acceptance criteria.

Success means that a selected fixture/mode imports predictably, exposes meaningful
controls, emits correct bytes, survives save/reload, and renders its declared
supported behavior. Report parsing, control/DMX, geometry/assets, and visual
simulation separately. A parsed archive or plausible image does not establish
complete compatibility.

Target all curated modes for structural and channel-semantic checks, with
representative visual states for every capability. Unsupported features require
explicit results and follow-up issues. Full photometric/spectral simulation,
vendor firmware effect emulation, laser/media-server simulation, and automatic
migration of old programming are outside the initial scope. Preserve controls
that cannot yet be simulated. Basic non-lighting import remains in scope through
the Antari case.

## Existing foundations and gaps

These findings come from source inspection at the documentation branch baseline,
not an executed compatibility measurement. Phase 0 establishes that measurement.

| Area | Foundation to reuse | Gap and affected behavior |
| --- | --- | --- |
| Library/parser | `gdtf-rs`, scanner/watcher, mesh extraction, source fingerprints | Repeated parsing; make/model indexing does not distinguish revisions; path-based resource URLs receive immutable caching. |
| Geometry | `FixtureGeometry` parent/child arrays and Three.js scene graph | All roots traversed; references unexpanded; node identity depends on names. |
| Controls | Per-element parameters, physical position units, patch bindings | Explicit wire offsets/breaks and most function semantics are lost; bindings pack parameter widths sequentially. |
| Articulation | Geometry axes and movement rendering | Name-based axis inference; first pan/tilt-bearing element supplies one pair and one smoothing state for all joints. |
| Light output | Existing color utilities, emitter meshes, beam shaders, built-in renderers | One controlling element per emitter; fixture-wide physical properties derived from the first beam. |
| Persistence/transport | Showfile contributors, fixture snapshots, separate geometry messages, typeshare | Stored indices can diverge from regenerated geometry; lookup uses make/model/mode; replacement needs coherent revisions. |
| Tests | Rust/Node tests and native Playwright/backend isolation | No pinned real-archive acceptance suite; transforms, DMX bytes, and images need independent expectations. |

## Proposed architecture

### One compiled definition per archive revision and mode

Keep GDTF interpretation in Rust. Introduce a pure compiler in
`crates/fixture-library` from parsed archive plus exact mode to an immutable
resolved definition. Produce controls, instantiated geometry, wire mappings,
resource references, and diagnostics together. Fixture creation and later
geometry materialization consume that same result.

Reuse the parser first. Distinguish archive faults, parser limitations, and
conversion gaps before changing dependencies. Avoid a second production XML
parser or independent GDTF interpretation in the browser.

| Contract | Required information |
| --- | --- |
| Definition identity | Archive content hash, exact mode, compiler/schema version; distinct revisions even when make/model match. |
| Geometry instances | Deterministic instance IDs, source references, parent IDs, authored rest transforms, resources, per-emitter physical data. Expand only instances reachable from the selected mode root. |
| Logical controls | Stable IDs, selectable element/group membership, semantic attribute, native unit, functions/ranges, defaults, highlight, and relationships. Labels are presentation, not identity. |
| Wire mapping | Ordered significant-byte offsets, break, active function, physical conversion, virtual status, and full mode footprint. |
| Render bindings | Explicit control-to-joint/emitter links, local movement convention, optical type, support/approximation status. |
| Runtime instance | Fixture UID, placement, parameter values, per-joint movement state, mutable scene objects. Share immutable definitions/resources, not mutable state. |

Place shared serializable contracts with existing fixture/DMX types; keep parsing
and compilation outside generic engine crates. Regenerate typeshare declarations
and worker contracts together. Use existing Bevy resources/SystemParams and
command boundaries; no new service or general plugin framework is needed.

Do not equate physical geometry with operator elements. Housings need geometry
but no selectable controls; one head can have separate movement and pixel control
groups. Preserve deterministic operator ordering with explicit physical bindings.
Repeated attributes on different heads remain independent. Multiple functions
sharing a physical channel must not become conflicting independent DMX outputs.

### Control semantics and physical DMX

Compile functions, channel sets, physical ranges/profiles, conditional activation,
defaults/highlight, and relationships before flattening parameters. Resolve
reference break overrides and offsets. Validate break patching and address
boundaries; do not assume each GDTF break means the next universe.

Update input decoders, output encoders, binding resolution, and footprint reporting
together. Cover 8/16/24/32-bit values, nonadjacent fine bytes, gaps, shared channels,
and virtual controls that consume no slots. Use integer-safe raw DMX storage where
needed: floating logical values must not promise exact 32-bit round trips they
cannot represent. Specify logical tolerances separately from byte-level fidelity.

Preserve engine fades, LTP/HTP, release, highlight, programmer values, and
grandmaster behavior. Define function-selector changes during fades, writes to
inactive functions, and profiles without a unique inverse. Report unsupported
inverse mappings instead of guessing a linear conversion.

Geometry inheritance is separate from control relationships. Distinguish virtual
relations baked into output from physical master controls applied by a device.
Derive effective visual values from the final fixture control snapshot using the
same compiled semantics, applying each relationship exactly once. Test those
values against corresponding encoded bytes; do not double-apply dimmers or
shutters. Preserve raw controls for vendor effects that cannot be simulated.

Keep existing built-in/OFL layouts and output behavior. Adapt them to shared
contracts where useful; do not reinterpret every profile as GDTF or depend on
specialized renderer names to make imported geometry function.

### Geometry, movement, optics, and resource ownership

Expand references with deterministic identity and bounded cycle/depth/node checks.
Document one coordinate/unit convention and normalize GLB, legacy 3DS, and
primitives at loading boundaries. Test asymmetrical parts, mirrored transforms,
rest poses, and rotated/inverted fixture placements.

Compose each joint's authored rest transform with its local movement. Bind joints
from channel semantics, not names such as Head or Yoke. Maintain per-joint state
and an injected clock. Distinguish position targeting, continuous rotation, and
optional mechanical smoothing so engine fades do not acquire a second delay.
Specify start/stop/reversal/wraparound/reset behavior. Nested tilt and independent
heads are required numerical transform tests, not just screenshot cases.

Per-emitter definitions govern glow/projected light, beam and field angles,
source position/direction, and optical controls. An Aura can contain glowing and
projecting components simultaneously. Explicit bindings combine shared dimmer or
shutter with local color/zoom instead of choosing one winning element.

Reuse existing Three.js loaders, color utilities, and shaders. Serve resources by
definition/resource identity restricted to indexed archives, with content hashes
in cache keys and immutable URLs. Bound archive expansion/resource sizes; prevent
embedded references from escaping allowed archive resources or fetching arbitrary
external URLs. Move expensive parsing/decode off latency-sensitive paths.

Share immutable geometry/textures, clone mutable materials/state as necessary,
and dispose only resources owned by the instance or released by the cache. Late
async loads must not mutate removed/replaced fixtures. Cache compiled modes by
content, mode, and compiler version with bounded memory; do not resend static
expanded geometry every frame.

### Saved shows, UI, and execution paths

Persist definition identity and enough resolved control/wire information to
reconstruct a coherent fixture. Reuse showfile asset packaging for source archives
and resources where possible. Library updates must not combine old programmed
indices with new geometry. Profile replacement/repatch is an atomic command that
updates controls, bindings, geometry, and undo state.

Old schemas may require explicit repatching; compatibility shims are not a goal.
Missing resources should produce an actionable degraded state without guessing a
different make/model match or silently altering output. Stable geometry IDs do
not solve index-based programming alone: preserve indices within a pinned
definition and make revision replacement explicit.

Audit selection syntax, groups, programmer/properties, FX distribution, cues,
patch footprints, duplicate fixtures, undo/redo, and previews. Expose relevant
modes/control groups and capability limitations in operator language. Use the
same resolved behavior for preview/stage and main-thread/worker renderers. Link
definition and parameter messages to coherent revisions. Keep browser-demo/shared
serialization coverage without introducing native filesystem dependencies.

## Delivery phases

Each phase is a work package to split into focused commits during implementation.
Every runtime change includes relevant tests; phase 7 expands automation and
coverage rather than deferring all tests until the end.

| Phase / Beads issue | Deliverable and primary areas | Depends on | Acceptance gate |
| --- | --- | --- | --- |
| 0 — `nightfall-lightdesk-oaa.1` | Pinned manifest/bundle, corpus runner, capability baseline, synthetic inputs; fixture-library tests/scripts. | None | Verify 18 inputs and enumerate every mode; establish independent initial-six expectations. Missing inputs fail; archive faults are separate. Record baseline load/memory/frame measurements. |
| 1 — `nightfall-lightdesk-oaa.2` | Resolved contracts/compiler; fixture-library converters/manager and fixtures geometry/parameter types. | 0 | Deterministic root/reference/break resolution, unique IDs, serialized bindings and structured diagnostics. Persistence and worker revision contracts established. |
| 2 — `nightfall-lightdesk-oaa.3` | Engine functions, input/output, patching; fixtures bindings/compositor, DMX types and output paths. | 1 | Independent expected bytes and input decoding pass for sparse/fine/virtual/shared channels. Defaults/highlight/release/relations and boundaries covered; built-in/OFL output stays correct. |
| 3 — `nightfall-lightdesk-oaa.4` | Scene/mesh loading, articulation and emitter attachment; geometry-builder, scene-manager, mesh-loader, renderers. | 2 | Synthetic nested tilt, Hydrabeam heads, MagicPanel instances and Pixel Line IP layouts pass transform/image tests. Copies remain independent; mounting/rest poses and continuous movement are deterministic. |
| 4 — `nightfall-lightdesk-oaa.5` | Per-emitter color/intensity/shutter; compiled semantics and existing color/beam utilities. | 3 | Aura, Pixel Line IP, Titan, Lustr, SkyPanel and JDC1 cases cover local/master controls, additive extended colors, subtractive CMY, color wheel, CCT/HSI/XY and strobe without double application. |
| 5 — `nightfall-lightdesk-oaa.6` | Optics and wheel resources/functions: zoom/focus/iris/frost, gobo selection/indexing/rotation, multiple wheels and prisms. | 4 | Sharpy/Viper and applicable Spiider modes have checked slot/range behavior and reviewed images; each capability is implemented or explicitly classified with a follow-up. |
| 6 — `nightfall-lightdesk-oaa.7` | Saved-show/operator workflows, revisioned assets/caches, atomic replacement, preview/worker parity. | 3 | Save/load, duplicate, undo/redo, mode/revision replacement, missing archive and late-load tests pass. Variant patching is unambiguous; groups/FX/cues retain targets. Re-run with phases 4–5 before release. |
| 7 — `nightfall-lightdesk-oaa.8` | Full bench CI, corpus reports, performance budgets and lifecycle soak coverage. | 5 and 6 | All capability expectations enforced; no unclassified curated failures; baselines reviewed; measured budgets met; no repeated load/remove resource growth; native/browser regressions checked. |

Dependency order: `0 → 1 → 2 → 3 → 4 → 5 → 7`, with `3 → 6 → 7`.
Phase 6 contracts are established in phase 1 even though workflow integration
follows later. Changes are not release-ready until phase 6 is complete.

The first useful vertical milestone is phases 0–3 on Sharpy, MAC Aura, MagicPanel
FX, Titan Tube, Hydrabeam 400, and Pixel Line IP: correct geometry, deterministic
control identity, actual wire mapping, and independent movement. This is an
internal milestone, not a claim of complete color/optical support. Prefer it to
fixture-specific visual patches that bypass the common model.

## Regression and rollout gates

Maintain per-archive/mode capability expectations: supported, documented
approximation, known unsupported, or invalid input. Known unsupported entries
need narrow expectations and issue IDs. Unexpected failure types and regressions
in passing behavior fail CI; improvements require reviewed expectation changes.

| Layer | Verification |
| --- | --- |
| Archive/compiler | Roots, references, functions/relations, IDs, finite transforms, offsets/bounds; malformed, cyclic and oversized inputs fail within limits. |
| Engine/wire | Independent byte vectors, physical-value tolerances, input decoding, breaks, defaults, virtual relations, selector boundaries, merge/release behavior. |
| Renderer logic | Numerical rest/world transforms, pivots, emitter directions, per-joint timing, color/intensity and actual resource readiness. |
| End-to-end | Patch through UI, issue commands, assert engine values and output buffers, render, save/reload. Keep physical transports disabled using existing test isolation. |
| Visual | Fixed camera, exposure/color settings, quality, viewport, clock/seeds; crop relevant parts; await assets and completed frames. Manually review baselines and retain actual/expected/diff images. |
| Lifecycle/performance | Cold/warm compile/load, 1/10/100 repeated fixtures where feasible, Rainbow mode stress, worker traffic, frame-time percentiles, cache/memory/GPU counts, repeated mode-switch/remove cycles. |

Use meaningful Cargo/Node tests and Playwright through
`npm run test:webui-playwright -- <spec>`, following macOS escalation rules.
Real archive integration uses the native backend; preserve embedded-demo smoke
coverage. Keep browser artifacts under `test-results/playwright/`.

Pin browser/rendering environments for image gates and a runner for performance.
Set numerical budgets from phase 0 measurements before optimization acceptance;
do not invent portable FPS promises. Bound concurrency and keep full-collection
sweeps nightly/on demand, separate from fast PR gates. Produce HTML/JSON reports
keyed by archive hash, compiler version, mode, stage, and capability rather than
one misleading overall compatibility percentage.

## Decisions and knock-on risks

| Risk/decision | Proposed approach | Resolution gate |
| --- | --- | --- |
| Parser omissions versus invalid authoring | Minimize reproductions and classify before dependency changes; retain archive/mode/node diagnostics. | Phases 0–1. |
| Identical make/model across revisions | Content identity, explicit revision selection, pinned patched definitions. | Phase 1 contract; phase 6 save/load/UI. |
| Authoritative expected behavior | Matching manuals and checked XML; Vis Only archives are not authoritative physical profiles. Equal channel counts do not establish equivalent modes. | Phase 0 oracle records, extended per capability. |
| Color accuracy | Prefer supplied colorimetry, reuse conversion libraries, document RGB approximation/gamut limits; no spectral renderer initially. | Phase 4 reference colors. |
| Vendor macros/complex optics | Preserve DMX controls and explicitly classify approximate/unsupported visualization with follow-up issues. | Phase 5 acceptance. |
| Ambiguous functions or relation cycles | Diagnose/reject unsupported interpretations; separate geometry parenting from control relationships. | Phases 1–2 negative tests. |
| Motion versus fades | Explicit physical interpretation and smoothing policy with deterministic time. | Phase 3 numerical tests. |
| Resource ownership/invalidation | Content/version keys, immutable sharing, per-instance state, disposal and late-load guards. | Phases 3/6 lifecycle and phase 7 soak. |
| Changed schema/programmed indices | Explicit rejection/repatching, atomic replacement and undo; no silent retargeting. | Phase 6. |
| Test asset availability | Record provenance/redistribution terms; provision private CI assets if public redistribution is unavailable; hash-check and fail missing required assets. | Phase 0. |

## References

- [Fixture selection, exact revisions, and articulation scenarios](gdtf-test-bench.md)
- [GDTF file format: geometry, references, DMX functions, relations, and resources](https://gdtf-development.com/help/developers/gdtf_1_2/file-format-definition/index.html)

Detailed Rust/TypeScript field names should be settled in phase 1 with executable
contract tests; the contracts above describe required information rather than a
frozen schema. Use existing parser, Bevy, Three.js, showfile, typeshare, and test
facilities before introducing dependencies.
