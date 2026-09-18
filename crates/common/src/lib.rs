// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::{
    path::PathBuf,
    sync::{OnceLock, RwLock},
};

pub mod blueprint;
pub mod color_path;
pub mod command_types;
pub mod constants;
pub mod data;
pub mod engine;
pub mod macros;
pub mod partial_result;
pub mod spanned_selection;
pub mod spatial_projection;
pub mod stores;
pub mod transitions;
pub mod value_source;
pub mod variables;

pub mod prelude {
    pub use crate::SimpleUuid;
    pub use crate::blueprint::{
        Blueprint, BlueprintAddress, BlueprintApplication, BlueprintResolution, BlueprintSelector,
    };
    pub use crate::color_path::{
        ColorAttributeTiming, ColorInterpolationSpace, ColorPath, ColorPathDefault, ColorPathId,
        ColorPathRgb, ColorPathTiming, ColorPathTimingComponent, HueDirection, builtin_color_paths,
        resolved_interpolation_space, sample_color_path,
    };
    pub use crate::command_types::{
        Axis, ElementSelectorExpr, FixtureRangeExpr, GridSize, GroupRefExpr, IdExpr,
        IndexedFixture, InvertMode, ObjectIdentity, ObjectRef, ObjectType, ProjectedCoord,
        ProjectionBounds, ResolvedSelection, SelectionExpr, SelectionIndex, SelectionType,
        SpatialClause, SpatialSelection, UnresolvedFixtureRef,
    };
    pub use crate::data::{FixtureRef, Group, HasIdentifiers, Identifiers, Priority, References};
    pub use crate::macros::Macro;
    pub use crate::partial_result::PartialResult;
    pub use crate::serde_instant;
    pub use crate::serde_uuid_simple;
    pub use crate::spanned_selection::SpannedSelection;
    pub use crate::spatial_projection::{
        SpatialProjectionError, project_resolved_spatial_selection, project_spanned_selection,
        project_spanned_selection_with_expander,
    };
    pub use crate::stores::{FilterType, InclusionMode, InclusionSettings};
    pub use crate::transitions::{
        AttributeTransitions, CueTriggerType, FadeCurve, MaterializedTransition, PartialTransition,
        SequenceStepTiming, SequenceStepTimingSummary, SequenceTimingSummary, Transition,
        TransitionMode, cue_authored_duration, evaluate_cubic_bezier, sequence_activation_interval,
        sequence_next_activation_position, sequence_timing_summary,
    };
    pub use crate::value_source::ValueSource;
    pub use crate::variables::VariableValue;
}

use serde::{Deserialize, Serialize};
use uuid::Uuid;

static ACTIVE_SHOW_DATA_DIR: OnceLock<RwLock<Option<PathBuf>>> = OnceLock::new();
static CONFIGURED_DATA_DIR: OnceLock<RwLock<Option<PathBuf>>> = OnceLock::new();

/// Returns the Nightfall data directory.
///
/// A typed startup override is preferred. Otherwise this falls back to the
/// platform-specific app data directory.
pub fn nightfall_data_dir() -> Option<PathBuf> {
    resolve_nightfall_data_dir(configured_data_dir(), platform_nightfall_data_dir())
}

/// Sets the typed process-wide data-directory override used by storage helpers.
pub fn set_nightfall_data_dir(path: Option<PathBuf>) {
    let mut guard = configured_data_dir_lock()
        .write()
        .expect("configured data directory lock should not be poisoned");
    *guard = path;
}

/// Returns the mounted show data directory used for showfile-scoped runtime assets.
///
/// The backend normally points this at a working draft folder so browser-side
/// asset uploads and object snapshots cannot mutate the canonical saved
/// showfile folder until the user explicitly saves.
pub fn active_show_data_dir() -> Option<PathBuf> {
    let override_dir = active_show_data_dir_override();
    override_dir.or_else(|| {
        nightfall_data_dir().map(|data_dir| data_dir.join(crate::constants::SHOW_DATA_DIR))
    })
}

/// Sets the mounted show data directory for showfile-scoped runtime assets.
pub fn set_active_show_data_dir(path: impl Into<PathBuf>) {
    let lock = active_show_data_dir_lock();
    let mut guard = lock
        .write()
        .expect("active show data directory lock should not be poisoned");
    *guard = Some(path.into());
}

/// Clears the mounted show data directory override and returns to the default show folder.
pub fn clear_active_show_data_dir() {
    let lock = active_show_data_dir_lock();
    let mut guard = lock
        .write()
        .expect("active show data directory lock should not be poisoned");
    *guard = None;
}

/// Returns the process-wide active show data directory lock.
fn active_show_data_dir_lock() -> &'static RwLock<Option<PathBuf>> {
    ACTIVE_SHOW_DATA_DIR.get_or_init(|| RwLock::new(None))
}

/// Returns the currently mounted show data directory override when one is set.
fn active_show_data_dir_override() -> Option<PathBuf> {
    active_show_data_dir_lock()
        .read()
        .expect("active show data directory lock should not be poisoned")
        .clone()
}

/// Returns the process-wide configured data-directory lock.
fn configured_data_dir_lock() -> &'static RwLock<Option<PathBuf>> {
    CONFIGURED_DATA_DIR.get_or_init(|| RwLock::new(None))
}

/// Returns the typed process-wide data-directory override when one is set.
fn configured_data_dir() -> Option<PathBuf> {
    configured_data_dir_lock()
        .read()
        .expect("configured data directory lock should not be poisoned")
        .clone()
}

fn resolve_nightfall_data_dir(
    env_override: Option<PathBuf>,
    platform_data_dir: Option<PathBuf>,
) -> Option<PathBuf> {
    env_override.or(platform_data_dir)
}

fn platform_nightfall_data_dir() -> Option<PathBuf> {
    directories::ProjectDirs::from("com", "nightfall", "nightfall")
        .map(|project_dirs| project_dirs.data_dir().to_path_buf())
}

/// Serde module for UUID serialization using simple format (no hyphens) that works
/// with both borrowed and owned strings during deserialization.
///
/// Use this instead of `uuid::serde::simple` when deserializing from `serde_json::Value`
/// (which cannot provide borrowed strings).
pub mod serde_uuid_simple {
    use std::str::FromStr;

    use serde::{Deserialize, Deserializer, Serializer, de::Error};
    use uuid::Uuid;

    pub fn serialize<S>(uuid: &Uuid, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&uuid.simple().to_string())
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Uuid, D::Error>
    where
        D: Deserializer<'de>,
    {
        let s: String = String::deserialize(deserializer)?;
        Uuid::from_str(&s).map_err(|e| D::Error::custom(format!("Invalid UUID: {}", e)))
    }
}

/// A UUID wrapper that serializes/deserializes using simple format (no hyphens).
///
/// Use this type when you need `Vec<Uuid>` or `HashMap<Uuid, _>` with simple format
/// serialization, since serde attributes cannot be applied to generic type arguments.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SimpleUuid(#[serde(with = "serde_uuid_simple")] pub Uuid);

impl From<Uuid> for SimpleUuid {
    fn from(uuid: Uuid) -> Self {
        SimpleUuid(uuid)
    }
}

impl From<SimpleUuid> for Uuid {
    fn from(simple: SimpleUuid) -> Self {
        simple.0
    }
}

pub mod serde_instant {
    use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error};
    use web_time::{Instant, SystemTime};

    pub fn serialize<S>(instant: &Instant, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let system_now = SystemTime::now();
        let instant_now = Instant::now();
        let approx = system_now - (instant_now - *instant);
        approx.serialize(serializer)
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Instant, D::Error>
    where
        D: Deserializer<'de>,
    {
        let de = SystemTime::deserialize(deserializer)?;
        let system_now = SystemTime::now();
        let instant_now = Instant::now();
        let duration = system_now.duration_since(de).map_err(Error::custom)?;
        let approx = instant_now - duration;
        Ok(approx)
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{
        active_show_data_dir, clear_active_show_data_dir, resolve_nightfall_data_dir,
        set_active_show_data_dir,
    };

    #[test]
    fn data_dir_resolution_prefers_env_override() {
        let override_dir = Some(PathBuf::from("/tmp/nightfall-override"));
        let platform_dir = Some(PathBuf::from("/tmp/nightfall-platform"));

        assert_eq!(
            resolve_nightfall_data_dir(override_dir.clone(), platform_dir),
            override_dir
        );
    }

    #[test]
    fn data_dir_resolution_falls_back_to_platform_dir() {
        let platform_dir = Some(PathBuf::from("/tmp/nightfall-platform"));

        assert_eq!(
            resolve_nightfall_data_dir(None, platform_dir.clone()),
            platform_dir
        );
    }

    /// Verifies show-local runtime paths use the mounted draft override when present.
    #[test]
    fn active_show_data_dir_prefers_process_override() {
        set_active_show_data_dir("/tmp/nightfall/drafts/default.nightfall-show");

        assert_eq!(
            active_show_data_dir(),
            Some(PathBuf::from(
                "/tmp/nightfall/drafts/default.nightfall-show"
            ))
        );

        clear_active_show_data_dir();
    }
}
