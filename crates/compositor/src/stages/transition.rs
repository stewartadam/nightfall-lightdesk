// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Compositor stage for applying transitions to layers in the compositor pipeline.
use std::time::Duration;

use bevy_ecs::prelude::*;
use moonshine_kind::prelude::*;
use nightfall::prelude::*;
use nightfall_dmx::prelude::*;

use crate::types::{
    CompositorParameter, ComputedLayer, Layer, LayerCompositingContext, ParameterRef,
};

/// Applies transitions and delays using a layer compositing context.
pub fn apply_transitions_with_compositing_context<P: CompositorParameter>(
    layer: &mut Layer,
    base: &ComputedLayer,
    parameters: &Query<InstanceMut<P>>,
    is_releasing: bool,
    context: LayerCompositingContext,
) -> ComputedLayer {
    let mut computed_layer =
        ComputedLayer::with_capacity(layer.absolute.len(), layer.relative.len());
    let mut skipped_absolute = Vec::new();
    let mut skipped_relative = Vec::new();

    // Process absolute values
    for (param_ref, (value, transition)) in layer.absolute.iter_mut() {
        if !is_releasing {
            if let (ParameterValue::Absolute { value }, None) = (&*value, transition.as_ref()) {
                if parameters.get(param_ref.entity()).is_ok() {
                    computed_layer.absolute.insert(param_ref, *value);
                }
                continue;
            }
        }

        if let Ok(param) = parameters.get(param_ref.entity()) {
            // We must start a span for each log because field filters can only be applied to spans.
            // See: https://github.com/tokio-rs/tracing/issues/2843#issuecomment-1884545840
            let _span = tracing::trace_span!(
                "composited_transitions",
                entity = %param.entity(),
                attribute = ?param.attribute()
            )
            .entered();

            let default_value = param.default_value();
            let base_value = base.absolute.get(param_ref).unwrap_or(&default_value);
            let asserted_value = {
                let mut tmp_param = (*param).clone();
                tmp_param.set_raw_value(*base_value);
                tmp_param.resolve_value(value)
            };

            let target = if is_releasing {
                absolute_release_target(&param, param_ref, base)
            } else {
                asserted_value
            };
            if transition_should_skip_output(
                &param,
                transition.as_ref(),
                *base_value,
                asserted_value,
                is_releasing,
                context,
            ) {
                skipped_absolute.push(param_ref);
                continue;
            }

            let new_value = if let Some(transition) = transition {
                let transition_source = if is_releasing {
                    transition_value_at_release_context(
                        &param,
                        *base_value,
                        asserted_value,
                        transition,
                        context,
                    )
                } else {
                    *base_value
                };
                process_transition_with_compositing_context(
                    &param,
                    transition_source,
                    target,
                    transition,
                    is_releasing,
                    context,
                )
            } else {
                target
            };

            computed_layer.absolute.insert(param_ref, new_value);
        }
    }

    // Process relative values
    for (param_ref, (value, transition)) in layer.relative.iter_mut() {
        if let Ok(param) = parameters.get(param_ref.entity()) {
            let _span = tracing::trace_span!(
                "composited_transitions",
                entity = %param.entity(),
                attribute = ?param.attribute()
            )
            .entered();

            let default_value = 0.0; // For relative values, default is 0
            let base_value = base.relative.get(param_ref).unwrap_or(&default_value);
            let asserted_value = {
                let mut tmp_param = (*param).clone();
                tmp_param.set_raw_value(*base_value);
                tmp_param.resolve_value(value)
            };

            let target = if is_releasing {
                *base.relative.get(param_ref).unwrap_or(&0.0)
            } else {
                asserted_value
            };
            if transition_should_skip_output(
                &param,
                transition.as_ref(),
                *base_value,
                asserted_value,
                is_releasing,
                context,
            ) {
                skipped_relative.push(param_ref);
                continue;
            }

            let new_value = if let Some(transition) = transition {
                let transition_source = if is_releasing {
                    transition_value_at_release_context(
                        &param,
                        *base_value,
                        asserted_value,
                        transition,
                        context,
                    )
                } else {
                    *base_value
                };
                process_transition_with_compositing_context(
                    &param,
                    transition_source,
                    target,
                    transition,
                    is_releasing,
                    context,
                )
            } else {
                target
            };

            computed_layer.relative.insert(param_ref, new_value);
        }
    }
    remove_skipped_assertions(layer, skipped_absolute, skipped_relative);

    computed_layer
}

/// Returns whether this assertion should be absent from the current composited layer.
fn transition_should_skip_output<P: CompositorParameter>(
    parameter: &InstanceRef<P>,
    transition: Option<&MaterializedTransition>,
    base: ParameterDmxValue,
    asserted: ParameterDmxValue,
    is_releasing: bool,
    context: LayerCompositingContext,
) -> bool {
    let Some(transition) = transition else {
        return is_releasing && !matches!(parameter.attribute(), Attribute::VirtualIntensity);
    };

    if is_releasing {
        let elapsed = elapsed_since_release(transition, context).unwrap_or_default();
        return transition.transition_release_parameter_ratio_at_elapsed(elapsed) >= 1.0
            && !matches!(parameter.attribute(), Attribute::VirtualIntensity);
    }

    if assertion_uses_out_timing(parameter, asserted - base) {
        return false;
    }

    transition.elapsed_from_start(context.position)
        < assertion_delay(parameter, transition, asserted - base)
}

/// Removes skipped assertions so attribution matches the effective output.
fn remove_skipped_assertions(
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

/// Returns the transition value at the moment release started for an evaluation context.
fn transition_value_at_release_context<P: CompositorParameter>(
    parameter: &InstanceRef<P>,
    base: ParameterDmxValue,
    asserted: ParameterDmxValue,
    transition: &MaterializedTransition,
    context: LayerCompositingContext,
) -> ParameterDmxValue {
    let Some(elapsed_since_release) = elapsed_since_release(transition, context) else {
        return asserted;
    };

    transition_value_at_release_elapsed(
        parameter,
        base,
        asserted,
        transition,
        transition
            .elapsed_from_start(context.position)
            .saturating_sub(elapsed_since_release),
    )
}

/// Returns the transition value at release for an explicit assertion elapsed time.
fn transition_value_at_release_elapsed<P: CompositorParameter>(
    parameter: &InstanceRef<P>,
    base: ParameterDmxValue,
    asserted: ParameterDmxValue,
    transition: &MaterializedTransition,
    elapsed_at_release: Duration,
) -> ParameterDmxValue {
    if elapsed_at_release < assertion_delay(parameter, transition, asserted - base) {
        return base;
    }

    let ratio = assertion_transition_ratio_at_elapsed(
        parameter,
        transition,
        asserted - base,
        elapsed_at_release,
    );

    interpolate_value(base, asserted, ratio)
}

/// Interpolates from one parameter value to another using a 0.0-1.0 ratio.
fn interpolate_value(
    base: ParameterDmxValue,
    target: ParameterDmxValue,
    ratio: f32,
) -> ParameterDmxValue {
    target - (target - base) * (1.0 - f64::from(ratio))
}

/// Returns the absolute target a releasing layer should fade toward before it is removed.
fn absolute_release_target<P: CompositorParameter>(
    parameter: &InstanceRef<P>,
    parameter_ref: ParameterRef,
    base: &ComputedLayer,
) -> ParameterDmxValue {
    if matches!(parameter.attribute(), Attribute::VirtualIntensity) {
        return base
            .absolute
            .get(parameter_ref)
            .copied()
            .unwrap_or_else(|| parameter.logical_min());
    }

    base.absolute
        .get(parameter_ref)
        .copied()
        .unwrap_or_else(|| parameter.default_value())
}

/// Processes one parameter transition against a layer compositing context.
pub fn process_transition_with_compositing_context<P: CompositorParameter>(
    parameter: &InstanceRef<P>,
    base: ParameterDmxValue,
    target: ParameterDmxValue,
    transition: &mut MaterializedTransition,
    is_releasing: bool,
    context: LayerCompositingContext,
) -> ParameterDmxValue {
    let elapsed_since_start = transition.elapsed_from_start(context.position);
    if !is_releasing && elapsed_since_start < assertion_delay(parameter, transition, target - base)
    {
        // Delay has not fully elapsed; do not assert our target yet
        return base;
    }

    let ratio = if is_releasing {
        // During release
        transition.transition_release_parameter_ratio_at_elapsed(
            elapsed_since_release(transition, context).unwrap_or_default(),
        )
    } else if assertion_uses_out_timing(parameter, target - base) {
        // Use out timing for HTP parameters moving down.
        transition.transition_out_parameter_ratio_at_elapsed(elapsed_since_start)
    } else {
        // Use fade-in for everything else
        transition.transition_in_parameter_ratio_at_elapsed(elapsed_since_start)
    };

    let value = interpolate_value(base, target, ratio);
    if ratio != 1.0 {
        // If ratio is 1.0, we are already at the target value and do not need to log
        tracing::trace!(
            entity = %parameter.entity(),
            attribute = ?parameter.attribute(),
            %value,
            %base,
            %target,
            delta = %(target - base),
            %ratio,
            "Transitioning parameter"
        );
    }

    value
}

/// Returns the delay that applies to an assertion moving in the given direction.
fn assertion_delay<P: CompositorParameter>(
    parameter: &InstanceRef<P>,
    transition: &MaterializedTransition,
    delta: ParameterDmxValue,
) -> Duration {
    if assertion_uses_out_timing(parameter, delta) {
        transition.delay_out
    } else {
        transition.delay_in
    }
}

/// Returns assertion progress for the direction between base and target.
fn assertion_transition_ratio_at_elapsed<P: CompositorParameter>(
    parameter: &InstanceRef<P>,
    transition: &MaterializedTransition,
    delta: ParameterDmxValue,
    elapsed: Duration,
) -> f32 {
    if assertion_uses_out_timing(parameter, delta) {
        transition.transition_out_parameter_ratio_at_elapsed(elapsed)
    } else {
        transition.transition_in_parameter_ratio_at_elapsed(elapsed)
    }
}

/// Returns whether assertion-out timing applies to this parameter movement.
fn assertion_uses_out_timing<P: CompositorParameter>(
    parameter: &InstanceRef<P>,
    delta: ParameterDmxValue,
) -> bool {
    parameter.uses_htp_merge() && delta < 0.0
}

/// Returns release elapsed using the canonical transition-owned anchor when present.
///
/// The layer-level release anchor is only a compatibility fallback for direct layer producers or
/// lifecycle contexts that have not yet stamped `MaterializedTransition::release_position`.
fn elapsed_since_release(
    transition: &MaterializedTransition,
    context: LayerCompositingContext,
) -> Option<Duration> {
    transition
        .release_position
        .or(context.released_at)
        .map(|released_at| context.position.saturating_sub(released_at))
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use bevy_ecs::world::World;
    use moonshine_kind::Instance;

    use super::*;
    use crate::types::test_support::{TestMergeMode, TestParameter};

    fn create_test_parameter(
        world: &mut World,
        merge_type: TestMergeMode,
        attribute: Attribute,
    ) -> Instance<TestParameter> {
        let entity = world.spawn(TestParameter::new(merge_type, attribute)).id();

        unsafe { Instance::from_entity_unchecked(entity) }
    }

    fn create_test_transition(
        delay_in: Duration,
        fade_in: Duration,
        delay_out: Duration,
        fade_out: Duration,
    ) -> MaterializedTransition {
        MaterializedTransition {
            delay_in,
            fade_in,
            curve_in: FadeCurve::Linear,
            delay_out,
            fade_out,
            curve_out: FadeCurve::Linear,
            start_position: Duration::ZERO,
            release_position: None,
        }
    }

    /// Verifies layer compositing contexts derive release elapsed from source-local positions.
    #[test]
    fn elapsed_since_release_uses_layer_release_position() {
        let compositing_context = LayerCompositingContext {
            position: Duration::from_millis(750),
            released_at: Some(Duration::from_millis(250)),
        };
        let transition = create_test_transition(
            Duration::ZERO,
            Duration::ZERO,
            Duration::ZERO,
            Duration::ZERO,
        );

        assert_eq!(
            elapsed_since_release(&transition, compositing_context),
            Some(Duration::from_millis(500))
        );
    }

    /// Verifies layer compositing contexts evaluate each transition from its source-local start anchor.
    #[test]
    fn transition_elapsed_uses_layer_position_and_transition_start_position() {
        let compositing_context = LayerCompositingContext {
            position: Duration::from_millis(750),
            released_at: None,
        };
        let mut transition = create_test_transition(
            Duration::ZERO,
            Duration::from_secs(1),
            Duration::ZERO,
            Duration::ZERO,
        );
        transition.start_position = Duration::from_millis(250);

        assert_eq!(
            transition.elapsed_from_start(compositing_context.position),
            Duration::from_millis(500)
        );
        assert_eq!(
            elapsed_since_release(&transition, compositing_context),
            None
        );
    }

    #[test]
    fn test_apply_transitions_absolute_values() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, TestMergeMode::Ltp, Attribute::Red);

        let mut layer = Layer::new("test".to_string(), Priority(1));
        layer.absolute.insert(
            param,
            (ParameterValue::Absolute { value: 100.0 }, None), // No transition
        );

        let base = ComputedLayer::default();
        let mut param_query_state = world.query::<InstanceMut<TestParameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        let computed = apply_transitions_with_compositing_context(
            &mut layer,
            &base,
            &param_query,
            false,
            LayerCompositingContext::default(),
        );

        // Should have the resolved absolute value
        assert!(computed.absolute.contains_key(&param));
        assert_eq!(*computed.absolute.get(&param).unwrap(), 100.0);
    }

    #[test]
    fn test_apply_transitions_relative_values() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, TestMergeMode::Ltp, Attribute::Red);

        let mut layer = Layer::new("test".to_string(), Priority(1));
        layer.relative.insert(
            param,
            (
                ParameterValue::Relative { offset: 50.0 },
                None, // No transition
            ),
        );

        let mut base = ComputedLayer::default();
        base.absolute.insert(param, 100.0); // Base value

        let mut param_query_state = world.query::<InstanceMut<TestParameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        let computed = apply_transitions_with_compositing_context(
            &mut layer,
            &base,
            &param_query,
            false,
            LayerCompositingContext::default(),
        );

        // Should have the relative offset (resolved: 100 base + 50 offset)
        assert!(computed.relative.contains_key(&param));
        assert_eq!(*computed.relative.get(&param).unwrap(), 50.0);
    }

    #[test]
    fn test_apply_transitions_with_transition_object() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, TestMergeMode::Ltp, Attribute::Red);

        let transition = create_test_transition(
            Duration::ZERO,
            Duration::from_secs(1),
            Duration::ZERO,
            Duration::from_secs(1),
        );

        let mut layer = Layer::new("test".to_string(), Priority(1));
        layer.absolute.insert(
            param,
            (ParameterValue::Absolute { value: 200.0 }, Some(transition)),
        );

        let mut base = ComputedLayer::default();
        base.absolute.insert(param, 100.0); // Starting from 100

        let mut param_query_state = world.query::<InstanceMut<TestParameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        let computed = apply_transitions_with_compositing_context(
            &mut layer,
            &base,
            &param_query,
            false,
            LayerCompositingContext {
                position: Duration::from_secs(10),
                released_at: None,
            },
        );

        // Should reach target value (transition completed)
        assert!(computed.absolute.contains_key(&param));
        assert_eq!(*computed.absolute.get(&param).unwrap(), 200.0);
    }

    /// Verifies delayed relative assertions do not contribute a synthetic base offset.
    #[test]
    fn delayed_relative_assertion_is_absent_until_fade_starts() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, TestMergeMode::Ltp, Attribute::Red);
        let transition = create_test_transition(
            Duration::from_secs(1),
            Duration::from_secs(1),
            Duration::ZERO,
            Duration::ZERO,
        );
        let mut layer = Layer::new("test".to_string(), Priority(1));
        layer.relative.insert(
            param,
            (ParameterValue::Relative { offset: 25.0 }, Some(transition)),
        );
        let mut base = ComputedLayer::default();
        base.relative.insert(param, 10.0);

        let mut param_query_state = world.query::<InstanceMut<TestParameter>>();
        let param_query = param_query_state.query_mut(&mut world);
        let computed = apply_transitions_with_compositing_context(
            &mut layer,
            &base,
            &param_query,
            false,
            LayerCompositingContext {
                position: Duration::from_millis(500),
                released_at: None,
            },
        );

        assert!(
            !computed.relative.contains_key(&param),
            "delayed relative assertions should not assert the base relative value"
        );
        assert!(
            !layer.relative.contains_key(&param),
            "delayed relative assertions should be absent from attribution"
        );
    }

    #[test]
    fn test_apply_transitions_releasing_reverts_to_base() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, TestMergeMode::Ltp, Attribute::Red);

        let transition = create_test_transition(
            Duration::ZERO,
            Duration::from_secs(1),
            Duration::ZERO,
            Duration::from_secs(1),
        );

        let mut layer = Layer::new("test".to_string(), Priority(1));
        layer.absolute.insert(
            param,
            (ParameterValue::Absolute { value: 200.0 }, Some(transition)),
        );

        let mut base = ComputedLayer::default();
        base.absolute.insert(param, 50.0); // Base value to revert to

        let mut param_query_state = world.query::<InstanceMut<TestParameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        // Process as releasing
        let computed = apply_transitions_with_compositing_context(
            &mut layer,
            &base,
            &param_query,
            true,
            LayerCompositingContext {
                position: Duration::from_secs(10),
                released_at: Some(Duration::ZERO),
            },
        );

        assert!(
            !computed.absolute.contains_key(&param),
            "completed release values should stop asserting instead of holding the base target"
        );
        assert!(
            !layer.absolute.contains_key(&param),
            "completed release values should be absent from attribution"
        );
    }

    /// Verifies zero-duration release entries disappear immediately for regular parameters.
    #[test]
    fn zero_duration_release_is_immediately_absent() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, TestMergeMode::Ltp, Attribute::Red);
        let transition = create_test_transition(
            Duration::ZERO,
            Duration::ZERO,
            Duration::ZERO,
            Duration::ZERO,
        );
        let mut layer = Layer::new("test".to_string(), Priority(1));
        layer.absolute.insert(
            param,
            (ParameterValue::Absolute { value: 200.0 }, Some(transition)),
        );
        let base = ComputedLayer::default();

        let mut param_query_state = world.query::<InstanceMut<TestParameter>>();
        let param_query = param_query_state.query_mut(&mut world);
        let computed = apply_transitions_with_compositing_context(
            &mut layer,
            &base,
            &param_query,
            true,
            LayerCompositingContext {
                position: Duration::ZERO,
                released_at: Some(Duration::ZERO),
            },
        );

        assert!(!computed.absolute.contains_key(&param));
        assert!(!layer.absolute.contains_key(&param));
    }

    /// Verifies active relative release fades remain relative until their release completes.
    #[test]
    fn active_relative_release_outputs_relative_offset() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, TestMergeMode::Ltp, Attribute::Blue);
        let transition = create_test_transition(
            Duration::ZERO,
            Duration::ZERO,
            Duration::ZERO,
            Duration::from_secs(2),
        );
        let mut layer = Layer::new("test".to_string(), Priority(1));
        layer.relative.insert(
            param,
            (ParameterValue::Relative { offset: 40.0 }, Some(transition)),
        );
        let base = ComputedLayer::default();

        let mut param_query_state = world.query::<InstanceMut<TestParameter>>();
        let param_query = param_query_state.query_mut(&mut world);
        let computed = apply_transitions_with_compositing_context(
            &mut layer,
            &base,
            &param_query,
            true,
            LayerCompositingContext {
                position: Duration::from_secs(1),
                released_at: Some(Duration::ZERO),
            },
        );

        let value = *computed
            .relative
            .get(&param)
            .expect("active relative release should output a relative value");
        assert!(
            (19.0..=21.0).contains(&value),
            "relative release should fade the relative offset toward zero, got {value}"
        );
    }

    /// Verifies virtual dimmers blackout on release instead of exposing their default full value.
    #[test]
    fn virtual_intensity_release_without_transition_targets_blackout() {
        let mut world = World::new();
        let param =
            create_test_parameter(&mut world, TestMergeMode::Htp, Attribute::VirtualIntensity);
        world
            .get_mut::<TestParameter>(param.entity())
            .expect("virtual intensity parameter should exist")
            .default_value = 255.0;

        let mut layer = Layer::new("test".to_string(), Priority(1));
        layer.absolute.insert(
            param,
            (ParameterValue::AbsolutePercent { value: 0.28.into() }, None),
        );

        let base = ComputedLayer::default();
        let mut param_query_state = world.query::<InstanceMut<TestParameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        let computed = apply_transitions_with_compositing_context(
            &mut layer,
            &base,
            &param_query,
            true,
            LayerCompositingContext {
                position: Duration::from_secs(10),
                released_at: Some(Duration::from_secs(10)),
            },
        );

        assert_eq!(
            *computed
                .absolute
                .get(&param)
                .expect("virtual intensity should output a release value"),
            0.0
        );
    }

    /// Verifies virtual dimmers fade down before the release layer restores default/base output.
    #[test]
    fn virtual_intensity_release_with_transition_fades_toward_blackout() {
        let mut world = World::new();
        let param =
            create_test_parameter(&mut world, TestMergeMode::Htp, Attribute::VirtualIntensity);
        world
            .get_mut::<TestParameter>(param.entity())
            .expect("virtual intensity parameter should exist")
            .default_value = 255.0;

        let transition = create_test_transition(
            Duration::ZERO,
            Duration::ZERO,
            Duration::ZERO,
            Duration::from_secs(1),
        );
        let mut layer = Layer::new("test".to_string(), Priority(1));
        layer.absolute.insert(
            param,
            (
                ParameterValue::AbsolutePercent { value: 0.28.into() },
                Some(transition),
            ),
        );

        let base = ComputedLayer::default();
        let mut param_query_state = world.query::<InstanceMut<TestParameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        let computed = apply_transitions_with_compositing_context(
            &mut layer,
            &base,
            &param_query,
            true,
            LayerCompositingContext {
                position: Duration::from_millis(10500),
                released_at: Some(Duration::from_secs(10)),
            },
        );
        let value = *computed
            .absolute
            .get(&param)
            .expect("virtual intensity should output a release fade value");

        assert!(
            (35.0..=37.0).contains(&value),
            "virtual intensity should fade from 28% toward blackout, got {value}"
        );
    }

    /// Verifies virtual dimmers release to active base output before blackout fallback.
    #[test]
    fn virtual_intensity_release_with_base_fades_toward_base() {
        let mut world = World::new();
        let param =
            create_test_parameter(&mut world, TestMergeMode::Htp, Attribute::VirtualIntensity);
        world
            .get_mut::<TestParameter>(param.entity())
            .expect("virtual intensity parameter should exist")
            .default_value = 255.0;

        let transition = create_test_transition(
            Duration::ZERO,
            Duration::ZERO,
            Duration::ZERO,
            Duration::from_secs(1),
        );
        let mut layer = Layer::new("test".to_string(), Priority(2));
        layer.absolute.insert(
            param,
            (
                ParameterValue::AbsolutePercent { value: 1.0.into() },
                Some(transition),
            ),
        );

        let mut base = ComputedLayer::default();
        base.absolute.insert(param, 64.0);
        let mut param_query_state = world.query::<InstanceMut<TestParameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        let computed = apply_transitions_with_compositing_context(
            &mut layer,
            &base,
            &param_query,
            true,
            LayerCompositingContext {
                position: Duration::from_millis(10500),
                released_at: Some(Duration::from_secs(10)),
            },
        );
        let value = *computed
            .absolute
            .get(&param)
            .expect("virtual intensity should output a release fade value");

        assert!(
            (159.0..=160.0).contains(&value),
            "virtual intensity should fade from full toward the active base, got {value}"
        );
    }

    #[test]
    fn test_apply_transitions_releasing_fades_from_asserted_value() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, TestMergeMode::Ltp, Attribute::Red);

        let transition = create_test_transition(
            Duration::ZERO,
            Duration::from_secs(1),
            Duration::ZERO,
            Duration::from_secs(1),
        );

        let mut layer = Layer::new("test".to_string(), Priority(1));
        layer.absolute.insert(
            param,
            (ParameterValue::Absolute { value: 200.0 }, Some(transition)),
        );

        let mut base = ComputedLayer::default();
        base.absolute.insert(param, 50.0);

        let mut param_query_state = world.query::<InstanceMut<TestParameter>>();
        let param_query = param_query_state.query_mut(&mut world);
        let computed = apply_transitions_with_compositing_context(
            &mut layer,
            &base,
            &param_query,
            true,
            LayerCompositingContext {
                position: Duration::from_secs(10),
                released_at: Some(Duration::from_millis(9500)),
            },
        );
        let value = *computed
            .absolute
            .get(&param)
            .expect("release fade should output an intermediate value");

        assert!(
            (120.0..=130.0).contains(&value),
            "release fade should interpolate from asserted value to base, got {value}"
        );
    }

    #[test]
    fn test_apply_transitions_releasing_freezes_active_fade_in() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, TestMergeMode::Ltp, Attribute::Red);

        let transition = create_test_transition(
            Duration::ZERO,
            Duration::from_secs(1),
            Duration::ZERO,
            Duration::from_secs(1),
        );

        let mut layer = Layer::new("test".to_string(), Priority(1));
        layer.absolute.insert(
            param,
            (ParameterValue::Absolute { value: 200.0 }, Some(transition)),
        );

        let mut base = ComputedLayer::default();
        base.absolute.insert(param, 50.0);

        let mut param_query_state = world.query::<InstanceMut<TestParameter>>();
        let param_query = param_query_state.query_mut(&mut world);
        let computed = apply_transitions_with_compositing_context(
            &mut layer,
            &base,
            &param_query,
            true,
            LayerCompositingContext {
                position: Duration::from_millis(750),
                released_at: Some(Duration::from_millis(500)),
            },
        );
        let value = *computed
            .absolute
            .get(&param)
            .expect("release fade should output an intermediate value");

        assert!(
            (103.0..=110.0).contains(&value),
            "release fade should start from the value frozen at release time, got {value}"
        );
    }

    /// Reproduces release output divergence when one evaluation samples transition time per parameter.
    #[test]
    fn process_transition_release_uses_one_context_for_one_evaluation() {
        let mut world = World::new();
        let first_param = create_test_parameter(&mut world, TestMergeMode::Ltp, Attribute::Red);
        let second_param = create_test_parameter(&mut world, TestMergeMode::Ltp, Attribute::Green);
        let mut first_transition = create_test_transition(
            Duration::ZERO,
            Duration::ZERO,
            Duration::ZERO,
            Duration::from_millis(4),
        );
        let mut second_transition = first_transition.clone();

        let mut param_query_state = world.query::<InstanceMut<TestParameter>>();
        let param_query = param_query_state.query_mut(&mut world);
        let context = LayerCompositingContext {
            position: Duration::ZERO,
            released_at: Some(Duration::ZERO),
        };
        let first_value = process_transition_with_compositing_context(
            &param_query
                .get(first_param.entity())
                .expect("first parameter should exist"),
            200.0,
            0.0,
            &mut first_transition,
            true,
            context,
        );
        std::thread::sleep(Duration::from_millis(6));
        let second_value = process_transition_with_compositing_context(
            &param_query
                .get(second_param.entity())
                .expect("second parameter should exist"),
            200.0,
            0.0,
            &mut second_transition,
            true,
            context,
        );

        assert!(
            (first_value - second_value).abs() < f64::EPSILON,
            "parameters in one release evaluation should share transition time; got {first_value} and {second_value}"
        );
    }

    /// Verifies transition assertion can be evaluated from elapsed playback time.
    #[test]
    fn process_transition_with_compositing_context_evaluates_assertion_elapsed() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, TestMergeMode::Ltp, Attribute::Red);
        let mut transition = create_test_transition(
            Duration::ZERO,
            Duration::from_secs(1),
            Duration::ZERO,
            Duration::from_secs(1),
        );

        let mut param_query_state = world.query::<InstanceMut<TestParameter>>();
        let param_query = param_query_state.query_mut(&mut world);
        let value = process_transition_with_compositing_context(
            &param_query
                .get(param.entity())
                .expect("parameter should exist"),
            100.0,
            200.0,
            &mut transition,
            false,
            LayerCompositingContext {
                position: Duration::from_millis(500),
                released_at: None,
            },
        );

        assert_eq!(value, 150.0);
    }

    /// Verifies downward assertions hold their base value through delay-out.
    #[test]
    fn process_transition_with_compositing_context_holds_downward_assertion_for_delay_out() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, TestMergeMode::Htp, Attribute::Intensity);
        let mut transition = create_test_transition(
            Duration::from_secs(3),
            Duration::ZERO,
            Duration::from_secs(1),
            Duration::from_secs(1),
        );

        let mut param_query_state = world.query::<InstanceMut<TestParameter>>();
        let param_query = param_query_state.query_mut(&mut world);
        let value = process_transition_with_compositing_context(
            &param_query
                .get(param.entity())
                .expect("parameter should exist"),
            200.0,
            100.0,
            &mut transition,
            false,
            LayerCompositingContext {
                position: Duration::from_millis(500),
                released_at: None,
            },
        );

        assert_eq!(
            value, 200.0,
            "downward assertions should use delay-out, not delay-in"
        );
    }

    /// Verifies upward assertions hold their base value through delay-in.
    #[test]
    fn process_transition_with_compositing_context_holds_upward_assertion_for_delay_in() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, TestMergeMode::Ltp, Attribute::Red);
        let mut transition = create_test_transition(
            Duration::from_secs(1),
            Duration::from_secs(1),
            Duration::from_secs(3),
            Duration::ZERO,
        );

        let mut param_query_state = world.query::<InstanceMut<TestParameter>>();
        let param_query = param_query_state.query_mut(&mut world);
        let value = process_transition_with_compositing_context(
            &param_query
                .get(param.entity())
                .expect("parameter should exist"),
            100.0,
            200.0,
            &mut transition,
            false,
            LayerCompositingContext {
                position: Duration::from_millis(500),
                released_at: None,
            },
        );

        assert_eq!(
            value, 100.0,
            "upward assertions should use delay-in, not delay-out"
        );
    }

    /// Verifies downward assertions do not wait on delay-in.
    #[test]
    fn process_transition_with_compositing_context_downward_assertion_ignores_delay_in() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, TestMergeMode::Htp, Attribute::Intensity);
        let mut transition = create_test_transition(
            Duration::from_secs(3),
            Duration::ZERO,
            Duration::ZERO,
            Duration::from_secs(1),
        );

        let mut param_query_state = world.query::<InstanceMut<TestParameter>>();
        let param_query = param_query_state.query_mut(&mut world);
        let value = process_transition_with_compositing_context(
            &param_query
                .get(param.entity())
                .expect("parameter should exist"),
            200.0,
            100.0,
            &mut transition,
            false,
            LayerCompositingContext {
                position: Duration::from_millis(500),
                released_at: None,
            },
        );

        assert_eq!(
            value, 150.0,
            "downward assertions should start fading when delay-out has elapsed"
        );
    }

    /// Verifies release freezes downward HTP assertions using delay-out timing.
    #[test]
    fn transition_value_at_release_elapsed_downward_assertion_uses_delay_out() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, TestMergeMode::Htp, Attribute::Intensity);
        let transition = create_test_transition(
            Duration::from_secs(3),
            Duration::ZERO,
            Duration::ZERO,
            Duration::from_secs(1),
        );

        let mut param_query_state = world.query::<InstanceMut<TestParameter>>();
        let param_query = param_query_state.query_mut(&mut world);
        let value = transition_value_at_release_elapsed(
            &param_query
                .get(param.entity())
                .expect("parameter should exist"),
            200.0,
            100.0,
            &transition,
            Duration::from_millis(500),
        );

        assert_eq!(
            value, 150.0,
            "released downward HTP assertions should freeze at delay-out progress"
        );
    }

    /// Verifies LTP downward assertions continue to use transition-in timing.
    #[test]
    fn process_transition_with_compositing_context_ltp_downward_assertion_uses_delay_in() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, TestMergeMode::Ltp, Attribute::Red);
        let mut transition = create_test_transition(
            Duration::from_secs(1),
            Duration::from_secs(1),
            Duration::ZERO,
            Duration::ZERO,
        );

        let mut param_query_state = world.query::<InstanceMut<TestParameter>>();
        let param_query = param_query_state.query_mut(&mut world);
        let value = process_transition_with_compositing_context(
            &param_query
                .get(param.entity())
                .expect("parameter should exist"),
            200.0,
            100.0,
            &mut transition,
            false,
            LayerCompositingContext {
                position: Duration::from_millis(500),
                released_at: None,
            },
        );

        assert_eq!(
            value, 200.0,
            "LTP downward assertions should preserve transition-in timing"
        );
    }

    /// Verifies transition release can be evaluated from elapsed playback time.
    #[test]
    fn process_transition_with_compositing_context_evaluates_release_elapsed() {
        let mut world = World::new();
        let param = create_test_parameter(&mut world, TestMergeMode::Ltp, Attribute::Red);
        let mut transition = create_test_transition(
            Duration::ZERO,
            Duration::from_secs(1),
            Duration::ZERO,
            Duration::from_secs(1),
        );

        let mut param_query_state = world.query::<InstanceMut<TestParameter>>();
        let param_query = param_query_state.query_mut(&mut world);
        let value = process_transition_with_compositing_context(
            &param_query
                .get(param.entity())
                .expect("parameter should exist"),
            200.0,
            0.0,
            &mut transition,
            true,
            LayerCompositingContext {
                position: Duration::from_secs(2),
                released_at: Some(Duration::from_millis(1500)),
            },
        );

        assert_eq!(value, 100.0);
    }

    #[test]
    fn test_apply_transitions_missing_parameter_skipped() {
        let mut world = World::new();
        let _param = create_test_parameter(&mut world, TestMergeMode::Ltp, Attribute::Red);

        let mut layer = Layer::new("test".to_string(), Priority(1));

        // Create a fake parameter reference that doesn't exist in the world
        let fake_param = ParameterRef::from_entity(Entity::from_bits(9999));
        layer.absolute.insert(
            fake_param,
            (ParameterValue::Absolute { value: 100.0 }, None),
        );

        let base = ComputedLayer::default();
        let mut param_query_state = world.query::<InstanceMut<TestParameter>>();
        let param_query = param_query_state.query_mut(&mut world);

        let computed = apply_transitions_with_compositing_context(
            &mut layer,
            &base,
            &param_query,
            false,
            LayerCompositingContext::default(),
        );

        // Should skip the missing parameter
        assert!(computed.absolute.is_empty());
    }
}
