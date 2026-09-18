// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::HashSet;

use super::*;
use crate::materialized_cue::MaterializedCuePartLayer;

/// Describes whether a cue-produced layer may contribute values to sequence tracking.
#[derive(Clone, Copy)]
pub(super) enum LayerTrackingPolicy {
    /// All asserted values in the layer are eligible to track forward.
    Always,
    /// Asserted values track according to the cue's tracking flags.
    CueFlags(cue_flags::TrackingFlags),
}

impl LayerTrackingPolicy {
    /// Returns whether this policy allows a parameter to carry into later sequence cues.
    fn allows_parameter(
        self,
        parameter: ParameterRef,
        param_query: &Query<InstanceMut<Parameter>>,
    ) -> bool {
        let LayerTrackingPolicy::CueFlags(tracking_flags) = self else {
            return true;
        };
        let Ok(parameter_ref) = param_query.get(parameter.entity()) else {
            return false;
        };

        match parameter_ref.metadata.merge_type {
            MergeStrategy::HTP => tracking_flags.contains(cue_flags::TrackingFlags::HTP),
            MergeStrategy::LTP => tracking_flags.contains(cue_flags::TrackingFlags::LTP),
        }
    }
}

/// Common accessors for layers that can feed the sequence tracking base.
pub(super) trait TrackableValueLayer {
    /// Absolute value type stored by the layer.
    type AbsoluteValue: Clone;
    /// Relative value type stored by the layer.
    type RelativeValue: Clone;

    /// Returns a clone of an absolute parameter value from the layer.
    fn absolute_value(&self, parameter: ParameterRef) -> Option<Self::AbsoluteValue>;
    /// Returns a clone of a relative parameter value from the layer.
    fn relative_value(&self, parameter: ParameterRef) -> Option<Self::RelativeValue>;
    /// Inserts an absolute parameter value into the layer.
    fn insert_absolute(&mut self, parameter: ParameterRef, value: Self::AbsoluteValue);
    /// Inserts a relative parameter value into the layer.
    fn insert_relative(&mut self, parameter: ParameterRef, value: Self::RelativeValue);
    /// Returns whether a tracked absolute value should replace the current target value.
    fn should_replace_absolute(
        &self,
        parameter: ParameterRef,
        value: &Self::AbsoluteValue,
        incoming_transitioning: bool,
        param_query: &Query<InstanceMut<Parameter>>,
    ) -> bool;
    /// Returns whether an absolute parameter value is still transitioning.
    fn absolute_is_transitioning(&self, _parameter: ParameterRef) -> bool {
        false
    }
    /// Copies auxiliary per-parameter state from another layer when the value tracks.
    fn copy_tracked_metadata(&mut self, _source: &Self, _parameter: ParameterRef) {}
}

impl TrackableValueLayer for Layer {
    type AbsoluteValue = (ParameterValue, Option<MaterializedTransition>);
    type RelativeValue = (ParameterValue, Option<MaterializedTransition>);

    /// Read the absolute assertion retained for a parameter.
    fn absolute_value(&self, parameter: ParameterRef) -> Option<Self::AbsoluteValue> {
        self.absolute.get(parameter).cloned()
    }

    /// Read the relative assertion retained for a parameter.
    fn relative_value(&self, parameter: ParameterRef) -> Option<Self::RelativeValue> {
        self.relative.get(parameter).cloned()
    }

    fn insert_absolute(&mut self, parameter: ParameterRef, value: Self::AbsoluteValue) {
        self.absolute.insert(parameter, value);
    }

    fn insert_relative(&mut self, parameter: ParameterRef, value: Self::RelativeValue) {
        self.relative.insert(parameter, value);
    }

    /// Apply the parameter merge strategy and transition state when replacing a tracked assertion.
    fn should_replace_absolute(
        &self,
        parameter: ParameterRef,
        value: &Self::AbsoluteValue,
        incoming_transitioning: bool,
        param_query: &Query<InstanceMut<Parameter>>,
    ) -> bool {
        let Some(existing) = self.absolute.get(parameter) else {
            return true;
        };
        let Ok(parameter_ref) = param_query.get(parameter.entity()) else {
            return true;
        };
        if !matches!(parameter_ref.metadata.merge_type, MergeStrategy::HTP) {
            return true;
        }

        let incoming_value = layer_absolute_dmx_value(&parameter_ref, value);
        let existing_value = layer_absolute_dmx_value(&parameter_ref, existing);
        let existing_transitioning = self.absolute_is_transitioning(parameter);

        if incoming_value > existing_value {
            return true;
        }

        if incoming_value == existing_value {
            return incoming_transitioning && !existing_transitioning;
        }

        !existing_transitioning
    }

    /// Report whether the retained absolute assertion is still transitioning.
    fn absolute_is_transitioning(&self, parameter: ParameterRef) -> bool {
        self.transitioning
            .get(parameter)
            .copied()
            .unwrap_or_default()
    }

    /// Copy transition metadata alongside a retained parameter assertion.
    fn copy_tracked_metadata(&mut self, source: &Self, parameter: ParameterRef) {
        if let Some(transitioning) = source.transitioning.get(parameter) {
            self.transitioning.insert(parameter, *transitioning);
        }
    }
}

impl TrackableValueLayer for ComputedLayer {
    type AbsoluteValue = ParameterDmxValue;
    type RelativeValue = ParameterDmxValue;

    /// Read the absolute assertion retained for a parameter.
    fn absolute_value(&self, parameter: ParameterRef) -> Option<Self::AbsoluteValue> {
        self.absolute.get(parameter).copied()
    }

    /// Read the relative assertion retained for a parameter.
    fn relative_value(&self, parameter: ParameterRef) -> Option<Self::RelativeValue> {
        self.relative.get(parameter).copied()
    }

    fn insert_absolute(&mut self, parameter: ParameterRef, value: Self::AbsoluteValue) {
        self.absolute.insert(parameter, value);
    }

    fn insert_relative(&mut self, parameter: ParameterRef, value: Self::RelativeValue) {
        self.relative.insert(parameter, value);
    }

    /// Apply the parameter merge strategy and transition state when replacing a tracked assertion.
    fn should_replace_absolute(
        &self,
        parameter: ParameterRef,
        value: &Self::AbsoluteValue,
        _incoming_transitioning: bool,
        param_query: &Query<InstanceMut<Parameter>>,
    ) -> bool {
        let Some(existing) = self.absolute.get(parameter) else {
            return true;
        };
        let Ok(parameter_ref) = param_query.get(parameter.entity()) else {
            return true;
        };
        if matches!(parameter_ref.metadata.merge_type, MergeStrategy::HTP) {
            *value > *existing
        } else {
            true
        }
    }
}

/// Overlays values from a cue-produced layer when its policy allows them to track.
pub(super) fn squash_trackable_layer_values<L>(
    target: &mut L,
    source: &L,
    policy: LayerTrackingPolicy,
    absolute_parameters: impl IntoIterator<Item = ParameterRef>,
    relative_parameters: impl IntoIterator<Item = ParameterRef>,
    param_query: &Query<InstanceMut<Parameter>>,
) where
    L: TrackableValueLayer,
{
    for parameter in absolute_parameters {
        if !policy.allows_parameter(parameter, param_query) {
            continue;
        }
        if let Some(value) = source.absolute_value(parameter) {
            if target.should_replace_absolute(
                parameter,
                &value,
                source.absolute_is_transitioning(parameter),
                param_query,
            ) {
                target.insert_absolute(parameter, value);
                target.copy_tracked_metadata(source, parameter);
            }
        }
    }

    for parameter in relative_parameters {
        if !policy.allows_parameter(parameter, param_query) {
            continue;
        }
        if let Some(value) = source.relative_value(parameter) {
            target.insert_relative(parameter, value);
            target.copy_tracked_metadata(source, parameter);
        }
    }
}

/// Resolves a layer absolute value to a DMX value for merge comparison.
fn layer_absolute_dmx_value(
    parameter: &InstanceRef<Parameter>,
    value: &(ParameterValue, Option<MaterializedTransition>),
) -> ParameterDmxValue {
    if let ParameterValue::Absolute { value } = &value.0 {
        return *value;
    }

    parameter.resolve_value(&value.0)
}

pub(super) fn apply_sequence_tracking_markers(
    mcue: &MaterializedCue,
    seq_layer: &mut Layer,
    cue_layer: &mut Layer,
    tracking_cue_layer: &mut Layer,
    base_layer: &mut ComputedLayer,
    compositing_context: Option<nightfall_compositor::types::LayerCompositingContext>,
) {
    for parameter in active_sequence_release_marker_parameters(mcue, compositing_context) {
        seq_layer.absolute.remove(parameter);
        seq_layer.relative.remove(parameter);
        seq_layer.transitioning.remove(parameter);
        cue_layer.absolute.remove(parameter);
        cue_layer.relative.remove(parameter);
        cue_layer.transitioning.remove(parameter);
        tracking_cue_layer.absolute.remove(parameter);
        tracking_cue_layer.relative.remove(parameter);
        tracking_cue_layer.transitioning.remove(parameter);
        base_layer.absolute.remove(parameter);
        base_layer.relative.remove(parameter);
    }
}

/// Returns release markers whose assertion delay has elapsed in the given context.
pub(super) fn active_sequence_release_marker_parameters(
    mcue: &MaterializedCue,
    compositing_context: Option<nightfall_compositor::types::LayerCompositingContext>,
) -> Vec<ParameterRef> {
    active_release_marker_parameters(
        &mcue.release_values,
        &mcue.release_value_transitions,
        compositing_context,
    )
}

/// Returns cue-part release markers whose assertion delay has elapsed.
pub(super) fn active_part_release_marker_parameters(
    part_layer: &MaterializedCuePartLayer,
    compositing_context: Option<nightfall_compositor::types::LayerCompositingContext>,
) -> Vec<ParameterRef> {
    active_release_marker_parameters(
        &part_layer.release_values,
        &part_layer.release_value_transitions,
        compositing_context,
    )
}

/// Returns active release markers from one marker set and its timing map.
fn active_release_marker_parameters(
    release_values: &HashSet<ParameterRef>,
    release_value_transitions: &ParameterMap<MaterializedTransition>,
    compositing_context: Option<nightfall_compositor::types::LayerCompositingContext>,
) -> Vec<ParameterRef> {
    release_values
        .iter()
        .copied()
        .filter(|parameter| {
            release_marker_delay_elapsed(*parameter, release_value_transitions, compositing_context)
        })
        .collect()
}

/// Returns whether a materialized release marker should clear tracked output now.
fn release_marker_delay_elapsed(
    parameter: ParameterRef,
    release_value_transitions: &ParameterMap<MaterializedTransition>,
    compositing_context: Option<nightfall_compositor::types::LayerCompositingContext>,
) -> bool {
    let Some(compositing_context) = compositing_context else {
        return true;
    };
    let Some(transition) = release_value_transitions.get(parameter) else {
        return true;
    };

    transition.elapsed_from_start(compositing_context.position) >= transition.delay_in
}

/// Removes release-marked parameters from one visible or intermediate layer.
pub(super) fn clear_release_marker_parameters_from_layer(
    layer: &mut Layer,
    parameters: &[ParameterRef],
) {
    for parameter in parameters {
        layer.absolute.remove(parameter);
        layer.relative.remove(parameter);
        layer.transitioning.remove(parameter);
    }
}

/// Removes release-marked parameters from one completed tracking base.
pub(super) fn clear_release_marker_parameters_from_computed_layer(
    layer: &mut ComputedLayer,
    parameters: &[ParameterRef],
) {
    for parameter in parameters {
        layer.absolute.remove(parameter);
        layer.relative.remove(parameter);
    }
}

/// Removes values outside the cue slot being replaced by a transition source layer.
pub(super) fn retain_layer_parameters(
    layer: &mut Layer,
    absolute_parameters: &[ParameterRef],
    relative_parameters: &[ParameterRef],
) {
    for parameter in layer.absolute.keys().collect::<Vec<_>>() {
        if !absolute_parameters.contains(&parameter) {
            layer.absolute.remove(parameter);
        }
    }
    for parameter in layer.relative.keys().collect::<Vec<_>>() {
        if !relative_parameters.contains(&parameter) {
            layer.relative.remove(parameter);
        }
    }
}

/// Applies sequence transitions and writes raw computed values back to the source layer.
pub(super) fn apply_and_squash_transitions_for_sequence_context(
    layer: &mut Layer,
    base: &ComputedLayer,
    parameter_query: &Query<InstanceMut<Parameter>>,
    compositing_context: Option<nightfall_compositor::types::LayerCompositingContext>,
    implicit_htp_assertion_timing: &HashSet<ParameterRef>,
) -> ComputedLayer {
    if !implicit_htp_assertion_timing.is_empty() {
        preserve_authored_htp_assertion_timing(
            layer,
            base,
            parameter_query,
            implicit_htp_assertion_timing,
        );
    }

    let context = compositing_context.unwrap_or_default();
    let mut computed = ComputedLayer::with_capacity(layer.absolute.len(), layer.relative.len());

    let mut skipped_absolute = Vec::new();
    for (parameter_ref, (value, transition)) in layer.absolute.iter_mut() {
        let Some((computed_value, active)) = compute_absolute_sequence_transition(
            parameter_ref,
            value,
            transition,
            base,
            parameter_query,
            context,
        ) else {
            skipped_absolute.push(parameter_ref);
            continue;
        };

        computed.absolute.insert(parameter_ref, computed_value);
        layer.transitioning.insert(parameter_ref, active);
        *value = ParameterValue::Absolute {
            value: computed_value,
        };
        mark_transition_input_complete(transition);
    }
    remove_sequence_assertions(layer, skipped_absolute, []);

    let mut skipped_relative = Vec::new();
    for (parameter_ref, (value, transition)) in layer.relative.iter_mut() {
        let Some((computed_value, active)) = compute_relative_sequence_transition(
            parameter_ref,
            value,
            transition,
            base,
            parameter_query,
            context,
        ) else {
            skipped_relative.push(parameter_ref);
            continue;
        };

        computed.relative.insert(parameter_ref, computed_value);
        layer.transitioning.insert(parameter_ref, active);
        *value = ParameterValue::Relative {
            offset: computed_value,
        };
        mark_transition_input_complete(transition);
    }
    remove_sequence_assertions(layer, [], skipped_relative);

    computed
}

/// Applies sequence transitions, lets a caller adjust computed output, then squashes once.
pub(super) fn apply_and_squash_transitions_for_sequence_context_with_computed(
    layer: &mut Layer,
    base: &ComputedLayer,
    parameter_query: &Query<InstanceMut<Parameter>>,
    compositing_context: Option<nightfall_compositor::types::LayerCompositingContext>,
    implicit_htp_assertion_timing: &HashSet<ParameterRef>,
    update_computed: impl FnOnce(&mut Layer, &mut ComputedLayer, &Query<InstanceMut<Parameter>>),
) -> ComputedLayer {
    if !implicit_htp_assertion_timing.is_empty() {
        preserve_authored_htp_assertion_timing(
            layer,
            base,
            parameter_query,
            implicit_htp_assertion_timing,
        );
    }

    let context = compositing_context.unwrap_or_default();
    let mut computed =
        apply_sequence_transitions_for_sequence_context(layer, base, parameter_query, context);
    update_computed(layer, &mut computed, parameter_query);
    squash_computed_values_with_recorded_activity(layer, &computed);
    computed
}

/// Applies sequence transitions while recording active state on the source layer.
fn apply_sequence_transitions_for_sequence_context(
    layer: &mut Layer,
    base: &ComputedLayer,
    parameter_query: &Query<InstanceMut<Parameter>>,
    context: nightfall_compositor::types::LayerCompositingContext,
) -> ComputedLayer {
    let mut computed = ComputedLayer::with_capacity(layer.absolute.len(), layer.relative.len());

    let mut skipped_absolute = Vec::new();
    for (parameter_ref, (value, transition)) in layer.absolute.iter_mut() {
        let Some((computed_value, active)) = compute_absolute_sequence_transition(
            parameter_ref,
            value,
            transition,
            base,
            parameter_query,
            context,
        ) else {
            skipped_absolute.push(parameter_ref);
            continue;
        };

        computed.absolute.insert(parameter_ref, computed_value);
        layer.transitioning.insert(parameter_ref, active);
    }
    remove_sequence_assertions(layer, skipped_absolute, []);

    let mut skipped_relative = Vec::new();
    for (parameter_ref, (value, transition)) in layer.relative.iter_mut() {
        let Some((computed_value, active)) = compute_relative_sequence_transition(
            parameter_ref,
            value,
            transition,
            base,
            parameter_query,
            context,
        ) else {
            skipped_relative.push(parameter_ref);
            continue;
        };

        computed.relative.insert(parameter_ref, computed_value);
        layer.transitioning.insert(parameter_ref, active);
    }
    remove_sequence_assertions(layer, [], skipped_relative);

    computed
}

/// Computes one absolute sequence transition output and activity flag.
fn compute_absolute_sequence_transition(
    parameter_ref: ParameterRef,
    value: &ParameterValue,
    transition: &mut Option<MaterializedTransition>,
    base: &ComputedLayer,
    parameter_query: &Query<InstanceMut<Parameter>>,
    context: nightfall_compositor::types::LayerCompositingContext,
) -> Option<(ParameterDmxValue, bool)> {
    let parameter = parameter_query.get(parameter_ref.entity()).ok()?;
    let default_value = parameter.get_default_value();
    let base_value = *base.absolute.get(parameter_ref).unwrap_or(&default_value);
    let asserted_value = parameter.resolve_value_with_current(value, base_value);
    if transition.as_ref().is_some_and(|transition| {
        sequence_assertion_waiting_to_start(
            &parameter,
            transition,
            asserted_value - base_value,
            context,
        )
    }) {
        return None;
    }

    let computed_value = if let Some(transition) = transition {
        nightfall_compositor::stages::transition::process_transition_with_compositing_context(
            &parameter,
            base_value,
            asserted_value,
            transition,
            false,
            context,
        )
    } else {
        asserted_value
    };
    let active = transition.as_ref().is_some_and(|transition| {
        sequence_assertion_transition_is_active(
            &parameter,
            transition,
            asserted_value - base_value,
            context,
        )
    });

    Some((computed_value, active))
}

/// Computes one relative sequence transition output and activity flag.
fn compute_relative_sequence_transition(
    parameter_ref: ParameterRef,
    value: &ParameterValue,
    transition: &mut Option<MaterializedTransition>,
    base: &ComputedLayer,
    parameter_query: &Query<InstanceMut<Parameter>>,
    context: nightfall_compositor::types::LayerCompositingContext,
) -> Option<(ParameterDmxValue, bool)> {
    let parameter = parameter_query.get(parameter_ref.entity()).ok()?;
    let base_value = *base.relative.get(parameter_ref).unwrap_or(&0.0);
    let asserted_value = parameter.resolve_value_with_current(value, base_value);
    if transition.as_ref().is_some_and(|transition| {
        sequence_assertion_waiting_to_start(
            &parameter,
            transition,
            asserted_value - base_value,
            context,
        )
    }) {
        return None;
    }

    let computed_value = if let Some(transition) = transition {
        nightfall_compositor::stages::transition::process_transition_with_compositing_context(
            &parameter,
            base_value,
            asserted_value,
            transition,
            false,
            context,
        )
    } else {
        asserted_value
    };
    let active = transition.as_ref().is_some_and(|transition| {
        sequence_assertion_transition_is_active(
            &parameter,
            transition,
            asserted_value - base_value,
            context,
        )
    });

    Some((computed_value, active))
}

/// Removes sequence assertions that did not produce output for the current evaluation.
fn remove_sequence_assertions(
    layer: &mut Layer,
    absolute: impl IntoIterator<Item = ParameterRef>,
    relative: impl IntoIterator<Item = ParameterRef>,
) {
    for parameter in absolute {
        layer.absolute.remove(parameter);
        layer.transitioning.remove(parameter);
    }
    for parameter in relative {
        layer.relative.remove(parameter);
        layer.transitioning.remove(parameter);
    }
}

/// Returns whether an assertion is still in its delay and should not contribute output.
fn sequence_assertion_waiting_to_start(
    parameter: &InstanceRef<Parameter>,
    transition: &MaterializedTransition,
    delta: ParameterDmxValue,
    context: nightfall_compositor::types::LayerCompositingContext,
) -> bool {
    if transition
        .release_position
        .or(context.released_at)
        .is_some()
    {
        return false;
    }

    if assertion_uses_out_timing(parameter, delta) {
        return false;
    }

    transition.elapsed_from_start(context.position) < assertion_delay(parameter, transition, delta)
}

/// Returns whether an assertion transition is still advancing at the sequence context.
fn sequence_assertion_transition_is_active(
    parameter: &InstanceRef<Parameter>,
    transition: &MaterializedTransition,
    delta: ParameterDmxValue,
    context: nightfall_compositor::types::LayerCompositingContext,
) -> bool {
    if let Some(released_at) = transition.release_position.or(context.released_at) {
        let elapsed_since_release = context.position.saturating_sub(released_at);
        return transition.transition_release_parameter_ratio_at_elapsed(elapsed_since_release)
            < 1.0;
    }

    transition.elapsed_from_start(context.position)
        < assertion_duration(parameter, transition, delta)
}

/// Writes computed sequence outputs using active state recorded during transition evaluation.
fn squash_computed_values_with_recorded_activity(layer: &mut Layer, computed: &ComputedLayer) {
    for (param_ref, value) in computed.absolute.iter() {
        if let Some((param_value, transition)) = layer.absolute.get_mut(param_ref) {
            let active = layer
                .transitioning
                .get(param_ref)
                .copied()
                .unwrap_or_default();
            layer.transitioning.insert(param_ref, active);
            *param_value = ParameterValue::Absolute { value: *value };
            mark_transition_input_complete(transition);
        }
    }

    for (param_ref, value) in computed.relative.iter() {
        if let Some((param_value, transition)) = layer.relative.get_mut(param_ref) {
            let active = layer
                .transitioning
                .get(param_ref)
                .copied()
                .unwrap_or_default();
            layer.transitioning.insert(param_ref, active);
            *param_value = ParameterValue::Relative { offset: *value };
            mark_transition_input_complete(transition);
        }
    }
}

/// Returns the delay that applies before an assertion starts moving.
fn assertion_delay(
    parameter: &InstanceRef<Parameter>,
    transition: &MaterializedTransition,
    delta: ParameterDmxValue,
) -> Duration {
    if assertion_uses_out_timing(parameter, delta) {
        transition.delay_out
    } else {
        transition.delay_in
    }
}

/// Returns whether assertion-out timing applies to this parameter movement.
fn assertion_uses_out_timing(parameter: &InstanceRef<Parameter>, delta: ParameterDmxValue) -> bool {
    matches!(parameter.metadata.merge_type, MergeStrategy::HTP) && delta < 0.0
}

/// Returns a deterministic compositing context that makes every finite transition complete.
pub(super) fn completed_sequence_compositing_context()
-> nightfall_compositor::types::LayerCompositingContext {
    nightfall_compositor::types::LayerCompositingContext {
        position: Duration::from_secs(24 * 60 * 60),
        released_at: None,
    }
}

/// Returns the active assertion span for the direction from base to target.
fn assertion_duration(
    parameter: &InstanceRef<Parameter>,
    transition: &MaterializedTransition,
    delta: ParameterDmxValue,
) -> Duration {
    if matches!(parameter.metadata.merge_type, MergeStrategy::HTP) && delta < 0.0 {
        transition.delay_out + transition.fade_out
    } else {
        transition.delay_in + transition.fade_in
    }
}

/// Marks a cloned transition as already applied before global composition.
pub(super) fn mark_transition_input_complete(transition: &mut Option<MaterializedTransition>) {
    let Some(transition) = transition else {
        return;
    };
    transition.delay_in = Duration::ZERO;
    transition.fade_in = Duration::ZERO;
    transition.start_position = Duration::ZERO;
}

/// Converts current-cue relative assertions into deltas from the tracked sequence base.
pub(super) fn retarget_sequence_relative_overrides(
    layer: &mut Layer,
    base: &ComputedLayer,
    parameter_query: &Query<InstanceMut<Parameter>>,
    relative_overrides: &[ParameterRef],
) {
    for param_ref in relative_overrides {
        let Some((value, _)) = layer.relative.get_mut(param_ref) else {
            continue;
        };
        let Ok(parameter) = parameter_query.get(param_ref.entity()) else {
            continue;
        };
        let desired_contribution = resolve_relative_contribution(&parameter, value);
        let tracked_contribution = *base.relative.get(param_ref).unwrap_or(&0.0);
        *value = ParameterValue::Relative {
            offset: desired_contribution - tracked_contribution,
        };
    }
}

/// Resolves a relative assertion as a sequence-level contribution.
fn resolve_relative_contribution(
    parameter: &InstanceRef<Parameter>,
    value: &ParameterValue,
) -> ParameterDmxValue {
    parameter.resolve_value_with_current(value, 0.0)
}

/// Preserves assertion-side timing for HTP parameters fading toward a lower target.
fn preserve_authored_htp_assertion_timing(
    layer: &mut Layer,
    base: &ComputedLayer,
    parameter_query: &Query<InstanceMut<Parameter>>,
    implicit_htp_assertion_timing: &HashSet<ParameterRef>,
) {
    for (parameter_ref, (value, transition)) in layer.absolute.iter_mut() {
        if !implicit_htp_assertion_timing.contains(&parameter_ref) {
            continue;
        }
        let Some(transition) = transition else {
            continue;
        };
        if transition.delay_out + transition.fade_out != Duration::ZERO {
            continue;
        }
        if transition.delay_in + transition.fade_in == Duration::ZERO {
            continue;
        }

        let Ok(parameter) = parameter_query.get(parameter_ref.entity()) else {
            continue;
        };
        if !matches!(parameter.metadata.merge_type, MergeStrategy::HTP) {
            continue;
        }

        let default_value = parameter.get_default_value();
        let base_value = *base.absolute.get(parameter_ref).unwrap_or(&default_value);
        let asserted_value = parameter.resolve_value_with_current(value, base_value);
        if asserted_value >= base_value {
            continue;
        }

        transition.delay_out = transition.delay_in;
        transition.fade_out = transition.fade_in;
        transition.curve_out = transition.curve_in;
    }
}
