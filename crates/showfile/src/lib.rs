// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Portable showfile serialization and runtime materialization.
//!
//! Storage adapters own where bytes come from. This crate owns the versioned JSON
//! contract, deterministic domain application, and world snapshots.

#![warn(missing_docs)]

mod apply;
mod contributors;
mod selection_refs;
mod snapshot;
mod world;

pub use apply::{
    ShowfileApplyState, ShowfileLoadDomain, ShowfileLoadPhase, apply_showfile_snapshot,
    apply_showfile_snapshot_to_world, initialize_showfile_resources, ordered_showfile_load_domains,
};
/// Current schema version written into newly saved showfile metadata.
pub const CURRENT_SHOWFILE_VERSION: u32 = 17;
pub use selection_refs::stabilize_showfile_group_refs;
pub use snapshot::{
    BindingsSnapshot, ShowfileMetadata, ShowfileSnapshot, current_showfile_metadata,
    validate_showfile_asset_versions,
};
pub use world::{ShowfileSaveState, snapshot_from_save_state, snapshot_from_world};

/// Parse a current-version showfile without transforming its persisted data.
pub fn parse_showfile_snapshot_json(json: &str, source: &str) -> Result<ShowfileSnapshot, String> {
    #[derive(serde::Deserialize)]
    struct VersionedShowfile {
        metadata: ShowfileMetadata,
    }

    let header: VersionedShowfile =
        serde_json::from_str(json).map_err(|error| showfile_parse_error(source, &error))?;
    let version = header.metadata.showfile_version;
    if version != CURRENT_SHOWFILE_VERSION {
        return Err(format!(
            "unsupported showfile version {version} in {source}; this nightfall build requires version {CURRENT_SHOWFILE_VERSION}"
        ));
    }

    serde_json::from_str(json).map_err(|error| showfile_parse_error(source, &error))
}

/// Serialize a canonical showfile snapshot as stable, human-readable JSON.
pub fn serialize_showfile_snapshot_json(snapshot: &ShowfileSnapshot) -> Result<String, String> {
    serde_json::to_string_pretty(snapshot)
        .map_err(|error| format!("failed to serialize showfile json: {error}"))
}

/// Validate showfile JSON against the supported version and runtime schema.
pub fn validate_showfile_snapshot_json(json: &str, source: &str) -> Result<(), String> {
    parse_showfile_snapshot_json(json, source).map(|_| ())
}

/// Build one consistent parse error for every showfile storage adapter.
fn showfile_parse_error(source: &str, error: &dyn std::fmt::Display) -> String {
    tracing::error!(filename = source, %error, "Failed to parse showfile");
    format!("failed to parse showfile {source}: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verify current snapshots retain their data through the public JSON boundary.
    #[test]
    fn current_showfile_round_trips() {
        let mut snapshot = contributors::collect_save_contributions(&[]);
        assert_eq!(snapshot.metadata.showfile_version, CURRENT_SHOWFILE_VERSION);
        snapshot.metadata.last_saved_unix_sec = 123;
        let json = serialize_showfile_snapshot_json(&snapshot).expect("serialize snapshot");
        let parsed = parse_showfile_snapshot_json(&json, "current").expect("parse snapshot");
        assert_eq!(serialize_showfile_snapshot_json(&parsed).unwrap(), json);
    }

    /// Preserve clip, master, and empty assignments through JSON and replace a previous bank on load.
    #[test]
    fn control_assignments_round_trip_and_replace_existing_bank() {
        use bevy_ecs::prelude::World;
        use nightfall_desk::prelude::{ControlAssignment, Controls};

        let mut world = World::new();
        initialize_showfile_resources(&mut world);
        let controls = Controls::from_assignments(&[
            Some(ControlAssignment::Clip(28)),
            None,
            Some(ControlAssignment::Master(7)),
        ]);
        let expected = controls.assignments();
        world.insert_resource(controls);
        let snapshot = snapshot_from_world(&mut world).unwrap();
        let json = serialize_showfile_snapshot_json(&snapshot).unwrap();
        let parsed = parse_showfile_snapshot_json(&json, "controls").unwrap();
        world.insert_resource(Controls::from_assignments(&[Some(
            ControlAssignment::Clip(99),
        )]));
        apply_showfile_snapshot_to_world(&mut world, parsed).unwrap();
        assert_eq!(world.resource::<Controls>().assignments(), expected);

        apply_showfile_snapshot_to_world(&mut world, ShowfileSnapshot::default()).unwrap();
        assert!(
            world
                .resource::<Controls>()
                .assignments()
                .iter()
                .all(Option::is_none)
        );
    }

    /// Reject every retired schema and future schemas before deserializing their data.
    #[test]
    fn unsupported_showfile_versions_are_rejected() {
        for version in (0..CURRENT_SHOWFILE_VERSION).chain([CURRENT_SHOWFILE_VERSION + 1]) {
            let json = serde_json::json!({"metadata": {"showfileVersion": version}}).to_string();
            let error = parse_showfile_snapshot_json(&json, "unsupported").unwrap_err();
            assert!(
                error.contains(&format!("unsupported showfile version {version}")),
                "{error}"
            );
        }
    }

    /// Reject absent and malformed schema metadata instead of assuming a legacy version.
    #[test]
    fn invalid_showfile_metadata_is_rejected() {
        for json in [
            "{}",
            r#"{"metadata": null}"#,
            r#"{"metadata": {}}"#,
            r#"{"metadata": {"showfileVersion": -1}}"#,
            r#"{"metadata": {"showfileVersion": "17"}}"#,
            r#"{"metadata": {"showfileVersion": 4294967296}}"#,
        ] {
            assert!(
                parse_showfile_snapshot_json(json, "invalid").is_err(),
                "{json}"
            );
        }
    }
}
