// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Color-path sampling and emitter decomposition for rendered sequence layers.

use nightfall_dmx::prelude::Attribute;

use super::super::tracking::mark_transition_input_complete;
use super::super::*;
use crate::materialized_cue::{
    MaterializedColorPathGroup, MaterializedColorPathModel, MaterializedColorPathScalarGroup,
};

/// Applies color path samples directly to a layer for standalone cue rendering.
pub(crate) fn apply_color_path_samples_to_layer(
    layer: &mut Layer,
    base: &ComputedLayer,
    groups: &[MaterializedColorPathGroup],
    scalar_groups: &[MaterializedColorPathScalarGroup],
    param_query: &Query<InstanceMut<Parameter>>,
    compositing_context: Option<nightfall_compositor::types::LayerCompositingContext>,
) {
    if groups.is_empty() && scalar_groups.is_empty() {
        return;
    }

    let mut computed = nightfall_compositor::stages::apply_transitions_with_compositing_context(
        layer,
        base,
        param_query,
        false,
        compositing_context.unwrap_or_default(),
    );
    apply_color_path_samples(
        layer,
        &mut computed,
        base,
        groups,
        scalar_groups,
        param_query,
        compositing_context,
    );
    squash_color_path_sampled_values(layer, &computed, groups, scalar_groups);
}

/// Applies color path samples to computed absolute emitter values.
pub(super) fn apply_color_path_samples(
    layer: &mut Layer,
    computed: &mut ComputedLayer,
    base: &ComputedLayer,
    groups: &[MaterializedColorPathGroup],
    scalar_groups: &[MaterializedColorPathScalarGroup],
    param_query: &Query<InstanceMut<Parameter>>,
    compositing_context: Option<nightfall_compositor::types::LayerCompositingContext>,
) {
    for group in groups {
        let Ok(red_parameter) = param_query.get(group.red.entity()) else {
            continue;
        };
        let Ok(green_parameter) = param_query.get(group.green.entity()) else {
            continue;
        };
        let Ok(blue_parameter) = param_query.get(group.blue.entity()) else {
            continue;
        };

        let Some(red_target) = absolute_layer_target(layer, base, group.red, &red_parameter) else {
            continue;
        };
        let Some(green_target) = absolute_layer_target(layer, base, group.green, &green_parameter)
        else {
            continue;
        };
        let Some(blue_target) = absolute_layer_target(layer, base, group.blue, &blue_parameter)
        else {
            continue;
        };

        let attributes = group.model.attributes();
        let start = group.model.to_rgb([
            normalize_emitter_value(
                &red_parameter,
                base_absolute_value(base, group.red, &red_parameter),
            ),
            normalize_emitter_value(
                &green_parameter,
                base_absolute_value(base, group.green, &green_parameter),
            ),
            normalize_emitter_value(
                &blue_parameter,
                base_absolute_value(base, group.blue, &blue_parameter),
            ),
        ]);
        let end = group.model.to_rgb([
            normalize_emitter_value(&red_parameter, red_target),
            normalize_emitter_value(&green_parameter, green_target),
            normalize_emitter_value(&blue_parameter, blue_target),
        ]);
        let parent_ratio = color_path_transition_ratio(layer, group, compositing_context);
        let brightness_multiplier =
            color_path_midpoint_brightness_multiplier(&group.path, parent_ratio);
        let sampled = ColorPathRgb {
            red: sample_color_path(
                &group.path,
                start,
                end,
                color_path_channel_ratio(&group.path, parent_ratio, &attributes[0]),
            )
            .red,
            green: sample_color_path(
                &group.path,
                start,
                end,
                color_path_channel_ratio(&group.path, parent_ratio, &attributes[1]),
            )
            .green,
            blue: sample_color_path(
                &group.path,
                start,
                end,
                color_path_channel_ratio(&group.path, parent_ratio, &attributes[2]),
            )
            .blue,
        }
        .scaled(brightness_multiplier)
        .clamped();
        let (sampled, decomposed_emitters) = if group.model == MaterializedColorPathModel::Rgb {
            let decomposed_emitters =
                sample_decomposed_rgb_emitters(group, start, end, parent_ratio);
            let primary = rgb_after_decomposed_emitters(sampled, &decomposed_emitters);
            (
                [primary.red, primary.green, primary.blue],
                decomposed_emitters,
            )
        } else {
            (group.model.from_rgb(sampled), Vec::new())
        };

        computed.absolute.insert(
            group.red,
            denormalize_emitter_value(&red_parameter, sampled[0]),
        );
        computed.absolute.insert(
            group.green,
            denormalize_emitter_value(&green_parameter, sampled[1]),
        );
        computed.absolute.insert(
            group.blue,
            denormalize_emitter_value(&blue_parameter, sampled[2]),
        );

        for (attribute, parameter_ref) in &group.decomposed_emitters {
            let Ok(parameter) = param_query.get(parameter_ref.entity()) else {
                continue;
            };
            let sampled = decomposed_emitters
                .iter()
                .find_map(|(sampled_attribute, value)| {
                    (sampled_attribute == attribute).then_some(*value)
                })
                .unwrap_or(0.0);
            let dmx_sampled = denormalize_emitter_value(&parameter, sampled);

            computed.absolute.insert(*parameter_ref, dmx_sampled);
            if !layer.absolute.contains_key(parameter_ref) {
                let transition = color_path_transition_for_derived_emitter(layer, group);
                if let Some(active) =
                    color_path_transition_activity_for_derived_emitter(layer, group)
                {
                    layer.transitioning.insert(*parameter_ref, active);
                }
                layer.absolute.insert(
                    *parameter_ref,
                    (ParameterValue::Absolute { value: dmx_sampled }, transition),
                );
            }
        }

        for (attribute, parameter_ref) in &group.auxiliary_emitters {
            let Ok(parameter) = param_query.get(parameter_ref.entity()) else {
                continue;
            };
            let Some(target) = absolute_layer_target(layer, base, *parameter_ref, &parameter)
            else {
                continue;
            };
            let start = normalize_emitter_value(
                &parameter,
                base_absolute_value(base, *parameter_ref, &parameter),
            );
            let end = normalize_emitter_value(&parameter, target);
            let sampled =
                (sample_color_path_scalar(
                    &group.path,
                    start,
                    end,
                    color_path_channel_ratio(&group.path, parent_ratio, attribute),
                ) * color_path_midpoint_brightness_multiplier(&group.path, parent_ratio))
                .clamp(0.0, 1.0);

            computed.absolute.insert(
                *parameter_ref,
                denormalize_emitter_value(&parameter, sampled),
            );
        }
    }

    for group in scalar_groups {
        let parent_ratio = color_path_scalar_transition_ratio(layer, group, compositing_context);
        for (attribute, parameter_ref) in &group.emitters {
            let Ok(parameter) = param_query.get(parameter_ref.entity()) else {
                continue;
            };
            let Some(target) = absolute_layer_target(layer, base, *parameter_ref, &parameter)
            else {
                continue;
            };
            let start = normalize_emitter_value(
                &parameter,
                base_absolute_value(base, *parameter_ref, &parameter),
            );
            let end = normalize_emitter_value(&parameter, target);
            let sampled =
                (sample_color_path_scalar(
                    &group.path,
                    start,
                    end,
                    color_path_channel_ratio(&group.path, parent_ratio, attribute),
                ) * color_path_midpoint_brightness_multiplier(&group.path, parent_ratio))
                .clamp(0.0, 1.0);

            computed.absolute.insert(
                *parameter_ref,
                denormalize_emitter_value(&parameter, sampled),
            );
        }
    }
}

/// Writes sampled color-path values back into the layer without consuming unrelated transitions.
fn squash_color_path_sampled_values(
    layer: &mut Layer,
    computed: &ComputedLayer,
    groups: &[MaterializedColorPathGroup],
    scalar_groups: &[MaterializedColorPathScalarGroup],
) {
    let mut squash_parameter = |parameter_ref: Instance<Parameter>| {
        let Some(value) = computed.absolute.get(parameter_ref).copied() else {
            return;
        };
        let Some((parameter_value, transition)) = layer.absolute.get_mut(parameter_ref) else {
            return;
        };
        *parameter_value = ParameterValue::Absolute { value };
        mark_transition_input_complete(transition);
    };

    for group in groups {
        squash_parameter(group.red);
        squash_parameter(group.green);
        squash_parameter(group.blue);

        for (_, parameter_ref) in &group.decomposed_emitters {
            squash_parameter(*parameter_ref);
        }
        for (_, parameter_ref) in &group.auxiliary_emitters {
            squash_parameter(*parameter_ref);
        }
    }

    for group in scalar_groups {
        for (_, parameter_ref) in &group.emitters {
            squash_parameter(*parameter_ref);
        }
    }
}

/// Samples RGB-derived color-mix emitters with their own color path timing.
fn sample_decomposed_rgb_emitters(
    group: &MaterializedColorPathGroup,
    start: ColorPathRgb,
    end: ColorPathRgb,
    parent_ratio: f32,
) -> Vec<(Attribute, f32)> {
    group
        .decomposed_emitters
        .iter()
        .filter_map(|(attribute, _)| {
            let sampled = sample_color_path(
                &group.path,
                start,
                end,
                color_path_channel_ratio(&group.path, parent_ratio, attribute),
            )
            .scaled(color_path_midpoint_brightness_multiplier(
                &group.path,
                parent_ratio,
            ))
            .clamped();
            decompose_rgb_color_mix(sampled, &group.decomposed_emitters)
                .into_iter()
                .find_map(|(sampled_attribute, value)| {
                    (sampled_attribute == *attribute).then_some((attribute.clone(), value))
                })
        })
        .collect()
}

/// Decomposes an RGB color into common additive color-mix emitter values.
fn decompose_rgb_color_mix(
    sampled: ColorPathRgb,
    emitters: &[(Attribute, Instance<Parameter>)],
) -> Vec<(Attribute, f32)> {
    let mut residual = sampled.clamped();
    let mut decomposed = Vec::new();

    if let Some(attribute) = first_available_attribute(
        emitters,
        &[Attribute::White, Attribute::WarmWhite, Attribute::CoolWhite],
    ) {
        let white = residual.red.min(residual.green).min(residual.blue);
        residual.red -= white;
        residual.green -= white;
        residual.blue -= white;
        decomposed.push((attribute, white));
    }

    if emitter_available(emitters, &Attribute::Amber) {
        let amber = residual.red.min(residual.green / 0.6);
        decomposed.push((Attribute::Amber, amber.clamp(0.0, 1.0)));
    }

    decomposed
}

/// Removes currently active derived color-mix emitters from a primary RGB sample.
fn rgb_after_decomposed_emitters(
    sampled: ColorPathRgb,
    attributes: &[(Attribute, f32)],
) -> ColorPathRgb {
    let mut residual = sampled.clamped();
    for (attribute, value) in attributes {
        match attribute {
            Attribute::White | Attribute::WarmWhite | Attribute::CoolWhite => {
                residual.red -= value;
                residual.green -= value;
                residual.blue -= value;
            }
            Attribute::Amber => {
                residual.red -= value;
                residual.green -= value * 0.6;
            }
            _ => {}
        }
    }
    residual.clamped()
}

/// Clones the parent RGB transition for derived emitter placeholders in the output layer.
fn color_path_transition_for_derived_emitter(
    layer: &Layer,
    group: &MaterializedColorPathGroup,
) -> Option<MaterializedTransition> {
    [group.red, group.green, group.blue]
        .into_iter()
        .find_map(|parameter_ref| layer.absolute.get(parameter_ref)?.1.clone())
}

/// Clones the parent RGB transition activity for derived emitter placeholders.
fn color_path_transition_activity_for_derived_emitter(
    layer: &Layer,
    group: &MaterializedColorPathGroup,
) -> Option<bool> {
    let mut activity = [group.red, group.green, group.blue]
        .into_iter()
        .filter_map(|parameter_ref| layer.transitioning.get(parameter_ref).copied());
    let first_activity = activity.next()?;

    Some(activity.fold(first_activity, |active, next| active || next))
}

/// Returns the first requested attribute that exists in the emitter set.
fn first_available_attribute(
    emitters: &[(Attribute, Instance<Parameter>)],
    attributes: &[Attribute],
) -> Option<Attribute> {
    attributes
        .iter()
        .find(|attribute| emitter_available(emitters, attribute))
        .cloned()
}

/// Returns whether a decomposed color-mix emitter is available.
fn emitter_available(emitters: &[(Attribute, Instance<Parameter>)], attribute: &Attribute) -> bool {
    emitters
        .iter()
        .any(|(emitter_attribute, _)| emitter_attribute == attribute)
}

/// Resolves the final absolute target authored in a layer for one parameter.
fn absolute_layer_target(
    layer: &Layer,
    base: &ComputedLayer,
    parameter_ref: Instance<Parameter>,
    parameter: &InstanceRef<Parameter>,
) -> Option<ParameterDmxValue> {
    let (value, _) = layer.absolute.get(parameter_ref)?;
    let base_value = base_absolute_value(base, parameter_ref, parameter);
    Some(parameter.resolve_value_with_current(value, base_value))
}

/// Returns the absolute start value for one emitter.
fn base_absolute_value(
    base: &ComputedLayer,
    parameter_ref: Instance<Parameter>,
    parameter: &InstanceRef<Parameter>,
) -> ParameterDmxValue {
    base.absolute
        .get(parameter_ref)
        .copied()
        .unwrap_or_else(|| parameter.get_default_value())
}

/// Resolves normalized color path progress from the group's transition timing.
fn color_path_transition_ratio(
    layer: &Layer,
    group: &MaterializedColorPathGroup,
    compositing_context: Option<nightfall_compositor::types::LayerCompositingContext>,
) -> f32 {
    let transition = [group.red, group.green, group.blue]
        .into_iter()
        .find_map(|parameter_ref| layer.absolute.get(parameter_ref)?.1.as_ref());
    let Some(transition) = transition else {
        return 1.0;
    };
    let context = compositing_context.unwrap_or_default();
    MaterializedTransition::fade_ratio_at_elapsed(
        transition.elapsed_from_start(context.position),
        transition.fade_in,
        transition.delay_in,
    )
}

/// Resolves normalized color path progress from scalar color emitter transition timing.
fn color_path_scalar_transition_ratio(
    layer: &Layer,
    group: &MaterializedColorPathScalarGroup,
    compositing_context: Option<nightfall_compositor::types::LayerCompositingContext>,
) -> f32 {
    let transition = group
        .emitters
        .iter()
        .find_map(|(_, parameter_ref)| layer.absolute.get(parameter_ref)?.1.as_ref());
    let Some(transition) = transition else {
        return 1.0;
    };
    let context = compositing_context.unwrap_or_default();
    MaterializedTransition::fade_ratio_at_elapsed(
        transition.elapsed_from_start(context.position),
        transition.fade_in,
        transition.delay_in,
    )
}

/// Resolves path progress after applying path-level and attribute-level timing controls.
fn color_path_channel_ratio(path: &ColorPath, parent_ratio: f32, attribute: &Attribute) -> f32 {
    path.timing
        .attributes
        .get(attribute)
        .map(|timing| {
            timed_ratio(
                parent_ratio,
                timing.delay_percent,
                timing.time_percent,
                timing.curve,
            )
        })
        .unwrap_or_else(|| color_path_global_ratio(path, parent_ratio))
}

/// Resolves path-level timing from in-color and out-color controls.
fn color_path_global_ratio(path: &ColorPath, parent_ratio: f32) -> f32 {
    match (&path.timing.in_color, &path.timing.out_color) {
        (Some(in_color), Some(out_color)) => {
            (timed_ratio_linear(parent_ratio, in_color.delay_percent, in_color.time_percent)
                + timed_ratio_linear(
                    parent_ratio,
                    out_color.delay_percent,
                    out_color.time_percent,
                ))
                / 2.0
        }
        (Some(in_color), None) => {
            timed_ratio_linear(parent_ratio, in_color.delay_percent, in_color.time_percent)
        }
        (None, Some(out_color)) => timed_ratio_linear(
            parent_ratio,
            out_color.delay_percent,
            out_color.time_percent,
        ),
        (None, None) => parent_ratio,
    }
}

/// Resolves a linear timing ratio from fractional delay and duration controls.
fn timed_ratio_linear(parent_ratio: f32, delay_percent: f32, time_percent: f32) -> f32 {
    let parent_ratio = parent_ratio.clamp(0.0, 1.0);
    let delay_percent = delay_percent.clamp(0.0, 1.0);
    let time_percent = time_percent.max(0.0);

    if parent_ratio < delay_percent {
        return 0.0;
    }
    if time_percent <= f32::EPSILON {
        return 1.0;
    }

    ((parent_ratio - delay_percent) / time_percent).clamp(0.0, 1.0)
}

/// Resolves the midpoint brightness envelope multiplier for a parent fade ratio.
fn color_path_midpoint_brightness_multiplier(path: &ColorPath, parent_ratio: f32) -> f32 {
    let midpoint_brightness = path.timing.brightness_percent.unwrap_or(1.0).max(0.0);
    let interior_weight = 1.0 - ((parent_ratio.clamp(0.0, 1.0) * 2.0) - 1.0).abs();
    1.0 + (midpoint_brightness - 1.0) * interior_weight
}

/// Maps a parent transition ratio through one fractional delay/fade timing control.
fn timed_ratio(parent_ratio: f32, delay_percent: f32, time_percent: f32, curve: FadeCurve) -> f32 {
    let parent_ratio = parent_ratio.clamp(0.0, 1.0);
    let delay_percent = delay_percent.clamp(0.0, 1.0);
    let time_percent = time_percent.max(0.0);

    if parent_ratio < delay_percent {
        return 0.0;
    }
    if time_percent <= f32::EPSILON {
        return 1.0;
    }

    let ratio = ((parent_ratio - delay_percent) / time_percent).clamp(0.0, 1.0);
    curve.evaluate_at(ratio)
}

/// Samples a scalar color emitter through the color path curve and timing.
fn sample_color_path_scalar(path: &ColorPath, start: f32, end: f32, t: f32) -> f32 {
    let ratio = path.curve.evaluate_at(t.clamp(0.0, 1.0));
    start + (end - start) * ratio
}

/// Converts an emitter DMX value into normalized 0.0-1.0 color space.
fn normalize_emitter_value(parameter: &InstanceRef<Parameter>, value: ParameterDmxValue) -> f32 {
    let min = parameter.metadata.logical_min();
    let max = parameter.metadata.logical_max();
    if (max - min).abs() <= f32::EPSILON {
        return 0.0;
    }
    ((value - min) / (max - min)).clamp(0.0, 1.0)
}

/// Converts a normalized color sample back into an emitter DMX value.
fn denormalize_emitter_value(parameter: &InstanceRef<Parameter>, value: f32) -> ParameterDmxValue {
    let min = parameter.metadata.logical_min();
    let max = parameter.metadata.logical_max();
    min + value.clamp(0.0, 1.0) * (max - min)
}
