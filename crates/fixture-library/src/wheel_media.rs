// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Loads source wheel images without embedding image bytes in fixture state messages.

use std::{io::Read, path::Path};

/// Failure to resolve or read one source wheel image.
#[derive(Debug, thiserror::Error)]
pub enum WheelMediaError {
    /// The archive could not be opened.
    #[error("fixture archive unavailable")]
    ArchiveUnavailable,
    /// The archive could not be parsed as GDTF.
    #[error("invalid fixture archive")]
    InvalidArchive,
    /// The named media was absent.
    #[error("wheel image not found")]
    NotFound,
    /// The resource could not be read as a bounded PNG payload.
    #[error("invalid wheel image")]
    InvalidImage,
}

/// Extracts one PNG during fixture setup; callers should run archive I/O off async executor threads.
pub fn extract_wheel_media(path: &Path, name: &str) -> Result<Vec<u8>, WheelMediaError> {
    let file = std::fs::File::open(path).map_err(|_| WheelMediaError::ArchiveUnavailable)?;
    let mut fixture = gdtf::GdtfFile::new(file).map_err(|_| WheelMediaError::InvalidArchive)?;
    let resource = fixture
        .resources
        .read_wheel_media(name)
        .map_err(|_| WheelMediaError::NotFound)?;
    const MAX_BYTES: u64 = 16 * 1024 * 1024;
    if resource.size() > MAX_BYTES {
        return Err(WheelMediaError::InvalidImage);
    }
    let mut data = Vec::with_capacity(resource.size() as usize);
    resource
        .take(MAX_BYTES + 1)
        .read_to_end(&mut data)
        .map_err(|_| WheelMediaError::InvalidImage)?;
    if data.len() > MAX_BYTES as usize || !data.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(WheelMediaError::InvalidImage);
    }
    Ok(data)
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    /// Builds a tiny owned archive to exercise real GDTF resource lookup and error handling.
    #[test]
    fn extracts_named_wheel_media_without_substitution() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("optics.gdtf");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("description.xml", options).unwrap();
        zip.write_all(br#"<GDTF DataVersion="1.2"></GDTF>"#)
            .unwrap();
        zip.start_file("wheels/pattern.png", options).unwrap();
        let png = b"\x89PNG\r\n\x1a\nsource-payload";
        zip.write_all(png).unwrap();
        zip.start_file("wheels/invalid.png", options).unwrap();
        zip.write_all(b"not a PNG").unwrap();
        zip.finish().unwrap();
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
}
