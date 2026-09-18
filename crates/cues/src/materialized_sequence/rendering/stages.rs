// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Setup, visible, completed, and transition-repair rendering stages.

use std::collections::HashSet;

use super::super::tracking::*;
use super::super::*;
use super::color_path::apply_color_path_samples;
use crate::materialized_cue::{MaterializedColorPathGroup, MaterializedColorPathScalarGroup};

/// Cached metadata describing which parameters a cue layer can affect while rendering.
pub(super) struct CueLayerMetadata {
    /// Policy used when the cue contributes values that track into later cues.
    pub(super) tracking_policy: LayerTrackingPolicy,
    /// Absolute parameters asserted by the cue.
    pub(super) absolute_parameters: Vec<ParameterRef>,
    /// Relative parameters asserted by the cue.
    pub(super) relative_parameters: Vec<ParameterRef>,
    /// Relative parameters whose values must be retargeted against the current sequence base.
    pub(super) relative_overrides: Vec<ParameterRef>,
    /// Absolute parameters eligible to track into later cues.
    pub(super) trackable_absolute_parameters: Vec<ParameterRef>,
    /// Relative parameters eligible to track into later cues.
    pub(super) trackable_relative_parameters: Vec<ParameterRef>,
    /// HTP parameters whose authored assertion timing omitted transition-out fields.
    pub(super) implicit_htp_assertion_timing: HashSet<ParameterRef>,
    /// Color-vector path groups derived from cue instructions.
    pub(super) color_path_groups: Vec<MaterializedColorPathGroup>,
    /// Scalar color path groups derived from cue instructions.
    pub(super) color_path_scalar_groups: Vec<MaterializedColorPathScalarGroup>,
}

/// Setup cue render result and whether it is safe to combine with cached cue prefixes.
pub(super) struct RenderedSetupLayer {
    /// Completed setup base that retained cue rendering builds on.
    pub(super) base_layer: ComputedLayer,
    /// Whether setup cue transitions have completed for the current clock.
    pub(super) stable: bool,
}

impl MaterializedSequence {
    /// Renders a cue through its aggregate materialized layer.
    pub(super) fn render_flattened_cue_layer(
        &mut self,
        index: usize,
        metadata: &CueLayerMetadata,
        visible_base_layer: &ComputedLayer,
        param_query: &mut Query<InstanceMut<Parameter>>,
        compositing_context: Option<nightfall_compositor::types::LayerCompositingContext>,
    ) -> (Layer, ComputedLayer) {
        let mut cue_layer = self.mcues[index].to_layer(None);
        retarget_sequence_relative_overrides(
            &mut cue_layer,
            visible_base_layer,
            param_query,
            &metadata.relative_overrides,
        );
        let rendered_base_layer = apply_and_squash_transitions_for_sequence_context_with_computed(
            &mut cue_layer,
            visible_base_layer,
            param_query,
            compositing_context,
            &metadata.implicit_htp_assertion_timing,
            |cue_layer, rendered_base_layer, param_query| {
                apply_color_path_samples(
                    cue_layer,
                    rendered_base_layer,
                    visible_base_layer,
                    &metadata.color_path_groups,
                    &metadata.color_path_scalar_groups,
                    param_query,
                    compositing_context,
                );
            },
        );
        (cue_layer, rendered_base_layer)
    }
}

/// Returns whether a layer carries values that need compositor evaluation.
pub(super) fn layer_has_values(layer: &Layer) -> bool {
    !layer.absolute.is_empty() || !layer.relative.is_empty()
}
