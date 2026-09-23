// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Content identity and bounded archive parsing before definition compilation.

use std::io::{Cursor, Write};

use nightfall_fixture_library::gdtf_archive::{
    ArchiveLimits, ArchiveSnapshot, COMPILER_VERSION, DEFINITION_SCHEMA_VERSION,
};
use nightfall_fixture_library::gdtf_compiler::CompileLimits;

/// Build a deterministic in-memory ZIP with controlled XML and resource bytes.
fn archive(xml: &str, asset: &[u8]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    writer.start_file("description.xml", options).unwrap();
    writer.write_all(xml.as_bytes()).unwrap();
    writer.start_file("models/gltf/test.glb", options).unwrap();
    writer.write_all(asset).unwrap();
    writer.finish().unwrap().into_inner()
}

/// Retain exact generated archive bytes with the default compressed-byte budget.
fn snapshot(bytes: Vec<u8>) -> ArchiveSnapshot {
    ArchiveSnapshot::from_bytes(bytes, ArchiveLimits::default().archive_bytes).unwrap()
}

/// Hashing uses the standard SHA-256 digest and enforces the exact compressed-byte boundary.
#[test]
fn snapshot_hash_and_byte_budget_have_independent_expectations() {
    let snapshot = ArchiveSnapshot::from_bytes(b"abc".to_vec(), 3).unwrap();
    assert_eq!(
        snapshot.sha256(),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert_eq!(snapshot.bytes(), b"abc");
    assert_eq!(
        ArchiveSnapshot::from_bytes(b"abc".to_vec(), 2)
            .unwrap_err()
            .code,
        "archive_size_limit"
    );
}

/// Replacing a library path cannot change a retained definition or its resource bytes.
#[test]
fn definition_is_bound_to_bytes_not_mutable_paths() {
    let xml = include_str!("fixtures/gdtf/nested-sparse.xml");
    let original = archive(xml, b"first resource");
    let replacement = archive(xml, b"other resource");
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("fixture.gdtf");
    std::fs::write(&path, &original).unwrap();
    let saved = ArchiveSnapshot::read(&path, original.len() as u64).unwrap();
    assert_eq!(
        ArchiveSnapshot::read(&path, original.len() as u64 - 1)
            .unwrap_err()
            .code,
        "archive_size_limit"
    );
    std::fs::write(&path, &replacement).unwrap();
    let parsed = saved.parse(ArchiveLimits::default()).unwrap();
    let definition = parsed
        .compile("Nested sparse", CompileLimits::default())
        .unwrap();
    drop(parsed);
    assert_eq!(definition.archive().bytes(), original);
    assert_eq!(
        definition.key().archive_sha256(),
        snapshot(original).sha256()
    );
    assert_ne!(
        definition.key().archive_sha256(),
        snapshot(replacement).sha256()
    );
    assert_eq!(definition.key().mode(), "Nested sparse");
    assert_eq!(definition.key().compiler_version(), COMPILER_VERSION);
    assert_eq!(definition.key().schema_version(), DEFINITION_SCHEMA_VERSION);
    assert_eq!(definition.mode().geometry().joints().len(), 2);
    assert!(
        serde_json::to_value(&definition)
            .unwrap()
            .get("archive")
            .is_none()
    );
}

/// Reusing one parsed archive preserves content identity while different exact modes receive different keys.
#[test]
fn modes_are_distinct_without_rehashing_or_reparsing() {
    let xml = include_str!("fixtures/gdtf/nested-sparse.xml");
    let start = xml.find("<DMXMode Name=").unwrap();
    let end = xml.find("</DMXMode>").unwrap() + "</DMXMode>".len();
    let alternate = xml[start..end].replace("Name=\"Nested sparse\"", "Name=\"Alternate \"");
    let xml = xml.replace("</DMXModes>", &format!("{alternate}</DMXModes>"));
    let parsed = snapshot(archive(&xml, &[]))
        .parse(ArchiveLimits::default())
        .unwrap();
    let first = parsed
        .compile("Nested sparse", CompileLimits::default())
        .unwrap();
    let second = parsed
        .compile("Alternate ", CompileLimits::default())
        .unwrap();
    assert_eq!(first.key().archive_sha256(), second.key().archive_sha256());
    assert_ne!(first.key(), second.key());
    assert_eq!(second.key().mode(), "Alternate ");
    assert!(
        parsed
            .compile("Alternate", CompileLimits::default())
            .is_err()
    );
}

/// Each archive budget rejects the corresponding excessive input before XML compilation.
#[test]
fn archive_and_description_budgets_are_enforced() {
    let xml = include_str!("fixtures/gdtf/nested-sparse.xml");
    let bytes = archive(xml, b"resource");
    let defaults = ArchiveLimits::default();
    for (limits, expected) in [
        (
            ArchiveLimits {
                archive_bytes: bytes.len() as u64 - 1,
                ..defaults
            },
            "archive_size_limit",
        ),
        (
            ArchiveLimits {
                entries: 1,
                ..defaults
            },
            "archive_entry_limit",
        ),
        (
            ArchiveLimits {
                entry_bytes: xml.len() as u64 - 1,
                ..defaults
            },
            "archive_entry_size_limit",
        ),
        (
            ArchiveLimits {
                expanded_bytes: xml.len() as u64 + 7,
                ..defaults
            },
            "archive_expansion_limit",
        ),
        (
            ArchiveLimits {
                description_bytes: xml.len() as u64 - 1,
                ..defaults
            },
            "description_size_limit",
        ),
    ] {
        assert_eq!(
            snapshot(bytes.clone()).parse(limits).unwrap_err().code,
            expected
        );
    }
    assert!(
        snapshot(bytes)
            .parse(ArchiveLimits {
                entries: 2,
                entry_bytes: xml.len() as u64,
                expanded_bytes: xml.len() as u64 + 8,
                description_bytes: xml.len() as u64,
                ..defaults
            })
            .is_ok()
    );
}

/// Broken containers, XML and ambiguous fixture counts produce distinct structured failures.
#[test]
fn malformed_inputs_keep_their_failing_stage() {
    assert_eq!(
        snapshot(b"invalid zip".to_vec())
            .parse(ArchiveLimits::default())
            .unwrap_err()
            .code,
        "invalid_archive"
    );
    assert_eq!(
        snapshot(archive("<broken", &[]))
            .parse(ArchiveLimits::default())
            .unwrap_err()
            .code,
        "description_parse"
    );
    let xml = include_str!("fixtures/gdtf/nested-sparse.xml");
    let start = xml.find("  <FixtureType").unwrap();
    let end = xml.find("</FixtureType>").unwrap() + "</FixtureType>".len();
    let duplicated = xml.replace("</GDTF>", &format!("{}</GDTF>", &xml[start..end]));
    assert_eq!(
        snapshot(archive(&duplicated, &[]))
            .parse(ArchiveLimits::default())
            .unwrap_err()
            .code,
        "ambiguous_fixture_type"
    );
}
