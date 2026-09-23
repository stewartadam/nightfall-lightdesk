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
