// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use bevy_ecs::prelude::*;
use nightfall::prelude::*;
use nightfall_instances::InstanceId;
use serde::{Deserialize, Serialize};
use smart_default::SmartDefault;
use uuid::Uuid;

/// Sources that can be assigned to clips.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum Source {
    /// Cue sequence identified by persistent UUID.
    Sequence(#[serde(with = "nightfall::serde_uuid_simple")] Uuid),
    /// Parameter effect identified by persistent UUID.
    Fx(#[serde(with = "nightfall::serde_uuid_simple")] Uuid),
    /// Flow graph identified by persistent UUID.
    Flow(#[serde(with = "nightfall::serde_uuid_simple")] Uuid),
    /// Step effect identified by persistent UUID.
    StepFx(#[serde(with = "nightfall::serde_uuid_simple")] Uuid),
    /// Effect module identified by persistent UUID.
    FxModule(#[serde(with = "nightfall::serde_uuid_simple")] Uuid),
}

/// Clip source references addressed by console-facing numeric ID before resolution.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum ClipSourceRef {
    /// Cue sequence addressed by numeric ID.
    Sequence(u32),
    /// Parameter effect addressed by numeric ID.
    Fx(u32),
    /// Flow graph addressed by numeric ID.
    Flow(u32),
    /// Step effect addressed by numeric ID.
    StepFx(u32),
    /// Effect module addressed by numeric ID.
    FxModule(u32),
}

/// Persistent playback behavior stored with a clip.
#[derive(Debug, Clone, Serialize, Deserialize, SmartDefault)]
#[typeshare::typeshare]
pub struct ClipOptions {
    /// Whether the clip should release current playback output after stopping.
    #[default = true]
    pub auto_release: bool,
    /// Whether a non-wrapping sequence clip should stop after the final cue completes.
    pub deactivate_on_sequence_end: bool,
}

/// Persistent clip configuration stored in a showfile.
#[derive(Debug, Clone, Component, Serialize, Deserialize, SmartDefault)]
#[typeshare::typeshare]
pub struct Clip {
    /// Stable numeric, UUID, and label identifiers.
    pub identifiers: Identifiers,
    /// Source to run when the clip starts.
    pub source: Option<Source>,
    /// Layer priority for spawned instances.
    pub priority: Priority,
    /// Clip-local playback behavior.
    #[serde(default)]
    pub options: ClipOptions,
}

/// Runtime link from a clip to its attached instance.
#[derive(Component, Clone, Debug)]
#[typeshare::typeshare]
pub struct MaterializedClip {
    /// Console-facing ID of the persistent clip.
    pub clip_id: u32,
    /// Instance controlled by the clip.
    pub attached_instance: InstanceId,
    /// Whether stopping the instance should emit a global release.
    pub auto_release_on_stop: bool,
}

impl HasIdentifiers for Clip {
    /// Returns the clip's stable identifier bundle.
    fn identifiers(&self) -> &Identifiers {
        &self.identifiers
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies new clip option defaults enable auto-release.
    #[test]
    fn clip_options_default_enables_auto_release() {
        let options = ClipOptions::default();

        assert!(
            options.auto_release,
            "expected new clips to auto-release by default"
        );
        assert!(
            !options.deactivate_on_sequence_end,
            "expected sequence-end deactivation to remain opt-in"
        );
    }
}
