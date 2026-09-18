// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Clip-routed FX playback and instance release handling.

use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};

use bevy_ecs::prelude::*;
use nightfall::prelude::*;
use nightfall_compositor::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_instances::{
    ClipInstanceAttachment, ClipInstanceStartContext, InstanceClock, InstanceControls,
    InstanceDisplayKind, InstanceId, InstanceKind, InstanceMetadata, Owner, PlaybackReleaseAction,
    instance_clock_from_reconstruction_timing, reconcile_instance_options,
};
use nightfall_playback_planner::PlaybackReconstructionTiming;
use uuid::Uuid;

use crate::prelude::*;

/// Active step FX instances and their playback lifecycle state.
type ActiveStepFxData = (
    Entity,
    &'static ActiveStepFx,
    Option<&'static InstanceId>,
    Option<&'static InstanceControls>,
    Option<&'static ReleaseMarker>,
    Option<&'static InstanceClock>,
);

/// Converts reconstruction timing into a start clock position.
fn playback_start_timing(timing: PlaybackReconstructionTiming) -> PlaybackReconstructionTiming {
    PlaybackReconstructionTiming {
        started_at: Duration::ZERO,
        position: timing.elapsed(),
        source: timing.source,
    }
}

/// Builds the playback clock for a started FX playback.
fn instance_clock_from_optional_reconstruction_timing(
    timing: Option<PlaybackReconstructionTiming>,
) -> InstanceClock {
    timing
        .map(playback_start_timing)
        .map(instance_clock_from_reconstruction_timing)
        .unwrap_or_default()
}

/// Clip-routed playback actions owned by the FX domain.
#[derive(Debug, Clone, EnginePayload)]
pub enum FxPlaybackAction {
    /// Start or refresh an ordinary waveform FX playback for an clip.
    StartFx {
        /// FX source UID to materialize.
        fx_uid: Uuid,
        /// Shared clip metadata for the routed start.
        context: ClipInstanceStartContext,
    },
    /// Start or refresh a step FX playback for an clip.
    StartStepFx {
        /// Step FX source UID to materialize.
        step_fx_uid: Uuid,
        /// Shared clip metadata for the routed start.
        context: ClipInstanceStartContext,
    },
    /// Release FX-owned instances attached to an clip.
    Stop {
        /// Numeric clip ID whose playback slot requested the action.
        clip_id: u32,
        /// Runtime instances currently attached to the clip.
        attached_instances: Vec<InstanceId>,
        /// Optional source-local release timing.
        timing: Option<PlaybackReconstructionTiming>,
    },
}

impl EngineAction for FxPlaybackAction {}

/// Mark FX-domain playback entities for release.
fn release_fx_instances(
    commands: &mut Commands,
    instance_ids: &HashSet<InstanceId>,
    timing: Option<PlaybackReconstructionTiming>,
    fx_query: &Query<(Entity, &MaterializedFx, &InstanceId)>,
    active_step_fx_query: &Query<ActiveStepFxData>,
) {
    for (entity, _, instance_id) in fx_query.iter() {
        if instance_ids.contains(instance_id) {
            let mut entity_commands = commands.entity(entity);
            entity_commands.insert(ReleaseMarker::default());
            if let Some(timing) = timing {
                entity_commands.insert(instance_clock_from_reconstruction_timing(timing));
            }
        }
    }

    for (entity, _, instance_id, _, _, _) in active_step_fx_query.iter() {
        let Some(instance_id) = instance_id else {
            continue;
        };
        if instance_ids.contains(instance_id) {
            let mut entity_commands = commands.entity(entity);
            entity_commands.insert(ReleaseMarker::default());
            if let Some(timing) = timing {
                entity_commands.insert(instance_clock_from_reconstruction_timing(timing));
            }
        }
    }
}

/// Handles clip-routed FX playback actions from the desk resolver.
pub fn handle_events(
    fx_query: Query<(Entity, &MaterializedFx, &InstanceId)>,
    step_fx_query: Query<(Entity, &StepFx)>,
    active_step_fx_query: Query<ActiveStepFxData>,
    fx_data_provider: Res<DataProvider<Fx>>,
    mut events: MessageReader<EngineActionEnvelope<FxPlaybackAction>>,
    mut attachments: MessageWriter<EventEnvelope<ClipInstanceAttachment>>,
    mut commands: Commands,
) {
    /// Runtime bookkeeping for a step FX currently applied to fixtures.
    #[derive(Clone)]
    struct ActiveStepFxState {
        active_entity: Entity,
        step_fx_uid: Uuid,
        runtime: ActiveStepFx,
        instance_id: InstanceId,
        controls: InstanceControls,
        clock: Option<InstanceClock>,
        is_releasing: bool,
    }

    let mut fx_instances_by_clip: HashMap<u32, (Entity, InstanceId, Uuid)> = HashMap::new();
    let mut active_step_fx_by_clip: HashMap<u32, ActiveStepFxState> = HashMap::new();
    let mut detaching_instances = HashSet::new();

    for event in events.read() {
        match &event.action {
            FxPlaybackAction::Stop {
                clip_id,
                attached_instances,
                timing,
            } => {
                let attached_instances = attached_instances.iter().copied().collect::<HashSet<_>>();
                detaching_instances.extend(attached_instances.iter().copied());
                tracing::debug!(
                    clip_id,
                    playback_count = attached_instances.len(),
                    "Releasing FX instances for clip"
                );
                release_fx_instances(
                    &mut commands,
                    &attached_instances,
                    *timing,
                    &fx_query,
                    &active_step_fx_query,
                );
            }
            FxPlaybackAction::StartFx { fx_uid, context } => {
                let context = *context;
                let fx = fx_data_provider.get(*fx_uid).expect("failed to obtain fx");

                tracing::debug!(
                    uid = %fx.identifiers().uid,
                    clip = %context.clip_uid,
                    "Materializing fx '{}' for clip",
                    fx.identifiers().label,
                );

                let mfx = MaterializedFx::materialize(&fx, context.priority);

                if let Some((mfx_entity, instance_id)) = fx_instances_by_clip
                    .get(&context.clip_id)
                    .copied()
                    .filter(|(_, instance_id, existing_fx_uid)| {
                        *existing_fx_uid == *fx_uid && !detaching_instances.contains(instance_id)
                    })
                    .map(|(entity, instance_id, _)| (entity, instance_id))
                    .or_else(|| {
                        context.attached_instance.and_then(|attached_instance| {
                            fx_query
                                .iter()
                                .find(|(_, mfx, instance_id)| {
                                    **instance_id == attached_instance
                                        && mfx.identifiers().uid == *fx_uid
                                        && !detaching_instances.contains(instance_id)
                                })
                                .map(|(entity, _, instance_id)| (entity, *instance_id))
                        })
                    })
                {
                    tracing::debug!(
                        uid = %mfx.identifiers().uid,
                        clip = %context.clip_uid,
                        "Updating materialization fx '{}' on clip",
                        fx.identifiers().label,
                    );

                    let mut entity_commands = commands.entity(mfx_entity);
                    entity_commands
                        .insert((
                            mfx,
                            instance_clock_from_optional_reconstruction_timing(context.timing),
                        ))
                        .remove::<ReleaseMarker>();
                    reconcile_instance_options(&mut entity_commands, context.instance_options);
                    attachments.write(EventEnvelope::for_action(
                        event,
                        ClipInstanceAttachment {
                            clip_id: context.clip_id,
                            instance_id,
                            auto_release_on_stop: context.auto_release_on_stop,
                        },
                    ));
                } else {
                    tracing::debug!(
                        uid = %mfx.identifiers().uid,
                        clip = %context.clip_uid,
                        "Creating materialization fx '{}' on clip",
                        fx.identifiers().label,
                    );

                    if let Some(attached_instance) = context.attached_instance {
                        release_fx_instances(
                            &mut commands,
                            &HashSet::from([attached_instance]),
                            None,
                            &fx_query,
                            &active_step_fx_query,
                        );
                        detaching_instances.insert(attached_instance);
                    }

                    let owner = Owner(context.clip_uid);
                    let marker = ObjectRefMarker(ObjectRef::ByUid {
                        object_type: ObjectType::Fx,
                        uid: mfx.identifiers().uid,
                    });
                    let instance_id = InstanceId::new();
                    let instance_metadata = InstanceMetadata::new(InstanceKind::Fx)
                        .with_name(fx.identifiers().label.clone());
                    let instance_controls = InstanceControls::default();
                    let instance_clock =
                        instance_clock_from_optional_reconstruction_timing(context.timing);

                    // Spawn the playback entity
                    let spawned_fx_entity = commands
                        .spawn((
                            mfx,
                            owner,
                            marker,
                            instance_id,
                            instance_metadata,
                            instance_controls,
                            instance_clock,
                        ))
                        .id();
                    if let Some(instance_options) = context.instance_options {
                        commands.entity(spawned_fx_entity).insert(instance_options);
                    }
                    let _ = spawned_fx_entity;
                    fx_instances_by_clip
                        .insert(context.clip_id, (spawned_fx_entity, instance_id, *fx_uid));

                    attachments.write(EventEnvelope::for_action(
                        event,
                        ClipInstanceAttachment {
                            clip_id: context.clip_id,
                            instance_id,
                            auto_release_on_stop: context.auto_release_on_stop,
                        },
                    ));
                }
            }
            FxPlaybackAction::StartStepFx {
                step_fx_uid,
                context,
            } => {
                let context = *context;
                let Some((fx_entity, step_fx)) = step_fx_query
                    .iter()
                    .find(|(_, step_fx)| step_fx.identifiers.uid == *step_fx_uid)
                else {
                    tracing::warn!(
                        clip_id = %context.clip_id,
                        step_fx_uid = %step_fx_uid,
                        "StepFx clip target not found"
                    );
                    continue;
                };

                if let Some(state) =
                    active_step_fx_by_clip
                        .get_mut(&context.clip_id)
                        .filter(|state| {
                            state.step_fx_uid == *step_fx_uid
                                && !detaching_instances.contains(&state.instance_id)
                        })
                {
                    let mut active_fx = state.runtime.clone();
                    active_fx.is_playing = true;
                    active_fx.priority = context.priority;
                    let mut entity_commands = commands.entity(state.active_entity);
                    entity_commands.insert((
                        active_fx,
                        state.instance_id,
                        InstanceMetadata::new(InstanceKind::Fx)
                            .with_display_kind(InstanceDisplayKind::StepFx)
                            .with_name(step_fx.identifiers.label.clone()),
                        state.controls.clone(),
                        context
                            .timing
                            .map(|timing| {
                                instance_clock_from_optional_reconstruction_timing(Some(timing))
                            })
                            .or_else(|| state.clock.clone())
                            .unwrap_or_default(),
                        Owner(context.clip_uid),
                    ));
                    reconcile_instance_options(&mut entity_commands, context.instance_options);
                    if state.is_releasing {
                        entity_commands.remove::<ReleaseMarker>();
                    }
                    attachments.write(EventEnvelope::for_action(
                        event,
                        ClipInstanceAttachment {
                            clip_id: context.clip_id,
                            instance_id: state.instance_id,
                            auto_release_on_stop: context.auto_release_on_stop,
                        },
                    ));
                    continue;
                }

                if let Some((
                    active_entity,
                    active_fx,
                    instance_id,
                    controls,
                    release_marker,
                    clock,
                )) = context.attached_instance.and_then(|attached_instance| {
                    active_step_fx_query
                        .iter()
                        .find(|(_, active_fx, instance_id, _, _, _)| {
                            instance_id.is_some_and(|instance_id| {
                                instance_id == &attached_instance
                                    && !detaching_instances.contains(instance_id)
                            }) && step_fx_query
                                .get(active_fx.fx_entity)
                                .ok()
                                .is_some_and(|(_, step_fx)| step_fx.identifiers.uid == *step_fx_uid)
                        })
                }) {
                    let mut active_fx = active_fx.clone();
                    active_fx.is_playing = true;
                    active_fx.priority = context.priority;
                    let mut entity_commands = commands.entity(active_entity);
                    entity_commands.insert((
                        active_fx,
                        *instance_id.expect("matched active step FX has playback ID"),
                        InstanceMetadata::new(InstanceKind::Fx)
                            .with_display_kind(InstanceDisplayKind::StepFx)
                            .with_name(step_fx.identifiers.label.clone()),
                        controls.cloned().unwrap_or_default(),
                        context
                            .timing
                            .map(|timing| {
                                instance_clock_from_optional_reconstruction_timing(Some(timing))
                            })
                            .or_else(|| clock.cloned())
                            .unwrap_or_default(),
                        Owner(context.clip_uid),
                    ));
                    reconcile_instance_options(&mut entity_commands, context.instance_options);
                    if release_marker.is_some() {
                        entity_commands.remove::<ReleaseMarker>();
                    }
                    attachments.write(EventEnvelope::for_action(
                        event,
                        ClipInstanceAttachment {
                            clip_id: context.clip_id,
                            instance_id: *instance_id
                                .expect("matched active step FX has playback ID"),
                            auto_release_on_stop: context.auto_release_on_stop,
                        },
                    ));
                    continue;
                }

                if let Some(attached_instance) = context.attached_instance {
                    release_fx_instances(
                        &mut commands,
                        &HashSet::from([attached_instance]),
                        None,
                        &fx_query,
                        &active_step_fx_query,
                    );
                    detaching_instances.insert(attached_instance);
                }

                let instance_id = InstanceId::new();
                let active_step_fx = ActiveStepFx {
                    fx_entity,
                    priority: context.priority,
                    rate: 1.0,
                    is_playing: true,
                };
                let instance_clock =
                    instance_clock_from_optional_reconstruction_timing(context.timing);
                let active_entity = commands
                    .spawn((
                        active_step_fx.clone(),
                        Owner(context.clip_uid),
                        instance_id,
                        InstanceMetadata::new(InstanceKind::Fx)
                            .with_display_kind(InstanceDisplayKind::StepFx)
                            .with_name(step_fx.identifiers.label.clone()),
                        InstanceControls::default(),
                        instance_clock.clone(),
                    ))
                    .id();
                if let Some(instance_options) = context.instance_options {
                    commands.entity(active_entity).insert(instance_options);
                }

                let _ = active_entity;
                active_step_fx_by_clip.insert(
                    context.clip_id,
                    ActiveStepFxState {
                        active_entity,
                        step_fx_uid: *step_fx_uid,
                        runtime: active_step_fx,
                        instance_id,
                        controls: InstanceControls::default(),
                        clock: Some(instance_clock),
                        is_releasing: false,
                    },
                );
                attachments.write(EventEnvelope::for_action(
                    event,
                    ClipInstanceAttachment {
                        clip_id: context.clip_id,
                        instance_id,
                        auto_release_on_stop: context.auto_release_on_stop,
                    },
                ));
            }
        }
    }
}

/// Handles playback-level stop commands for active step FX instances.
pub fn handle_step_fx_playback_commands(
    mut commands: Commands,
    mut instance_events: MessageReader<EngineActionEnvelope<PlaybackReleaseAction>>,
    active_fx_query: Query<(Entity, &InstanceId, Option<&InstanceMetadata>), With<ActiveStepFx>>,
) {
    for event in instance_events.read() {
        match &event.action {
            PlaybackReleaseAction::One(target_instance_id) => {
                for (entity, instance_id, _) in active_fx_query.iter() {
                    if instance_id == target_instance_id {
                        commands.entity(entity).insert(ReleaseMarker::default());
                    }
                }
            }
            PlaybackReleaseAction::All => {
                for (entity, _, _) in active_fx_query.iter() {
                    commands.entity(entity).insert(ReleaseMarker::default());
                }
            }
            PlaybackReleaseAction::ByKind(kind) => {
                for (entity, _, metadata) in active_fx_query.iter() {
                    if metadata.is_some_and(|metadata| metadata.kind == *kind) {
                        commands.entity(entity).insert(ReleaseMarker::default());
                    }
                }
            }
            PlaybackReleaseAction::ByTag(tag) => {
                for (entity, _, metadata) in active_fx_query.iter() {
                    if metadata.is_some_and(|metadata| metadata.tags.contains(tag)) {
                        commands.entity(entity).insert(ReleaseMarker::default());
                    }
                }
            }
        }
    }
}
