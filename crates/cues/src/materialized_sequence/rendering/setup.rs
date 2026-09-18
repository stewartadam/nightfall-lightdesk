// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Setup-cue rendering, compositing contexts, and cue metadata preparation.

use std::collections::HashSet;

use super::super::tracking::*;
use super::super::*;
use super::stages::{CueLayerMetadata, RenderedSetupLayer};

impl MaterializedSequence {
    /// Renders the setup cue and returns the completed base that sequence cues build on.
    pub(super) fn render_setup_layer(
        &mut self,
        seq_layer: &mut Layer,
        param_query: &mut Query<InstanceMut<Parameter>>,
        compositing_context: Option<nightfall_compositor::types::LayerCompositingContext>,
    ) -> RenderedSetupLayer {
        let empty_base_layer = ComputedLayer::default();
        let mut setup_layer = self.setup_cue.to_layer(Some(seq_layer));
        let setup_relative_overrides: Vec<_> = self.setup_cue.values.relative.keys().collect();
        retarget_sequence_relative_overrides(
            &mut setup_layer,
            &empty_base_layer,
            param_query,
            &setup_relative_overrides,
        );
        let setup_base_layer = apply_and_squash_transitions_for_sequence_context(
            &mut setup_layer,
            &empty_base_layer,
            param_query,
            compositing_context,
            &HashSet::new(),
        );
        let stable = setup_layer
            .transitioning
            .values()
            .all(|transitioning| !*transitioning);
        seq_layer.squash(setup_layer);
        RenderedSetupLayer {
            base_layer: setup_base_layer,
            stable,
        }
    }

    /// Returns the compositing context for a cue step at its own source-local activation anchor.
    pub(super) fn cue_compositing_context_for_index(
        &self,
        index: usize,
        clock: Option<&InstanceClock>,
    ) -> Option<nightfall_compositor::types::LayerCompositingContext> {
        let clock = clock?;
        self.cue_activation_positions
            .get(index)
            .and_then(|position| *position)?;
        Some(nightfall_compositor::types::LayerCompositingContext {
            position: clock.position,
            released_at: None,
        })
    }

    /// Returns the compositing context for the setup cue asserted at sequence start.
    pub(super) fn setup_compositing_context(
        &self,
        clock: Option<&InstanceClock>,
    ) -> Option<nightfall_compositor::types::LayerCompositingContext> {
        clock.map(
            |clock| nightfall_compositor::types::LayerCompositingContext {
                position: clock.position,
                released_at: None,
            },
        )
    }

    /// Builds owned metadata for the cue at an index before mutating its rendered layer.
    pub(super) fn cue_layer_metadata(&self, index: usize) -> CueLayerMetadata {
        let mcue = &self.mcues[index];
        let sequence_tracking_flags = self.sequence.tracking_mode.resolve_default();
        let mut absolute_parameters = mcue.values.absolute.keys().collect::<Vec<_>>();
        for parameter_ref in mcue.color_path_groups.iter().flat_map(|group| {
            group
                .decomposed_emitters
                .iter()
                .map(|(_, parameter_ref)| ParameterRef::from(*parameter_ref))
        }) {
            if !absolute_parameters.contains(&parameter_ref) {
                absolute_parameters.push(parameter_ref);
            }
        }
        CueLayerMetadata {
            tracking_policy: LayerTrackingPolicy::CueFlags(
                mcue.cue.sequence_tracking_flags(sequence_tracking_flags),
            ),
            trackable_absolute_parameters: absolute_parameters.clone(),
            trackable_relative_parameters: mcue.values.relative.keys().collect(),
            absolute_parameters,
            relative_parameters: mcue.values.relative.keys().collect(),
            relative_overrides: mcue.values.relative.keys().collect(),
            implicit_htp_assertion_timing: mcue.implicit_htp_assertion_timing.clone(),
            color_path_groups: mcue.color_path_groups.clone(),
            color_path_scalar_groups: mcue.color_path_scalar_groups.clone(),
        }
    }
}
