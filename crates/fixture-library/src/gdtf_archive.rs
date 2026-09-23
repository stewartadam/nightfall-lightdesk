// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Immutable archive snapshots and content-bound compiled definitions.

use std::collections::HashSet;
use std::io::{Cursor, Read};
use std::path::Path;
use std::sync::Arc;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::gdtf_compiler::{CompileLimits, CompiledMode, compile_mode};
use crate::gdtf_resolver::ResolveError;

/// Bump when interpretation changes so cached compiled behavior cannot cross compiler revisions.
pub const COMPILER_VERSION: u32 = 2;
/// Version of the owned definition contract, independent of the GDTF input file's version.
pub const DEFINITION_SCHEMA_VERSION: u32 = 2;

/// Archive I/O limits applied before parser and geometry expansion budgets.
#[derive(Debug, Clone, Copy)]
pub struct ArchiveLimits {
    /// Maximum compressed archive bytes retained in memory.
    pub archive_bytes: u64,
    /// Maximum number of entries exposed by the ZIP index (raw duplicates require upstream validation).
    pub entries: usize,
    /// Maximum declared uncompressed size for an individual resource.
    pub entry_bytes: u64,
    /// Maximum declared uncompressed size across indexed entries.
    pub expanded_bytes: u64,
    /// Maximum actual description.xml bytes passed to the parser.
    pub description_bytes: u64,
}

impl Default for ArchiveLimits {
    /// Bound file loading and expansion while accommodating the curated archive collection.
    fn default() -> Self {
        Self {
            archive_bytes: 256 * 1024 * 1024,
            entries: 10_000,
            entry_bytes: 64 * 1024 * 1024,
            expanded_bytes: 512 * 1024 * 1024,
            description_bytes: 64 * 1024 * 1024,
        }
    }
}

/// Exact identity of a compiled archive/mode; paths and product labels are deliberately excluded.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionKey {
    archive_sha256: String,
    mode: String,
    compiler_version: u32,
    schema_version: u32,
}

impl DefinitionKey {
    /// Return the SHA-256 digest of all archive bytes, including resources.
    pub fn archive_sha256(&self) -> &str {
        &self.archive_sha256
    }
    /// Return the exact authored mode name without whitespace normalization.
    pub fn mode(&self) -> &str {
        &self.mode
    }
    /// Return the interpretation revision used to compile this definition.
    pub fn compiler_version(&self) -> u32 {
        self.compiler_version
    }
    /// Return the owned contract revision.
    pub fn schema_version(&self) -> u32 {
        self.schema_version
    }
}

/// Shared immutable input bytes; cloning does not reread a mutable library path.
#[derive(Debug, Clone)]
pub struct ArchiveSnapshot {
    bytes: Arc<[u8]>,
    sha256: String,
}

/// A parsed snapshot reusable for compiling several modes without reparsing XML.
#[derive(Debug)]
pub struct ParsedArchive {
    snapshot: ArchiveSnapshot,
    description: gdtf::Description,
}

/// Content-bound mode retaining its exact source bytes for subsequent resource loading.
/// Diagnostic serialization excludes the archive bytes; persistence must package them separately.
#[derive(Debug, Serialize)]
pub struct CompiledDefinition {
    key: DefinitionKey,
    mode: CompiledMode,
    #[serde(skip)]
    archive: ArchiveSnapshot,
}

/// Report archive failures before any compiled definition can be published.
fn error(code: &'static str, path: &str, message: impl Into<String>) -> ResolveError {
    ResolveError {
        code,
        path: path.into(),
        message: message.into(),
    }
}

impl ArchiveSnapshot {
    /// Read at most the archive budget plus one byte, then hash the exact retained snapshot.
    pub fn read(path: &Path, limit: u64) -> Result<Self, ResolveError> {
        let path_label = path.to_string_lossy();
        let file = std::fs::File::open(path)
            .map_err(|err| error("archive_io", &path_label, err.to_string()))?;
        let mut bytes = Vec::new();
        file.take(limit.saturating_add(1))
            .read_to_end(&mut bytes)
            .map_err(|err| error("archive_io", &path_label, err.to_string()))?;
        Self::from_bytes(bytes, limit)
    }

    /// Retain caller-owned bytes after checking their size; ZIP/XML validity is checked by parse.
    pub fn from_bytes(bytes: Vec<u8>, limit: u64) -> Result<Self, ResolveError> {
        if bytes.len() as u64 > limit {
            return Err(error(
                "archive_size_limit",
                "archive",
                "Archive exceeds the byte budget",
            ));
        }
        let sha256 = format!("{:x}", Sha256::digest(&bytes));
        Ok(Self {
            bytes: bytes.into(),
            sha256,
        })
    }

    /// Inspect immutable content identity without accessing the original path.
    pub fn sha256(&self) -> &str {
        &self.sha256
    }

    /// Inspect retained archive bytes for exact resource loading or showfile packaging.
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// Check indexed ZIP budgets and decoded name collisions, then parse bounded XML with the existing GDTF parser.
    /// The ZIP dependency collapses identical raw names before indexing; rejecting those remains an upstream requirement.
    pub fn parse(self, limits: ArchiveLimits) -> Result<ParsedArchive, ResolveError> {
        if self.bytes.len() as u64 > limits.archive_bytes {
            return Err(error(
                "archive_size_limit",
                &self.sha256,
                "Archive exceeds the byte budget",
            ));
        }
        let mut archive = zip::ZipArchive::new(Cursor::new(self.bytes.clone()))
            .map_err(|err| error("invalid_archive", &self.sha256, err.to_string()))?;
        if archive.len() > limits.entries {
            return Err(error(
                "archive_entry_limit",
                &self.sha256,
                "Archive has too many entries",
            ));
        }
        let mut names = HashSet::new();
        let mut expanded = 0u64;
        for index in 0..archive.len() {
            let entry = archive
                .by_index(index)
                .map_err(|err| error("invalid_archive_entry", &self.sha256, err.to_string()))?;
            if !names.insert(entry.name().to_owned()) {
                return Err(error(
                    "duplicate_archive_entry",
                    entry.name(),
                    "Archive entry names must be unique",
                ));
            }
            if entry.size() > limits.entry_bytes {
                return Err(error(
                    "archive_entry_size_limit",
                    entry.name(),
                    "Declared resource exceeds the byte budget",
                ));
            }
            expanded = expanded
                .checked_add(entry.size())
                .filter(|size| *size <= limits.expanded_bytes)
                .ok_or_else(|| {
                    error(
                        "archive_expansion_limit",
                        &self.sha256,
                        "Declared archive expansion exceeds the byte budget",
                    )
                })?;
        }
        let description_file = archive
            .by_name("description.xml")
            .map_err(|err| error("missing_description", &self.sha256, err.to_string()))?;
        if description_file.size() > limits.description_bytes {
            return Err(error(
                "description_size_limit",
                &self.sha256,
                "Description exceeds the XML byte budget",
            ));
        }
        let mut xml = String::new();
        description_file
            .take(limits.description_bytes.saturating_add(1))
            .read_to_string(&mut xml)
            .map_err(|err| error("description_read", &self.sha256, err.to_string()))?;
        if xml.len() as u64 > limits.description_bytes {
            return Err(error(
                "description_size_limit",
                &self.sha256,
                "Description exceeds the XML byte budget",
            ));
        }
        let description: gdtf::Description = xml
            .parse()
            .map_err(|err| error("description_parse", &self.sha256, format!("{err}")))?;
        if description.fixture_types.len() != 1 {
            return Err(error(
                "ambiguous_fixture_type",
                &self.sha256,
                "Archive must describe exactly one fixture type",
            ));
        }
        Ok(ParsedArchive {
            snapshot: self,
            description,
        })
    }
}

impl ParsedArchive {
    /// Construct the prospective identity used for cache lookup; compile still validates the mode exists.
    pub fn definition_key(&self, mode: &str) -> DefinitionKey {
        DefinitionKey {
            archive_sha256: self.snapshot.sha256.clone(),
            mode: mode.into(),
            compiler_version: COMPILER_VERSION,
            schema_version: DEFINITION_SCHEMA_VERSION,
        }
    }

    /// Inspect the single validated fixture type for metadata and resource compilation.
    pub fn fixture(&self) -> &gdtf::fixture_type::FixtureType {
        &self.description.fixture_types[0]
    }

    /// Compile one mode and bind its key to the very same snapshot that supplied its source data.
    pub fn compile(
        &self,
        mode: &str,
        limits: CompileLimits,
    ) -> Result<CompiledDefinition, ResolveError> {
        let compiled = compile_mode(self.fixture(), mode, limits)?;
        Ok(CompiledDefinition {
            key: self.definition_key(compiled.name()),
            mode: compiled,
            archive: self.snapshot.clone(),
        })
    }
}

impl CompiledDefinition {
    /// Inspect the content and version key that must accompany runtime and geometry messages.
    pub fn key(&self) -> &DefinitionKey {
        &self.key
    }
    /// Inspect immutable compiled semantics and geometry.
    pub fn mode(&self) -> &CompiledMode {
        &self.mode
    }
    /// Access pinned source bytes without reopening a library path.
    pub fn archive(&self) -> &ArchiveSnapshot {
        &self.archive
    }
}
