# Pinned GDTF corpus

`manifest.json` pins 18 archives, containing 632 authored modes, selected in the
[test bench](../../../../../docs/src/developer-reference/gdtf-test-bench.md).
The inventory is read directly from XML and is **not a passing Nightfall baseline**.
Counts include template definitions and inactive roots; they are not resolved
emitter counts. Exact mode names retain whitespace.

Archives are privately provisioned because redistribution permission has not
been established. Do not commit the downloaded archives. Provision from a local
copy of the collection (or a private CI asset download):

```sh
python3 scripts/gdtf-corpus.py --source ~/tmp
```

The tool checks basename, byte size, and SHA-256, then copies matching archives
to the ignored `test-results/gdtf/assets/<sha256>.gdtf` directory. It validates
every required input in a separate time-limited process and writes a JSON report
to `test-results/gdtf/inventory.json`. To recheck already provisioned inputs:

```sh
python3 scripts/gdtf-corpus.py
python3 -m unittest discover -s scripts -p 'gdtf_corpus_test.py'
```

Use `--asset-dir`, `--manifest`, `--report`, and `--timeout` for CI or a separate
test corpus. Missing or changed inputs fail with a nonzero exit status. Archive,
XML, identity, inventory, and timeout failures are reported separately.

To measure the real Rust importer, build `gdtf_probe` with Cargo and pass the
resulting executable path explicitly (use the configured target directory):

```sh
cargo build -p nightfall-fixture-library --example gdtf_probe
python3 scripts/gdtf-corpus.py --probe /path/to/debug/examples/gdtf_probe
```

Each archive's actual parse/conversion results are flushed to a separate JSONL
file under `<report-stem>/probes/` beside the report. Reports with different names
therefore retain separate probe artifacts. Timeouts and process failures retain
completed results and fail the run. `--probe-timeout` bounds each archive, while
`--fixture sharpy --fixture hydrabeam` can select a smaller investigation. Probe
output normalizes generated fixture UUIDs and removes local archive paths. A
successful conversion still does not prove semantic or visual correctness.

With `--probe`, the runner also checks `expectations.json`: independently checked
selected-mode root/emitter counts and joint bindings for the initial six fixtures.
Unmet targets produce a nonzero exit status and list the responsible implementation
issue. These targets intentionally expose current importer gaps; they are not
snapshots of its existing output. A passing structural case does not establish
correct movement, color, or DMX bytes. The JSON report keeps inventory, conversion,
and geometry acceptance results separate.

The probe also runs the pure mode resolver as a separate `resolution` stage.
`resolution_acceptance` checks the same selected roots, emitter counts, and joint
targets against its expanded hierarchy. These results are separate from the
production converter's `geometry_acceptance`: resolver success does not imply
that production rendering or DMX output uses the resolved definition yet.
The resolver retains channel functions and reference scopes for later passes.
The separate `wire` stage calculates exact one-based slots within independently
patched breaks, preserving byte significance, gaps, virtual channels, and nested
reference offsets. `wire_acceptance` compares every channel in the initial six
modes against the independently checked count/stride tables in `expectations.json`.
Shared logical functions occupy their physical channel only once. Fixed breaks
use their first matching reference entry; Overwrite uses the final entry, which
may target that same break at a different offset (covered by Spiider and synthetic
tests). These checks do not prove engine encoding/decoding or effective light.
The wire contracts live in `nightfall-dmx`, without a GDTF parser dependency.
`ChannelWire::read_raw` and `write_raw` provide allocation-free successful byte
I/O against a caller-selected, fixture-relative break buffer. Synthetic tests
check independent sparse byte vectors at all four widths, exact 32-bit values,
unchanged gaps, and rejected writes leaving the entire buffer unchanged. Virtual
controls have no `ChannelWire`. These primitives do not yet perform engine
patching, whole-frame transactions, physical conversion, or relation evaluation.
Rust/JSON round-trip coverage preserves null virtual channels and numeric break
keys. Explicit TypeScript annotations retain those null entries and describe
footprints as a JSON object instead of exposing a Rust collection name.

The fixture runtime's resolved output destinations now carry ordered byte
addresses rather than a single contiguous base address. The production universe
writer preserves sparse/reversed byte order and rejects invalid destinations
before modifying either console or transport buffers. Manual DMX assertions and
release use those same addresses, excluding gaps. Existing bindings explicitly
expand contiguous parameter widths. Transport input targets likewise carry
ordered source-relative byte offsets. Accepted-frame routing validates the whole
mapping before decoding; invalid targets do not claim precedence over a later
valid binding. Input contribution traces validate the same mapping and report
its most significant address. Synthetic plugin tests exercise all four widths,
reversed significance, gaps, boundaries and invalid-binding precedence. This does
not yet connect compiled GDTF breaks to patch bindings.

The shared `ModeWires::patch` operation resolves every physical break through an
explicit universe/start-address map. It preserves channel order and virtual
entries, checks declared footprints, and rejects missing/stale break mappings,
overlapping bytes and addresses beyond 512 without rolling into another universe.
Its immutable result supports whole-mode raw input/output; output validates all
values and required universe buffers before touching any byte. Synthetic
compiler integration checks both nested tilt joints and referenced RGB pixels
against complete independently authored universe buffers. The production fixture
binding producer still needs to consume this patch contract; transport numbering
and cross-fixture overlap policy belong to that integration.

Compiled channels also construct shared, validated raw-state rules from their
normalized defaults, optional highlight values, precision and physical/virtual
status. Each instance owns its integer values and shares only the immutable
rules. Batched updates and decoded input validate before mutation; missing input
preserves existing values, and wire input cannot target a virtual channel.
Highlight produces a temporary snapshot without overwriting programming. An
explicit reset restores defaults; this is not compositor release behavior.
Compiler integration tests exercise this state with the patched nested fixture.
Compositor ownership, function/relation evaluation and production instance
creation still need to adopt these shared contracts together.

The live mesh HTTP route now accepts only paths in the current installed/package
GDTF index. It shares the archive snapshot/index budgets used by compilation,
bounds actual resource reads, and performs extraction in blocking workers with
at most two concurrent extractions. Missing/empty GLB permits 3DS fallback;
corrupt or oversized resources fail explicitly. Geometry records the SHA-256 of
the exact snapshot parsed, its indexed path and selected mode. Mesh URLs include
that revision; extraction verifies the hash and reads resources from the same
snapshot. Replacing a file at its original path makes an old revision request
fail with HTTP 409 rather than return different bytes. Successful responses use
private immutable caching; errors use no-store. The frontend shares mesh loads
by archive hash and model, and encodes source paths as UTF-8.

Route tests cover index refresh/removal, unindexed paths, resource naming,
limits, corruption, fallback, replacement and headers. A browser test exercises
the production mesh loader with two owned synthetic GLB responses, checks request
counts and decoded dimensions, and renders both revisions for inspection. This
does not establish native archive-to-stage parity or resolve WebGPU rendering
issues. Cached archive and bundled models share geometry with explicit ownership
references and clone mutable materials per instance. Removing an instance releases
its materials without disposing geometry still used by another instance or the
cache. Late loads release their instance resources instead of attaching to removed
fixtures. Node tests check final-owner disposal and repeated removal; the browser
test checks independent materials and removal during a shared pending request.
Archive and bundled templates share an LRU cache capped at 64 ready templates
and 64 MiB of geometry backing buffers. Shared buffers inside a template count
once; this accounting excludes JavaScript objects, textures and GPU overhead.
Eviction releases the template's ownership while live copies retain their
geometry. Oversized models serve current waiters without remaining cached.
Pending requests coalesce, including failures; retries require a later request.
These are retention limits, not limits on pending decode work or live scenes.
Retaining old archives across library revisions and save/reload, external GLB
reference restrictions, bounded decode work, and lifecycle memory/GPU budgets
remain part of resource/renderer integration.

Logical parameter values and percentages use double precision; byte assembly
and encoding retain `u32`. A pipeline regression checks 266 raw values, including
adjacent values above the single-precision integer limit, through transport
input, percentage assertions, compositing and sparse console/transport output.
JSON and inversion tests cover the same precision boundary. Physical mappings
and nonlinear color/effect processing have their own numerical tolerances; these
tests do not establish lossless inverse mappings for every physical range.
The FX-module value/range contract uses `f64` in WIT version 0.2.0 and requires
guest rebuilding. Logical scalar storage grows from four to eight bytes; overall
memory and frame-time impact must be measured with the performance bench.

The `compiled_channels` stage builds one owned channel program using the wire,
function, selector, physical and relation passes, then evaluates every active
function at the initial raw snapshot. It retains channel/geometry identities,
resolved attribute indices, defaults/highlight and function intervals without borrowing the
parsed archive. Tests drop the source before evaluating sparse DMX inputs and
local selectors, and verify overlapping logical functions remain separately
observable. Returned physical values are not relation-adjusted semantic fractions.
Its owned attribute table retains exact names, display labels, physical units
and auxiliary unit declarations. Function links must resolve exactly; missing
or duplicate names, duplicate auxiliary types and nonfinite auxiliary ranges are
diagnosed, with explicit table-size budgets. Synthetic tests check that declared
units survive even when they differ from what a name might suggest.
The owned physical mappings also expand inherited auxiliary ranges and bind
function-specific `SubChannelSet` overrides, retaining their names and units.
Auxiliary evaluation uses the parent function's raw interval and its own optional
profile from the shared profile library; it does not reuse the main physical
value or restart at a channel-set boundary. Duplicate overrides, unresolved links,
nonfinite ranges and excessive expanded mappings fail compilation. The corpus
has 98 `SubPhysicalUnit` declarations but no `SubChannelSet` overrides, so explicit
overrides and curves are verified with synthetic numerical tests. These values
are available to consumers but are not yet used for rendering strobe/gobo behavior.
This is the channel portion of the planned definition; attribute grouping/color
and optical metadata, geometry/resources, revision persistence and engine adoption
are still required. Serialization here is diagnostic output, not a finalized
showfile or worker contract.

The `compiled_mode` stage exercises the single owned mode compiler. It resolves
one hierarchy and builds geometry and channel programs with coherent indices.
Geometry retains structural IDs, reference labels, parent/child order, numeric
row-major rest matrices in GDTF coordinates/metres, effective model indices,
explicit channel-to-joint bindings and per-beam optical declarations. It checks
model identity/dimensions and finite optical values. Resource stems and spectrum
links remain declarations; this stage does not prove resource availability or
rendering. Non-beam geometry categories remain distinguishable, but specialized
media/laser/wiring behavior is not simulated. Synthetic tests verify source
disposal, nested joints, reference model overrides, separate beams and asymmetric
rest matrices. Archive identity/versioning, resolved resources, worker/showfile
contracts and engine/renderer adoption still surround this owned mode contract.

The `definition` stage loads a bounded immutable archive snapshot, hashes all
its bytes with SHA-256, parses its bounded XML once with the existing GDTF parser,
and compiles modes against those same bytes. Definition keys include the hash,
exact mode, compiler version and schema version; the corpus runner independently
checks each successful key against the input hash/mode and valid version fields.
Tests replace a library file after snapshot capture, change only a resource,
distinguish modes with significant whitespace, and exercise byte/entry/XML
limits. Compiled definitions retain shared source bytes for later asset loading.
This is not yet the library manager's production path, persisted show format,
resource service or bounded compiled cache. ZIP size/count checks currently cover
the entries exposed by the dependency's index: identical raw ZIP filenames are
collapsed upstream and cannot yet be rejected (`nightfall-lightdesk-oaa.2.4`).
Full XML-depth/parser-work bounds also remain necessary; a byte cap alone does
not prove a parse-time bound.

`DefinitionCache` reuses immutable definitions by the complete content/mode/version
key and evicts least-recently-used entries under count and admission-weight
limits. Compilation budgets are fixed for a cache's lifetime. Admission weight
is archive bytes plus serialized contract bytes (counted without creating a
second serialized buffer); shared archive bytes are charged for every cached
mode. This is not an allocator/GPU memory measurement and needs calibration in
the performance phase. Oversized definitions remain usable but are returned
uncached without evicting the working set. Active fixture handles survive both
eviction and clearing. Synthetic tests cover reuse across separate parses,
resource revisions, exact weight boundaries, recency, failed requests and handle
lifetimes. Library-manager adoption and async loading remain pending.

The `functions` stage normalizes integer defaults/highlight and inclusive raw
ranges through 32 bits. Mutually exclusive logical channels and ModeMaster
conditions retain separate ranges. Selector source links and their ranges are
validated at the master's resolution. Complete source functions remain available for
profiles, channel sets, relations and resource compilation. Mirroring and shifting
operate on the parsed literal bytes with independent hexadecimal test vectors.

The `bindings` stage connects ModeMaster selectors to instantiated channels and
functions. Repeated pixels use masters in their own reference scope; shared
masters resolve in the nearest enclosing scope. An explicit source channel with
only one instance remains an unambiguous target. Ambiguous repeated targets fail
instead of selecting the first instance. Synthetic tests cover local, shared,
and nested repeated assemblies.

The `relations` stage binds each declared follower function instance to its local
or shared master using those same reference scopes. Multiply and Override remain
distinct, as do physical and virtual channels. Repeated identical edges and
ambiguous links are diagnosed, and expansion has an explicit relation budget.
Dependency planning validates indices and computes a deterministic master-first
order without recursion. Channel dependency cycles fail explicitly, including
cycles that would require conditional analysis to establish a safe order.

The normalized relation evaluator takes original semantic fractions and active
function indices. It produces two independent snapshots: virtual-master effects
for output conversion, and all declared effects for visualization. Neither pass
uses the other pass's results. Synthetic tests cover chains, independent pixels,
inactive functions, physical/virtual masters, sole Override, and competing
overrides. Multiple active follower functions on a shared channel are diagnosed
instead of silently merged. All 7,072 bound corpus relations are Multiply with
virtual masters (136 target virtual followers); physical masters and Override
therefore rely on synthetic coverage. Corpus reports check dependency planning,
not semantic snapshot evaluation. Conversion between raw/function physical values
and the evaluator's semantic fractions, output quantization, and engine integration
are still required.

The `sets` stage normalizes channel-set boundaries at the channel's full raw
precision and rejects non-increasing or out-of-function ranges. It retains
labels, explicit physical overrides, parent endpoints, and zero-based wheel
slots without converting the parser's slot index twice. Unlabeled values before
the first set remain unlabeled. A total expanded-set budget bounds this pass.
Synthetic tests check sparse boundaries, inherited versus explicit values,
descending endpoints, slot indices and malformed sets. Resolving a slot index
does not yet validate its linked wheel or render it.

An XML inventory of the 18 pinned archives contains 32,160 authored ChannelSet
nodes, but no DMXProfile or SubChannelSet nodes and no nonempty DMXProfile links.
Those capabilities therefore require independent synthetic coverage; a green
real-archive sweep cannot establish profile or sub-channel-unit support.

`gdtf_profile_tests` covers the owned piecewise cubic profile compiler separately.
XML breakpoint percentages are fractions (0–1), while coefficients produce
percentage output; tests reproduce the [builder's S-curve example](https://gdtf-development.com/help/users/gdtf_builder/physical_descriptions/index.html)
at five independent sample points. Profiles retain discontinuities and
non-monotonic output, select the new polynomial exactly at a breakpoint, and
return zero before the first point. Invalid links, duplicate names/points,
nonfinite values, overflow and point budgets are diagnosed. Raw interval tests
retain distinct 32-bit values.

The `physical` stage compiles mappings and evaluates both raw endpoints of every
function and channel set. Linear mappings preserve descending ranges and
quantize inverse requests to the nearest raw integer through 32 bits. Profiles
scale percentage output into function Min/Max (defaulting to PhysicalFrom/To).
Constant linear ranges report an ambiguous inverse, and profiles report an
unavailable inverse rather than guessing. Synthetic physical tests cover those
cases independently. Sets with no physical overrides preserve the parent mapping,
including curves. Explicit overrides interpolate across the set's own range;
an omitted endpoint uses the corresponding parent endpoint. A one-slot set uses
its starting physical value. Combining explicit set overrides with a function
profile currently reports `profile_set_composition_unavailable` pending verified
composition semantics. This stage does not select active functions, apply
relations, map sub-channel units, or run in the engine yet.
Linear inverse requests search the effective set ranges and any unlabeled prefix.
A unique range can be encoded; overlapping ranges and unselected constant ranges
report an ambiguous inverse. Explicit set selection restricts encoding to that
set, with its first raw value chosen for a constant range. Values in physical gaps
are rejected. Synthetic tests verify reversed ranges, overlaps, constant choices,
and four-byte round trips. Profile inversion remains a separate unsupported path.

The `activation` stage compiles a bounded dependency order and evaluates each
mode's raw defaults. Function links require the target function to be active;
channel links use only the master's raw value. Cyclic function dependencies fail
explicitly. Evaluation retains all eligible logical functions, including
NoFeature ranges, instead of choosing a single arbitrary winner. Synthetic tests
cover inclusive boundaries, local independence, cascades, invalid snapshots,
32-bit endpoints, and a 20,000-function chain. These checks establish eligibility,
not physical conversion, automatic selector writes, fade behavior, or engine
integration. See the [GDTF mode dependency guidance](https://gdtf-share.com/help/users/gdtf_howto/handle_mode_dependencies/index.html).

`function_acceptance` checks selected Sharpy, MAC Aura and Hydrabeam defaults and
physical endpoints against authored XML. Descending ranges must remain descending.
Hydrabeam's sampled axes declare 0..1, which is retained without claiming accurate
mechanical limits. Neither successful normalization nor these samples establish
complete function evaluation or operator behavior.

The pinned parser mishandles dotted `Universe.Address` reference offsets; this is
tracked as `nightfall-lightdesk-oaa.2.2` and must be fixed before claiming complete
address compatibility. All 18 curated archives use decimal reference offsets.

The initial resolver sweep identified three unreachable channel links in the
pinned sources (tracked by `nightfall-lightdesk-oaa.2.1`): Titan Tube's
`16: Effect Mode RGB` and `49: RGB*RGBS`, and primary Pixel Line IP's `39 Channel`.
Each targets geometry outside its selected mode hierarchy. These are explicit
failures; the resolver does not silently substitute another mode's geometry.

The manifest's provenance records the downloaded collection, not a verified
manufacturer endorsement or permission to redistribute it. Matching manuals,
resolved-mode expectations, and real Rust import/conversion outcomes are distinct
acceptance evidence and must not be inferred from this inventory.

## Synthetic source

The owned compiler also records control groups and reverse channel ownership.
The initial grouping policy collects channels targeting the same instantiated
geometry, orders groups by first authored channel occurrence, and excludes parts
without controls. Labels do not determine identity or numbering. All matching
attribute functions remain candidates; lookup does not silently select a winner.
The probe includes these groups in `compiled_mode` output and their count in
`definition` output. Compiler/schema version 2 distinguishes this contract.

Synthetic control tests verify separate nested Tilt targets, referenced pixel
ownership, label changes, source ordering, and multiple functions on one channel.
This is an intermediate compiler representation: merging conventional pan/tilt
into useful head groups, whole-fixture master selection, active-function command
resolution, and production CLI/engine integration remain required. It does not
establish final operator numbering for newly patched real fixtures.

`nested-sparse.xml` is a repository-owned, resource-free parser/compiler input.
Its parser test establishes that the dependency preserves the required inputs;
it does not assert that Nightfall already resolves them correctly.

The selected root is Base. Arm and its child Head have independent Tilt channels
at significant-byte offsets `[1, 4]` and `[2, 5]` on break 1. Head has an authored
one-metre Z translation. Its two references instantiate Pixel at separate local
positions. RGB offsets `[1]`, `[2]`, `[3]` use Overwrite and become break 2
addresses 10–12 and 20–22 respectively. Each instance also has a virtual Dimmer,
which must consume no address. Neither the Pixel template nor Unused should be a
second scene root. These values provide independent compiler/wire expectations
and an asymmetric nested-joint transform case for subsequent acceptance tests.
