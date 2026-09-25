// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Loads source wheel images without embedding image bytes in fixture state messages.

use std::{io::Read, path::Path};

/// Largest wheel image served to clients; GDTF gobo media is a small raster.
pub const MAX_WHEEL_MEDIA_BYTES: u64 = 16 * 1024 * 1024;

/// PNG file signature every wheel image must start with.
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

/// Failure to resolve or read one source wheel image.
#[derive(Debug, thiserror::Error)]
pub enum WheelMediaError {
    /// The archive file does not exist.
    #[error("fixture archive not found")]
    ArchiveNotFound,
    /// The archive or entry could not be read from disk.
    #[error("fixture archive unreadable: {0}")]
    Io(#[from] std::io::Error),
    /// The archive is not a readable ZIP container.
    #[error("corrupt fixture archive: {0}")]
    CorruptArchive(zip::result::ZipError),
    /// The named media was absent from the archive.
    #[error("wheel image not found")]
    NotFound,
    /// The entry exceeds [`MAX_WHEEL_MEDIA_BYTES`] or is not a PNG payload.
    #[error("invalid wheel image")]
    InvalidImage,
}

/// Reads one `wheels/{name}.png` entry from a GDTF archive for a single HTTP request.
///
/// The entry is opened directly from the ZIP central directory, so the fixture's
/// `description.xml` is not parsed. This performs blocking file I/O and must run
/// off async executor threads.
pub fn extract_wheel_media(path: &Path, name: &str) -> Result<Vec<u8>, WheelMediaError> {
    let file = std::fs::File::open(path).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => WheelMediaError::ArchiveNotFound,
        _ => WheelMediaError::Io(error),
    })?;
    let mut archive = zip::ZipArchive::new(file).map_err(zip_error)?;
    let entry = archive
        .by_name(&format!("wheels/{name}.png"))
        .map_err(zip_error)?;
    if entry.size() > MAX_WHEEL_MEDIA_BYTES {
        return Err(WheelMediaError::InvalidImage);
    }
    let mut data = Vec::with_capacity(entry.size() as usize);
    entry
        .take(MAX_WHEEL_MEDIA_BYTES + 1)
        .read_to_end(&mut data)?;
    if data.len() as u64 > MAX_WHEEL_MEDIA_BYTES || !data.starts_with(PNG_SIGNATURE) {
        return Err(WheelMediaError::InvalidImage);
    }
    Ok(data)
}

/// Separates missing entries and disk failures from structurally invalid archives.
fn zip_error(error: zip::result::ZipError) -> WheelMediaError {
    match error {
        zip::result::ZipError::FileNotFound => WheelMediaError::NotFound,
        zip::result::ZipError::Io(error) => WheelMediaError::Io(error),
        error => WheelMediaError::CorruptArchive(error),
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    /// Writes an archive with the given wheel entries and no parseable fixture description.
    fn write_archive(path: &Path, entries: &[(&str, &[u8])]) {
        let mut zip = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        for (name, data) in entries {
            zip.start_file(*name, options).unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap();
    }

    /// Reads the exact named entry without consulting description.xml or substituting media.
    #[test]
    fn extracts_named_wheel_media_without_substitution() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("optics.gdtf");
        let png = b"\x89PNG\r\n\x1a\nsource-payload";
        write_archive(
            &path,
            &[
                ("wheels/pattern.png", png),
                ("wheels/invalid.png", b"not a PNG"),
            ],
        );
        assert_eq!(extract_wheel_media(&path, "pattern").unwrap(), png);
        assert!(matches!(
            extract_wheel_media(&path, "missing"),
            Err(WheelMediaError::NotFound)
        ));
        assert!(matches!(
            extract_wheel_media(&path, "invalid"),
            Err(WheelMediaError::InvalidImage)
        ));
    }

    /// Distinguishes a missing archive from a file that is not a ZIP container.
    #[test]
    fn classifies_missing_and_corrupt_archives() {
        let directory = tempfile::tempdir().unwrap();
        assert!(matches!(
            extract_wheel_media(&directory.path().join("absent.gdtf"), "pattern"),
            Err(WheelMediaError::ArchiveNotFound)
        ));
        let corrupt = directory.path().join("corrupt.gdtf");
        std::fs::write(&corrupt, b"definitely not a zip archive").unwrap();
        assert!(matches!(
            extract_wheel_media(&corrupt, "pattern"),
            Err(WheelMediaError::CorruptArchive(_))
        ));
    }

    /// Rejects entries larger than the media limit even when they carry a PNG signature.
    #[test]
    fn rejects_oversize_wheel_media() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("oversize.gdtf");
        let mut oversize = PNG_SIGNATURE.to_vec();
        oversize.resize(MAX_WHEEL_MEDIA_BYTES as usize + 1, 0);
        write_archive(&path, &[("wheels/huge.png", &oversize)]);
        assert!(matches!(
            extract_wheel_media(&path, "huge"),
            Err(WheelMediaError::InvalidImage)
        ));
    }
}
