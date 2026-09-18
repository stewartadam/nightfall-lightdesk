// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use super::*;

impl MaterializedCue {
    /// Updates all transition anchors stored in a layer.
    fn set_layer_start_position(layer: &mut Layer, position: Duration) {
        [&mut layer.absolute, &mut layer.relative]
            .into_iter()
            .for_each(|layer| {
                layer.iter_mut().for_each(|(_, (_, maybe_transition))| {
                    if let Some(transition) = maybe_transition {
                        transition.start_position = position;
                    }
                });
            });
    }

    /// Creates a layer with fixture instructions from a materialized cue
    pub fn to_layer(&mut self, tracked: Option<&Layer>) -> Layer {
        tracing::trace!(
            uid=%self.cue.identifiers().uid,
            "Creating layer for materialized cue '{}'",
            self.identifiers().label
        );
        let mut base_layer = if let Some(tracked) = tracked {
            tracked.clone()
        } else {
            Layer::with_capacity(
                self.identifiers().label.clone(),
                self.priority,
                self.values.absolute.len(),
                self.values.relative.len(),
            )
        };

        // FIXME: might help to memoize this for when tracked has not changed
        base_layer.squash(self.values.clone());
        base_layer
    }

    /// Returns inspectable instance runtime status for standalone cue playback.
    pub fn runtime_status(&self) -> InstanceStatus {
        self.runtime_status_at_clock(None)
    }

    /// Returns inspectable instance runtime status using the playback clock when available.
    pub fn runtime_status_at_clock(&self, clock: Option<&InstanceClock>) -> InstanceStatus {
        InstanceStatus {
            position: clock.map_or(InstancePosition::None, |clock| InstancePosition::Time {
                elapsed: clock.position,
            }),
            source_activation_epoch_ms: clock
                .and_then(|clock| clock.activation_epoch_ms)
                .or_else(|| Some(activation_epoch_ms(self.activation_time))),
            transition_elapsed: clock.map(|clock| clock.position),
        }
    }

    /// Returns the resolved duration profile for this materialized cue.
    pub fn duration_profile(&self) -> CueDurationProfile {
        self.duration_profile
    }

    /// Returns the source-local duration this cue occupies in sequence scheduling.
    pub(crate) fn cue_duration(&self) -> Duration {
        self.max_assertion_duration
            .max(self.cue.authored_duration())
    }

    /// Sets the cue's UI-facing host activation timestamp.
    pub fn set_activation_time(&mut self, time: Instant) {
        self.activation_time = time;
    }

    /// Sets the source-local start position of the cue and all its transitions.
    pub fn set_start_position(&mut self, position: Duration) {
        self.start_position = position;
        Self::set_layer_start_position(&mut self.values, position);
        self.part_layers.iter_mut().for_each(|part_layer| {
            Self::set_layer_start_position(&mut part_layer.values, position)
        });
        self.release_timing_overrides
            .iter_mut()
            .for_each(|(_, transition)| transition.start_position = position);
        self.release_value_transitions
            .iter_mut()
            .for_each(|(_, transition)| transition.start_position = position);
        self.part_layers.iter_mut().for_each(|part_layer| {
            part_layer
                .release_value_transitions
                .iter_mut()
                .for_each(|(_, transition)| transition.start_position = position)
        });
    }
}
