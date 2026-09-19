// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Showfile lifecycle composition and public integration facade.
//!
//! Responsibility-focused child modules own command routing, persistence, replacement loading,
//! snapshot contracts, revisions, imports, draft management, assets, and operator feedback.

#[cfg(test)]
use std::path::Path;

use bevy::ecs::hierarchy::ChildOf;
use bevy::ecs::observer::Observer;
use bevy::ecs::resource::IsResource;
use bevy::ecs::system::RunSystemOnce;
use bevy::prelude::*;
use nightfall::prelude::*;
use nightfall_compositor::prelude::*;
use nightfall_cues::prelude::*;
use nightfall_desk::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_fixtures::prelude::*;
use nightfall_flow::prelude::*;
use nightfall_fx::prelude::*;
use nightfall_fx_module::prelude::*;
#[cfg(feature = "midi")]
use nightfall_input_midi::prelude::*;
#[cfg(feature = "osc")]
use nightfall_input_osc::prelude::*;
use nightfall_io::IoRuntimeSettings;
use nightfall_programmer::prelude::*;
use nightfall_scene_objects::prelude::*;
use nightfall_timecode::prelude::*;
use nightfall_timeline::prelude::*;
use nightfall_undo::prelude::*;

/// Compiled-in file staged with a newly created show before its draft is published.
#[derive(Debug)]
pub(crate) struct InitialShowfileAsset {
    /// Path within the new show folder; only normal relative components are accepted.
    pub relative_path: &'static str,
    /// Asset contents compiled into the application.
    pub bytes: &'static [u8],
}

mod assets;
mod backup;
mod commands;
mod draft;
pub mod export;
mod feedback;
mod http_routes;
mod import;
mod listing;
mod load;
mod manifest;
mod paths;
mod revision;
mod save;
mod state;
mod storage;

#[cfg(all(test, feature = "object-library"))]
use assets::{
    copy_imported_scene_object_assets, scene_object_model_path,
    snapshot_library_model_path_for_showfile,
};
use assets::{
    normalize_scene_object_model_paths_for_showfile, prepare_imported_showfile_assets,
    remove_orphaned_showfile_object_snapshots, remove_orphaned_timeline_audio_assets_after_save,
};
#[cfg(test)]
use assets::{
    remove_orphaned_timeline_audio_assets, remove_orphaned_timeline_audio_assets_in_save_dirs,
};
#[cfg(test)]
use backup::copy_directory_recursive;
use backup::{
    backup_show_data_directory, copy_directory_recursive_excluding_names,
    list_show_data_backup_directories,
};
#[cfg(test)]
use commands::effective_save_showfile_name;
pub use commands::handle_events;
#[cfg(test)]
use draft::normalize_clean_snapshot_hash_metadata;
pub(crate) use draft::{DraftSaveOutcome, save_draft_showfile_if_dirty};
use draft::{
    prepare_showfile_session, prepare_working_draft_for_save, remove_draft_showfile,
    replace_working_draft_with_saved_snapshot, save_initial_draft_showfile_snapshot,
};
use feedback::*;
pub(crate) use http_routes::register_showfile_http_routes;
#[cfg(test)]
use import::resolve_import_showfile_path;
use import::{import_showfile_path, merge_showfile_snapshots};
pub(crate) use load::ShowfileLoadState;
#[cfg(test)]
use load::load_showfile_in_place;
pub use load::load_showfile_into_world;
use load::load_showfile_snapshot_from_state;
#[cfg(test)]
use manifest::{read_current_showfile_manifest_from_dir, write_showfile_manifest_to_dir};
pub(crate) use nightfall_showfile::ShowfileSaveState;
pub(crate) use nightfall_showfile::validate_showfile_snapshot_json;
use nightfall_showfile::{
    BindingsSnapshot, ShowfileMetadata, ShowfileSnapshot, apply_showfile_snapshot,
    current_showfile_metadata, serialize_showfile_snapshot_json, snapshot_from_save_state,
    snapshot_from_world, stabilize_showfile_group_refs, validate_showfile_asset_versions,
};
#[cfg(test)]
use nightfall_showfile::{ShowfileLoadDomain, ordered_showfile_load_domains};
use paths::*;
use save::{
    apply_showfile_save_options, save_showfile, update_clean_snapshot_hash,
    update_clean_snapshot_hash_from_saved_show,
};
pub(crate) use save::{
    persist_new_showfile_draft_from_world, refresh_clean_snapshot_hash_after_showfile_bootstrap,
    refresh_clean_snapshot_hash_from_world, serialize_showfile_snapshot_json_from_world,
};
pub use state::{CurrentShowfile, ShowfileCleanSnapshotHash};
use storage::{
    hash_showfile_snapshot_with_metadata, read_showfile_snapshot, read_showfile_snapshot_from_path,
    repair_showfile_manifest_for_existing_snapshot_to_dir, replace_showfile_dir_with_temp,
    temporary_showfile_dir, write_showfile_snapshot_with_manifest_to_dir,
};

#[cfg(test)]
mod tests;
