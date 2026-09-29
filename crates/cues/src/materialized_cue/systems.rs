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
    layer_stack_query: Query<LayerStackData>,
    parameter_query: Query<InstanceMut<Parameter>>,
    mut commands: Commands,
) {
    let mut color_path_bases =
        standalone_color_path_bases(&mcue_query, &layer_stack_query, &parameter_query);

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
            if let Some(color_path_base_layer) = color_path_bases.remove(&entity) {
                apply_color_path_samples_to_layer(
                    &mut new_layer,
                    &color_path_base_layer,
                    &mcue.color_path_groups,
                    &mcue.color_path_scalar_groups,
                    &parameter_query,
                    layer_compositing_context,
                );
            }
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

/// Layer stack components read to build standalone cue color-path bases.
type LayerStackData = (
    Entity,
    &'static Layer,
    Option<&'static ReleaseMarker>,
    Option<&'static LayerCompositingContext>,
);

/// Compositing order of a layer: lower keys composite first.
type LayerStackKey = (i8, Instant);

/// Returns the compositing order key of a layer.
fn layer_stack_key(layer: &Layer) -> LayerStackKey {
    (*layer.priority, layer.activation_time)
}

/// Incrementally composites the existing layer stack in compositor order.
struct LayerStackCompositor {
    /// Composite of every layer merged so far.
    base_layer: ComputedLayer,
    /// Priority of the last merged layer, to merge same-priority layers together.
    previous_priority: Option<Priority>,
}

impl LayerStackCompositor {
    /// Starts from an empty composite.
    fn new() -> Self {
        Self {
            base_layer: ComputedLayer::default(),
            previous_priority: None,
        }
    }

    /// Applies one layer's transitions against the composite so far and merges it in.
    fn merge(
        &mut self,
        (_, layer, release_marker, compositing_context): &(
            Entity,
            &Layer,
            Option<&ReleaseMarker>,
            Option<&LayerCompositingContext>,
        ),
        parameter_query: &Query<InstanceMut<Parameter>>,
    ) {
        let mut layer = (*layer).clone();
        let computed_layer =
            nightfall_compositor::stages::apply_transitions_with_compositing_context(
                &mut layer,
                &self.base_layer,
                parameter_query,
                release_marker.is_some(),
                compositing_context.copied().unwrap_or_default(),
            );
        let same_priority = self
            .previous_priority
            .is_some_and(|priority| priority == layer.priority);
        nightfall_compositor::stages::merge(
            &mut self.base_layer,
            &computed_layer,
            same_priority,
            parameter_query,
        );
        self.previous_priority = Some(layer.priority);
    }
}

/// Computes the compositor base below each standalone cue that samples color paths.
///
/// A cue's base composites every other layer that sorts strictly below the cue's layer. Cues
/// without color paths need no base, so the stack is only walked when some cue has them, and then
/// only once: bases are snapshots of one ascending walk, which keeps painting linear in the number
/// of cues. A cue whose own previous layer sorts below its new key is excluded from its base, so it
/// gets a dedicated walk instead.
fn standalone_color_path_bases(
    mcue_query: &Query<CuePlaybackData, Without<Owner>>,
    layer_stack_query: &Query<LayerStackData>,
    parameter_query: &Query<InstanceMut<Parameter>>,
) -> HashMap<Entity, ComputedLayer> {
    let now = Instant::now();
    let mut targets = mcue_query
        .iter()
        .filter(|(_, mcue, ..)| {
            !mcue.color_path_groups.is_empty() || !mcue.color_path_scalar_groups.is_empty()
        })
        .map(|(entity, mcue, existing_layer, ..)| {
            let activation_time = existing_layer.map_or(now, |layer| layer.activation_time);
            ((*mcue.priority, activation_time), entity)
        })
        .collect::<Vec<_>>();
    if targets.is_empty() {
        return HashMap::new();
    }
    targets.sort_by_key(|(key, _)| *key);

    let mut stack = layer_stack_query.iter().collect::<Vec<_>>();
    stack.sort_by_key(|(_, layer, ..)| layer_stack_key(layer));

    let mut bases = HashMap::with_capacity(targets.len());
    let mut compositor = LayerStackCompositor::new();
    let mut merged = 0;
    for (key, entity) in targets {
        while merged < stack.len() && layer_stack_key(stack[merged].1) < key {
            compositor.merge(&stack[merged], parameter_query);
            merged += 1;
        }

        let includes_own_layer = stack[..merged].iter().any(|entry| entry.0 == entity);
        let base_layer = if includes_own_layer {
            let mut own_compositor = LayerStackCompositor::new();
            for entry in stack[..merged].iter().filter(|entry| entry.0 != entity) {
                own_compositor.merge(entry, parameter_query);
            }
            own_compositor.base_layer
        } else {
            compositor.base_layer.clone()
        };
        bases.insert(entity, base_layer);
    }
    bases
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
