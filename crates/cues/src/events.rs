// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Handles cue-related events from the engine

use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};

use bevy_app::prelude::*;
use bevy_ecs::{prelude::*, system::SystemParam};
use moonshine_kind::prelude::*;
use nightfall::prelude::*;
use nightfall_clips::{Clip, ClipAction, MaterializedClip, Source, log_clip_lookup_failure};
use nightfall_compositor::prelude::*;
use nightfall_desk::instances::InstanceIndex;
use nightfall_desk::prelude::*;
use nightfall_dmx::prelude::{Attribute, ParameterValue};
use nightfall_engine::prelude::*;
use nightfall_fixtures::prelude::*;
use nightfall_fixtures::selection::SpatialSelectionResolver;
use nightfall_instances::{
    EditorPreviewInstance, InstanceClock, InstanceControls, InstanceId, InstanceKind,
    InstanceMetadata, InstanceOptions, Owner, instance_clock_from_reconstruction_timing,
};
#[cfg(test)]
use nightfall_instances::{InstanceClockDiscontinuity, InstanceClockSource};
use nightfall_playback_planner::{PlaybackPositionSource, PlaybackReconstructionTiming};
use nightfall_undo::prelude::{UndoEntry, UndoManager, UndoableOperation};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::materialized_sequence::{PlaybackReleaseTiming, SequenceMaterializationParams};
use crate::prelude::*;
use crate::undo::RestoreSequencePosition;
use crate::websocket::{
    CueDefinitionChange, SequenceDefinitionChange, SequenceLookaheadStateDirty,
};

mod actions;
mod block_tracking;
mod clip;
mod color_paths;
mod cue_crud;
mod definitions;
mod instance;
mod preview;
mod sequence_crud;
mod undo;

pub use actions::*;
use block_tracking::*;
pub use clip::*;
use color_paths::*;
pub use cue_crud::*;
use definitions::*;
pub use instance::*;
pub use preview::*;
pub use sequence_crud::*;
pub use undo::*;

/// Registers cue-domain event handlers with explicit ordering between dependent use cases.
pub(crate) fn register_event_systems(app: &mut App) {
    app.add_systems(
        Update,
        (
            handle_events
                .after(
                    nightfall_desk::systems::event_handlers::clip_events::forward_clip_ingress_actions,
                )
                .after(
                    nightfall_desk::systems::event_handlers::clip_events::forward_clip_playback_requests,
                ),
            cue_store_operations,
            cue_action_events.before(cue_crud_events),
            cue_crud_events,
            crate::materialized_sequence::rematerialize_sequences_after_cue_definition_change
                .after(cue_crud_events),
            sequence_crud_events,
            crate::materialized_sequence::rematerialize_sequences_after_sequence_definition_change
                .after(sequence_crud_events),
            crate::materialized_sequence::rebuild_blueprint_reference_index
                .after(cue_crud_events)
                .after(sequence_crud_events)
                .before(
                    nightfall_desk::systems::event_handlers::blueprint_events::crud_events,
                ),
            crate::materialized_sequence::rematerialize_after_blueprint_definition_change
                .after(nightfall_desk::systems::event_handlers::blueprint_events::crud_events)
                .after(nightfall_desk::systems::event_handlers::blueprint_events::action_events),
            handle_sequence_playback_actions,
            handle_restore_sequence_position,
        )
            .in_set(EventHandling),
    );
    app.add_systems(
        Update,
        handle_cue_preview_commands.in_set(EventHandling).after(
            nightfall_desk::systems::event_handlers::instance_events::handle_playback_commands,
        ),
    );
}

#[cfg(test)]
mod tests;
