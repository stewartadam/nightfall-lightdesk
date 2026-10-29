// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::io::Write;

use super::*;
use crate::testing::gdtf_archive;

/// A GDTF archive passes; anything else is refused before it reaches the library.
#[test]
fn only_gdtf_archives_pass() {
    assert!(check_archive(&gdtf_archive("Spot")).is_ok());
    assert!(check_archive(b"<html>maintenance</html>").is_err());

    let mut other = zip::ZipWriter::new(Cursor::new(Vec::new()));
    other
        .start_file("readme.txt", zip::write::SimpleFileOptions::default())
        .unwrap();
    other.write_all(b"not a fixture").unwrap();
    let other = other.finish().unwrap().into_inner();
    assert!(check_archive(&other).is_err());
}

/// The archive is written whole under its final name, replacing an earlier copy, and no
/// temporary file is left behind.
#[test]
fn save_replaces_and_leaves_no_partial_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("fixtures/Acme@Spot@1.gdtf");
    save(&path, b"first").unwrap();
    save(&path, b"second").unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"second");
    let names: Vec<_> = std::fs::read_dir(path.parent().unwrap())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(names, ["Acme@Spot@1.gdtf"]);
}

/// Progress steps by whole percent of a known size and by 64 KiB of an unknown one, so
/// the route streams few lines either way.
#[test]
fn progress_steps_by_percent_or_by_64_kib() {
    let known = |received| GdtfShareDownloadProgress {
        received,
        total: Some(1000),
    };
    assert_eq!(known(0).step(), 0);
    assert_eq!(known(505).step(), 50);
    assert_eq!(known(1000).step(), 100);
    let unknown = |received| GdtfShareDownloadProgress {
        received,
        total: None,
    };
    assert_eq!(unknown(65_535).step(), 0);
    assert_eq!(unknown(65_536).step(), 1);
}

/// The fixture type id comes from the `FixtureType` element, lowercased, and a missing or
/// nil id reads as none.
#[test]
fn reads_the_fixture_type_id() {
    let description = r#"<GDTF><FixtureType Name="Spot" FixtureTypeID="AB12CD34-0000-4000-8000-000000000001" RefFT=""><DMXModes/></FixtureType></GDTF>"#;
    assert_eq!(
        fixture_type_id(description).as_deref(),
        Some("ab12cd34-0000-4000-8000-000000000001")
    );
    assert_eq!(
        fixture_type_id(r#"<FixtureType FixtureTypeID="00000000-0000-0000-0000-000000000000">"#),
        None
    );
    assert_eq!(fixture_type_id(r#"<FixtureType Name="Spot">"#), None);
    assert_eq!(check_archive(&gdtf_archive("Spot")).unwrap(), None);
}
