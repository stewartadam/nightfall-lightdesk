// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Cue and sequence editor preview commands and materialization.

use super::*;

pub(super) const CUE_PREVIEW_PRIORITY: Priority = Priority(126);

/// Commands for cue preview during editing
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum CuePreviewCommand {
    /// Preview a cue configuration.
    PreviewCue {
        /// Existing preview instance to replace, or `None` to start a new one.
        instance_id: Option<InstanceId>,
        /// Cue snapshot to materialize.
        cue: Box<Cue>,
    },
    /// Preview a sequence snapshot at a cue position.
    PreviewSequence {
        /// Existing preview instance to replace, or `None` to start a new one.
        instance_id: Option<InstanceId>,
        /// Sequence snapshot to materialize.
        preview: Box<SequencePreview>,
    },
    /// Stop the preview instance with the given runtime instance ID.
    StopPreview {
        /// Playback to release.
        instance_id: InstanceId,
    },
    /// Assigns transition-local preview time and whether playback should continue.
    SeekPreview {
        /// Editor-owned preview instance to control.
        instance_id: InstanceId,
        /// Elapsed time since the active cue was asserted.
        position: Duration,
        /// Whether to continue playback from the assigned time.
        playing: bool,
    },
}

impl IngressCommand for CuePreviewCommand {}

/// Sequence snapshot used for sequence-editor preview.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(deny_unknown_fields)]
pub struct SequencePreview {
    /// Sequence definition containing the preview step order and default timing.
    pub sequence: Sequence,
    /// Cue snapshots referenced by the preview sequence steps.
    pub cues: Vec<Cue>,
    /// One-based sequence position to render as the active cue.
    pub position: u32,
}

/// Final preview action to apply for one runtime preview instance.
pub(super) enum PendingPreviewRequest {
    Cue(Box<Cue>),
    Sequence(Box<SequencePreview>),
    Stop,
    Seek(Duration, bool),
}

/// Runtime preview components used to replace or release a specific instance.
type PreviewInstanceView = (Entity, &'static InstanceId, Option<&'static ReleaseMarker>);

/// Preview clock controls and source timing needed for transition-local seeking.
type PreviewClockView = (
    &'static InstanceId,
    &'static mut InstanceClock,
    &'static mut InstanceControls,
    Option<&'static MaterializedSequence>,
    Option<&'static MaterializedCue>,
);

/// Encapsulates command input and materialization dependencies for editor previews.
#[derive(SystemParam)]
pub struct CuePreviewContext<'w, 's> {
    events: MessageReader<'w, 's, CommandEnvelope<CuePreviewCommand>>,
    responder: CommandResponder<'w>,
    color_path_data_provider: Option<Res<'w, DataProvider<ColorPath>>>,
    blueprint_data_provider: Option<Res<'w, DataProvider<Blueprint>>>,
    fixture_data_provider: Res<'w, FixtureDataProviderExt>,
    selection_resolver: SpatialSelectionResolver<'w>,
    parameter_query: Query<'w, 's, InstanceRef<'static, Parameter>>,
    preview_query: Query<'w, 's, PreviewInstanceView, With<EditorPreviewInstance>>,
    preview_clocks:
        Query<'w, 's, PreviewClockView, (With<EditorPreviewInstance>, Without<ReleaseMarker>)>,
}

/// Marks an active preview instance with the matching runtime ID for release.
pub(super) fn release_preview_playback_by_id(
    commands: &mut Commands,
    preview_query: &Query<
        (Entity, &InstanceId, Option<&ReleaseMarker>),
        With<EditorPreviewInstance>,
    >,
    target_instance_id: InstanceId,
) {
    for (entity, instance_id, release_marker) in preview_query.iter() {
        if release_marker.is_none() && *instance_id == target_instance_id {
            commands.entity(entity).insert(ReleaseMarker::default());
        }
    }
}

/// Despawns preview instances with the matching runtime ID before replacement.
pub(super) fn despawn_preview_instances_by_id(
    commands: &mut Commands,
    preview_query: &Query<
        (Entity, &InstanceId, Option<&ReleaseMarker>),
        With<EditorPreviewInstance>,
    >,
    target_instance_id: InstanceId,
) {
    for (entity, instance_id, _) in preview_query.iter() {
        if *instance_id == target_instance_id {
            commands.entity(entity).despawn();
        }
    }
}

/// Materializes and spawns one cue preview as an addressable instance.
pub(super) fn spawn_preview_cue(
    commands: &mut Commands,
    instance_id: InstanceId,
    cue: &Cue,
    color_path_data_provider: Option<&DataProvider<ColorPath>>,
    blueprint_data_provider: Option<&DataProvider<Blueprint>>,
    fixture_data_provider: &FixtureDataProviderExt,
    selection_resolver: &SpatialSelectionResolver,
    parameter_query: &Query<InstanceRef<Parameter>>,
) {
    let mcue = MaterializedCue::materialize_with_sources(
        cue,
        color_path_data_provider,
        blueprint_data_provider,
        fixture_data_provider,
        &parameter_query.as_readonly(),
        selection_resolver,
    );

    let mut mcue_preview = mcue;
    mcue_preview.priority = CUE_PREVIEW_PRIORITY;

    let marker = ObjectRefMarker(ObjectRef::ByUid {
        object_type: ObjectType::Cue,
        uid: cue.identifiers.uid,
    });
    let instance_metadata = InstanceMetadata::new(InstanceKind::Cue)
        .with_name(format!("Cue Preview: {}", cue.identifiers.label));
    let instance_controls = InstanceControls::default();
    let instance_clock = InstanceClock::default();
    commands.spawn((
        mcue_preview,
        marker,
        EditorPreviewInstance,
        instance_id,
        instance_metadata,
        instance_controls,
        instance_clock,
    ));
}

/// Materializes and spawns a sequence preview as an addressable instance.
pub(super) fn spawn_sequence_preview(
    commands: &mut Commands,
    instance_id: InstanceId,
    preview: &SequencePreview,
    color_path_data_provider: Option<&DataProvider<ColorPath>>,
    blueprint_data_provider: Option<&DataProvider<Blueprint>>,
    fixture_data_provider: &Res<FixtureDataProviderExt>,
    selection_resolver: &SpatialSelectionResolver,
    parameter_query: &Query<InstanceRef<Parameter>>,
) {
    let mut msequence = MaterializedSequence::materialize_from_steps_with_sources(
        &preview.sequence,
        preview.cues.clone(),
        color_path_data_provider,
        blueprint_data_provider,
        fixture_data_provider,
        &parameter_query.as_readonly(),
        selection_resolver,
    );
    msequence.priority = CUE_PREVIEW_PRIORITY;

    if !msequence.mcues.is_empty() {
        let position = preview
            .position
            .clamp(1, msequence.mcues.len().try_into().unwrap_or(u32::MAX));
        msequence.set_position(position);
    }

    let marker = ObjectRefMarker(ObjectRef::ByUid {
        object_type: ObjectType::Sequence,
        uid: preview.sequence.identifiers.uid,
    });
    let instance_metadata = InstanceMetadata::new(InstanceKind::Sequence).with_name(format!(
        "Sequence Preview: {}",
        preview.sequence.identifiers.label
    ));
    let instance_status = msequence.runtime_status();
    let instance_controls = InstanceControls::default();
    let instance_clock = InstanceClock::default();
    commands.spawn((
        msequence,
        marker,
        EditorPreviewInstance,
        instance_id,
        instance_metadata,
        instance_status,
        instance_controls,
        instance_clock,
    ));
}

/// Handles cue preview commands for real-time editing feedback.
pub fn handle_cue_preview_commands(context: CuePreviewContext, mut commands: Commands) {
    let CuePreviewContext {
        mut events,
        mut responder,
        color_path_data_provider,
        blueprint_data_provider,
        fixture_data_provider,
        selection_resolver,
        parameter_query,
        preview_query,
        mut preview_clocks,
    } = context;
    let mut pending_requests =
        HashMap::<InstanceId, (PendingPreviewRequest, Vec<(CommandId, bool)>)>::new();
    for event in events.read() {
        let (instance_id, request, returns_instance_id) = match &event.command {
            CuePreviewCommand::PreviewCue { instance_id, cue } => {
                let instance_id = instance_id.unwrap_or_else(InstanceId::new);
                (instance_id, PendingPreviewRequest::Cue(cue.clone()), true)
            }
            CuePreviewCommand::PreviewSequence {
                instance_id,
                preview,
            } => {
                let instance_id = instance_id.unwrap_or_else(InstanceId::new);
                (
                    instance_id,
                    PendingPreviewRequest::Sequence(preview.clone()),
                    true,
                )
            }
            CuePreviewCommand::StopPreview { instance_id } => {
                (*instance_id, PendingPreviewRequest::Stop, false)
            }
            CuePreviewCommand::SeekPreview {
                instance_id,
                position,
                playing,
            } => (
                *instance_id,
                PendingPreviewRequest::Seek(*position, *playing),
                false,
            ),
        };
        match pending_requests.entry(instance_id) {
            std::collections::hash_map::Entry::Occupied(mut entry) => {
                // Replacement and stop commands invalidate seeks from the previous preview state.
                if !matches!(request, PendingPreviewRequest::Seek(..))
                    || matches!(entry.get().0, PendingPreviewRequest::Seek(..))
                {
                    entry.get_mut().0 = request;
                }
                entry
                    .get_mut()
                    .1
                    .push((event.command_id, returns_instance_id));
            }
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert((request, vec![(event.command_id, returns_instance_id)]));
            }
        }
    }

    for (instance_id, (request, completions)) in pending_requests {
        match request {
            PendingPreviewRequest::Seek(position, playing) => {
                for (id, mut clock, mut controls, sequence, cue) in &mut preview_clocks {
                    if *id != instance_id {
                        continue;
                    }
                    let elapsed = sequence
                        .and_then(|sequence| {
                            sequence
                                .runtime_status_at_clock(Some(&clock))
                                .transition_elapsed
                        })
                        .unwrap_or_else(|| {
                            clock.position.saturating_sub(
                                cue.map(|cue| cue.start_position).unwrap_or_default(),
                            )
                        });
                    let anchor = clock.position.saturating_sub(elapsed);
                    clock.seek_to(anchor.saturating_add(position));
                    controls.set_rate(if playing { 1.0 } else { 0.0 });
                }
            }
            PendingPreviewRequest::Cue(cue) => {
                despawn_preview_instances_by_id(&mut commands, &preview_query, instance_id);
                spawn_preview_cue(
                    &mut commands,
                    instance_id,
                    &cue,
                    color_path_data_provider.as_deref(),
                    blueprint_data_provider.as_deref(),
                    &fixture_data_provider,
                    &selection_resolver,
                    &parameter_query,
                );
                tracing::debug!("Updated cue preview for '{}'", cue.identifiers.label);
            }
            PendingPreviewRequest::Sequence(preview) => {
                despawn_preview_instances_by_id(&mut commands, &preview_query, instance_id);
                spawn_sequence_preview(
                    &mut commands,
                    instance_id,
                    &preview,
                    color_path_data_provider.as_deref(),
                    blueprint_data_provider.as_deref(),
                    &fixture_data_provider,
                    &selection_resolver,
                    &parameter_query,
                );
                tracing::debug!(
                    "Updated sequence preview for '{}' at position {}",
                    preview.sequence.identifiers.label,
                    preview.position
                );
            }
            PendingPreviewRequest::Stop => {
                release_preview_playback_by_id(&mut commands, &preview_query, instance_id);
                tracing::debug!(?instance_id, "Stopped editor preview instance");
            }
        }

        for (command_id, returns_instance_id) in completions {
            let result = if returns_instance_id {
                responder.succeed_with_output(
                    command_id,
                    serde_json::json!({ "instance_id": instance_id.0 }),
                )
            } else {
                responder.succeed(command_id)
            };
            if let Err(error) = result {
                tracing::error!(%command_id, %error, "cue_preview_command_completion_failed");
            }
        }
    }
}
