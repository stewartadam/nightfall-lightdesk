// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::*;
use crate::materialized_sequence::apply_color_path_samples_to_layer;

/// Cue instances and authored release clocks used during cleanup.
type ReleasingCueData = (
    Entity,
    &'static mut MaterializedCue,
    Option<&'static InstanceClock>,
    Option<&'static PlaybackReleaseTiming>,
);

/// Cue instances and layer state used to advance standalone playback.
type CuePlaybackData = (
    Entity,
    &'static mut MaterializedCue,
    Option<&'static Layer>,
    Option<&'static InstanceClock>,
    Option<&'static ReleaseMarker>,
);

/// Prepares standalone materialized cues for release when marked.
pub fn release_materialized_cues(
    mut mcues: Query<ReleasingCueData, With<ReleaseMarker>>,
    fixture_data_provider: Res<FixtureDataProviderExt>,
    parameter_query: Query<InstanceRef<Parameter>>,
) {
    for (entity, mut mcue, clock, release_timing) in mcues.iter_mut() {
        if !mcue.has_release_anchor_for_clock(clock) {
            tracing::debug!(entity=%entity, uid=%mcue.identifiers().uid, "Releasing cue '{}'", mcue.identifiers().label);
            let release_position = release_timing
                .map(|timing| timing.released_at)
                .or_else(|| clock.map(|clock| clock.position))
                .unwrap_or_default();
            mcue.release_with_ltp_hold_at_playback_position(
                &fixture_data_provider,
                &parameter_query,
                Some(release_position),
            );
        }
    }
}

/// Despawns cues that are due done releasing.
pub fn despawn_materialized_cues(
    mut commands: Commands,
    mut mcues: Query<(Entity, &mut MaterializedCue, Option<&InstanceClock>), With<ReleaseMarker>>,
) {
    for (entity, mcue, clock) in mcues.iter_mut() {
        let max_release_duration = mcue.max_release_duration();
        let release_elapsed = clock
            .and_then(|clock| {
                mcue.release_position
                    .map(|released_at| clock.position.saturating_sub(released_at))
            })
            .unwrap_or_default();

        if release_elapsed <= max_release_duration + Duration::from_millis(10) {
            continue;
        }

        tracing::debug!(entity=%entity, uid=%mcue.identifiers().uid, "Despawning cue '{}'", mcue.identifiers().label);
        commands.entity(entity).despawn();
    }
}

/// Bevy system that reads standalone materialized cues and generates rendering instructions layer
/// This is used for cue previews and other standalone cue rendering scenarios
pub fn paint_materialized_cues(
    mut mcue_query: Query<CuePlaybackData, Without<Owner>>,
    layer_stack_query: Query<(
        Entity,
        &Layer,
        Option<&ReleaseMarker>,
        Option<&LayerCompositingContext>,
    )>,
    parameter_query: Query<InstanceMut<Parameter>>,
    mut commands: Commands,
) {
    let layer_stack = layer_stack_query
        .iter()
        .map(
            |(entity, layer, release_marker, compositing_context)| StandaloneLayerStackEntry {
                entity,
                layer: layer.clone(),
                is_releasing: release_marker.is_some(),
                compositing_context: compositing_context.copied(),
            },
        )
        .collect::<Vec<_>>();

    mcue_query.iter_mut().for_each(
        |(entity, mut mcue, existing_layer, clock, release_marker)| {
            let mut new_layer = mcue.to_layer(None);
            if let Some(existing_layer) = existing_layer {
                new_layer.activation_time = existing_layer.activation_time;
            }
            let layer_compositing_context = if let Some(clock) = clock {
                Some(LayerCompositingContext {
                    position: clock.position,
                    released_at: release_marker.and(mcue.release_position),
                })
            } else if new_layer.has_transitions() {
                Some(LayerCompositingContext {
                    position: Duration::ZERO,
                    released_at: release_marker.and(mcue.release_position),
                })
            } else {
                None
            };
            let color_path_base_layer = standalone_color_path_base_layer(
                entity,
                &new_layer,
                &layer_stack,
                &parameter_query,
            );
            apply_color_path_samples_to_layer(
                &mut new_layer,
                &color_path_base_layer,
                &mcue.color_path_groups,
                &mcue.color_path_scalar_groups,
                &parameter_query,
                layer_compositing_context,
            );
            let mut entity_commands = commands.entity(entity);
            entity_commands.insert(new_layer);
            if let Some(layer_compositing_context) = layer_compositing_context {
                entity_commands.insert(layer_compositing_context);
            } else {
                entity_commands.remove::<LayerCompositingContext>();
            }
        },
    );
}

/// Existing compositor layer data used to build a standalone cue's color-path base.
struct StandaloneLayerStackEntry {
    /// Entity that owns the layer.
    entity: Entity,
    /// Current layer output from that entity.
    layer: Layer,
    /// Whether the layer is currently releasing.
    is_releasing: bool,
    /// Source-local timing context for the layer.
    compositing_context: Option<LayerCompositingContext>,
}

/// Computes the compositor base below the standalone cue layer being repainted.
fn standalone_color_path_base_layer(
    current_entity: Entity,
    current_layer: &Layer,
    layer_stack: &[StandaloneLayerStackEntry],
    parameter_query: &Query<InstanceMut<Parameter>>,
) -> ComputedLayer {
    let current_key = (*current_layer.priority, current_layer.activation_time);
    let mut lower_layers = layer_stack
        .iter()
        .filter(|entry| entry.entity != current_entity)
        .filter(|entry| (*entry.layer.priority, entry.layer.activation_time) < current_key)
        .collect::<Vec<_>>();
    lower_layers.sort_by_key(|entry| (*entry.layer.priority, entry.layer.activation_time));

    let mut base_layer = ComputedLayer::default();
    let mut previous_priority: Option<Priority> = None;
    for entry in lower_layers {
        let mut layer = entry.layer.clone();
        let compositing_context = entry.compositing_context.unwrap_or_default();
        let computed_layer =
            nightfall_compositor::stages::apply_transitions_with_compositing_context(
                &mut layer,
                &base_layer,
                parameter_query,
                entry.is_releasing,
                compositing_context,
            );
        let same_priority = previous_priority.is_some_and(|priority| priority == layer.priority);
        nightfall_compositor::stages::merge(
            &mut base_layer,
            &computed_layer,
            same_priority,
            parameter_query,
        );
        previous_priority = Some(layer.priority);
    }
    base_layer
}

/// Keeps generic instance runtime status in sync with standalone cue timing.
pub fn sync_cue_playback_runtime_status(
    mut commands: Commands,
    mut query: Query<(
        Entity,
        &MaterializedCue,
        Option<&InstanceClock>,
        Option<&mut InstanceStatus>,
    )>,
) {
    for (entity, cue, clock, status) in query.iter_mut() {
        let next_status = cue.runtime_status_at_clock(clock);
        if let Some(mut status) = status {
            *status = next_status;
        } else {
            commands.entity(entity).insert(next_status);
        }
    }
}
