// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Resource bounds and the actual async HTTP handler's library access policy.

use std::io::{Cursor, Write};
use std::path::Path;

use axum::{
    body::to_bytes,
    extract::{Path as RoutePath, State},
    http::{StatusCode, header},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use nightfall_fixture_library::FixtureLibraryManager;
use nightfall_fixture_library::gdtf_archive::ArchiveLimits;
use nightfall_fixture_library::http_routes::{MeshAccess, serve_mesh};
use nightfall_fixture_library::mesh::{
    MeshExtractionError, MeshFormat, extract_mesh_from_gdtf, extract_mesh_with_limits,
};

/// Create a valid indexed fixture with independently specified mesh entries.
fn archive(path: &Path, resources: &[(&str, &[u8])]) {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    writer.start_file("description.xml", options).unwrap();
    writer
        .write_all(include_bytes!("fixtures/gdtf/nested-sparse.xml"))
        .unwrap();
    for (name, bytes) in resources {
        writer.start_file(*name, options).unwrap();
        writer.write_all(bytes).unwrap();
    }
    std::fs::write(path, writer.finish().unwrap().into_inner()).unwrap();
}

/// Build the same path identifier emitted by the current frontend loader.
fn encoded(path: &Path) -> String {
    URL_SAFE_NO_PAD.encode(path.to_str().unwrap().as_bytes())
}

/// GLB is preferred while absent or empty GLB falls back to the exact 3DS archive entry.
#[test]
fn extracts_exact_resources_and_preserves_format_fallback() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("fixture.gdtf");
    for (glb, format, expected) in [
        (Some(b"glb".as_slice()), MeshFormat::Glb, b"glb".as_slice()),
        (Some(b"".as_slice()), MeshFormat::ThreeDs, b"3ds".as_slice()),
        (None, MeshFormat::ThreeDs, b"3ds".as_slice()),
    ] {
        let mut resources = vec![("models/3ds/body.3ds", b"3ds".as_slice())];
        if let Some(glb) = glb {
            resources.push(("models/gltf/body.glb", glb));
        }
        archive(&path, &resources);
        let mesh = extract_mesh_from_gdtf(&path, "body").unwrap();
        assert_eq!(mesh.format, format);
        assert_eq!(mesh.data, expected);
    }
    assert!(matches!(
        extract_mesh_from_gdtf(&path, "missing"),
        Err(MeshExtractionError::MeshNotFound(_))
    ));
}

/// Resource names cannot escape model directories, and both compressed and expanded size caps apply.
#[test]
fn rejects_path_components_and_oversized_archives() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("fixture.gdtf");
    archive(&path, &[("models/gltf/body.glb", &[0; 16384])]);
    for name in ["", ".", "..", "../body", "a/body", "a\\body", "body\0"] {
        assert!(
            matches!(
                extract_mesh_from_gdtf(&path, name),
                Err(MeshExtractionError::InvalidModelName)
            ),
            "{name:?}"
        );
    }
    for (limits, code) in [
        (
            ArchiveLimits {
                archive_bytes: std::fs::metadata(&path).unwrap().len() - 1,
                ..ArchiveLimits::default()
            },
            "archive_size_limit",
        ),
        (
            ArchiveLimits {
                entry_bytes: 8192,
                ..ArchiveLimits::default()
            },
            "archive_entry_size_limit",
        ),
        (
            ArchiveLimits {
                entries: 1,
                ..ArchiveLimits::default()
            },
            "archive_entry_limit",
        ),
    ] {
        let Err(MeshExtractionError::ArchiveError(error)) =
            extract_mesh_with_limits(&path, "body", limits)
        else {
            panic!("expected {code}");
        };
        assert_eq!(error.code, code);
    }
}

/// A corrupt preferred resource is reported rather than hidden behind a valid fallback model.
#[test]
fn corrupt_glb_does_not_silently_use_3ds() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("fixture.gdtf");
    archive(
        &path,
        &[
            ("models/gltf/body.glb", b"unique-corrupt-payload"),
            ("models/3ds/body.3ds", b"valid-fallback"),
        ],
    );
    let mut bytes = std::fs::read(&path).unwrap();
    let index = bytes
        .windows(b"unique-corrupt-payload".len())
        .position(|window| window == b"unique-corrupt-payload")
        .unwrap();
    bytes[index] ^= 1;
    std::fs::write(&path, bytes).unwrap();
    assert!(matches!(
        extract_mesh_from_gdtf(&path, "body"),
        Err(MeshExtractionError::IoError(_))
    ));
}

/// HTTP serving enforces current index membership and mutable-resource cache headers.
#[tokio::test]
async fn handler_serves_only_current_indexed_archives() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let indexed = dir.path().join("indexed.gdtf");
    let unindexed = outside.path().join("unindexed.gdtf");
    archive(&indexed, &[("models/gltf/body.glb", b"indexed-mesh")]);
    archive(&unindexed, &[("models/gltf/body.glb", b"unindexed-mesh")]);
    let mut library =
        FixtureLibraryManager::read_from_directories(dir.path().into(), None).unwrap();
    let access = MeshAccess::new(&library);
    let response = serve_mesh(
        State(access.clone()),
        RoutePath((encoded(&indexed), "body".into())),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()[header::CONTENT_TYPE],
        "model/gltf-binary"
    );
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(
        to_bytes(response.into_body(), 1024).await.unwrap().as_ref(),
        b"indexed-mesh"
    );
    let response = serve_mesh(
        State(access.clone()),
        RoutePath((encoded(&unindexed), "body".into())),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let response = serve_mesh(
        State(access.clone()),
        RoutePath((encoded(&indexed), "../body".into())),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    std::fs::remove_file(&indexed).unwrap();
    library.scan().unwrap();
    access.refresh(&library);
    archive(
        &indexed,
        &[("models/gltf/body.glb", b"recreated-without-rescan")],
    );
    let response = serve_mesh(State(access), RoutePath((encoded(&indexed), "body".into()))).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}
