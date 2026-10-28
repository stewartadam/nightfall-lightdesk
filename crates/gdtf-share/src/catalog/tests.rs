// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::*;

/// A listed revision with one mode, a user upload and no rating.
fn fixture(rid: u32, manufacturer: &str, name: &str, mode: &str) -> GdtfShareFixture {
    GdtfShareFixture {
        rid,
        fixture_type_id: Some(format!("type-{rid}")),
        manufacturer: manufacturer.into(),
        fixture: name.into(),
        revision: "1.0".into(),
        modes: vec![GdtfShareMode {
            name: mode.into(),
            footprint: 16,
        }],
        rating: None,
        manufacturer_upload: false,
        last_modified: 1_700_000_000,
        file_size: 1024,
    }
}

/// Returns the fixture names of a search's results, in order.
fn names(catalog: &Catalog, query: &str) -> Vec<String> {
    catalog
        .search(query)
        .fixtures
        .into_iter()
        .map(|fixture| fixture.fixture)
        .collect()
}

/// Every word must match a manufacturer, fixture or mode name, ignoring case.
#[test]
fn every_word_must_match_somewhere() {
    let catalog = Catalog::new(
        0,
        vec![
            fixture(1, "Robe", "Spiider", "Mode 1"),
            fixture(2, "Martin", "MAC Aura", "Extended"),
            fixture(3, "Robe", "MegaPointe", "Extended"),
        ],
    );
    assert_eq!(names(&catalog, "ROBE extended"), ["MegaPointe"]);
    assert_eq!(names(&catalog, "robe aura"), Vec::<String>::new());
    assert_eq!(names(&catalog, "  "), ["MAC Aura", "MegaPointe", "Spiider"]);
}

/// Name matches beat mode-only matches, word starts beat matches inside a word, and the
/// fixture's whole name beats both.
#[test]
fn closer_matches_rank_first() {
    let catalog = Catalog::new(
        0,
        vec![
            fixture(1, "Acme", "Wash", "Beam"),
            fixture(2, "Acme", "Superbeam", "Standard"),
            fixture(3, "Acme", "Beam Pro", "Standard"),
            fixture(4, "Acme", "Beam", "Standard"),
        ],
    );
    assert_eq!(
        names(&catalog, "beam"),
        ["Beam", "Beam Pro", "Superbeam", "Wash"]
    );
}

/// Equal matches list manufacturer uploads first, then the best rated.
#[test]
fn ties_prefer_manufacturer_uploads_then_rating() {
    let rated = GdtfShareFixture {
        rating: Some(4.5),
        ..fixture(1, "Acme", "Spot B", "Standard")
    };
    let official = GdtfShareFixture {
        manufacturer_upload: true,
        ..fixture(2, "Acme", "Spot C", "Standard")
    };
    let plain = fixture(3, "Acme", "Spot A", "Standard");
    let catalog = Catalog::new(0, vec![plain, rated, official]);
    assert_eq!(names(&catalog, "spot"), ["Spot C", "Spot B", "Spot A"]);
}

/// Only the most recently changed revision of a fixture type is searched, but every
/// revision can still be looked up.
#[test]
fn search_shows_the_newest_revision_of_each_type() {
    let older = GdtfShareFixture {
        fixture_type_id: Some("same".into()),
        last_modified: 100,
        ..fixture(1, "Acme", "Spot", "Standard")
    };
    let newer = GdtfShareFixture {
        fixture_type_id: Some("same".into()),
        last_modified: 200,
        ..fixture(2, "Acme", "Spot", "Standard")
    };
    let catalog = Catalog::new(0, vec![newer, older]);
    let results = catalog.search("spot");
    assert_eq!(results.total, 1);
    assert_eq!(results.fixtures[0].rid, 2);
    assert!(catalog.revision(1).is_some());
}

/// A search returns every match, however many there are, with the match count and the
/// list's fetch time.
#[test]
fn search_returns_every_match() {
    let catalog = Catalog::new(
        42,
        (1..=250)
            .map(|rid| fixture(rid, "Acme", &format!("Spot {rid}"), "Standard"))
            .collect(),
    );
    let results = catalog.search("spot");
    assert_eq!((results.total, results.fetched_at), (250, 42));
    assert_eq!(results.fixtures.len(), 250);
}

/// List entries keep their fields, with a blank id, an `N/A` rating and the
/// manufacturer upload marker normalized.
#[test]
fn list_entries_are_normalized() {
    let entry: ShareEntry = serde_json::from_value(serde_json::json!({
        "rid": 7,
        "uuid": " ",
        "manufacturer": "Acme ",
        "fixture": "Spot",
        "revision": "v2",
        "lastModified": 1_700_000_000u64,
        "uploader": "Manuf.",
        "rating": "N/A",
        "filesize": 2048,
        "modes": [{ "name": "Basic", "dmxfootprint": 8 }],
    }))
    .unwrap();
    let fixture = GdtfShareFixture::from_entry(entry);
    assert_eq!(fixture.fixture_type_id, None);
    assert_eq!(fixture.manufacturer, "Acme");
    assert_eq!(fixture.rating, None);
    assert!(fixture.manufacturer_upload);
    assert_eq!(fixture.modes[0].footprint, 8);

    let rated: ShareEntry =
        serde_json::from_value(serde_json::json!({ "rid": 8, "rating": "3.5" })).unwrap();
    assert_eq!(GdtfShareFixture::from_entry(rated).rating, Some(3.5));
}

/// File names follow GDTF Share's `Manufacturer@Fixture@Revision.gdtf` and cannot escape
/// the library folder or add an `@` field.
#[test]
fn file_names_are_safe() {
    let mut named = fixture(1, "Clay Paky", "Sharpy", "Standard");
    named.revision = "Fw 1.2/3".into();
    assert_eq!(named.file_name(), "Clay_Paky@Sharpy@Fw_1.2_3@1.gdtf");
    named.manufacturer = "../..".into();
    named.fixture = "a@b".into();
    named.revision = "...".into();
    assert_eq!(named.file_name(), "unnamed@a_b@unnamed@1.gdtf");
}

/// A fetched list is saved and read back after a restart; an unreadable file counts as
/// no list.
#[tokio::test]
async fn saved_list_survives_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(CATALOG_FILE_NAME);
    let saved = SavedCatalog {
        fetched_at: 7,
        fixtures: vec![fixture(1, "Acme", "Spot", "Standard")],
    };
    write_saved(&path, &saved).unwrap();
    let catalog = GdtfShareCatalog::new(path.clone()).current().await.unwrap();
    assert_eq!(catalog.fetched_at(), 7);
    assert!(catalog.is_stale(7 + REFRESH_AFTER.as_secs()));
    assert!(!catalog.is_stale(8));

    std::fs::write(&path, "not json").unwrap();
    assert!(GdtfShareCatalog::new(path).current().await.is_none());
}
