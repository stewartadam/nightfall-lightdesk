// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Definition reuse, exact revision separation, bounded admission and independent handle lifetimes.

use std::io::{Cursor, Write};
use std::sync::Arc;

use nightfall_fixture_library::gdtf_archive::{
    ArchiveLimits, ArchiveSnapshot, CompiledDefinition, ParsedArchive,
};
use nightfall_fixture_library::gdtf_cache::{CacheLimits, DefinitionCache};
use nightfall_fixture_library::gdtf_compiler::CompileLimits;

/// Parse one archive with three equal-length mode names and a controllable resource revision.
fn source(resource: &[u8]) -> ParsedArchive {
    let xml = include_str!("fixtures/gdtf/nested-sparse.xml");
    let start = xml.find("<DMXMode Name=").unwrap();
    let end = xml.find("</DMXMode>").unwrap() + "</DMXMode>".len();
    let modes: String = ["A", "B", "C"]
        .into_iter()
        .map(|name| xml[start..end].replace("Nested sparse", name))
        .collect();
    let xml = format!("{}{}{}", &xml[..start], modes, &xml[end..]);
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    zip.start_file("description.xml", options).unwrap();
    zip.write_all(xml.as_bytes()).unwrap();
    zip.start_file("models/gltf/model.glb", options).unwrap();
    zip.write_all(resource).unwrap();
    ArchiveSnapshot::from_bytes(
        zip.finish().unwrap().into_inner(),
        ArchiveLimits::default().archive_bytes,
    )
    .unwrap()
    .parse(ArchiveLimits::default())
    .unwrap()
}

/// Give tests a cache limited by definition count without a constraining weight budget.
fn cache(count: usize) -> DefinitionCache {
    DefinitionCache::new(
        CacheLimits {
            definitions: count,
            weight_bytes: usize::MAX,
        },
        CompileLimits::default(),
    )
}

/// Assert that compiled handles can safely cross engine and loading thread boundaries.
fn assert_shareable<T: Send + Sync>() {}

/// Exact content/mode reuse returns the same immutable allocation even after a separate parse.
#[test]
fn repeated_content_reuses_the_compiled_allocation() {
    assert_shareable::<CompiledDefinition>();
    let source = source(b"revision one");
    let mut cache = cache(4);
    let first = cache.get_or_compile(&source, "A").unwrap();
    let second = cache.get_or_compile(&source, "A").unwrap();
    assert!(Arc::ptr_eq(&first, &second));
    assert_eq!(cache.stats().hits, 1);
    assert_eq!(cache.stats().misses, 1);
    assert_eq!(cache.stats().definitions, 1);
    let other_mode = cache.get_or_compile(&source, "B").unwrap();
    assert!(!Arc::ptr_eq(&first, &other_mode));
    assert_ne!(first.key(), other_mode.key());
}

/// A resource-only revision never aliases the old definition even when its mode and product labels match.
#[test]
fn content_revisions_remain_separate() {
    let original = source(b"revision one");
    let reparsed = source(b"revision one");
    let revised = source(b"revision two");
    let mut cache = cache(4);
    let old = cache.get_or_compile(&original, "A").unwrap();
    assert!(Arc::ptr_eq(
        &old,
        &cache.get_or_compile(&reparsed, "A").unwrap()
    ));
    let new = cache.get_or_compile(&revised, "A").unwrap();
    assert_ne!(old.key(), new.key());
    assert_eq!(cache.stats().definitions, 2);
}

/// Least-recently-used eviction respects lookups while retained fixture handles survive eviction and clearing.
#[test]
fn eviction_releases_only_cache_ownership() {
    let source = source(b"resource");
    let mut cache = cache(2);
    let a = cache.get_or_compile(&source, "A").unwrap();
    let b = cache.get_or_compile(&source, "B").unwrap();
    assert!(cache.get(a.key()).is_some());
    let c = cache.get_or_compile(&source, "C").unwrap();
    assert!(cache.get(b.key()).is_none());
    assert!(cache.get(a.key()).is_some());
    assert!(cache.get(c.key()).is_some());
    assert_eq!(cache.stats().definitions, 2);
    assert_eq!(cache.stats().evictions, 1);
    assert_eq!(b.mode().geometry().joints().len(), 2);
    cache.clear();
    assert_eq!(cache.stats().definitions, 0);
    assert_eq!(cache.stats().weight_bytes, 0);
    assert_eq!(a.mode().channels().defaults().len(), 10);
    assert_eq!(c.mode().geometry().nodes().len(), 5);
}

/// Exact weight boundaries admit a definition; overweight requests return usable handles without cache churn.
#[test]
fn weight_limits_control_admission_and_eviction() {
    let source = source(b"resource");
    let mut measure = cache(2);
    let a = measure.get_or_compile(&source, "A").unwrap();
    let weight = measure.stats().weight_bytes;
    assert_eq!(
        weight,
        a.archive().bytes().len() + serde_json::to_vec(a.as_ref()).unwrap().len()
    );
    let mut bounded = DefinitionCache::new(
        CacheLimits {
            definitions: 2,
            weight_bytes: weight,
        },
        CompileLimits::default(),
    );
    bounded.get_or_compile(&source, "A").unwrap();
    bounded.get_or_compile(&source, "B").unwrap();
    assert_eq!(bounded.stats().definitions, 1);
    assert_eq!(bounded.stats().evictions, 1);
    assert_eq!(bounded.stats().weight_bytes, weight);
    let oversized = source_with_large_resource();
    let retained_key = source.definition_key("B");
    let large = bounded.get_or_compile(&oversized, "A").unwrap();
    assert!(large.archive().bytes().len() > weight);
    assert!(bounded.get(&retained_key).is_some());
    assert_eq!(bounded.stats().evictions, 1);
    let mut too_small = DefinitionCache::new(
        CacheLimits {
            definitions: 2,
            weight_bytes: weight - 1,
        },
        CompileLimits::default(),
    );
    assert!(too_small.get_or_compile(&source, "A").is_ok());
    assert_eq!(too_small.stats().definitions, 0);
}

/// Supply an uncompressed resource large enough to exceed a small compiled definition's admission weight.
fn source_with_large_resource() -> ParsedArchive {
    source(&vec![0; 100_000])
}

/// Disabled caching and failed requests do not poison or evict existing successful definitions.
#[test]
fn failures_and_disabled_caching_leave_no_partial_entries() {
    let source = source(b"resource");
    let mut disabled = cache(0);
    assert!(disabled.get_or_compile(&source, "A").is_ok());
    assert_eq!(disabled.stats().definitions, 0);
    let mut cache = cache(2);
    let a = cache.get_or_compile(&source, "A").unwrap();
    let weight = cache.stats().weight_bytes;
    assert!(cache.get_or_compile(&source, "Missing").is_err());
    assert!(Arc::ptr_eq(&a, &cache.get(a.key()).unwrap()));
    assert_eq!(cache.stats().weight_bytes, weight);
    assert_eq!(cache.stats().definitions, 1);
}
