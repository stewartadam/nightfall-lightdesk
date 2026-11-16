// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::*;

/// Fixture type id shared by the revisions in these tests.
const TYPE: &str = "e6e44f65-4f1d-4b62-b614-9ab1f6c0c2d1";

/// A listed revision of [`TYPE`] named `revision`, changed at `last_modified`.
fn listed(rid: u32, revision: &str, last_modified: u32, manufacturer: bool) -> GdtfShareFixture {
    GdtfShareFixture {
        rid,
        fixture_type_id: Some(TYPE.into()),
        manufacturer: "Generic".into(),
        fixture: "RGBW8".into(),
        revision: revision.into(),
        modes: Vec::new(),
        rating: None,
        manufacturer_upload: manufacturer,
        last_modified,
        file_size: 1024,
    }
}

/// A library file of [`TYPE`] with fingerprint `etag` and latest revision text `revision`.
fn library(etag: &str, revision: Option<&str>) -> GdtfShareLibraryFixture {
    GdtfShareLibraryFixture {
        asset_etag: etag.into(),
        fixture_type_id: TYPE.into(),
        revision: revision.map(Into::into),
    }
}

/// Returns `(asset_etag, installed rid, latest rid, library copy)` for each update found.
fn found(
    catalog: &Catalog,
    installs: &[(&str, u32)],
    fixtures: &[GdtfShareLibraryFixture],
) -> Vec<(String, Option<u32>, u32, Option<String>)> {
    let installs = installs
        .iter()
        .map(|(etag, rid)| ((*etag).to_string(), *rid))
        .collect();
    find_updates(catalog, &installs, fixtures)
        .updates
        .into_iter()
        .map(|update| {
            (
                update.asset_etag,
                update.installed.map(|installed| installed.rid),
                update.latest.rid,
                update.library_copy,
            )
        })
        .collect()
}

/// A recorded install updates to a revision of the same type changed strictly later.
#[test]
fn recorded_install_updates_to_a_later_revision() {
    let catalog = Catalog::new(
        0,
        vec![listed(10, "v1", 100, false), listed(11, "v2", 200, false)],
    );
    assert_eq!(
        found(&catalog, &[("a", 10)], &[library("a", None)]),
        [("a".to_string(), Some(10), 11, None)]
    );
    assert!(found(&catalog, &[("a", 11)], &[library("a", None)]).is_empty());
}

/// Revisions changed at the same time are not newer than each other, whatever their ids.
#[test]
fn equal_change_times_are_not_updates() {
    let catalog = Catalog::new(
        0,
        vec![listed(10, "v1", 100, false), listed(11, "v2", 100, false)],
    );
    assert!(found(&catalog, &[("a", 10)], &[library("a", None)]).is_empty());
}

/// Without a recorded install, the file's latest revision text names its revision,
/// ignoring case and spaces.
#[test]
fn revision_text_identifies_files_from_elsewhere() {
    let catalog = Catalog::new(
        0,
        vec![
            listed(10, "added white channel", 100, false),
            listed(11, "fixed gobos", 200, false),
        ],
    );
    assert_eq!(
        found(&catalog, &[], &[library("a", Some(" Added White Channel"))]),
        [("a".to_string(), Some(10), 11, None)]
    );
}

/// A file neither a record nor its revision text identifies gets no update, so it is
/// never pointed at a revision it may already be newer than.
#[test]
fn unidentified_files_are_left_out() {
    let catalog = Catalog::new(
        0,
        vec![listed(10, "v1", 100, false), listed(11, "v2", 200, false)],
    );
    assert!(found(&catalog, &[], &[library("a", Some("my own edit"))]).is_empty());
    assert!(found(&catalog, &[], &[library("a", None)]).is_empty());
}

/// Manufacturer files update only to manufacturer uploads, and user files only to user
/// uploads.
#[test]
fn updates_come_from_the_same_kind_of_uploader() {
    let catalog = Catalog::new(
        0,
        vec![
            listed(10, "Release", 100, true),
            listed(11, "user tweak", 300, false),
            listed(12, "Release 2", 200, true),
            listed(13, "user v1", 50, false),
        ],
    );
    assert_eq!(
        found(
            &catalog,
            &[("m", 10), ("u", 13)],
            &[library("m", None), library("u", None)]
        ),
        [
            ("m".to_string(), Some(10), 12, None),
            ("u".to_string(), Some(13), 11, None),
        ]
    );
}

/// A recorded revision GDTF Share no longer lists was replaced, and updates to the newest
/// revision, preferring manufacturer uploads.
#[test]
fn replaced_revisions_update_to_the_newest_manufacturer_upload() {
    let catalog = Catalog::new(
        0,
        vec![
            listed(11, "user tweak", 300, false),
            listed(12, "Release", 200, true),
        ],
    );
    assert_eq!(
        found(&catalog, &[("a", 9)], &[library("a", Some("gone"))]),
        [("a".to_string(), None, 12, None)]
    );
}

/// A replaced revision re-uploaded under its old name is matched by that name.
#[test]
fn reuploaded_revisions_are_matched_by_name() {
    let catalog = Catalog::new(
        0,
        vec![listed(20, "v1", 300, false), listed(21, "v2", 400, false)],
    );
    assert_eq!(
        found(&catalog, &[("a", 9)], &[library("a", Some("v1"))]),
        [("a".to_string(), Some(20), 21, None)]
    );
}

/// An update another library file already is says so, so the client offers that copy.
#[test]
fn updates_already_in_the_library_are_marked() {
    let catalog = Catalog::new(
        0,
        vec![listed(10, "v1", 100, false), listed(11, "v2", 200, false)],
    );
    assert_eq!(
        found(
            &catalog,
            &[("old", 10), ("new", 11)],
            &[library("old", None), library("new", None)]
        ),
        [("old".to_string(), Some(10), 11, Some("new".to_string()))]
    );
}

/// A record pointing at another fixture type's still-listed revision is ignored rather than
/// taken for a replaced revision, so an unidentified file gets no update.
#[test]
fn records_for_another_fixture_type_are_ignored() {
    let mut other = listed(30, "v9", 900, false);
    other.fixture_type_id = Some("another".into());
    let catalog = Catalog::new(
        0,
        vec![
            listed(10, "v1", 100, false),
            listed(11, "v2", 200, false),
            other,
        ],
    );
    assert!(found(&catalog, &[("a", 30)], &[library("a", Some("unknown"))]).is_empty());
    assert_eq!(
        found(&catalog, &[("a", 30)], &[library("a", Some("v1"))]),
        [("a".to_string(), Some(10), 11, None)]
    );
}

/// Only names shaped like installs, with a manufacturer, fixture and revision before the
/// id, yield a revision id.
#[test]
fn install_file_names_carry_the_revision_id() {
    assert_eq!(
        installed_rid("Generic@RGBW8@added_white@18244.gdtf"),
        Some(18244)
    );
    assert_eq!(installed_rid("Generic@RGBW8@test.gdtf"), None);
    assert_eq!(installed_rid("Generic@RGBW8@v1@x.gdtf"), None);
    assert_eq!(installed_rid("Generic@RGBW8@v1@12.json"), None);
}

/// A missing record is rebuilt from install-named library files and saved; recording an
/// install adds to it and survives a reload.
#[tokio::test]
async fn record_is_rebuilt_from_file_names_and_saved() {
    let data = tempfile::tempdir().unwrap();
    let library_dir = data.path().join("fixtures");
    std::fs::create_dir_all(&library_dir).unwrap();
    std::fs::write(library_dir.join("Generic@RGBW8@v1@42.gdtf"), b"one").unwrap();
    std::fs::write(library_dir.join("Renamed.gdtf"), b"two").unwrap();
    let path = data.path().join(INSTALLS_FILE_NAME);

    let record = InstalledRevisions::new(path.clone(), library_dir.clone());
    assert_eq!(
        record.rids().await,
        HashMap::from([(fixture_asset_etag(b"one"), 42)])
    );
    assert!(path.exists());
    record.record(fixture_asset_etag(b"two"), 43).await;

    let reloaded = InstalledRevisions::new(path, library_dir);
    assert_eq!(
        reloaded.rids().await,
        HashMap::from([
            (fixture_asset_etag(b"one"), 42),
            (fixture_asset_etag(b"two"), 43)
        ])
    );
}

/// Every identified file GDTF Share still lists is reported with its revision, whether or
/// not it has an update, while replaced and unidentified files are not.
#[test]
fn listed_files_report_their_revision() {
    let catalog = Catalog::new(
        0,
        vec![listed(10, "v1", 100, false), listed(11, "v2", 200, false)],
    );
    let installs = [("old".to_string(), 10), ("gone".to_string(), 9)]
        .into_iter()
        .collect();
    let result = find_updates(
        &catalog,
        &installs,
        &[
            library("old", None),
            library("new", Some("v2")),
            library("gone", None),
            library("mine", Some("my own edit")),
        ],
    );
    let listed: Vec<_> = result
        .listed
        .iter()
        .map(|listing| (listing.asset_etag.as_str(), listing.fixture.rid))
        .collect();
    assert_eq!(listed, [("old", 10), ("new", 11)]);
}
