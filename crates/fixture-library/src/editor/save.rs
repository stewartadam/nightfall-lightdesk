// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Opening library files as drafts, previewing drafts and saving them as GDTF archives.

use std::io::{Cursor, Read};
use std::path::PathBuf;

use nightfall_engine::prelude::CommandError;

use super::commands::{DraftId, DraftPreviewResponse};
use super::draft::{DraftState, FixtureDraft};
use super::problems::has_errors;
use crate::GdtfMetadata;
use crate::commands::{AvailableFixtureInfo, FixtureLibraryEntry, GetFixtureProfileResponse};
use crate::converters::gdtf::convert_gdtf_mode;
use crate::gdtf_repair::repair_description;
use crate::gdtf_write::{DESCRIPTION_ENTRY, lost_content, rebuild_archive};
use crate::manager::{FixtureLibraryManager, FixtureSource};

/// Software name recorded in the revisions a save appends.
const MODIFIED_BY: &str = concat!("Nightfall ", env!("CARGO_PKG_VERSION"));

/// A library file read for editing.
pub(super) struct OpenedSource {
    /// Parsed description.
    pub state: DraftState,
    /// Archive that parses, with load-time repairs applied when the file needed them.
    pub archive: Vec<u8>,
    /// Path of the library file.
    pub path: PathBuf,
    /// Parts of the description a save drops.
    pub lost_content: Vec<String>,
}

/// Builds a command error with a fixture-editor code.
pub(super) fn editor_error(code: &str, message: impl Into<String>) -> CommandError {
    CommandError::new(format!("fixture_editor.{code}"), message.into())
}

/// Reads a GDTF library fixture into a draft state.
///
/// The file is read once; later changes to it on disk do not reach the
/// draft. Only GDTF sources can be edited.
pub(super) fn open_library_fixture(
    library: &FixtureLibraryManager,
    entry: &FixtureLibraryEntry,
) -> Result<OpenedSource, CommandError> {
    let profile = library
        .find_revision(&entry.make, &entry.model, entry.asset_etag.as_deref())
        .ok_or_else(|| {
            editor_error(
                "not_found",
                format!(
                    "{} {} is not in the fixture library",
                    entry.make, entry.model
                ),
            )
        })?;
    if !matches!(profile.source, FixtureSource::Gdtf(_)) {
        return Err(editor_error(
            "unsupported_source",
            format!(
                "{} {} is not a GDTF file; only GDTF fixtures can be edited",
                entry.make, entry.model
            ),
        ));
    }
    let bytes = std::fs::read(&profile.file_path).map_err(|error| {
        editor_error(
            "read_failed",
            format!("Failed to read {}: {error}", profile.file_path.display()),
        )
    })?;
    let (archive, description, xml) = parseable_archive(bytes).map_err(|error| {
        editor_error(
            "read_failed",
            format!("Failed to read the GDTF file: {error}"),
        )
    })?;
    if description.fixture_types.is_empty() {
        return Err(editor_error(
            "read_failed",
            "The GDTF file has no fixture type",
        ));
    }
    Ok(OpenedSource {
        state: DraftState {
            description,
            body: None,
        },
        archive,
        path: profile.file_path.clone(),
        lost_content: lost_content(&xml).unwrap_or_default(),
    })
}

/// Parses an archive, applying load-time repairs when strict parsing fails.
///
/// Returns the archive that parses, its description, and the description
/// XML that was parsed.
fn parseable_archive(bytes: Vec<u8>) -> Result<(Vec<u8>, gdtf::Description, String), String> {
    let mut source =
        zip::ZipArchive::new(Cursor::new(bytes.as_slice())).map_err(|error| error.to_string())?;
    let mut xml = String::new();
    source
        .by_name(DESCRIPTION_ENTRY)
        .map_err(|error| error.to_string())?
        .read_to_string(&mut xml)
        .map_err(|error| error.to_string())?;
    let strict = match xml.parse::<gdtf::Description>() {
        Ok(description) => return Ok((bytes, description, xml)),
        Err(error) => error.to_string(),
    };
    let Some((repaired, _)) = repair_description(&xml).filter(|(_, repairs)| !repairs.is_empty())
    else {
        return Err(strict);
    };
    let description = repaired
        .parse::<gdtf::Description>()
        .map_err(|error| format!("{strict} (after repairs: {error})"))?;
    let archive = rebuild_archive(&mut source, &repaired, true)?;
    Ok((archive, description, repaired))
}

/// Builds an archive holding only a description.
fn description_archive(xml: &str) -> Result<Vec<u8>, String> {
    let mut stub =
        zip::ZipArchive::new(Cursor::new(empty_zip()?)).map_err(|error| error.to_string())?;
    rebuild_archive(&mut stub, xml, false)
}

/// Bytes of a zip archive with no entries.
fn empty_zip() -> Result<Vec<u8>, String> {
    Ok(zip::ZipWriter::new(Cursor::new(Vec::new()))
        .finish()
        .map_err(|error| error.to_string())?
        .into_inner())
}

/// Builds a parsed GDTF file holding the draft's current description.
///
/// With `with_resources`, the file reads models and images from the
/// archive the draft was opened from; otherwise it has no resources.
pub(super) fn gdtf_file(
    draft: &FixtureDraft,
    with_resources: bool,
) -> Result<gdtf::GdtfFile, String> {
    let archive = match (&draft.source_archive, with_resources) {
        (Some(archive), true) => archive.clone(),
        _ => description_archive(r#"<GDTF DataVersion="1.2"/>"#)?,
    };
    let mut file = gdtf::GdtfFile::new(Cursor::new(archive)).map_err(|error| error.to_string())?;
    file.description = draft.description().clone();
    Ok(file)
}

/// Library metadata describing the draft, as the converter expects.
///
/// Mesh URLs in converted geometry point at the source file, which the
/// library already serves.
pub(super) fn metadata(draft: &FixtureDraft) -> GdtfMetadata {
    let fixture_type = draft.fixture_type();
    GdtfMetadata {
        manufacturer: fixture_type.manufacturer.clone(),
        model: model_name(fixture_type),
        modes: fixture_type
            .dmx_modes
            .iter()
            .filter_map(|mode| mode.name.as_ref().map(ToString::to_string))
            .collect(),
        fixture_type_id: Some(fixture_type.fixture_type_id)
            .filter(|id| !id.is_nil())
            .map(|id| id.to_string()),
        file_path: draft
            .source_path
            .clone()
            .unwrap_or_else(|| PathBuf::from(default_file_name(fixture_type))),
    }
}

/// Model name the library lists a fixture type under: its long name, or its name when that is empty.
fn model_name(fixture_type: &gdtf::fixture_type::FixtureType) -> String {
    if fixture_type.long_name.trim().is_empty() {
        fixture_type
            .name
            .as_ref()
            .map(ToString::to_string)
            .unwrap_or_default()
    } else {
        fixture_type.long_name.clone()
    }
}

/// Converts one mode of a draft into a preview fixture and geometry.
pub(super) fn preview(
    draft: &FixtureDraft,
    mode: Option<&str>,
) -> Result<DraftPreviewResponse, CommandError> {
    let metadata = metadata(draft);
    let mode = match mode {
        Some(mode) => mode.to_string(),
        None => metadata
            .modes
            .first()
            .cloned()
            .ok_or_else(|| editor_error("no_modes", "The draft has no modes to preview"))?,
    };
    let mut gdtf = gdtf_file(draft, true).map_err(|error| editor_error("preview_failed", error))?;
    let converted = convert_gdtf_mode(&mut gdtf, &metadata, &mode, 0).map_err(|error| {
        editor_error(
            "preview_failed",
            format!("Failed to preview {mode}: {error}"),
        )
    })?;
    Ok(DraftPreviewResponse {
        draft_id: draft.id,
        profile: GetFixtureProfileResponse {
            info: AvailableFixtureInfo {
                make: metadata.manufacturer.clone(),
                model: metadata.model.clone(),
                modes: metadata.modes.clone(),
                source_format: "GDTF".to_string(),
                asset_etag: draft_etag(draft.id),
                gdtf_fixture_type_id: metadata.fixture_type_id.clone(),
            },
            requested_mode: Some(mode),
            fixture: Some(converted.fixture),
            geometry: converted.geometry,
        },
    })
}

/// Revision tag of a preview, distinct from every library revision.
fn draft_etag(id: DraftId) -> String {
    format!("draft-{id}")
}

/// File name a save uses when none is given: `Manufacturer@Name.gdtf`.
pub(super) fn default_file_name(fixture_type: &gdtf::fixture_type::FixtureType) -> String {
    let name = fixture_type
        .name
        .as_ref()
        .map(ToString::to_string)
        .unwrap_or_default();
    safe_file_name(&format!("{}@{name}", fixture_type.manufacturer))
}

/// Turns text into a `.gdtf` file name without path separators or characters file systems reject.
fn safe_file_name(text: &str) -> String {
    let text = text.trim();
    let stem = if text.to_ascii_lowercase().ends_with(".gdtf") {
        &text[..text.len() - ".gdtf".len()]
    } else {
        text
    };
    let stem: String = stem
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || " -_@().,+".contains(character) {
                character
            } else {
                '_'
            }
        })
        .collect();
    let stem = stem.trim_matches(|character: char| character == '.' || character.is_whitespace());
    format!("{}.gdtf", if stem.is_empty() { "fixture" } else { stem })
}

/// Options of one save.
pub(super) struct SaveRequest<'a> {
    /// File name to save as.
    pub file_name: Option<&'a str>,
    /// Replace an existing library file.
    pub overwrite: bool,
    /// Revision note.
    pub note: Option<&'a str>,
}

/// Writes a draft into the user fixture library and marks it saved.
///
/// The save appends a revision entry and keeps every resource of the source
/// archive. It is refused while the draft has errors, and, unless
/// `overwrite` is set, when the target file exists and is not one this draft
/// wrote.
pub(super) fn save(
    draft: &mut FixtureDraft,
    library: &FixtureLibraryManager,
    request: SaveRequest<'_>,
) -> Result<PathBuf, CommandError> {
    let problems = draft.problems();
    if has_errors(problems) {
        return Err(editor_error(
            "has_errors",
            "Fix the problems listed for the draft before saving",
        )
        .with_details(serde_json::json!({ "problems": problems })));
    }
    let file_name = match (request.file_name, &draft.file_name) {
        (Some(name), _) => safe_file_name(name),
        (None, Some(name)) => name.clone(),
        (None, None) => default_file_name(draft.fixture_type()),
    };
    let target = library.library_path().join(&file_name);
    let wrote_it = draft.saved_file.as_deref() == Some(file_name.as_str());
    if target.exists() && !request.overwrite && !wrote_it {
        return Err(editor_error(
            "file_exists",
            format!("{file_name} is already in the fixture library"),
        )
        .with_details(serde_json::json!({ "file_name": file_name })));
    }

    let revision = gdtf::revision::Revision {
        text: request
            .note
            .map(str::trim)
            .filter(|note| !note.is_empty())
            .unwrap_or("Edited in the Nightfall fixture editor")
            .to_string(),
        date: jiff::Timestamp::now()
            .strftime("%Y-%m-%dT%H:%M:%S")
            .to_string(),
        user_id: 0,
        modified_by: MODIFIED_BY.to_string(),
    };
    let mut description = draft.description().clone();
    description.fixture_types[0]
        .revisions
        .push(revision.clone());
    let bytes = archive_bytes(draft.source_archive.as_deref(), &description).map_err(|error| {
        editor_error(
            "save_failed",
            format!("Failed to build {file_name}: {error}"),
        )
    })?;
    let path = library
        .upload_fixture(&file_name, &bytes)
        .map_err(|error| {
            editor_error(
                "save_failed",
                format!("Failed to save {file_name}: {error}"),
            )
        })?;
    draft.mark_saved(file_name, revision);
    Ok(path)
}

/// Serializes a description into an archive, keeping the source archive's resources when there is one.
fn archive_bytes(
    source: Option<&[u8]>,
    description: &gdtf::Description,
) -> Result<Vec<u8>, String> {
    let xml = description.to_string().map_err(|error| error.to_string())?;
    xml.parse::<gdtf::Description>()
        .map_err(|error| format!("the written description does not read back: {error}"))?;
    match source {
        Some(source) => {
            let mut archive =
                zip::ZipArchive::new(Cursor::new(source)).map_err(|error| error.to_string())?;
            rebuild_archive(&mut archive, &xml, true)
        }
        None => description_archive(&xml),
    }
}
