// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Waveform previews and isolated Step FX editor preview sessions.

use std::collections::HashMap;

use bevy_ecs::prelude::*;
use nightfall::prelude::*;
use nightfall_compositor::prelude::*;
use nightfall_instances::{
    EditorPreviewInstance, InstanceClock, InstanceControls, InstanceDisplayKind, InstanceId,
    InstanceKind, InstanceMetadata,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::continuity::{reanchored_step_fx_runtime, refreshed_step_fx_playback_metadata};
use crate::prelude::*;

/// Runtime components associated with an independently controlled editor preview.
type StepFxPreviewData = (
    Entity,
    &'static StepFxPreviewSessionId,
    &'static ActiveStepFx,
    Option<&'static InstanceClock>,
    Option<&'static StepFxLanePhaseOffsets>,
    Option<&'static InstanceMetadata>,
);

/// High-frequency FX preview changes during editing.
#[derive(Debug, Clone, Serialize, Deserialize, Message)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum FxPreviewUpdate {
    /// Start previewing an FX configuration (spawns singleton preview entity)
    StartPreview(Fx),
    /// Update the preview with new configuration
    UpdatePreview(Fx),
    /// Stop preview and clean up
    StopPreview,
}

/// Marker component for preview FX entities
#[derive(Component)]
pub struct PreviewMaterializedFx;

/// Stable identity for one independently controlled Step FX editor preview.
#[derive(Component, Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct StepFxPreviewSessionId(
    #[serde(with = "nightfall::serde_uuid_simple")]
    #[typeshare(serialized_as = "String")]
    pub Uuid,
);

/// High-frequency complete-draft updates for Step FX editor previews.
#[derive(Debug, Clone, Serialize, Deserialize, Message)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum StepFxPreviewUpdate {
    /// Starts a session-specific preview from a complete valid draft.
    Start {
        /// Editor-owned preview session identity.
        session_id: StepFxPreviewSessionId,
        /// Complete valid draft to evaluate.
        step_fx: StepFx,
    },
    /// Replaces a running session's draft while preserving normalized cycle phase.
    Update {
        /// Editor-owned preview session identity.
        session_id: StepFxPreviewSessionId,
        /// Complete valid draft to evaluate.
        step_fx: StepFx,
    },
    /// Stops only the addressed editor preview session.
    Stop {
        /// Editor-owned preview session identity.
        session_id: StepFxPreviewSessionId,
    },
}

/// Preview-only Step FX definition kept outside the persisted component type.
#[derive(Component, Clone, Debug)]
pub struct PreviewStepFxDefinition(pub StepFx);

/// Marker for the active playback owned by a Step FX preview session.
#[derive(Component)]
pub struct PreviewStepFxPlayback;

/// Handles FX preview commands for real-time editing feedback
pub fn handle_preview_commands(
    mut commands: Commands,
    mut events: MessageReader<FxPreviewUpdate>,
    preview_query: Query<Entity, With<PreviewMaterializedFx>>,
) {
    for event in events.read() {
        match event {
            FxPreviewUpdate::StartPreview(fx) | FxPreviewUpdate::UpdatePreview(fx) => {
                // Despawn existing preview entities
                for entity in preview_query.iter() {
                    commands.entity(entity).insert(ReleaseMarker::default());
                }

                // Spawn new preview with Priority(75) - above cues but below programmer
                let mfx = MaterializedFx {
                    fx: fx.clone(),
                    priority: Priority(75),
                };
                let marker = ObjectRefMarker(ObjectRef::ByUid {
                    object_type: ObjectType::StepFx,
                    uid: mfx.identifiers().uid,
                });
                commands.spawn((mfx, marker, PreviewMaterializedFx, InstanceClock::default()));
                tracing::debug!("Started FX preview for '{}'", fx.identifiers.label);
            }
            FxPreviewUpdate::StopPreview => {
                // Despawn all preview entities
                for entity in preview_query.iter() {
                    commands.entity(entity).insert(ReleaseMarker::default());
                }
                tracing::debug!("Stopped FX preview");
            }
        }
    }
}

/// Applies isolated Step FX preview sessions without mutating stored definitions.
pub fn handle_step_fx_preview_commands(
    mut commands: Commands,
    mut events: MessageReader<StepFxPreviewUpdate>,
    preview_definitions: Query<(Entity, &StepFxPreviewSessionId, &PreviewStepFxDefinition)>,
    preview_playbacks: Query<StepFxPreviewData, With<PreviewStepFxPlayback>>,
) {
    let mut latest_updates = HashMap::new();
    for event in events.read() {
        let (session_id, step_fx) = match event {
            StepFxPreviewUpdate::Start {
                session_id,
                step_fx,
            }
            | StepFxPreviewUpdate::Update {
                session_id,
                step_fx,
            } => (*session_id, Some(step_fx)),
            StepFxPreviewUpdate::Stop { session_id } => (*session_id, None),
        };
        if let Some(step_fx) = step_fx {
            let validation_issues = step_fx.validate();
            if !validation_issues.is_empty() {
                tracing::warn!(
                    session = %session_id.0,
                    issue_count = validation_issues.len(),
                    "Ignored invalid Step FX preview update"
                );
                continue;
            }
        }
        latest_updates.insert(session_id, step_fx.cloned());
    }

    for (session_id, step_fx) in latest_updates {
        let existing_definition = preview_definitions
            .iter()
            .find(|(_, existing_session, _)| **existing_session == session_id);
        let existing_playback = preview_playbacks
            .iter()
            .find(|(_, existing_session, _, _, _, _)| **existing_session == session_id);

        let Some(step_fx) = step_fx.as_ref() else {
            if let Some((entity, _, _)) = existing_definition {
                commands.entity(entity).despawn();
            }
            if let Some((entity, _, _, _, _, _)) = existing_playback {
                commands.entity(entity).despawn();
            }
            tracing::debug!(session = %session_id.0, "Stopped Step FX preview");
            continue;
        };

        if let Some((definition_entity, _, previous)) = existing_definition {
            commands
                .entity(definition_entity)
                .insert(PreviewStepFxDefinition(step_fx.clone()));
            if let Some((playback_entity, _, active, clock, offsets, metadata)) = existing_playback
            {
                let (clock, offsets) =
                    reanchored_step_fx_runtime(clock, offsets, active.rate, &previous.0, step_fx);
                commands.entity(playback_entity).insert((
                    clock,
                    offsets,
                    refreshed_step_fx_playback_metadata(
                        metadata,
                        format!("Preview: {}", step_fx.identifiers.label),
                    ),
                ));
            }
            tracing::trace!(session = %session_id.0, "Updated Step FX preview");
            continue;
        }

        let definition_entity = commands
            .spawn((PreviewStepFxDefinition(step_fx.clone()), session_id))
            .id();
        commands.spawn((
            ActiveStepFx {
                fx_entity: definition_entity,
                priority: Priority(75),
                rate: 1.0,
                is_playing: true,
            },
            session_id,
            PreviewStepFxPlayback,
            EditorPreviewInstance,
            InstanceId::new(),
            InstanceControls::default(),
            InstanceClock::default(),
            InstanceMetadata::new(InstanceKind::Fx)
                .with_display_kind(InstanceDisplayKind::StepFx)
                .with_name(format!("Preview: {}", step_fx.identifiers.label)),
        ));
        tracing::debug!(session = %session_id.0, "Started Step FX preview");
    }
}

#[cfg(test)]
mod tests {
    use bevy_app::{App, Update};
    use nightfall_engine::prelude::DataProvider;
    use nightfall_fixtures::prelude::FixtureDataProviderExt;

    use super::super::test_support::valid_step_fx;
    use super::*;

    /// Builds a focused app for isolated Step FX preview-session tests.
    fn step_fx_preview_app() -> App {
        let mut app = App::new();
        app.init_resource::<DataProvider<Group>>();
        app.init_resource::<FixtureDataProviderExt>();
        app.add_message::<StepFxPreviewUpdate>();
        app.add_systems(Update, handle_step_fx_preview_commands);
        app
    }

    /// Verifies two editor previews coexist and stopping one leaves the other untouched.
    #[test]
    fn step_fx_preview_sessions_are_isolated() {
        let mut app = step_fx_preview_app();
        let session_a = StepFxPreviewSessionId(Uuid::from_u128(0x640));
        let session_b = StepFxPreviewSessionId(Uuid::from_u128(0x641));
        let step_fx_a = valid_step_fx(10, Uuid::from_u128(0x642), SpatialSelection::default());
        let step_fx_b = valid_step_fx(11, Uuid::from_u128(0x643), SpatialSelection::default());

        app.world_mut().write_message(StepFxPreviewUpdate::Start {
            session_id: session_a,
            step_fx: step_fx_a,
        });
        app.world_mut().write_message(StepFxPreviewUpdate::Start {
            session_id: session_b,
            step_fx: step_fx_b,
        });
        app.update();

        assert_eq!(
            app.world_mut()
                .query_filtered::<&StepFxPreviewSessionId, With<PreviewStepFxPlayback>>()
                .iter(app.world())
                .count(),
            2
        );

        app.world_mut().write_message(StepFxPreviewUpdate::Stop {
            session_id: session_a,
        });
        app.update();

        let sessions = app
            .world_mut()
            .query_filtered::<&StepFxPreviewSessionId, With<PreviewStepFxPlayback>>()
            .iter(app.world())
            .copied()
            .collect::<Vec<_>>();
        assert_eq!(sessions, vec![session_b]);
    }

    /// Verifies a same-frame restart keeps one live session without targeting despawned entities.
    #[test]
    fn step_fx_preview_restart_coalesces_to_latest_session_update() {
        let mut app = step_fx_preview_app();
        let session = StepFxPreviewSessionId(Uuid::from_u128(0x648));
        let initial = valid_step_fx(10, Uuid::from_u128(0x649), SpatialSelection::default());
        app.world_mut().write_message(StepFxPreviewUpdate::Start {
            session_id: session,
            step_fx: initial.clone(),
        });
        app.update();

        let mut replacement = initial;
        replacement.identifiers.label = "Restarted preview".to_owned();
        app.world_mut().write_message(StepFxPreviewUpdate::Stop {
            session_id: session,
        });
        app.world_mut().write_message(StepFxPreviewUpdate::Start {
            session_id: session,
            step_fx: replacement,
        });
        app.update();

        let definitions = app
            .world_mut()
            .query::<(&StepFxPreviewSessionId, &PreviewStepFxDefinition)>()
            .iter(app.world())
            .filter(|(candidate, _)| **candidate == session)
            .map(|(_, definition)| definition.0.identifiers.label.as_str())
            .collect::<Vec<_>>();
        assert_eq!(definitions, vec!["Restarted preview"]);
        assert_eq!(
            app.world_mut()
                .query_filtered::<&StepFxPreviewSessionId, With<PreviewStepFxPlayback>>()
                .iter(app.world())
                .filter(|candidate| **candidate == session)
                .count(),
            1
        );
    }

    /// Verifies editing a preview label refreshes its active-playback metadata.
    #[test]
    fn step_fx_preview_update_refreshes_playback_metadata() {
        let mut app = step_fx_preview_app();
        let session = StepFxPreviewSessionId(Uuid::from_u128(0x64a));
        let initial = valid_step_fx(10, Uuid::from_u128(0x64b), SpatialSelection::default());
        app.world_mut().write_message(StepFxPreviewUpdate::Start {
            session_id: session,
            step_fx: initial.clone(),
        });
        app.update();

        let mut replacement = initial;
        replacement.identifiers.label = "Renamed draft".to_owned();
        app.world_mut().write_message(StepFxPreviewUpdate::Update {
            session_id: session,
            step_fx: replacement,
        });
        app.update();

        let metadata = app
            .world_mut()
            .query_filtered::<&InstanceMetadata, With<PreviewStepFxPlayback>>()
            .single(app.world())
            .expect("preview playback metadata should exist");
        assert_eq!(metadata.name.as_deref(), Some("Preview: Renamed draft"));
    }

    /// Verifies a same-frame invalid edit does not replace the session's last valid draft.
    #[test]
    fn invalid_step_fx_preview_update_keeps_last_valid_definition() {
        let mut app = step_fx_preview_app();
        let session = StepFxPreviewSessionId(Uuid::from_u128(0x650));
        let valid = valid_step_fx(12, Uuid::from_u128(0x651), SpatialSelection::default());
        app.world_mut().write_message(StepFxPreviewUpdate::Start {
            session_id: session,
            step_fx: valid.clone(),
        });
        let mut invalid = valid.clone();
        invalid.identifiers.label.clear();
        app.world_mut().write_message(StepFxPreviewUpdate::Update {
            session_id: session,
            step_fx: invalid,
        });
        app.update();

        let preview = app
            .world_mut()
            .query::<(&StepFxPreviewSessionId, &PreviewStepFxDefinition)>()
            .iter(app.world())
            .find(|(candidate, _)| **candidate == session)
            .map(|(_, definition)| definition)
            .unwrap();
        assert_eq!(preview.0.identifiers.label, valid.identifiers.label);
    }
}
