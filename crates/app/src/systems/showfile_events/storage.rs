// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::{
    hash::{Hash, Hasher},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use flate2::{Compression, read::MultiGzDecoder, write::GzEncoder};
use nightfall_showfile::{parse_showfile_snapshot_json, serialize_showfile_snapshot_json};

use super::{
    ShowfileMetadata, ShowfileSnapshot,
    manifest::write_showfile_manifest_to_dir,
    paths::{
        SHOWFILE_COMPRESSED_SNAPSHOT_FILENAME, SHOWFILE_SNAPSHOT_FILENAME, showfile_path,
        showfile_snapshot_path_from_path,
    },
};

/// Replace a show-data directory with a prepared temporary directory.
pub(super) fn replace_showfile_dir_with_temp(
    temp_dir: &Path,
    destination_dir: &Path,
) -> Result<(), String> {
    if destination_dir.exists() {
        std::fs::remove_dir_all(destination_dir).map_err(|error| {
            format!(
                "failed to replace existing showfile directory {}: {}",
                destination_dir.display(),
                error
            )
        })?;
    }
    std::fs::rename(temp_dir, destination_dir).map_err(|error| {
        format!(
            "failed to move showfile directory {} to {}: {}",
            temp_dir.display(),
            destination_dir.display(),
            error
        )
    })
}

/// Build a unique temporary directory path beside a show-data directory.
pub(super) fn temporary_showfile_dir(parent: &Path, folder_name: &str) -> PathBuf {
    parent.join(format!(
        ".{folder_name}.tmp-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0)
    ))
}

/// Write a gzip snapshot and its matching discovery sidecar into a show-data directory.
pub(super) fn write_showfile_snapshot_with_manifest_to_dir(
    showfile_snapshot: &ShowfileSnapshot,
    show_data_dir: &Path,
    state_hash: u64,
    based_on_state_hash: Option<u64>,
) -> Result<(), String> {
    write_snapshot_to_dir(
        showfile_snapshot,
        show_data_dir,
        state_hash,
        based_on_state_hash,
        true,
    )
}

/// Write plain JSON for interchange and archives that provide their own compression.
pub(super) fn write_showfile_json_with_manifest_to_dir(
    snapshot: &ShowfileSnapshot,
    directory: &Path,
    state_hash: u64,
) -> Result<(), String> {
    write_snapshot_to_dir(snapshot, directory, state_hash, None, false)
}

/// Publish a complete encoded snapshot before replacing its alternate encoding and discovery sidecar.
fn write_snapshot_to_dir(
    showfile_snapshot: &ShowfileSnapshot,
    show_data_dir: &Path,
    state_hash: u64,
    based_on_state_hash: Option<u64>,
    compressed: bool,
) -> Result<(), String> {
    std::fs::create_dir_all(show_data_dir).map_err(|error| {
        format!(
            "failed to create showfile directory {}: {}",
            show_data_dir.display(),
            error
        )
    })?;
    let (filename, alternate) = if compressed {
        (
            SHOWFILE_COMPRESSED_SNAPSHOT_FILENAME,
            SHOWFILE_SNAPSHOT_FILENAME,
        )
    } else {
        (
            SHOWFILE_SNAPSHOT_FILENAME,
            SHOWFILE_COMPRESSED_SNAPSHOT_FILENAME,
        )
    };
    let path = show_data_dir.join(filename);
    let json = serialize_showfile_snapshot_json(showfile_snapshot)?;
    let write = || -> Result<(), std::io::Error> {
        let mut temporary = tempfile::NamedTempFile::new_in(show_data_dir)?;
        if compressed {
            let mut encoder = GzEncoder::new(temporary.as_file_mut(), Compression::default());
            encoder.write_all(json.as_bytes())?;
            encoder.finish()?;
        } else {
            temporary.write_all(json.as_bytes())?;
        }
        temporary.persist(&path).map_err(|error| error.error)?;
        match std::fs::remove_file(show_data_dir.join(alternate)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    };
    write().map_err(|error| format!("failed to write showfile {}: {error}", path.display()))?;
    write_showfile_manifest_to_dir(show_data_dir, state_hash, based_on_state_hash)
}

/// Best-effort repair a sidecar for a selected snapshot already parsed from disk.
pub(super) fn repair_showfile_manifest_for_existing_snapshot_to_dir(
    show_data_dir: &Path,
    state_hash: u64,
    based_on_state_hash: Option<u64>,
) {
    if let Err(error) = write_showfile_manifest_for_existing_snapshot_to_dir(
        show_data_dir,
        state_hash,
        based_on_state_hash,
    ) {
        tracing::warn!(
            show_data_dir = %show_data_dir.display(),
            "Failed to repair rebuildable showfile manifest: {error}"
        );
    }
}

/// Write a sidecar for a selected snapshot that has already been parsed from disk.
fn write_showfile_manifest_for_existing_snapshot_to_dir(
    show_data_dir: &Path,
    state_hash: u64,
    based_on_state_hash: Option<u64>,
) -> Result<(), String> {
    write_showfile_manifest_to_dir(show_data_dir, state_hash, based_on_state_hash)
}

/// Read and deserialize a canonical or named showfile JSON from disk.
pub(super) fn read_showfile_snapshot(name: Option<&str>) -> Result<ShowfileSnapshot, String> {
    let path = showfile_path(name)?;
    read_showfile_snapshot_from_path(&path)
}

/// Read and deserialize a showfile snapshot from an explicit path.
pub(crate) fn read_showfile_snapshot_from_path(path: &Path) -> Result<ShowfileSnapshot, String> {
    let path = showfile_snapshot_path_from_path(path);
    let filename = path.display().to_string();
    tracing::debug!("Loading showfile: {}", filename);
    let json = read_showfile_json_from_path(&path)?;
    parse_showfile_snapshot_json(&json, &filename)
}

/// Decode stored gzip or plain interchange JSON, validating the entire gzip stream and checksum.
pub(super) fn read_showfile_json_from_path(path: &Path) -> Result<String, String> {
    let path = showfile_snapshot_path_from_path(path);
    let filename = path.display().to_string();
    let file = std::fs::File::open(&path)
        .map_err(|error| format!("failed to open showfile {}: {}", filename, error))?;
    let mut reader: Box<dyn Read> = if path.extension().is_some_and(|extension| extension == "gz") {
        Box::new(MultiGzDecoder::new(file))
    } else {
        Box::new(file)
    };
    let mut json = String::new();
    reader
        .read_to_string(&mut json)
        .map_err(|error| format!("failed to read showfile {filename}: {error}"))?;

    Ok(json)
}

/// Hash a showfile snapshot after replacing volatile save metadata with a stable baseline.
pub(super) fn hash_showfile_snapshot_with_metadata(
    snapshot: &ShowfileSnapshot,
    metadata: &ShowfileMetadata,
) -> Result<u64, String> {
    let mut snapshot = snapshot.clone();
    snapshot.metadata = metadata.clone();
    let json = serialize_showfile_snapshot_json(&snapshot)?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    json.hash(&mut hasher);
    Ok(hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::super::{
        listing::list_available_showfiles_in_root,
        manifest::read_current_showfile_manifest_from_dir,
    };
    use super::*;

    /// Gzip storage preserves JSON and semantic hashes while keeping manifests and discovery usable.
    #[test]
    fn compressed_snapshots_roundtrip_and_remain_discoverable() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("Tour.nightfall-show");
        let snapshot = ShowfileSnapshot {
            metadata: nightfall_showfile::current_showfile_metadata(),
            ..Default::default()
        };
        let json = serialize_showfile_snapshot_json(&snapshot).unwrap();
        let hash = hash_showfile_snapshot_with_metadata(&snapshot, &snapshot.metadata).unwrap();
        write_showfile_json_with_manifest_to_dir(&snapshot, &directory, hash).unwrap();
        write_showfile_snapshot_with_manifest_to_dir(&snapshot, &directory, hash, Some(hash))
            .unwrap();
        let path = directory.join(SHOWFILE_COMPRESSED_SNAPSHOT_FILENAME);
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[..2], &[0x1f, 0x8b]);
        assert!(bytes.len() < json.len());
        assert!(!directory.join(SHOWFILE_SNAPSHOT_FILENAME).exists());
        assert_eq!(read_showfile_json_from_path(&directory).unwrap(), json);
        let loaded = read_showfile_snapshot_from_path(&path).unwrap();
        assert_eq!(
            hash_showfile_snapshot_with_metadata(&loaded, &loaded.metadata).unwrap(),
            hash
        );
        assert!(
            read_current_showfile_manifest_from_dir(&directory)
                .unwrap()
                .matches_clean_state_hash(&super::super::manifest::snapshot_hash_label(hash))
        );
        let shows = list_available_showfiles_in_root(root.path()).unwrap();
        assert_eq!(shows.len(), 1);
        assert!(shows[0].has_saved_snapshot);
        super::super::backup::backup_show_data_directory(&directory, 2).unwrap();
        let draft = root.path().join("drafts/Tour.nightfall-show");
        let mut edited = snapshot.clone();
        edited.settings.audio_device = Some("draft selection".to_string());
        let edited_hash = hash_showfile_snapshot_with_metadata(&edited, &edited.metadata).unwrap();
        write_showfile_snapshot_with_manifest_to_dir(&edited, &draft, edited_hash, Some(hash))
            .unwrap();
        let shows = list_available_showfiles_in_root(root.path()).unwrap();
        assert!(shows[0].draft.is_some());
        assert_eq!(shows[0].revisions.len(), 1);
        let revision = Path::new(&shows[0].revisions[0].path);
        assert_eq!(read_showfile_json_from_path(revision).unwrap(), json);
        assert_eq!(
            read_showfile_snapshot_from_path(&draft)
                .unwrap()
                .settings
                .audio_device
                .as_deref(),
            Some("draft selection")
        );
        let diagnostic =
            crate::diagnostic_showfile::read_stored_showfile(directory.clone()).unwrap();
        assert_eq!(
            serialize_showfile_snapshot_json(&diagnostic.snapshot).unwrap(),
            json
        );

        write_showfile_json_with_manifest_to_dir(&snapshot, &directory, hash).unwrap();
        assert!(!path.exists());
        assert_eq!(
            std::fs::read_to_string(directory.join(SHOWFILE_SNAPSHOT_FILENAME)).unwrap(),
            json
        );
        read_current_showfile_manifest_from_dir(&directory).unwrap();
    }

    /// Truncation, checksum failures, and trailing garbage must fail rather than load partial data.
    #[test]
    fn damaged_gzip_snapshots_are_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let snapshot = ShowfileSnapshot {
            metadata: nightfall_showfile::current_showfile_metadata(),
            ..Default::default()
        };
        write_showfile_snapshot_with_manifest_to_dir(&snapshot, directory.path(), 1, None).unwrap();
        let path = directory.path().join(SHOWFILE_COMPRESSED_SNAPSHOT_FILENAME);
        let bytes = std::fs::read(&path).unwrap();
        let mut bad_checksum = bytes.clone();
        let checksum_offset = bad_checksum.len() - 8;
        bad_checksum[checksum_offset] ^= 1;
        let mut trailing_garbage = bytes.clone();
        trailing_garbage.extend_from_slice(b"garbage");
        for damaged in [
            bytes[..bytes.len() - 4].to_vec(),
            bad_checksum,
            trailing_garbage,
        ] {
            std::fs::write(&path, damaged).unwrap();
            let error = read_showfile_snapshot_from_path(directory.path()).unwrap_err();
            assert!(error.contains("failed to read showfile"), "{error}");
            assert!(
                error.contains(SHOWFILE_COMPRESSED_SNAPSHOT_FILENAME),
                "{error}"
            );
        }
    }
}
