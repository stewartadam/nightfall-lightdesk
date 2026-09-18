// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Generates the layer for the programmer
use bevy_ecs::prelude::*;
use moonshine_kind::prelude::*;
use nightfall::prelude::*;
use nightfall_compositor::prelude::*;
use nightfall_cues::prelude::*;
use nightfall_engine::prelude::DataProvider;
use nightfall_fixtures::prelude::*;
use nightfall_fixtures::selection::SpatialSelectionResolver;
use nightfall_instances::{
    InstanceClock, InstanceControls, InstanceId, InstanceKind, InstanceMetadata, Owner,
    activation_epoch_ms,
};

use crate::resources::Programmer;

/// Owned cue instances and layer clocks updated by the programmer painter.
type ProgrammerCueData = (
    Entity,
    &'static mut MaterializedCue,
    &'static Owner,
    Option<&'static Layer>,
    Option<&'static ReleaseMarker>,
    Option<&'static InstanceClock>,
);

/// Builds the source-local compositing context for a programmer-owned layer.
fn programmer_layer_compositing_context(
    clock: Option<&InstanceClock>,
    is_releasing: bool,
    release_position: Option<std::time::Duration>,
) -> LayerCompositingContext {
    let position = clock.map(|clock| clock.position).unwrap_or_default();
    LayerCompositingContext {
        position,
        released_at: is_releasing.then_some(release_position.unwrap_or(position)),
    }
}

/// Removes release-side timing from a programmer layer without changing assertion timing.
fn zero_programmer_release_timing(mcue: &mut MaterializedCue) {
    for (_, (_, transition)) in mcue
        .values
        .absolute
        .iter_mut()
        .chain(mcue.values.relative.iter_mut())
    {
        if let Some(transition) = transition {
            transition.delay_out = std::time::Duration::ZERO;
            transition.fade_out = std::time::Duration::ZERO;
            transition.curve_out = FadeCurve::Linear;
        }
    }
    mcue.release_timing_overrides = Default::default();
}

/// The programmer is rendered into a layer (that is always composited last)
/// TODO: find a better home for this
pub fn materialize_and_paint_programmer(
    programmer: Res<Programmer>,
    parameter_query: Query<InstanceRef<Parameter>>,
    data_provider: Res<FixtureDataProviderExt>,
    blueprint_data_provider: Option<Res<DataProvider<Blueprint>>>,
    selection_resolver: SpatialSelectionResolver,
    mut mcues_query: Query<ProgrammerCueData>,
    mut commands: Commands,
) {
    tracing::trace!(
        uid = %programmer.identifiers().uid,
        "Painting layers for programmer '{}'",
        programmer.identifiers().label
    );

    let active_instruction_ids = programmer
        .active_instructions()
        .iter()
        .map(|(uuid, _)| *uuid)
        .collect::<std::collections::HashSet<_>>();

    for (entity, mut mcue, owner, existing_layer, release_marker, clock) in mcues_query.iter_mut() {
        if owner.0 != programmer.identifiers().uid
            || active_instruction_ids.contains(&mcue.cue.identifiers().uid)
        {
            continue;
        }

        let mut entity_commands = commands.entity(entity);
        if release_marker.is_none() {
            tracing::debug!(
                uid = %mcue.cue.identifiers().uid,
                "Releasing stale programmer instruction layer"
            );
            zero_programmer_release_timing(&mut mcue);
            let mut release_layer = mcue.to_layer(None);
            if let Some(existing_layer) = existing_layer {
                release_layer.activation_time = existing_layer.activation_time;
            }
            entity_commands.insert(release_layer);
            entity_commands.insert(ReleaseMarker::default());
        }
        entity_commands.insert(programmer_layer_compositing_context(
            clock,
            true,
            mcue.release_position,
        ));
    }

    // Materialize any each instruction since last frame (since existing ones might have been modified), then generate layers for each
    for (uuid, instruction) in programmer.active_instructions().iter() {
        // Check if the UUID already exists in the ECS
        let existing_count = mcues_query
            .iter_mut()
            .filter(|(_, mcue, _, _, release_marker, _)| {
                release_marker.is_none() && mcue.cue.identifiers().uid == *uuid
            })
            .fold(0, |count, (entity, mut mcue, _, _, _, clock)| {
                tracing::trace!(
                    "Materialized cue for programmer instruction '{}' already exists",
                    uuid
                );

                let original_activation_time = mcue.activation_time;
                let original_start_position = mcue.start_position;
                mcue.cue.instructions = vec![instruction.clone()];
                let mut updated_mcue = MaterializedCue::materialize_with_sources(
                    &mcue.cue,
                    None,
                    blueprint_data_provider.as_deref(),
                    &data_provider,
                    &parameter_query,
                    &selection_resolver,
                );
                // Preserve timing anchors so transitions continue from when they were first created.
                updated_mcue.set_activation_time(original_activation_time);
                updated_mcue.set_start_position(original_start_position);
                updated_mcue.priority = mcue.priority;
                let layer = updated_mcue.to_layer(None);
                let compositing_context = programmer_layer_compositing_context(clock, false, None);
                commands.entity(entity).insert((
                    updated_mcue,
                    layer,
                    compositing_context,
                    Owner(programmer.identifiers().uid),
                    ObjectRefMarker(ObjectRef::ByUid {
                        object_type: ObjectType::Cue,
                        uid: mcue.cue.identifiers().uid,
                    }),
                ));
                count + 1
            });

        // Only create a new materialized cue if one doesn't already exist
        if existing_count > 0 {
            continue;
        }

        tracing::trace!(
            uid = %programmer.identifiers().uid,
            "Creating materialized cue for programmer '{}' instruction '{}'",
            programmer.identifiers().label,
            uuid
        );
        let mut mcue = MaterializedCue::materialize_with_sources(
            &Cue {
                instructions: vec![instruction.clone()],
                identifiers: Identifiers {
                    uid: *uuid,
                    label: format!("Programmer Instruction {}", uuid),
                    ..Default::default()
                },
                ..Default::default()
            },
            None,
            blueprint_data_provider.as_deref(),
            &data_provider,
            &parameter_query,
            &selection_resolver,
        );

        if let Some(source_uid) = programmer.transition_anchor_source(uuid) {
            if let Some((activation_time, start_position)) = mcues_query
                .iter_mut()
                .find(|(_, source_mcue, _, _, release_marker, _)| {
                    release_marker.is_none() && source_mcue.cue.identifiers().uid == source_uid
                })
                .map(|(_, source_mcue, _, _, _, _)| {
                    (source_mcue.activation_time, source_mcue.start_position)
                })
            {
                mcue.set_activation_time(activation_time);
                mcue.set_start_position(start_position);
            }
        }

        mcue.priority = Priority(127); // programmer should always be layered on top of everything else

        let marker = ObjectRefMarker(ObjectRef::ByUid {
            object_type: ObjectType::Cue,
            uid: mcue.identifiers().uid,
        });
        let layer = mcue.to_layer(None);
        let compositing_context = programmer_layer_compositing_context(None, false, None);
        let instance_id = InstanceId::new();
        let instance_clock = InstanceClock::realtime_with_activation_epoch(Some(
            activation_epoch_ms(mcue.activation_time),
        ));
        let instance_metadata = InstanceMetadata::new(InstanceKind::Programmer)
            .with_name(format!("Programmer Instruction {}", uuid));
        let instance_controls = InstanceControls::default();
        commands.spawn((
            mcue,
            layer,
            compositing_context,
            Owner(programmer.identifiers.uid),
            marker,
            instance_id,
            instance_clock,
            instance_metadata,
            instance_controls,
        ));
    }
}
