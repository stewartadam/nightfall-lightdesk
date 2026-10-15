// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Clip-to-cue playback adaptation and lifecycle action handling.
//!
//! [`handle_events`] routes each [`ClipOperation`] family to a handler in a sibling module:
//! starts in [`start`], stops in [`stop`], and cursor movement (go, back, goto, render-at)
//! in [`transport`]. Starts of clips without running playback are coalesced with same-tick
//! transport operations by [`deferred_start`] and materialized once at the end of the run.

use super::*;

mod deferred_start;
mod start;
mod stop;
mod transport;

use deferred_start::{DeferredClipAutostart, DeferredClipOperation, DeferredClipStarts};
use transport::StepDirection;

/// Groups playback resources used while translating clip commands.
#[derive(SystemParam)]
pub struct ClipPlaybackParams<'w> {
    pending_buffer: ResMut<'w, PendingEngineOperationBuffer>,
    instance_index: Option<Res<'w, InstanceIndex>>,
}

impl ClipPlaybackParams<'_> {
    /// Returns whether a playback instance is hosted by an indexed entity.
    ///
    /// Without an instance index every instance is treated as indexed, so clip handling
    /// keeps working in worlds that do not maintain one.
    fn is_indexed(&self, instance_id: &InstanceId) -> bool {
        match self.instance_index.as_ref() {
            Some(index) => index.get(instance_id).is_some(),
            None => true,
        }
    }

    /// Queues a sequence playback operation that inherits the clip event's command and undo
    /// identities, so the delegated mutation joins the same undo group.
    fn delegate(
        &mut self,
        envelope: &EngineOperationEnvelope<ClipOperation>,
        operation: SequencePlaybackOperation,
    ) {
        self.pending_buffer
            .push(DynEngineOperationEnvelope::with_context(
                OperationId::new(),
                envelope.command_id,
                envelope.undo_id,
                Box::new(operation),
            ));
    }
}

/// Definition sources needed to materialize sequence playback for a clip.
#[derive(SystemParam)]
pub struct ClipMaterializationSources<'w, 's> {
    cue_data_provider: Res<'w, DataProvider<Cue>>,
    color_path_data_provider: Option<Res<'w, DataProvider<ColorPath>>>,
    blueprint_data_provider: Option<Res<'w, DataProvider<Blueprint>>>,
    fixture_data_provider: Res<'w, FixtureDataProviderExt>,
    selection_resolver: SpatialSelectionResolver<'w>,
    parameter_query: Query<'w, 's, InstanceRef<'static, Parameter>>,
}

impl ClipMaterializationSources<'_, '_> {
    /// Builds the initial materialized playback state for a stored sequence.
    fn materialize_initial(&self, sequence: &Sequence) -> MaterializedSequence {
        MaterializedSequence::materialize_initial_with_sources(
            sequence,
            &self.cue_data_provider,
            self.color_path_data_provider.as_deref(),
            self.blueprint_data_provider.as_deref(),
            &self.fixture_data_provider,
            &self.parameter_query.as_readonly(),
            &self.selection_resolver,
        )
    }

    /// Extends a materialized sequence through the step a `go` would advance to.
    fn materialize_next_step(&self, msequence: &mut MaterializedSequence) {
        msequence.materialize_next_step_with_sources(
            self.color_path_data_provider.as_deref(),
            self.blueprint_data_provider.as_deref(),
            &self.fixture_data_provider,
            &self.parameter_query.as_readonly(),
            &self.selection_resolver,
        );
    }

    /// Extends a materialized sequence through the step a `back` would return to.
    fn materialize_previous_step(&self, msequence: &mut MaterializedSequence) {
        msequence.materialize_previous_step_with_sources(
            self.color_path_data_provider.as_deref(),
            self.blueprint_data_provider.as_deref(),
            &self.fixture_data_provider,
            &self.parameter_query.as_readonly(),
            &self.selection_resolver,
        );
    }

    /// Extends a materialized sequence through a one-based cue position.
    fn materialize_through_position(&self, msequence: &mut MaterializedSequence, position: u32) {
        msequence.materialize_through_position_with_sources(
            position,
            self.color_path_data_provider.as_deref(),
            self.blueprint_data_provider.as_deref(),
            &self.fixture_data_provider,
            &self.parameter_query.as_readonly(),
            &self.selection_resolver,
        );
    }
}

/// Finds an clip by numeric ID using the live ECS query.
pub(super) fn find_clip_by_id<'a>(exec_query: &'a Query<&Clip>, id: u32) -> Option<&'a Clip> {
    exec_query.iter().find(|clip| clip.identifiers.id == id)
}

/// Finds a clip for an operation, logging the miss and failing the command when absent.
fn lookup_clip<'a>(
    exec_query: &'a Query<&Clip>,
    outbound: &mut CommandResponder,
    correlation_id: Uuid,
    clip_id: u32,
    command_name: &'static str,
) -> Option<&'a Clip> {
    let clip = find_clip_by_id(exec_query, clip_id);
    if clip.is_none() {
        log_clip_lookup_failure(clip_id, "NoEntities", exec_query, command_name);
        outbound.fail_cue(
            correlation_id,
            format!("Failed to find clip with id: {clip_id}"),
        );
    }
    clip
}

/// Adds cue-domain terminal response helpers to the shared lifecycle responder.
pub(super) trait CueCommandResponseExt {
    /// Finishes a tracked cue-domain command successfully.
    fn succeed_cue(&mut self, correlation_id: uuid::Uuid);

    /// Finishes a tracked cue-domain command with structured failure details.
    fn fail_cue(&mut self, correlation_id: uuid::Uuid, message: String);

    /// Finishes a tracked cue-domain command with serializable output.
    fn succeed_cue_with_output<T: Serialize>(&mut self, correlation_id: uuid::Uuid, output: T);
}

impl CueCommandResponseExt for CommandResponder<'_> {
    fn succeed_cue(&mut self, correlation_id: uuid::Uuid) {
        let command_id = correlation_id.into();
        if !self.is_active(command_id) {
            return;
        }
        if let Err(error) = self.succeed(command_id) {
            tracing::error!(%command_id, %error, "cue_command_completion_failed");
        }
    }

    fn fail_cue(&mut self, correlation_id: uuid::Uuid, message: String) {
        let command_id = correlation_id.into();
        if !self.is_active(command_id) {
            return;
        }
        if let Err(error) = self.fail(
            command_id,
            CommandError::new("cues.command_failed", message),
        ) {
            tracing::error!(%command_id, %error, "cue_command_failure_failed");
        }
    }

    fn succeed_cue_with_output<T: Serialize>(&mut self, correlation_id: uuid::Uuid, output: T) {
        let command_id = correlation_id.into();
        if !self.is_active(command_id) {
            return;
        }
        if let Err(error) = self.succeed_with_output(command_id, output) {
            tracing::error!(%command_id, %error, "cue_command_output_completion_failed");
        }
    }
}

/// Reports an clip command whose stored sequence target no longer exists.
pub(super) fn report_missing_clip_sequence(
    outbound: &mut CommandResponder,
    correlation_id: uuid::Uuid,
    clip: &Clip,
    sequence_uid: uuid::Uuid,
    command_name: &'static str,
    error: &impl std::fmt::Display,
) {
    tracing::warn!(
        clip = %clip.identifiers().uid,
        clip_label = %clip.identifiers().label,
        sequence_uid = %sequence_uid,
        command = command_name,
        error = %error,
        "Clip references a missing sequence target"
    );
    outbound.fail_cue(
        correlation_id,
        format!(
            "Clip '{}' references missing sequence {}",
            clip.identifiers().label,
            sequence_uid
        ),
    );
}

/// Resolves one user-facing cue release reference to concrete cue identities.
pub(super) fn cue_release_uids(
    object_ref: &ObjectRef,
    cue_data_provider: &DataProvider<Cue>,
) -> Result<Vec<Uuid>, CommandError> {
    match object_ref {
        ObjectRef::ById { object_type, id } if *object_type == ObjectType::Cue => cue_data_provider
            .from_id(*id)
            .map(|cue| vec![cue.identifiers.uid])
            .map_err(|error| {
                CommandError::new(
                    "cue.release_not_found",
                    format!("Unable to release cue {id}: {error}"),
                )
            }),
        ObjectRef::ByUid { object_type, uid } if *object_type == ObjectType::Cue => Ok(vec![*uid]),
        _ => Err(CommandError::new(
            "cue.release_unsupported_object",
            format!("Cue release does not support {object_ref}"),
        )),
    }
}

/// Marks materialized instances of the supplied cue identities for release.
pub(super) fn release_cue_instances(
    uids: &[Uuid],
    materialized_cues: &Query<(Entity, &MaterializedCue)>,
    commands: &mut Commands,
) {
    materialized_cues
        .iter()
        .filter(|(_, cue)| uids.contains(&cue.identifiers().uid))
        .for_each(|(entity, cue)| {
            tracing::debug!(uid = %cue.identifiers().uid, "Releasing materialized cue");
            commands.entity(entity).insert(ReleaseMarker::default());
        });
}

/// Couples cue lifecycle action input with its typed internal result channel.
#[derive(SystemParam)]
pub struct CueLifecycleIo<'w, 's> {
    actions: MessageReader<'w, 's, EngineOperationEnvelope<CueLifecycleOperation>>,
    results: MessageWriter<'w, OperationResult<(), CommandError>>,
}

/// Runtime sequence playback components inspected while adapting clip commands.
type ClipSequencePlaybackView = (
    Entity,
    &'static MaterializedSequence,
    Option<&'static ReleaseMarker>,
    &'static InstanceId,
);

/// Dependencies shared by every clip operation handler.
#[derive(SystemParam)]
pub struct ClipOperationContext<'w, 's> {
    exec_query: Query<'w, 's, &'static Clip>,
    seq_data_provider: Res<'w, DataProvider<Sequence>>,
    sources: ClipMaterializationSources<'w, 's>,
    outbound: CommandResponder<'w>,
    msequences: Query<'w, 's, ClipSequencePlaybackView>,
    materialized_clips: Query<'w, 's, (Entity, &'static MaterializedClip)>,
    clip_playback: ClipPlaybackParams<'w>,
    commands: Commands<'w, 's>,
}

impl ClipOperationContext<'_, '_> {
    /// Finds the indexed playback instance a clip currently drives, skipping instances a
    /// same-tick stop is already detaching.
    fn active_instance(
        &self,
        clip_id: u32,
        detaching_instances: &HashSet<InstanceId>,
    ) -> Option<(Entity, InstanceId)> {
        self.materialized_clips
            .iter()
            .find(|(_, mexec)| {
                mexec.clip_id == clip_id
                    && self.clip_playback.is_indexed(&mexec.attached_instance)
                    && !detaching_instances.contains(&mexec.attached_instance)
            })
            .map(|(entity, mexec)| (entity, mexec.attached_instance))
    }
}

/// Encapsulates the complete dependency set for clip-to-cue event adaptation.
#[derive(SystemParam)]
pub struct CueClipEventContext<'w, 's> {
    clip_events: MessageReader<'w, 's, EngineOperationEnvelope<ClipOperation>>,
    cue_commands: MessageReader<'w, 's, CommandEnvelope<CueCommand>>,
    cue_lifecycle: CueLifecycleIo<'w, 's>,
    materialized_cues_for_release: Query<'w, 's, (Entity, &'static MaterializedCue)>,
    operations: ClipOperationContext<'w, 's>,
}

/// One clip operation envelope with the response and undo identities its handlers share.
struct ClipEvent<'a> {
    envelope: &'a EngineOperationEnvelope<ClipOperation>,
    correlation_id: Uuid,
    undo_id: Uuid,
}

impl<'a> ClipEvent<'a> {
    /// Derives the identities used to answer and group an operation: the originating
    /// command when present, otherwise the operation itself.
    fn new(envelope: &'a EngineOperationEnvelope<ClipOperation>) -> Self {
        let correlation_id = envelope
            .command_id
            .map(Uuid::from)
            .unwrap_or_else(|| envelope.operation_id.into());
        let undo_id = envelope.undo_id.map(Uuid::from).unwrap_or(correlation_id);
        Self {
            envelope,
            correlation_id,
            undo_id,
        }
    }
}

/// State accumulated across all clip operations handled in one system run.
#[derive(Default)]
struct ClipTickState {
    /// Instances a stop in this run has detached from their clips.
    detaching_instances: HashSet<InstanceId>,
    /// Clip starts awaiting materialization at the end of the run.
    deferred: DeferredClipStarts,
}

/// Adapts clip and cue lifecycle actions into materialized cue-domain playback.
///
/// Clip operations are handled in order, then deferred starts are materialized, then cue
/// release commands and lifecycle actions are applied.
pub fn handle_events(mut context: CueClipEventContext) {
    let operations = &mut context.operations;
    let mut tick = ClipTickState::default();

    for envelope in context.clip_events.read() {
        let event = ClipEvent::new(envelope);
        match &envelope.operation {
            ClipOperation::Start(clip_ids) => {
                start::handle_operation(operations, &mut tick, &event, clip_ids, None, None);
            }
            ClipOperation::StartAtTiming {
                clip_id,
                timing,
                instance_options,
            } => start::handle_operation(
                operations,
                &mut tick,
                &event,
                clip_id,
                Some(sequence_start_timing_from_timeline(*timing)),
                instance_options.and_then(|options| options.lookahead_enabled),
            ),
            ClipOperation::Stop(clip_ids) => {
                stop::handle_operation(operations, &mut tick, &event, clip_ids, None);
            }
            ClipOperation::StopAtTiming { clip_id, timing } => {
                stop::handle_operation(operations, &mut tick, &event, clip_id, Some(*timing));
            }
            ClipOperation::Go(clip_ids) => {
                transport::handle_step(operations, &mut tick, &event, clip_ids, StepDirection::Go);
            }
            ClipOperation::Back(clip_ids) => {
                transport::handle_step(operations, &mut tick, &event, clip_ids, StepDirection::Back)
            }
            ClipOperation::Goto {
                clip_id,
                position,
                timing,
            } => transport::handle_goto(operations, &mut tick, &event, clip_id, *position, *timing),
            ClipOperation::RenderAt {
                clip_id,
                position,
                timing,
                instance_options,
            } => transport::handle_render_at(
                operations,
                &mut tick,
                &event,
                clip_id,
                *position,
                *timing,
                instance_options.and_then(|options| options.lookahead_enabled),
            ),
            _ => {}
        }
    }

    tick.deferred.flush(operations);

    handle_cue_releases(&mut context);
}

/// Releases materialized cues named by cue release commands and lifecycle actions.
fn handle_cue_releases(context: &mut CueClipEventContext) {
    let operations = &mut context.operations;

    for event in context.cue_commands.read() {
        let CueCommand::ReleaseCue(object_ref) = &event.command else {
            continue;
        };
        let result =
            cue_release_uids(object_ref, &operations.sources.cue_data_provider).map(|uids| {
                release_cue_instances(
                    &uids,
                    &context.materialized_cues_for_release,
                    &mut operations.commands,
                );
            });
        let completion = match result {
            Ok(()) => operations.outbound.succeed(event.command_id),
            Err(error) => operations.outbound.fail(event.command_id, error),
        };
        if let Err(error) = completion {
            tracing::error!(command_id = %event.command_id, %error, "cue_release_completion_failed");
        }
    }

    for event in context.cue_lifecycle.actions.read() {
        let CueLifecycleOperation::ReleaseCueInstances { uids } = &event.operation;
        release_cue_instances(
            uids,
            &context.materialized_cues_for_release,
            &mut operations.commands,
        );
        context
            .cue_lifecycle
            .results
            .write(OperationResult::succeeded(event.operation_id, ()));
    }
}
