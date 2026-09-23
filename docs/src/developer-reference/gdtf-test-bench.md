# GDTF compatibility and rendering test bench

This document records the selected fixtures and intended regression coverage for
improving GDTF import, control binding, and visualization. The bench contains
**17 fixture models and 18 archives**, including two authoring variants of ACME
Pixel Line IP. Selection is agreed; the archives have not yet been packaged as
test assets, and the regression suite described here is not implemented.

The selection combines recognizable production fixtures with fixtures whose
geometry, controls, or authoring exercise distinct capabilities. A fixture's
inclusion does not imply that Nightfall currently supports all of its features.

## Selection rationale

The **initial** group is the first six-fixture implementation bench. All other
fixtures remain part of the selected full bench. Parse and convert every mode;
choose representative modes for the more expensive visual tests.

| ID | Fixture | Group | Why we selected it | Representative coverage |
| --- | --- | --- | --- | --- |
| sharpy | Clay Paky Sharpy | Initial | A simple moving-beam baseline with GLB models and a single emitter. | Nested pan/tilt, body scale and pivots, color wheel, gobo, prism; Standard and Vector modes. |
| mac-viper | Martin MAC Viper Profile | Full | A profile fixture with subtractive color mixing, multiple gobo wheels, and legacy 3DS models. | CMY, iris, wheel selection, optical controls, and Basic versus Extended modes. |
| mac-aura | Martin MAC Aura | Initial | Separate beam and aura controls in one body; the archive mixes Wash and None beam types. | Main/aura isolation, master intensity, glow versus projected light, Standard versus Extended modes. |
| spiider | Robe Robin Spiider | Full | Repeated geometry and several ways to control the same moving wash. | Zone and pixel personalities, shared controls, RGB/RGBW, zoom, and flower effect. |
| titan-tube | Astera FP1 Titan Tube | Initial | Many personalities and geometry roots for a familiar segmented tube. | Single versus multipixel modes, reference expansion, virtual controls, RGB/white/amber, and alternate color spaces. |
| x4-bar | GLP impression X4 Bar 20 | Full | A tilt-only bar with pixel grouping and different root geometries for different modes. | Mode-root selection, grouped versus individual pixels, 8/16-bit modes, and 3DS assets. |
| magicpanel | Ayrton MagicPanel FX | Initial | A clear instancing case: one LED definition is referenced 25 times. | Reference transforms and DMX offsets, unique instance identity, pan/tilt, and pixel independence. |
| lustr | ETC Source Four Series 3 Lustr X8, 26° | Full | A static profile with emitter colors beyond RGBW. | Direct emitter control, deep red/indigo/lime/amber attributes, RGB and HSIC personalities, and fixed optics. |
| skypanel | ARRI SkyPanel S60-C | Full | A GDTF 1.1 archive with varied color-control personalities. | CCT, HSI and XY, 8/16-bit channels, and mode-specific geometry. |
| jdc1 | GLP JDC1 | Full | Independent white/RGB emitters and strobe controls in an articulated fixture. | Emitter grouping, tilt, shutter phase, and pixel modes. The selected archive is explicitly Vis Only; it is not an authoritative DMX reference. |
| rainbow | Quasar Science Rainbow R2 8ft | Full | A large mode/reference stress case: 340 modes and 992 references across the archive. | Mode selection, expansion cost, caching, and segmented color control. The reference count is not the active pixel count for a mode. |
| snow-machine | Antari S-500 Snow Machine | Full | A non-lighting fixture with geometry and controls but no beam definitions. | Import and body rendering without inventing emitters; preserve snow/blower controls. |
| pixel-line | ACME Pixel Line IP | Initial | A production-relevant LED bar with extensive pixel personalities and two substantially different local authoring variants. | Separate emitter controls, pixel grouping, root selection, and 7-, 39-, 112-, and 117-channel modes in Release-05. No movement axes are defined in the selected archives. |
| hydrabeam | Cameo Hydrabeam 400 | Initial | Four independently controlled heads, each with its own pan/tilt chain. The local archive contains eight axes. | Independent and simultaneous movement, sibling isolation, parent/child transforms, and four beam directions in the available 19 CH mode. |
| volero | Clay Paky Volero Wave | Full | Eight independently tilting bodies, each carrying an emitter. | Per-head tilt, pivot placement, referenced emitter attachment, and isolation between neighboring heads. |
| pxl-curve | CHAUVET COLORado PXL Curve 12 | Full | Twelve independently controlled heads; the archive also includes a master axis and split movement/LED personalities. | Per-head tilt, zoom and color, shared versus local controls, and split-personality interpretation. |
| magicblade | Ayrton MagicBlade FX | Full | Nested pan/tilt with seven referenced emitters and explicit PanRotate/TiltRotate controls. | Hierarchical transforms, continuous rotation, wraparound, and emitter orientation during combined movement. |

The local Color Strike M archive is not selected for pixel coverage: the inspected
revision has only one mode and two beam definitions. The hardware's more extensive
pixel controls do not make that particular file a strong pixel test input.

## Selected archive revisions

These exact basenames were inspected in the December 30, 2025 collection under
`~/tmp/GDTF_fixtures_12_30_2025_11-_part_*`. That location is discovery provenance,
not a runtime dependency for tests. Names and revision comments identify the
candidate inputs; they do not establish manufacturer approval or correctness.

| ID | Archive basename |
| --- | --- |
| sharpy | `Clay_Paky@Sharpy@ClayPaky_Official_File_Fw_Ver_2_25_006.gdtf` |
| mac-viper | `Martin_Professional@MAC_Viper_Profile@20230516NoMeas.gdtf` |
| mac-aura | `Martin_Professional@MAC_Aura@20230201NoMeas.gdtf` |
| spiider | `Robe_Lighting@Robin_Spiider@2025-12-03__Reupload_to_share.gdtf` |
| titan-tube | `Astera_LED_Technology@FP1_Titan_Tube@tested_by_Astera__V3.gdtf` |
| x4-bar | `GLP@impression_X4_Bar_20@Final._Based_of_X4_Bar_10.gdtf` |
| magicpanel | `Ayrton@MagicPanel_FX@V2.62_Corrected_PanTilt_Rotate.gdtf` |
| lustr | `ETC@S4_Series_3_Lustr_X8_26Deg@v1.3.0.gdtf` |
| skypanel | `ARRI@SkyPanel_S60C@DMX_v4.4_13_Jan_2021.gdtf` |
| jdc1 | `GLP@JDC1_(Vis_Only)@Version_1.0.gdtf` |
| rainbow | `Quasar_Science@Rainbow_R2_8ft@1.0.2_-_Initial_Public_release.gdtf` |
| snow-machine | `Antari@S-500_Snow_Machine@Version_1.gdtf` |
| pixel-line (primary) | `ACME@Pixel_Line_IP@Release-05.gdtf` |
| pixel-line (alternate) | `ACME@PIXEL_LINE_IP_(STROBE_3_IP)@Rev_01.gdtf` |
| hydrabeam | `Cameo@Hydrabeam_400@1.0.0.3.gdtf` |
| volero | `Clay_Paky@Volero_Wave@Claypaky_Official_File_Fw_V.2.0.005.gdtf` |
| pxl-curve | `Chauvet_Professional@COLORado_PXL_Curve_12@White_Calib_Off_Fix.gdtf` |
| magicblade | `Ayrton@MagicBlade_FX@V2.6_Corrected_PT_Rotate.gdtf` |

Pixel Line IP Release-05 contains 11 modes, 16 root geometries, and 118 references.
The alternate Rev_01 archive contains 10 modes, seven roots, and 219 explicit beam
definitions without geometry references. These are whole-file counts, not expected
per-mode instance counts. Validate each revision against its own expectations;
only compare behavior across modes whose semantics have been checked to match.

Before admitting an archive to the automated suite, record its SHA-256, source,
revision, exact mode names (including significant whitespace), capability tags,
and independently checked expectations in a machine-readable manifest. Package
the inputs in a versioned test asset bundle with appropriate provenance and
redistribution permissions. Missing required assets must fail the curated suite
rather than silently skip tests. Do not load the developer's personal library.

## Multi-geometry and articulation requirements

Movement controls must bind to individual geometry instances, preserving their
parent/child hierarchy. A single fixture-wide pan/tilt pair cannot represent the
Hydrabeam or independently moving bars. Reference expansion must preserve unique
instance identities, local transforms, and DMX break/offset mappings.

Use numerical world-transform and beam-direction assertions alongside images:

| Scenario | Required result | Primary examples |
| --- | --- | --- |
| Independent movement | Moving one head leaves siblings and the base stationary. | Hydrabeam, Volero, PXL Curve |
| Nested movement | Pan carries the tilt assembly; tilt uses its own local pivot, including when both axes move. | Sharpy, Hydrabeam, MagicBlade |
| Emitter attachment | Beam origin and direction follow the owning head throughout movement. | Volero, MagicBlade, MagicPanel |
| Instance isolation | Two copies of a fixture can hold different poses without sharing mutable transforms. | Hydrabeam, MagicPanel |
| Mounting transforms | Poses remain correct after rotating or inverting the entire fixture placement. | Sharpy, Hydrabeam, MagicBlade |
| Continuous rotation | A controlled clock verifies direction, speed, stop behavior, and continuity across angle wraparound. | MagicBlade |
| Control isolation | Per-cell tilt, zoom, color, and intensity affect only their intended geometry, subject to declared master controls. | PXL Curve, Spiider, Pixel Line IP |

Include a small synthetic fixture with neutral axis names to ensure axis binding
comes from channel/geometry semantics rather than names such as Head or Yoke.
Additional synthetic cases should isolate nested references, repeated instance
names, reversed ranges, virtual channels, noncontiguous offsets, 32-bit channels,
and invalid references. Real archives supply integration coverage; synthetic
inputs make individual edge cases precise and easy to diagnose.

## Automated regression strategy

### Semantic checks on every pull request

Run Rust import/conversion tests over every mode of the curated archives. Assert
mode-root selection, expanded instance counts, hierarchy, transforms, emitter and
axis bindings, channel resolution, and resolved DMX addresses. Test missing or
unsupported resources explicitly, including intentional primitive fallbacks.

Build expected results from checked XML, the GDTF specification, and manufacturer
documentation matching the selected revision. Do not establish correctness by
snapshotting current converter output alone. Normalize generated UUIDs and local
absolute paths out of snapshots. Classify unsupported capabilities explicitly
and link them to Beads issues; previously passing behavior must remain passing.

### Deterministic rendering checks

Extend `webui/e2e/visualizer-render.spec.ts` and run through
`npm run test:webui-playwright -- <spec>` with an isolated native backend and the
curated asset bundle. The native path exercises real GDTF conversion and resource
serving. Follow the repository's macOS browser-launch permission requirements.

For representative modes, capture unlit bodies from fixed viewpoints, open white
beams, primary colors, dimmer zero/full, zoom endpoints, movement poses, and pixel
patterns. Exercise master versus local intensity and independent white/RGB/aura
groups. Add save/reload coverage for geometry materialization and control binding.

Wait explicitly for resource loading and frame completion. Fix camera, viewport,
render settings, animation time, and random seeds where used. Compare cropped
images with documented tolerances in a pinned browser/GPU environment; keep
baselines separate when rendering environments differ. Cover both main-thread
and worker rendering. Stop playback after tests that start it.

Assertions must also verify that expected meshes actually loaded: a fallback body
can look plausible while hiding an asset failure. Review initial images manually
before accepting them as baselines, and require review of subsequent updates.

### Full-collection compatibility and performance sweeps

Run the larger collection nightly or on demand, with per-file resource/time
limits and isolated failures. Report archive reading, XML/parser acceptance,
conversion, resource loading, and rendering support separately. Parsing success
does not establish correct control or visual behavior.

The initial inventory found 5,475 archives (about 4.95 GiB). Archive/XML inspection
completed for 5,426; 49 failed inspection, including CRC failures. Among the
inspected files, 1,051 use references and 1,279 have multiple roots. These counts
describe the downloaded corpus, not Nightfall's parser pass rate. Keep damaged
inputs in a separately classified robustness suite.

Use Rainbow R2 for mode/reference scaling and repeated fixture instances for
cache, load-time, frame-time, and memory measurements. Set performance budgets
after measuring a fixed runner; do not treat timing on arbitrary developer GPUs
as a stable correctness gate.

Publish an HTML report identifying archive hash, mode, failed stage, structural
differences, and expected/actual/diff images. Retain Playwright traces and
screenshots under `test-results/playwright/` for diagnosis.

## Implementation emphasis

Begin with the six initial fixtures to cover basic movement, mixed emitters,
reference expansion, mode-specific roots, multiple articulated heads, and pixel
bars together. Prioritize mode-root selection, reference expansion and DMX
offsets, and per-instance control binding before extending color and optical
effects. The full bench remains the target; implementation status and follow-up
work belong in Beads.

## References

- [GDTF 1.2 file format, geometry references, and DMX mappings](https://gdtf-development.com/help/developers/gdtf_1_2/file-format-definition/index.html)
- [ACME Pixel Line IP](https://en.acmelighting.com/item/PIXEL-LINE-IP)
- [Cameo Hydrabeam 400 RGBW](https://www.cameolight.com/en/solutions/dj-musicians/moving-lights/lighting-effects/2140/hydrabeam-400-rgbw)
- [Claypaky Volero Wave](https://www.claypaky.it/products/volero-wave/)
- [CHAUVET COLORado PXL Curve 12](https://chauvetprofessional.com/product/colorado-pxl-curve-12/)
- [CHAUVET Color Strike M hardware capabilities](https://chauvetprofessional.com/product/color-strike-m/)
- [GLP JDC1 user manual](https://glp.de/files/products/jdc1-product-data/GLP_JDC1_User_Manual_EN_Rev20240830-01.pdf)
