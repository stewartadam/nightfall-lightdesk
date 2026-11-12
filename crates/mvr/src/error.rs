// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Errors raised while reading an MVR archive.

use thiserror::Error;

/// Reasons an MVR archive or one of its files cannot be read.
#[derive(Debug, Error)]
pub enum MvrError {
    /// The file is not a readable zip archive.
    #[error("not a valid MVR archive: {0}")]
    Zip(#[from] zip::result::ZipError),

    /// Reading from the underlying file failed.
    #[error("failed to read MVR archive: {0}")]
    Io(#[from] std::io::Error),

    /// The archive has no `GeneralSceneDescription.xml` at its root.
    #[error("the archive has no GeneralSceneDescription.xml, so it is not an MVR file")]
    MissingSceneDescription,

    /// The scene description is not valid UTF-8.
    #[error("GeneralSceneDescription.xml is not valid UTF-8")]
    InvalidEncoding,

    /// The scene description is not well-formed or does not follow the MVR schema.
    #[error("GeneralSceneDescription.xml could not be read: {0}")]
    Xml(#[from] quick_xml::DeError),

    /// The scene description nests elements deeper than this reader allows.
    #[error("GeneralSceneDescription.xml nests elements more than {limit} levels deep")]
    TooDeeplyNested {
        /// Deepest nesting allowed.
        limit: usize,
    },

    /// The file was written with a major MVR version this reader does not understand.
    #[error("MVR version {major}.{minor} is not supported (only version 1.x is)")]
    UnsupportedVersion {
        /// Major version from the file.
        major: u32,
        /// Minor version from the file.
        minor: u32,
    },

    /// The archive holds more files than the configured limit.
    #[error("the archive holds {count} files, more than the limit of {limit}")]
    TooManyFiles {
        /// Number of files in the archive.
        count: usize,
        /// Configured limit.
        limit: usize,
    },

    /// The files in the archive would expand past the configured total size.
    #[error("the archive would expand to {size} bytes, more than the limit of {limit}")]
    ArchiveTooLarge {
        /// Declared total uncompressed size.
        size: u64,
        /// Configured limit.
        limit: u64,
    },

    /// A file in the archive is larger than the configured limit for one file.
    #[error("{name} expands past the limit of {limit} bytes")]
    FileTooLarge {
        /// File name inside the archive.
        name: String,
        /// Configured limit.
        limit: u64,
    },

    /// No file with that name exists in the archive.
    #[error("{0} is not in the archive")]
    FileNotFound(String),

    /// The file is encrypted, which MVR does not allow.
    #[error("{0} is encrypted, which MVR does not allow")]
    Encrypted(String),

    /// The file uses a compression method other than STORE or DEFLATE.
    #[error("{name} uses compression method {method}, but MVR only allows STORE and DEFLATE")]
    UnsupportedCompression {
        /// File name inside the archive.
        name: String,
        /// Compression method reported by the archive.
        method: String,
    },
}
