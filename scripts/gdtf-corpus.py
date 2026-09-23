#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Provision and inspect pinned GDTF test inputs independently of the Rust importer.

This XML reader is a test oracle/inventory tool, not a production GDTF converter.
Each archive runs in a separate process with a timeout. Real importer outcomes
belong in a separate stage so XML readability cannot imply Nightfall support.
"""

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "crates/fixture-library/tests/fixtures/gdtf/manifest.json"
DEFAULT_EXPECTATIONS = DEFAULT_MANIFEST.with_name("expectations.json")
MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
MAX_XML_BYTES = 64 * 1024 * 1024


def fingerprint(path):
    """Hash an archive in bounded chunks without holding its contents in memory."""
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_manifest(path):
    """Validate the pinned-input schema and reject duplicate or unsafe identities."""
    manifest = json.loads(path.read_text())
    if manifest.get("schema_version") != 1 or not manifest.get("fixtures"):
        raise ValueError("Expected schema_version 1 and a nonempty fixtures array")
    seen = set()
    for fixture in manifest["fixtures"]:
        identity = fixture["id"]
        name = fixture["filename"]
        digest = fixture["sha256"]
        if not identity or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789-" for c in identity):
            raise ValueError(f"Invalid fixture ID: {identity}")
        if identity in seen:
            raise ValueError(f"Duplicate fixture ID: {identity}")
        seen.add(identity)
        if Path(name).name != name or "/" in name or "\\" in name:
            raise ValueError(f"Archive filename must be a basename: {name}")
        if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            raise ValueError(f"Invalid SHA-256 for {identity}")
        if not 0 < fixture["size_bytes"] <= MAX_ARCHIVE_BYTES:
            raise ValueError(f"Invalid archive size for {identity}")
        modes = fixture["inventory"]["modes"]
        if not modes or any(not mode.get("name") for mode in modes):
            raise ValueError(f"Missing exact mode names for {identity}")
    return manifest


def xml_inventory(description):
    """Describe authored XML without pretending to resolve geometry or DMX semantics."""
    root = ET.fromstring(description)
    fixture = root.find("FixtureType")
    if fixture is None:
        raise ValueError("Missing FixtureType")
    geometry = fixture.find("Geometries")
    if geometry is None:
        raise ValueError("Missing Geometries")
    return {
        "data_version": root.get("DataVersion"),
        "manufacturer": fixture.get("Manufacturer"),
        "name": fixture.get("Name"),
        "modes": [
            {
                "name": mode.get("Name"),
                "geometry": mode.get("Geometry"),
                "channel_definitions": len(mode.findall("./DMXChannels/DMXChannel")),
            }
            for mode in fixture.findall("./DMXModes/DMXMode")
        ],
        "root_geometries": [node.get("Name") for node in geometry],
        "reference_definitions": len(list(geometry.iter("GeometryReference"))),
        "beam_definitions": len(list(geometry.iter("Beam"))),
        "axis_definitions": len(list(geometry.iter("Axis"))),
    }


def inspect_archive(path):
    """Classify archive integrity and XML faults separately, enforcing size limits."""
    stage = "archive"
    started = time.monotonic()
    try:
        if path.stat().st_size > MAX_ARCHIVE_BYTES:
            raise ValueError("Archive exceeds size limit")
        with zipfile.ZipFile(path) as archive:
            descriptions = [i for i in archive.infolist() if i.filename == "description.xml"]
            if len(descriptions) != 1:
                raise ValueError("Expected exactly one description.xml")
            if descriptions[0].file_size > MAX_XML_BYTES:
                raise ValueError("description.xml exceeds size limit")
            description = archive.read(descriptions[0])
        stage = "xml"
        # Entity expansion is not part of a GDTF description and is not needed here.
        if b"<!DOCTYPE" in description or b"<!ENTITY" in description:
            raise ValueError("XML document types and entity declarations are unsupported")
        inventory = xml_inventory(description)
        result = {"status": "passed", "stage": stage, "inventory": inventory}
    except (OSError, ValueError, RuntimeError, zipfile.BadZipFile, ET.ParseError) as error:
        result = {"status": "failed", "stage": stage, "error": str(error)}
    result["duration_ms"] = round((time.monotonic() - started) * 1000, 2)
    return result


def inspect_bounded(path, timeout):
    """Kill a slow inspection worker without blocking the remainder of the corpus."""
    try:
        process = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), "--inspect-one", str(path)],
            capture_output=True, text=True, timeout=timeout, check=False,
        )
        if process.returncode:
            return {"status": "failed", "stage": "worker", "error": process.stderr[-2000:]}
        return json.loads(process.stdout)
    except subprocess.TimeoutExpired:
        return {"status": "failed", "stage": "timeout", "error": f"Exceeded {timeout}s"}


def provision(fixtures, source, destination):
    """Copy exact pinned inputs into a private content-addressed directory."""
    candidates = {}
    for path in source.rglob("*.gdtf"):
        candidates.setdefault(path.name, []).append(path)
    destination.mkdir(parents=True, exist_ok=True)
    errors = {}
    for fixture in fixtures:
        target = destination / f"{fixture['sha256']}.gdtf"
        if target.exists() and fingerprint(target) == fixture["sha256"]:
            continue
        match = next((
            path for path in candidates.get(fixture["filename"], [])
            if path.stat().st_size == fixture["size_bytes"]
            and fingerprint(path) == fixture["sha256"]
        ), None)
        if match is None:
            errors[fixture["id"]] = "No source archive matches the pinned name, size, and SHA-256"
            continue
        shutil.copyfile(match, target)
    return errors


def verify_fixture(fixture, asset_dir, timeout):
    """Require the exact pinned input and compare its independent authored inventory."""
    path = asset_dir / f"{fixture['sha256']}.gdtf"
    result = {"id": fixture["id"], "sha256": fixture["sha256"]}
    try:
        if path.stat().st_size != fixture["size_bytes"] or fingerprint(path) != fixture["sha256"]:
            raise ValueError("Archive does not match pinned size/SHA-256")
    except (OSError, ValueError) as error:
        return {**result, "status": "failed", "stage": "identity", "error": str(error)}
    result.update(inspect_bounded(path, timeout))
    if result["status"] == "passed" and result["inventory"] != fixture["inventory"]:
        result.update(status="failed", stage="inventory", error="Authored inventory changed")
    return result


def run_probe(executable, archive, report, timeout, expected_modes):
    """Retain actual Rust stage results even when a later conversion crashes or times out."""
    report.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    terminal_error = None
    with report.open("w") as output:
        try:
            process = subprocess.run([str(executable), str(archive)], stdout=output,
                                     stderr=subprocess.PIPE, text=True, timeout=timeout, check=False)
            if process.returncode:
                terminal_error = f"Probe exited {process.returncode}: {process.stderr[-2000:]}"
        except subprocess.TimeoutExpired:
            terminal_error = f"Probe exceeded {timeout}s"
    stages = []
    with report.open() as stream:
        for line in stream:
            try:
                record = json.loads(line)
                stages.append({key: record[key] for key in
                               ("stage", "status", "mode", "error", "diagnostic", "duration_ms") if key in record})
            except json.JSONDecodeError:
                terminal_error = terminal_error or "Probe emitted an incomplete JSON record"
    if not stages:
        terminal_error = terminal_error or "Probe emitted no stage results"
    for stage in ("resolution", "wire", "functions", "conversion"):
        reported_modes = [s.get("mode") for s in stages if s.get("stage") == stage]
        if reported_modes != expected_modes:
            terminal_error = terminal_error or f"Probe did not report every expected mode in order for {stage}"
    if not any(s.get("stage") == "parse" and s.get("status") == "passed" for s in stages):
        terminal_error = terminal_error or "Probe did not report successful parsing"
    return {"status": "failed" if terminal_error or any(s.get("status") != "passed" for s in stages) else "passed",
            "duration_ms": round((time.monotonic() - started) * 1000, 2),
            "report": str(report), "stages": stages, "error": terminal_error}


def read_stage_records(report, stage, modes):
    """Stream one stage, retaining only requested modes and leaving missing records detectable."""
    modes = set(modes)
    records = {}
    if not modes:
        return records
    with report.open() as stream:
        for line in stream:
            try:
                record = json.loads(line)
                if record.get("stage") == stage and record.get("mode") in modes:
                    records[record["mode"]] = record
            except json.JSONDecodeError:
                continue
    return records


def check_resolution_expectations(report, cases):
    """Check selected-root expansion and explicit joint links separately from production output."""
    records = read_stage_records(report, "resolution", (case["mode"] for case in cases))
    results = []
    for case in cases:
        record = records.get(case["mode"], {})
        checks = [{"capability": "resolution_available", "expected": True,
                   "actual": record.get("status") == "passed",
                   "status": "passed" if record.get("status") == "passed" else "failed"}]
        for key in ("root_count", "beam_count"):
            checks.append({"capability": key, "expected": case[key], "actual": record.get(key),
                           "status": "passed" if record.get(key) == case[key] else "failed"})
        resolved = record.get("resolved", {})
        for name, axis in case["joints"].items():
            matches = [i for i, node in enumerate(resolved.get("geometries", [])) if node["name"] == name]
            axes = [j["axis"] for j in resolved.get("joints", []) if j["geometry"] in matches]
            checks.append({"capability": f"joint:{name}", "expected": [axis], "actual": axes,
                           "status": "passed" if len(matches) == 1 and axes == [axis] else "failed"})
        results.append({"mode": case["mode"], "issue": case["issue"], "checks": checks,
                        "status": "passed" if all(c["status"] == "passed" for c in checks) else "failed"})
    return results


def check_wire_expectations(report, cases):
    """Compare every selected channel slot against independently authored count/stride tables."""
    records = read_stage_records(report, "wire", (case["mode"] for case in cases if "wire" in case))
    results = []
    for case in cases:
        if "wire" not in case:
            continue
        record = records.get(case["mode"], {})
        expected = []
        for group in case["wire"]["groups"]:
            for instance in range(group["count"]):
                expected.append(None if group["offsets"] is None else {
                    "dmxBreak": group["dmx_break"],
                    "offsets": [offset + instance * group.get("stride", 0) for offset in group["offsets"]],
                })
        actual = record.get("wires", {})
        checks = [{"capability": "wire_available", "expected": True,
                   "actual": record.get("status") == "passed",
                   "status": "passed" if record.get("status") == "passed" else "failed"}]
        for key, target in (("channels", expected), ("footprints", case["wire"]["footprints"])):
            checks.append({"capability": key, "expected": target, "actual": actual.get(key),
                           "status": "passed" if actual.get(key) == target else "failed"})
        results.append({"mode": case["mode"], "issue": case["issue"], "checks": checks,
                        "status": "passed" if all(c["status"] == "passed" for c in checks) else "failed"})
    return results


def check_geometry_expectations(report, cases):
    """Compare independent initial-mode targets to probe output without blessing known gaps."""
    records = read_stage_records(report, "conversion", (case["mode"] for case in cases))
    results = []
    for case in cases:
        record = records.get(case["mode"], {})
        geometry = record.get("geometry") or {}
        nodes = geometry.get("nodes", [])
        beams = [node for node in nodes if node.get("geometryType") == "beam"]
        actual = {"root_count": len(geometry.get("roots", [])), "beam_count": len(beams),
                  "bound_beam_count": sum(bool(node.get("controlledElement")) for node in beams)}
        available = record.get("status") == "passed" and isinstance(record.get("geometry"), dict)
        checks = [{"capability": "conversion_available", "expected": True, "actual": available,
                   "status": "passed" if available else "failed"}]
        checks += [{"capability": key, "expected": case[key], "actual": actual[key],
                   "status": "passed" if actual[key] == case[key] else "failed"}
                  for key in actual]
        for name, axis in case["joints"].items():
            matches = [node.get("axis") for node in nodes if node.get("name") == name]
            checks.append({"capability": f"joint:{name}", "expected": [axis], "actual": matches,
                           "status": "passed" if matches == [axis] else "failed"})
        results.append({"mode": case["mode"], "issue": case["issue"], "checks": checks,
                        "status": "passed" if all(c["status"] == "passed" for c in checks) else "failed"})
    return results


def check_function_expectations(report, cases):
    """Verify selected authored defaults and signed physical endpoints independently of the importer."""
    cases = [case for case in cases if case.get("function_samples")]
    records = read_stage_records(report, "functions", (case["mode"] for case in cases))
    results = []
    for case in cases:
        record = records.get(case["mode"], {})
        channels = record.get("channels", [])
        checks = [{"capability": "functions_available", "expected": True,
                   "actual": record.get("status") == "passed",
                   "status": "passed" if record.get("status") == "passed" else "failed"}]
        for sample in case["function_samples"]:
            index = sample["channel_index"]
            expected = {key: value for key, value in sample.items() if key != "channel_index"}
            actual = None
            if index < len(channels):
                channel = channels[index]
                actual = {key: channel.get(key) for key in ("bytes", "default", "highlight", "initialFunction")}
                actual["ranges"] = [[f.get(key) for key in ("rawFrom", "rawTo", "physicalFrom", "physicalTo")]
                                    for f in channel.get("functions", [])]
            checks.append({"capability": f"channel:{index}", "expected": expected, "actual": actual,
                           "status": "passed" if actual == expected else "failed"})
        results.append({"mode": case["mode"], "issue": case["issue"], "checks": checks,
                        "status": "passed" if all(c["status"] == "passed" for c in checks) else "failed"})
    return results


def main():
    """Provide explicit provisioning/verification with a machine-readable stage report."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--source", type=Path, help="Optional directory to search for pinned archives")
    parser.add_argument("--asset-dir", type=Path, default=ROOT / "test-results/gdtf/assets")
    parser.add_argument("--report", type=Path, default=ROOT / "test-results/gdtf/inventory.json")
    parser.add_argument("--timeout", type=float, default=15)
    parser.add_argument("--probe", type=Path, help="Built Rust gdtf_probe executable; enables real conversion")
    parser.add_argument("--expectations", type=Path, default=DEFAULT_EXPECTATIONS)
    parser.add_argument("--probe-timeout", type=float, default=120)
    parser.add_argument("--fixture", action="append", help="Inspect only a manifest ID; repeat to select several")
    parser.add_argument("--inspect-one", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.timeout <= 0 or args.probe_timeout <= 0:
        parser.error("Timeouts must be positive")
    if args.probe and not args.probe.is_file():
        parser.error("--probe must identify a built executable")
    if args.inspect_one:
        print(json.dumps(inspect_archive(args.inspect_one)))
        return 0
    manifest = load_manifest(args.manifest)
    fixtures = manifest["fixtures"]
    if args.fixture:
        unknown = set(args.fixture) - {f["id"] for f in fixtures}
        if unknown:
            parser.error(f"Unknown fixture IDs: {sorted(unknown)}")
        fixtures = [f for f in fixtures if f["id"] in args.fixture]
    errors = provision(fixtures, args.source, args.asset_dir) if args.source else {}
    results = [verify_fixture(f, args.asset_dir, args.timeout) for f in fixtures]
    if args.probe:
        expectations = json.loads(args.expectations.read_text())["cases"]
        for result in results:
            if result["status"] != "passed":
                continue
            result["nightfall"] = run_probe(
                args.probe.resolve(), args.asset_dir / f"{result['sha256']}.gdtf",
                args.report.parent / args.report.stem / "probes" / f"{result['id']}.jsonl", args.probe_timeout,
                [mode["name"] for mode in result["inventory"]["modes"]])
            cases = [case for case in expectations if case["id"] == result["id"]]
            result["geometry_acceptance"] = check_geometry_expectations(
                Path(result["nightfall"]["report"]), cases)
            result["resolution_acceptance"] = check_resolution_expectations(
                Path(result["nightfall"]["report"]), cases)
            result["wire_acceptance"] = check_wire_expectations(
                Path(result["nightfall"]["report"]), cases)
            result["function_acceptance"] = check_function_expectations(
                Path(result["nightfall"]["report"]), cases)
    scope = ("archive identity, XML inventory, Rust resolution/wire/functions/conversion, and selected targets"
             if args.probe else "archive identity and XML inventory only")
    report = {"schema_version": 1, "scope": scope,
              "provision_errors": errors, "fixtures": results}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    passed = sum(r["status"] == "passed" for r in results)
    modes = sum(len(r.get("inventory", {}).get("modes", [])) for r in results)
    print(f"{passed}/{len(results)} pinned archives passed; {modes} modes inventoried. Report: {args.report}")
    for result in results:
        if result["status"] != "passed":
            print(f"{result['id']}: {result['stage']}: {result['error']}", file=sys.stderr)
        for kind in ("geometry_acceptance", "resolution_acceptance", "wire_acceptance", "function_acceptance"):
            for case in result.get(kind, []):
                if case["status"] != "passed":
                    print(f"{result['id']}: {kind} targets unmet in {case['mode']} ({case['issue']})", file=sys.stderr)
        for stage in result.get("nightfall", {}).get("stages", []):
            if stage["status"] != "passed":
                print(f"{result['id']}: {stage['stage']} failed in {stage.get('mode')}: {stage.get('error')}", file=sys.stderr)
    return int(bool(errors) or passed != len(results)
               or any(r.get("nightfall", {}).get("status") == "failed" for r in results)
               or any(c["status"] != "passed" for r in results
                      for kind in ("geometry_acceptance", "resolution_acceptance", "wire_acceptance", "function_acceptance")
                      for c in r.get(kind, [])))


if __name__ == "__main__":
    sys.exit(main())
