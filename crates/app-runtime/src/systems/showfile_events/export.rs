// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Reusable, isolated showfile preparation for diagnostics and native showfile exports.

use std::{
    collections::HashMap,
    io::{Seek, Write},
    path::{Component, Path, PathBuf},
};

use nightfall_showfile::ShowfileSnapshot;
use serde::{Deserialize, Serialize};

use super::{
    backup::copy_directory_recursive,
    storage::{
        hash_showfile_snapshot_with_metadata, write_showfile_json_with_manifest_to_dir,
        write_showfile_snapshot_with_manifest_to_dir,
    },
};

#[cfg(test)]
mod tests;

/// Selects how much supporting data accompanies a captured showfile.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ShowfileExportPolicy {
    /// Write the captured snapshot and matching manifest only.
    ShowfileOnly,
    /// Preserve the active show directory's contents alongside the captured snapshot.
    ShowfileReferences,
    /// Also embed referenced assets from outside the active show directory.
    AllReferences,
}

/// Owns a prepared, loadable show directory until its caller copies or archives it.
pub struct PreparedShowfileExport {
    temporary: tempfile::TempDir,
    /// Missing or unsupported files that prevented a fully self-contained export.
    pub warnings: Vec<String>,
}

impl PreparedShowfileExport {
    /// Returns the standard show directory that can be copied or included in an archive.
    pub fn path(&self) -> PathBuf {
        self.temporary.path().join("showfile.nightfall-show")
    }

    /// Builds a downloadable archive with a named show folder and any export warnings beside it.
    pub fn write_zip(&self, name: &str) -> Result<tempfile::NamedTempFile, String> {
        let folder = super::paths::showfile_folder_name(Some(name))?;
        let mut file = tempfile::NamedTempFile::new().map_err(|error| error.to_string())?;
        let mut zip = zip::ZipWriter::new(file.as_file_mut());
        archive_directory(&mut zip, &self.path(), &folder)?;
        if !self.warnings.is_empty() {
            zip.start_file(
                "export-warnings.json",
                zip::write::SimpleFileOptions::default(),
            )
            .map_err(|error| error.to_string())?;
            serde_json::to_writer_pretty(&mut zip, &self.warnings)
                .map_err(|error| error.to_string())?;
        }
        zip.finish().map_err(|error| error.to_string())?;
        file.as_file_mut()
            .rewind()
            .map_err(|error| error.to_string())?;
        Ok(file)
    }

    /// Publishes a complete named copy beside a selected folder without replacing an existing show.
    pub fn write_to(&self, parent: &Path, name: &str) -> Result<PathBuf, String> {
        let folder = super::paths::showfile_folder_name(Some(name))?;
        let destination = parent.join(&folder);
        if destination
            .try_exists()
            .map_err(|error| error.to_string())?
        {
            return Err(format!(
                "{} already exists. Choose a different export name or folder.",
                destination.display()
            ));
        }
        let staging = tempfile::tempdir_in(parent).map_err(|error| error.to_string())?;
        let staged_show = staging.path().join(&folder);
        copy_directory_recursive(&self.path(), &staged_show)?;
        let snapshot = super::storage::read_showfile_snapshot_from_path(&staged_show)?;
        let hash = hash_showfile_snapshot_with_metadata(&snapshot, &snapshot.metadata)?;
        write_showfile_snapshot_with_manifest_to_dir(&snapshot, &staged_show, hash, None)?;
        if destination
            .try_exists()
            .map_err(|error| error.to_string())?
        {
            return Err(format!(
                "{} already exists. Choose a different export name or folder.",
                destination.display()
            ));
        }
        std::fs::rename(staged_show, &destination).map_err(|error| error.to_string())?;
        Ok(destination)
    }
}

/// Streams a prepared directory into a ZIP, preserving empty folders and returning its file inventory.
pub(crate) fn archive_directory<W: Write + Seek>(
    zip: &mut zip::ZipWriter<W>,
    source: &Path,
    name: &str,
) -> Result<Vec<String>, String> {
    let mut files = Vec::new();
    zip.add_directory(format!("{name}/"), zip::write::SimpleFileOptions::default())
        .map_err(|error| error.to_string())?;
    for entry in std::fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let kind = entry.file_type().map_err(|error| error.to_string())?;
        let entry_name = format!(
            "{name}/{}",
            entry
                .file_name()
                .to_str()
                .ok_or("Showfile filename is not valid Unicode")?
        );
        if kind.is_dir() {
            files.extend(archive_directory(zip, &entry.path(), &entry_name)?);
        } else if kind.is_file() {
            let compression =
                if entry.file_name() == super::paths::SHOWFILE_COMPRESSED_SNAPSHOT_FILENAME {
                    zip::CompressionMethod::Stored
                } else {
                    zip::CompressionMethod::Deflated
                };
            zip.start_file(
                &entry_name,
                zip::write::SimpleFileOptions::default().compression_method(compression),
            )
            .map_err(|error| error.to_string())?;
            let mut file = std::fs::File::open(entry.path()).map_err(|error| error.to_string())?;
            std::io::copy(&mut file, zip).map_err(|error| error.to_string())?;
            files.push(entry_name);
        } else {
            return Err(format!(
                "Unsupported archive entry: {}",
                entry.path().display()
            ));
        }
    }
    Ok(files)
}

/// Prepares a captured show without saving, pruning, or changing its source directory or live state.
pub fn prepare_showfile_export(
    mut snapshot: ShowfileSnapshot,
    source: &Path,
    app_data: &Path,
    policy: ShowfileExportPolicy,
) -> Result<PreparedShowfileExport, String> {
    let mut prepared = PreparedShowfileExport {
        temporary: tempfile::tempdir().map_err(|error| error.to_string())?,
        warnings: Vec::new(),
    };
    let destination = prepared.path();
    if policy != ShowfileExportPolicy::ShowfileOnly && source.exists() {
        copy_directory_recursive(source, &destination)?;
        remove_export_links(&destination, &mut prepared.warnings)?;
    } else {
        std::fs::create_dir(&destination).map_err(|error| error.to_string())?;
        if policy != ShowfileExportPolicy::ShowfileOnly {
            prepared.warnings.push(format!(
                "Showfile directory unavailable: {}",
                source.display()
            ));
        }
    }
    if policy == ShowfileExportPolicy::AllReferences {
        let mut collector = ReferenceCollector {
            destination: &destination,
            source,
            copied: HashMap::new(),
            warnings: &mut prepared.warnings,
        };
        collect_audio(&mut collector, &mut snapshot)?;
        collect_models(&mut collector, &mut snapshot, app_data)?;
        collect_modules(&mut collector, &snapshot, source, app_data)?;
        collect_fixtures(&mut collector, &snapshot, source, app_data)?;
    }
    let hash = hash_showfile_snapshot_with_metadata(&snapshot, &snapshot.metadata)?;
    write_showfile_json_with_manifest_to_dir(&snapshot, &destination, hash)?;
    Ok(prepared)
}

/// Removes copied symlinks before collecting assets so neither ZIP entries nor writes escape staging.
fn remove_export_links(directory: &Path, warnings: &mut Vec<String>) -> Result<(), String> {
    for entry in std::fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let kind = entry.file_type().map_err(|error| error.to_string())?;
        if kind.is_symlink() {
            warnings.push(format!("Symbolic link omitted: {}", entry.path().display()));
            std::fs::remove_file(entry.path()).map_err(|error| error.to_string())?;
        } else if kind.is_dir() {
            remove_export_links(&entry.path(), warnings)?;
        } else if !kind.is_file() {
            return Err(format!(
                "Unsupported showfile entry: {}",
                entry.path().display()
            ));
        }
    }
    Ok(())
}

/// Resolves a show-scoped asset without permitting traversal or links outside the show directory.
fn rooted_reference(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.is_empty()
        || relative.contains('\\')
        || !Path::new(relative)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err(format!("Unsafe showfile reference: {relative}"));
    }
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let path = root
        .join(relative)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !path.starts_with(root) {
        return Err(format!(
            "Reference escapes its source directory: {relative}"
        ));
    }
    Ok(path)
}

/// Copies each external asset once and assigns collision-free paths inside the prepared show.
struct ReferenceCollector<'a> {
    destination: &'a Path,
    source: &'a Path,
    copied: HashMap<(PathBuf, String), String>,
    warnings: &'a mut Vec<String>,
}

impl ReferenceCollector<'_> {
    /// Embeds an asset, recording inaccessible sources while treating destination failures as fatal.
    fn copy(
        &mut self,
        source: Result<PathBuf, String>,
        directory: &str,
        file_name: Option<&str>,
    ) -> Result<Option<String>, String> {
        let source = match source.and_then(|path| {
            path.canonicalize()
                .map_err(|error| format!("{}: {error}", path.display()))
        }) {
            Ok(source) => source,
            Err(error) => {
                self.warnings.push(error);
                return Ok(None);
            }
        };
        if let Ok(root) = self.source.canonicalize() {
            if let Ok(relative) = source.strip_prefix(root) {
                if file_name.is_none() && self.destination.join(relative).is_file() {
                    return Ok(Some(relative.to_string_lossy().replace('\\', "/")));
                }
            }
        }
        let key = (
            source.clone(),
            format!("{directory}/{}", file_name.unwrap_or_default()),
        );
        if let Some(name) = self.copied.get(&key) {
            return Ok(Some(name.clone()));
        }
        let mut file = match std::fs::File::open(&source).and_then(|file| {
            if file.metadata()?.is_file() {
                Ok(file)
            } else {
                Err(std::io::Error::other("not a regular file"))
            }
        }) {
            Ok(file) => file,
            Err(error) => {
                self.warnings.push(format!("{}: {error}", source.display()));
                return Ok(None);
            }
        };
        let name = match file_name {
            Some(file_name) => format!("{directory}/{file_name}"),
            None => {
                // OFL derives manufacturer identity from the filename before `@`.
                let mut name = std::ffi::OsString::from(source.file_stem().unwrap_or_default());
                name.push(format!("-{}", uuid::Uuid::new_v4().simple()));
                if let Some(extension) = source.extension() {
                    name.push(".");
                    name.push(extension);
                }
                format!("{directory}/{}", name.to_string_lossy())
            }
        };
        let target = self.destination.join(&name);
        std::fs::create_dir_all(target.parent().unwrap()).map_err(|error| error.to_string())?;
        let mut output = std::fs::File::create(&target).map_err(|error| error.to_string())?;
        std::io::copy(&mut file, &mut output).map_err(|error| error.to_string())?;
        self.copied.insert(key, name.clone());
        Ok(Some(name))
    }
}

/// Preserves local audio paths and embeds absolute audio references in the exported copy.
fn collect_audio(
    collector: &mut ReferenceCollector<'_>,
    snapshot: &mut ShowfileSnapshot,
) -> Result<(), String> {
    for timeline in &mut snapshot.timelines {
        let path = timeline.audio_path.trim();
        if path.is_empty() {
            continue;
        }
        if Path::new(path).is_absolute() {
            if let Some(name) = collector.copy(Ok(PathBuf::from(path)), "timeline-audio", None)? {
                timeline.audio_path = name;
            }
        } else if let Err(error) = rooted_reference(collector.destination, path) {
            collector.warnings.push(format!("Audio {path}: {error}"));
        }
    }
    Ok(())
}

/// Uses the existing object token codec to preserve local models and embed library bundles with textures.
fn collect_models(
    collector: &mut ReferenceCollector<'_>,
    snapshot: &mut ShowfileSnapshot,
    app_data: &Path,
) -> Result<(), String> {
    use nightfall_scene_objects::prelude::SceneObjectProperties;
    for object in &mut snapshot.scene_objects {
        let SceneObjectProperties::Custom(properties) = &mut object.properties else {
            continue;
        };
        let token = &properties.model_path;
        if token.is_empty() {
            continue;
        }
        #[cfg(feature = "object-library")]
        {
            use nightfall_object_library::manager::{
                ObjectModelPathScope, decode_object_path, encode_showfile_object_path,
            };
            let decoded = match decode_object_path(token) {
                Ok(decoded) => decoded,
                Err(error) => {
                    collector.warnings.push(format!("Model {token}: {error}"));
                    continue;
                }
            };
            match decoded.scope {
                ObjectModelPathScope::Library => {
                    if let Some(name) = collector.copy(
                        rooted_reference(&app_data.join("objects"), &decoded.bundle_filename),
                        "scene-objects",
                        None,
                    )? {
                        properties.model_path = encode_showfile_object_path(Path::new(&name));
                    }
                }
                ObjectModelPathScope::ShowfileData => {
                    if let Err(error) = rooted_reference(
                        &collector.destination.join("scene-objects"),
                        &decoded.bundle_filename,
                    ) {
                        collector.warnings.push(format!("Model {token}: {error}"));
                    }
                }
            }
        }
        #[cfg(not(feature = "object-library"))]
        {
            let _ = app_data;
            collector.warnings.push(format!(
                "Model {token}: object library support is unavailable"
            ));
        }
    }
    Ok(())
}

/// Embeds the referenced FX components under their module names for normal show-local runtime lookup.
fn collect_modules(
    collector: &mut ReferenceCollector<'_>,
    snapshot: &ShowfileSnapshot,
    source: &Path,
    app_data: &Path,
) -> Result<(), String> {
    for module in &snapshot.fx_module {
        let path = nightfall_fx_module::instances::fx_module_path_in(
            &module.module_name,
            Some(source),
            app_data,
        );
        let path = match path {
            Ok(path) => path,
            Err(error) => {
                collector.warnings.push(error.to_string());
                continue;
            }
        };
        let name = if module.module_name.ends_with(".wasm") {
            module.module_name.clone()
        } else {
            format!("{}.wasm", module.module_name)
        };
        collector.copy(Ok(path), "fx-modules", Some(&name))?;
    }
    Ok(())
}

/// Includes only fixture source files used by the snapshot, with show-local profiles taking precedence.
fn collect_fixtures(
    collector: &mut ReferenceCollector<'_>,
    snapshot: &ShowfileSnapshot,
    source: &Path,
    app_data: &Path,
) -> Result<(), String> {
    #[cfg(feature = "fixture-library")]
    {
        use nightfall_fixture_library::manager::FixtureLibraryManager;
        if snapshot.fixtures.is_empty() {
            return Ok(());
        }
        let library = match FixtureLibraryManager::read_from_directories(
            app_data.join("fixtures"),
            Some(source.to_owned()),
        ) {
            Ok(library) => library,
            Err(error) => {
                collector
                    .warnings
                    .push(format!("Fixture library unavailable: {error}"));
                return Ok(());
            }
        };
        for fixture in &snapshot.fixtures {
            // Package the revision the fixture was created from, not merely the newest one.
            match library.find_revision(
                &fixture.make,
                &fixture.model,
                fixture.library_asset_etag.as_deref(),
            ) {
                Some(profile) if !profile.file_path.as_os_str().is_empty() => {
                    collector.copy(Ok(profile.file_path.clone()), "fixtures", None)?;
                }
                Some(_) => {}
                None => collector.warnings.push(format!(
                    "Fixture source unavailable: {} {} ({})",
                    fixture.make, fixture.model, fixture.mode
                )),
            }
        }
    }
    #[cfg(not(feature = "fixture-library"))]
    {
        let _ = (source, app_data);
        if !snapshot.fixtures.is_empty() {
            collector
                .warnings
                .push("Fixture library support is unavailable".to_string());
        }
    }
    Ok(())
}
