// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Opening `.mvr` archives and reading the files inside them.
//!
//! MVR files come from other people's tools, so the archive is treated as untrusted:
//! the number of files, the declared total size and every file actually read are capped,
//! and nothing is ever extracted to disk by its archive name.

use std::collections::HashMap;
use std::io::{Read, Seek};

use zip::{CompressionMethod, ZipArchive};

use crate::error::MvrError;
use crate::scene::{GeneralSceneDescription, Scene};

/// Name of the scene description every MVR archive holds at its root.
pub const SCENE_DESCRIPTION: &str = "GeneralSceneDescription.xml";

/// Largest buffer reserved up front when reading a file, whatever size it declares.
const INITIAL_READ_CAPACITY: u64 = 1 << 20;

/// Size caps applied while opening and reading an archive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArchiveLimits {
    /// Most files the archive may hold.
    pub max_files: usize,
    /// Largest declared total uncompressed size of all files, in bytes.
    pub max_total_size: u64,
    /// Largest size one file may expand to when read, in bytes.
    pub max_file_size: u64,
}

impl Default for ArchiveLimits {
    /// Limits roomy enough for large venue models: 65 536 files, 4 GiB in total and
    /// 1 GiB per file.
    fn default() -> Self {
        Self {
            max_files: 65_536,
            max_total_size: 4 << 30,
            max_file_size: 1 << 30,
        }
    }
}

/// Departures from the MVR archive rules that do not stop the file from being read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArchiveWarning {
    /// A file sits in a folder, though MVR puts every file at the root.
    FileInFolder(String),
    /// Two entries have exactly the same name; only the first can be read.
    DuplicateName(String),
    /// Two file names differ only by case, which MVR forbids; lookups that ignore case
    /// find the first.
    CaseInsensitiveDuplicate {
        /// Name kept for case-insensitive lookups.
        kept: String,
        /// Name that clashes with it.
        duplicate: String,
    },
    /// A file is encrypted and cannot be read.
    Encrypted(String),
    /// A file uses a compression method other than STORE or DEFLATE and cannot be read.
    UnsupportedCompression {
        /// File name inside the archive.
        name: String,
        /// Compression method reported by the archive.
        method: String,
    },
}

/// An opened `.mvr` archive with its parsed scene description.
pub struct MvrArchive<R> {
    zip: ZipArchive<R>,
    description: GeneralSceneDescription,
    limits: ArchiveLimits,
    /// Name of each entry, by archive index.
    names: Vec<String>,
    /// Exact file name to its entry index.
    by_name: HashMap<String, usize>,
    /// Lowercased file name to the index of the first entry with that name.
    by_lowercase_name: HashMap<String, usize>,
    warnings: Vec<ArchiveWarning>,
}

impl<R: Read + Seek> MvrArchive<R> {
    /// Opens an archive with the default [`ArchiveLimits`] and parses its scene.
    pub fn open(reader: R) -> Result<Self, MvrError> {
        Self::open_with_limits(reader, ArchiveLimits::default())
    }

    /// Opens an archive, checks it against `limits` and parses its scene description.
    ///
    /// Fails when the archive is not a zip, breaks a limit, has no readable
    /// `GeneralSceneDescription.xml` or was written with an unsupported major version.
    /// Files that break MVR rules without blocking the import are reported by
    /// [`MvrArchive::warnings`].
    pub fn open_with_limits(reader: R, limits: ArchiveLimits) -> Result<Self, MvrError> {
        let mut zip = ZipArchive::new(reader)?;
        if zip.len() > limits.max_files {
            return Err(MvrError::TooManyFiles {
                count: zip.len(),
                limit: limits.max_files,
            });
        }

        let mut warnings = Vec::new();
        let mut names = Vec::with_capacity(zip.len());
        let mut by_name = HashMap::new();
        let mut by_lowercase_name: HashMap<String, usize> = HashMap::new();
        let mut total_size: u64 = 0;
        for index in 0..zip.len() {
            let entry = zip.by_index_raw(index)?;
            let name = entry.name()?.to_string();
            names.push(name.clone());
            if entry.is_dir() {
                continue;
            }
            by_name.entry(name.clone()).or_insert(index);
            total_size = total_size.saturating_add(entry.size());
            if name.contains('/') || name.contains('\\') {
                warnings.push(ArchiveWarning::FileInFolder(name.clone()));
            }
            if entry.encrypted() {
                warnings.push(ArchiveWarning::Encrypted(name.clone()));
            }
            if !is_allowed_compression(entry.compression()) {
                warnings.push(ArchiveWarning::UnsupportedCompression {
                    name: name.clone(),
                    method: entry.compression().to_string(),
                });
            }
            let key = name.to_lowercase();
            match by_lowercase_name.get(&key) {
                Some(&kept_index) if names[kept_index] == name => {
                    warnings.push(ArchiveWarning::DuplicateName(name));
                }
                Some(&kept_index) => {
                    let kept = names[kept_index].clone();
                    warnings.push(ArchiveWarning::CaseInsensitiveDuplicate {
                        kept,
                        duplicate: name,
                    });
                }
                None => {
                    by_lowercase_name.insert(key, index);
                }
            }
        }
        if total_size > limits.max_total_size {
            return Err(MvrError::ArchiveTooLarge {
                size: total_size,
                limit: limits.max_total_size,
            });
        }

        let xml = match by_lowercase_name.get(&SCENE_DESCRIPTION.to_lowercase()) {
            Some(&index) => read_entry(&mut zip, index, limits.max_file_size)?,
            None => return Err(MvrError::MissingSceneDescription),
        };
        let xml = String::from_utf8(xml).map_err(|_| MvrError::InvalidEncoding)?;
        let description = GeneralSceneDescription::from_xml(&xml)?;
        Ok(Self {
            zip,
            description,
            limits,
            names,
            by_name,
            by_lowercase_name,
            warnings,
        })
    }

    /// Returns the parsed scene description, including the file's version and provider.
    pub fn description(&self) -> &GeneralSceneDescription {
        &self.description
    }

    /// Returns the scene: layers, objects and shared definitions.
    pub fn scene(&self) -> &Scene {
        &self.description.scene
    }

    /// Returns the MVR rule violations found while opening the archive.
    pub fn warnings(&self) -> &[ArchiveWarning] {
        &self.warnings
    }

    /// Returns the names of every file in the archive, in archive order.
    pub fn file_names(&self) -> impl Iterator<Item = &str> {
        self.names.iter().map(String::as_str)
    }

    /// Finds the archive's name for `name`: an exact match, or else the file whose name
    /// differs only by case.
    pub fn find_file(&self, name: &str) -> Option<&str> {
        self.find_index(name)
            .and_then(|index| self.names.get(index))
            .map(String::as_str)
    }

    /// Finds the archive file a fixture's `GDTFSpec` refers to.
    ///
    /// The spec asks for the full file name, but exporters often leave out the `.gdtf`
    /// extension, so the name is tried as written and then with `.gdtf` appended.
    pub fn find_gdtf(&self, gdtf_spec: &str) -> Option<&str> {
        let has_extension = gdtf_spec
            .rsplit_once('.')
            .is_some_and(|(_, extension)| extension.eq_ignore_ascii_case("gdtf"));
        if has_extension {
            return self.find_file(gdtf_spec);
        }
        self.find_file(&format!("{gdtf_spec}.gdtf"))
            .or_else(|| self.find_file(gdtf_spec))
    }

    /// Reads a whole file from the archive, looking the name up as [`Self::find_file`]
    /// does.
    ///
    /// Fails when the file is missing, encrypted, compressed with a method MVR does not
    /// allow, or expands past [`ArchiveLimits::max_file_size`], whatever size the archive
    /// declares for it.
    pub fn read_file(&mut self, name: &str) -> Result<Vec<u8>, MvrError> {
        let index = self
            .find_index(name)
            .ok_or_else(|| MvrError::FileNotFound(name.to_string()))?;
        read_entry(&mut self.zip, index, self.limits.max_file_size)
    }

    /// Returns the entry index for `name`: an exact match, or else the first entry whose
    /// name differs only by case.
    fn find_index(&self, name: &str) -> Option<usize> {
        self.by_name
            .get(name)
            .or_else(|| self.by_lowercase_name.get(&name.to_lowercase()))
            .copied()
    }
}

/// Reads the archive entry at `index` in full.
///
/// Fails when the entry is encrypted, compressed with a method MVR does not allow, or
/// expands past `limit` bytes, whatever size the archive declares for it.
fn read_entry<R: Read + Seek>(
    zip: &mut ZipArchive<R>,
    index: usize,
    limit: u64,
) -> Result<Vec<u8>, MvrError> {
    {
        let raw = zip.by_index_raw(index)?;
        let name = raw.name()?.to_string();
        if raw.encrypted() {
            return Err(MvrError::Encrypted(name));
        }
        if !is_allowed_compression(raw.compression()) {
            return Err(MvrError::UnsupportedCompression {
                name,
                method: raw.compression().to_string(),
            });
        }
    }
    let entry = zip.by_index(index)?;
    let name = entry.name()?.to_string();
    // The declared size is untrusted, so it only sizes the first allocation up to a cap.
    let initial_capacity = entry.size().min(limit).min(INITIAL_READ_CAPACITY) as usize;
    let mut contents = Vec::with_capacity(initial_capacity);
    entry
        .take(limit.saturating_add(1))
        .read_to_end(&mut contents)?;
    if contents.len() as u64 > limit {
        return Err(MvrError::FileTooLarge { name, limit });
    }
    Ok(contents)
}

/// Whether MVR allows this compression method.
fn is_allowed_compression(method: CompressionMethod) -> bool {
    matches!(
        method,
        CompressionMethod::Stored | CompressionMethod::Deflated
    )
}
