# SPDX-License-Identifier: MPL-2.0
"""Exercise independent corpus validation, including failures that must not skip."""

import copy
import importlib.util
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch
import subprocess

SPEC = importlib.util.spec_from_file_location("gdtf_corpus", Path(__file__).with_name("gdtf-corpus.py"))
CORPUS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CORPUS)
XML = b'''<GDTF DataVersion="1.2"><FixtureType Name="Test" Manufacturer="Nightfall">
<Geometries><Geometry Name="Base"><Axis Name="Joint"><Beam Name="Lens"/></Axis>
<GeometryReference Name="Pixel2" Geometry="Pixel"/></Geometry><Beam Name="Pixel"/></Geometries>
<DMXModes><DMXMode Name="Mode with trailing space " Geometry="Base"><DMXChannels>
<DMXChannel Geometry="Joint" Offset="1,4"/></DMXChannels></DMXMode></DMXModes>
</FixtureType></GDTF>'''


class CorpusTests(unittest.TestCase):
    """Test corpus isolation and failure classification using small synthetic archives."""

    def setUp(self):
        """Create a private archive and matching manifest entry for each test."""
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.path = self.root / "source.gdtf"
        with zipfile.ZipFile(self.path, "w") as archive:
            archive.writestr("description.xml", XML)
        self.entry = {"id": "test", "filename": self.path.name,
                      "sha256": CORPUS.fingerprint(self.path),
                      "size_bytes": self.path.stat().st_size,
                      "inventory": CORPUS.xml_inventory(XML)}

    def test_mode_names_and_template_counts_are_preserved(self):
        """Inventory preserves exact mode names and does not expand referenced templates."""
        result = CORPUS.inspect_archive(self.path)
        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["inventory"]["modes"][0]["name"], "Mode with trailing space ")
        self.assertEqual(result["inventory"]["reference_definitions"], 1)
        self.assertEqual(result["inventory"]["beam_definitions"], 2)

    def test_missing_archive_fails(self):
        """Missing required corpus assets fail instead of skipping or reporting success."""
        self.assertEqual(CORPUS.verify_fixture(self.entry, self.root, 5)["stage"], "identity")

    def test_provision_and_verify_exact_archive(self):
        """Provisioned private assets retain their hash and pass a separate worker inspection."""
        assets = self.root / "assets"
        self.assertEqual(CORPUS.provision([self.entry], self.root, assets), {})
        self.assertEqual(CORPUS.verify_fixture(self.entry, assets, 5)["status"], "passed")

    def test_wrong_revision_is_not_provisioned(self):
        """A matching product filename alone cannot substitute for a pinned archive revision."""
        entry = copy.deepcopy(self.entry)
        entry["sha256"] = "0" * 64
        self.assertIn("test", CORPUS.provision([entry], self.root, self.root / "assets"))

    def test_bad_zip_and_bad_xml_have_different_stages(self):
        """Archive faults are distinct from well-formed archives containing invalid XML."""
        self.path.write_bytes(b"not a zip")
        self.assertEqual(CORPUS.inspect_archive(self.path)["stage"], "archive")
        with zipfile.ZipFile(self.path, "w") as archive:
            archive.writestr("description.xml", b"<broken")
        self.assertEqual(CORPUS.inspect_archive(self.path)["stage"], "xml")

    def test_xml_limit_is_checked_before_decompression(self):
        """An advertised oversized description is rejected before parsing its contents."""
        with patch.object(CORPUS, "MAX_XML_BYTES", 1):
            result = CORPUS.inspect_archive(self.path)
        self.assertEqual(result["status"], "failed")
        self.assertIn("size limit", result["error"])

    def test_worker_timeout_is_a_failure(self):
        """A timed-out inspector cannot count as a passing or silently skipped archive."""
        with patch.object(CORPUS.subprocess, "run", side_effect=subprocess.TimeoutExpired("worker", 1)):
            result = CORPUS.inspect_bounded(self.path, 1)
        self.assertEqual(result["stage"], "timeout")
        self.assertEqual(result["status"], "failed")

    def test_probe_requires_all_modes_even_after_successful_exit(self):
        """A partial report with a zero exit status cannot bless missing mode conversions."""
        def incomplete_run(*args, **kwargs):
            """Simulate a probe that parses but forgets to convert its declared modes."""
            kwargs["stdout"].write('{"stage":"parse","status":"passed"}\n')
            return subprocess.CompletedProcess(args, 0, stderr="")

        with patch.object(CORPUS.subprocess, "run", side_effect=incomplete_run):
            result = CORPUS.run_probe(Path("probe"), self.path, self.root / "probe.jsonl", 1, ["Mode"])
        self.assertEqual(result["status"], "failed")
        self.assertIn("every expected mode", result["error"])

    def test_probe_timeout_preserves_completed_stages(self):
        """A timed-out later conversion retains earlier measurements for diagnosis."""
        def timed_out_run(*args, **kwargs):
            """Write a completed parse stage before simulating the worker timeout."""
            kwargs["stdout"].write('{"stage":"parse","status":"passed"}\n')
            raise subprocess.TimeoutExpired("probe", 1)

        with patch.object(CORPUS.subprocess, "run", side_effect=timed_out_run):
            result = CORPUS.run_probe(Path("probe"), self.path, self.root / "probe.jsonl", 1, ["Mode"])
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["stages"][0]["stage"], "parse")
        self.assertIn("exceeded", result["error"])

    def test_geometry_counts_do_not_hide_missing_joint_bindings(self):
        """Matching emitter counts cannot pass when a named moving part has no axis binding."""
        report = self.root / "geometry.jsonl"
        record = {"stage": "conversion", "status": "passed", "mode": "Mode",
                  "geometry": {"roots": [0], "nodes": [
                      {"name": "Arm", "geometryType": "axis", "axis": None},
                      {"name": "Lens", "geometryType": "beam", "controlledElement": "Pixel"}]}}
        case = {"mode": "Mode", "root_count": 1, "beam_count": 1, "bound_beam_count": 1,
                "joints": {"Arm": "tilt"}, "issue": "test"}
        report.write_text(json.dumps(record) + "\n")
        result = CORPUS.check_geometry_expectations(report, [case])[0]
        self.assertEqual(result["status"], "failed")
        self.assertEqual([c["capability"] for c in result["checks"] if c["status"] == "failed"],
                         ["joint:Arm"])
        record["geometry"]["nodes"][0]["axis"] = "tilt"
        report.write_text(json.dumps(record) + "\n")
        self.assertEqual(CORPUS.check_geometry_expectations(report, [case])[0]["status"], "passed")

    def test_missing_conversion_cannot_pass_empty_geometry_targets(self):
        """Zero expected emitters still require a successful conversion and a geometry report."""
        report = self.root / "geometry.jsonl"
        report.write_text("")
        case = {"mode": "Missing", "root_count": 0, "beam_count": 0,
                "bound_beam_count": 0, "joints": {}, "issue": "test"}
        self.assertEqual(CORPUS.check_geometry_expectations(report, [case])[0]["status"], "failed")

    def test_resolution_checks_joint_targets_in_addition_to_counts(self):
        """Two joints with the same attribute must bind their respective geometry instances."""
        report = self.root / "resolved.jsonl"
        record = {"stage": "resolution", "status": "passed", "mode": "Mode",
                  "root_count": 1, "beam_count": 0,
                  "resolved": {"geometries": [{"name": "Arm"}, {"name": "Head"}],
                               "joints": [{"geometry": 0, "axis": "tilt"},
                                          {"geometry": 1, "axis": "tilt"}]}}
        case = {"mode": "Mode", "root_count": 1, "beam_count": 0,
                "joints": {"Arm": "tilt", "Head": "tilt"}, "issue": "test"}
        report.write_text(json.dumps(record) + "\n")
        self.assertEqual(CORPUS.check_resolution_expectations(report, [case])[0]["status"], "passed")
        record["resolved"]["joints"][1]["geometry"] = 0
        report.write_text(json.dumps(record) + "\n")
        self.assertEqual(CORPUS.check_resolution_expectations(report, [case])[0]["status"], "failed")

    def test_conversion_only_probe_cannot_skip_resolution(self):
        """An older or incomplete probe cannot silently omit the required compiler stage."""
        def conversion_only(*args, **kwargs):
            """Emit successful legacy stages with no resolver result."""
            kwargs["stdout"].write('{"stage":"parse","status":"passed"}\n'
                                   '{"stage":"conversion","status":"passed","mode":"Mode"}\n')
            return subprocess.CompletedProcess(args, 0, stderr="")

        with patch.object(CORPUS.subprocess, "run", side_effect=conversion_only):
            result = CORPUS.run_probe(Path("probe"), self.path, self.root / "probe.jsonl", 1, ["Mode"])
        self.assertEqual(result["status"], "failed")
        self.assertIn("resolution", result["error"])

    def test_wire_check_detects_byte_order_and_virtual_slot_errors(self):
        """A matching footprint cannot hide swapped fine bytes or an allocated virtual control."""
        report = self.root / "wire.jsonl"
        case = {"mode": "Mode", "issue": "test", "wire": {
            "footprints": {"2": 10}, "groups": [
                {"count": 2, "dmx_break": 2, "offsets": [1, 7], "stride": 3},
                {"count": 1, "offsets": None}]}}
        record = {"stage": "wire", "status": "passed", "mode": "Mode", "wires": {
            "footprints": {"2": 10}, "channels": [
                {"dmxBreak": 2, "offsets": [1, 7]}, {"dmxBreak": 2, "offsets": [4, 10]}, None]}}
        report.write_text(json.dumps(record) + "\n")
        self.assertEqual(CORPUS.check_wire_expectations(report, [case])[0]["status"], "passed")
        record["wires"]["channels"][0]["offsets"] = [7, 1]
        report.write_text(json.dumps(record) + "\n")
        self.assertEqual(CORPUS.check_wire_expectations(report, [case])[0]["status"], "failed")
        record["wires"]["channels"][0]["offsets"] = [1, 7]
        record["wires"]["channels"][2] = {"dmxBreak": 2, "offsets": [2]}
        report.write_text(json.dumps(record) + "\n")
        self.assertEqual(CORPUS.check_wire_expectations(report, [case])[0]["status"], "failed")

    def test_function_samples_preserve_descending_physical_ranges(self):
        """A plausible sorted angular range must not hide reversed fixture movement semantics."""
        report = self.root / "functions.jsonl"
        record = {"stage": "functions", "status": "passed", "mode": "Mode", "channels": [{
            "bytes": 2, "default": 32768, "highlight": None, "initialFunction": 0,
            "functions": [{"rawFrom": 0, "rawTo": 65535, "physicalFrom": 270, "physicalTo": -270}]}]}
        case = {"mode": "Mode", "issue": "test", "function_samples": [{
            "channel_index": 0, "bytes": 2, "default": 32768, "highlight": None,
            "initialFunction": 0, "ranges": [[0, 65535, 270, -270]]}]}
        report.write_text(json.dumps(record) + "\n")
        self.assertEqual(CORPUS.check_function_expectations(report, [case])[0]["status"], "passed")
        record["channels"][0]["functions"][0].update({"physicalFrom": -270, "physicalTo": 270})
        report.write_text(json.dumps(record) + "\n")
        self.assertEqual(CORPUS.check_function_expectations(report, [case])[0]["status"], "failed")


if __name__ == "__main__":
    unittest.main()
