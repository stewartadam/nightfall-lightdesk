// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Reads wheel slot images (gobos, animation wheels) directly from GDTF archives.
//!
//! Wheel images are served per HTTP request, so they are read straight from the
//! ZIP central directory without parsing the fixture's `description.xml`.

use std::{io::Read, path::Path};

/// Largest wheel image served to clients; GDTF gobo media is a small raster.
pub const MAX_WHEEL_MEDIA_BYTES: u64 = 16 * 1024 * 1024;

/// PNG file signature every wheel image must start with.
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

/// Failure to resolve or read one wheel image.
#[derive(Debug, thiserror::Error)]
pub enum WheelMediaError {
    /// The archive file does not exist.
    #[error("fixture archive not found")]
    ArchiveNotFound,
    /// The archive or entry could not be read from disk.
    #[error("fixture archive unreadable: {0}")]
    Io(std::io::Error),
    /// The archive is not a readable ZIP container, is truncated, or holds damaged entry data.
    #[error("corrupt fixture archive: {0}")]
    CorruptArchive(zip::result::ZipError),
    /// The named media is absent from the archive.
    #[error("wheel image not found")]
    NotFound,
    /// The entry exceeds [`MAX_WHEEL_MEDIA_BYTES`] or is not a PNG payload.
    #[error("invalid wheel image")]
    InvalidImage,
}

/// Reads the `wheels/{name}.png` entry of a GDTF archive.
///
/// `media_name` is a wheel slot's `MediaFileName`, with or without the `.png`
/// extension some archives include. This performs blocking file I/O and must
/// run off async executor threads.
pub fn extract_wheel_media(path: &Path, media_name: &str) -> Result<Vec<u8>, WheelMediaError> {
    let name = media_name.strip_suffix(".png").unwrap_or(media_name);
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
        .read_to_end(&mut data)
        .map_err(archive_read_error)?;
    if data.len() as u64 > MAX_WHEEL_MEDIA_BYTES || !data.starts_with(PNG_SIGNATURE) {
        return Err(WheelMediaError::InvalidImage);
    }
    Ok(data)
}

/// Separates missing entries and disk failures from structurally invalid archives.
fn zip_error(error: zip::result::ZipError) -> WheelMediaError {
    match error {
        zip::result::ZipError::FileNotFound => WheelMediaError::NotFound,
        zip::result::ZipError::Io(error) => archive_read_error(error),
        error => WheelMediaError::CorruptArchive(error),
    }
}

/// Classifies an I/O error raised while reading an already opened archive.
///
/// Truncated archives surface as unexpected EOF, and damaged deflate streams or
/// CRC mismatches as invalid data or input; those describe the archive's
/// contents, so they are reported as corrupt rather than as disk failures.
fn archive_read_error(error: std::io::Error) -> WheelMediaError {
    match error.kind() {
        std::io::ErrorKind::UnexpectedEof
        | std::io::ErrorKind::InvalidData
        | std::io::ErrorKind::InvalidInput => {
            WheelMediaError::CorruptArchive(zip::result::ZipError::Io(error))
        }
        _ => WheelMediaError::Io(error),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use zip::result::ZipError;

    use super::*;
    use crate::testing::{GdtfBuilder, GeometrySpec};

    /// A minimal payload carrying the PNG signature.
    pub(crate) const PNG: &[u8] = b"\x89PNG\r\n\x1a\nsource-payload";

    /// Writes a GDTF archive holding the given extra files.
    fn write_archive(path: &Path, files: &[(&str, &[u8])]) {
        files
            .iter()
            .fold(
                GdtfBuilder::new("Test", "Gobo").geometry(GeometrySpec::generic("Base")),
                |builder, (name, data)| builder.file(name, data),
            )
            .write_to(path);
    }

    /// Reads the named entry with or without a `.png` suffix, and rejects missing or non-PNG entries.
    #[test]
    fn extracts_named_wheel_media() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("optics.gdtf");
        write_archive(
            &path,
            &[
                ("wheels/stars.png", PNG),
                ("wheels/invalid.png", b"not a PNG"),
            ],
        );
        assert_eq!(extract_wheel_media(&path, "stars").unwrap(), PNG);
        assert_eq!(extract_wheel_media(&path, "stars.png").unwrap(), PNG);
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
            extract_wheel_media(&directory.path().join("absent.gdtf"), "stars"),
            Err(WheelMediaError::ArchiveNotFound)
        ));
        let corrupt = directory.path().join("corrupt.gdtf");
        std::fs::write(&corrupt, b"definitely not a zip archive").unwrap();
        assert!(matches!(
            extract_wheel_media(&corrupt, "stars"),
            Err(WheelMediaError::CorruptArchive(_))
        ));
    }

    /// Reads a little-endian unsigned field of `width` bytes at `offset`.
    fn read_le(bytes: &[u8], offset: usize, width: usize) -> usize {
        bytes[offset..offset + width]
            .iter()
            .rev()
            .fold(0, |value, byte| (value << 8) | usize::from(*byte))
    }

    /// Overwrites the little-endian `u32` field at `offset`.
    fn write_u32(bytes: &mut [u8], offset: usize, value: usize) {
        bytes[offset..offset + 4].copy_from_slice(&u32::try_from(value).unwrap().to_le_bytes());
    }

    /// Builds an archive whose last entry is `wheels/stars.png` holding `payload`, and
    /// returns its bytes with that entry's local header offset, data offset and compressed size.
    fn archive_with_stars(payload: &[u8]) -> (Vec<u8>, usize, usize, usize) {
        let bytes = GdtfBuilder::new("Test", "Gobo")
            .geometry(GeometrySpec::generic("Base"))
            .file("wheels/stars.png", payload)
            .to_bytes();
        let name = b"wheels/stars.png";
        let header = bytes
            .windows(name.len())
            .position(|window| window == name)
            .expect("local header name")
            - 30;
        let data = header + 30 + read_le(&bytes, header + 26, 2) + read_le(&bytes, header + 28, 2);
        let compressed = read_le(&bytes, header + 18, 4);
        (bytes, header, data, compressed)
    }

    /// Reports an archive cut off inside the wheel entry's compressed stream as corrupt,
    /// not as a disk failure.
    #[test]
    fn classifies_truncated_archive_as_corrupt() {
        let mut payload = PNG_SIGNATURE.to_vec();
        let mut state = 0x2545_f491_u32;
        payload.extend((0..4096).map(|_| {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (state >> 24) as u8
        }));
        let (bytes, header, data, compressed) = archive_with_stars(&payload);
        let kept = compressed / 2;
        let mut truncated = bytes[..data + kept].to_vec();
        truncated.extend_from_slice(&bytes[data + compressed..]);
        write_u32(&mut truncated, header + 18, kept);
        let central = data
            + kept
            + truncated[data + kept..]
                .windows(4)
                .rposition(|window| window == b"PK\x01\x02")
                .expect("central record");
        write_u32(&mut truncated, central + 20, kept);
        let end = truncated.len() - 22;
        let directory_offset = read_le(&truncated, end + 16, 4);
        write_u32(
            &mut truncated,
            end + 16,
            directory_offset - (compressed - kept),
        );

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("truncated.gdtf");
        std::fs::write(&path, truncated).unwrap();
        assert!(matches!(
            extract_wheel_media(&path, "stars"),
            Err(WheelMediaError::CorruptArchive(ZipError::Io(_)))
        ));
    }

    /// Reports an entry whose header is intact but whose compressed data is damaged as corrupt.
    #[test]
    fn classifies_damaged_entry_data_as_corrupt() {
        let (mut bytes, _, data, compressed) = archive_with_stars(PNG);
        bytes[data..data + compressed].fill(0xFF);
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("damaged.gdtf");
        std::fs::write(&path, bytes).unwrap();
        assert!(matches!(
            extract_wheel_media(&path, "stars"),
            Err(WheelMediaError::CorruptArchive(ZipError::Io(_)))
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
