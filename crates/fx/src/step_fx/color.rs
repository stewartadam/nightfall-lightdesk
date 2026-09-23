// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Whole-color authoring with the same step clock and shaping as attribute tracks.

use super::*;

#[cfg(test)]
mod tests;

/// One complete RGB color target with shared component timing.
#[serde_with::serde_as]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct FxColorStep {
    /// Stable identity retained when reordering steps.
    #[serde(with = "nightfall::serde_uuid_simple")]
    #[typeshare(serialized_as = "String")]
    pub uid: Uuid,
    /// Inline color, or deterministic fallback for a missing Blueprint.
    pub target: ColorPathRgb,
    /// Live Blueprint providing all three absolute RGB components.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde_as(as = "Option<serde_with::DisplayFromStr>")]
    #[typeshare(serialized_as = "Option<String>")]
    pub blueprint_uid: Option<Uuid>,
    /// Length of this step in authored beats.
    pub width_beats: f32,
    /// Portion of this step used to approach its target.
    pub transition: StepFxTransition,
    /// Shape applied equally to every color component.
    pub curve: CurveType,
}

/// Absolute whole-color steps using the effect's timing and phase.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct FxColorLane {
    /// Ordered colors in one forward pass.
    pub steps: Vec<FxColorStep>,
}

impl FxColorLane {
    /// Validates colors and reuses scalar step validation for shared timing and identities.
    pub(super) fn validate(
        &self,
        uids: &mut HashSet<Uuid>,
        issues: &mut Vec<StepFxValidationIssue>,
    ) {
        let track = FxTrack {
            steps: self
                .steps
                .iter()
                .map(|step| FxStep {
                    uid: step.uid,
                    target: ParameterValue::AbsolutePercent {
                        value: step.target.red.into(),
                    },
                    blueprint_uid: step.blueprint_uid,
                    width_beats: step.width_beats,
                    transition: step.transition.clone(),
                    curve: step.curve.clone(),
                })
                .collect(),
        };
        validate_track(&track, false, "color_lane", uids, issues);
        for (index, step) in self.steps.iter().enumerate() {
            if [step.target.red, step.target.green, step.target.blue]
                .iter()
                .any(|value| !value.is_finite() || !(0.0..=1.0).contains(value))
            {
                push_issue(
                    issues,
                    format!("color_lane.steps.{index}.target"),
                    "Color components must be between zero and one",
                );
            }
        }
    }
}

impl StepFx {
    /// Computes the whole-color cycle duration for playback and continuity.
    pub fn color_cycle_duration(&self) -> Option<Duration> {
        let lane = self.color_lane.as_ref()?;
        let beats = match self.cycle_scale {
            StepFxCycleScale::Auto => lane.steps.iter().map(|step| step.width_beats).sum(),
            StepFxCycleScale::Fixed(beats) => beats,
        };
        positive_duration(
            beats * self.timing.beat_duration.as_secs_f32() * direction_pass_count(&self.direction),
        )
    }

    /// Samples a complete color with one phase and interpolation factor for all components.
    pub fn sample_color(
        &self,
        elapsed: Duration,
        selection_index: usize,
        selection_index_count: usize,
        runtime_phase_offset: f32,
        blueprints: Option<&DataProvider<Blueprint>>,
    ) -> Option<ColorPathRgb> {
        let lane = self.color_lane.as_ref()?;
        let (previous, current, factor) = sample_step_positions(
            &lane.steps,
            &self.timing,
            &self.direction,
            &self.cycle_scale,
            elapsed,
            phase_for_selection_index(&self.phase, selection_index, selection_index_count),
            runtime_phase_offset,
            |step| (step.width_beats, &step.transition, &step.curve),
        )?;
        let start = resolved_color(&lane.steps[previous], blueprints);
        let end = resolved_color(&lane.steps[current], blueprints);
        Some(
            ColorPathRgb {
                red: start.red + (end.red - start.red) * factor,
                green: start.green + (end.green - start.green) * factor,
                blue: start.blue + (end.blue - start.blue) * factor,
            }
            .clamped(),
        )
    }
}

/// Resolves a complete RGB Blueprint atomically, retaining the fallback if any component is absent.
fn resolved_color(
    step: &FxColorStep,
    blueprints: Option<&DataProvider<Blueprint>>,
) -> ColorPathRgb {
    let Some(blueprint) = step.blueprint_uid.and_then(|uid| blueprints?.get(uid).ok()) else {
        return step.target;
    };
    let component = |attribute| match blueprint.values.get(&attribute) {
        Some(ValueSource::Inline(ParameterValue::AbsolutePercent { value })) => {
            Some(value.as_f32())
        }
        _ => None,
    };
    match (
        component(Attribute::Red),
        component(Attribute::Green),
        component(Attribute::Blue),
    ) {
        (Some(red), Some(green), Some(blue)) => ColorPathRgb { red, green, blue },
        _ => step.target,
    }
}
