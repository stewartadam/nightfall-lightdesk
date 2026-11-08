// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Render systems that hold parked parameters at their parked values.
//!
//! Park runs after compositing, in two steps of the virtual dimmer stage. Parked virtual
//! intensity parameters are written first, after inhibit masters and before virtual dimmers
//! scale their color parameters, so a parked virtual dimmer still dims its element by the parked
//! level. Every parked parameter, virtual intensity included, is then written last, after masters, virtual dimmers and
//! relations, so its parked value is exactly what goes out.
//!
//! The compositor skips passes when nothing it reads changed. Park writes its values without
//! flagging the parameters as changed while the parked set stays the same, so holding a value
//! doesn't force a full composite every frame. When the set or the patch changes, every
//! parameter that was or is parked is flagged instead, so the next pass recomposites it and an
//! unparked parameter returns to its composited value.

use bevy_ecs::prelude::*;
use moonshine_kind::prelude::*;
use nightfall_compositor::prelude::FinalLayerOutput;
use nightfall_dmx::prelude::{Attribute, ParameterDmxValue};
use nightfall_fixtures::prelude::*;

use crate::state::ParkedParameters;

/// Parked parameters resolved to the parameter entities they hold, rebuilt when the parked set
/// or the patch changes.
#[derive(Resource, Debug, Default)]
pub struct ParkTargets {
    /// Patch revision the targets were resolved against.
    patch_revision: Option<u64>,
    /// Parked virtual intensity parameters, written before virtual dimmers scale.
    virtual_intensity: Vec<(Instance<Parameter>, ParameterDmxValue)>,
    /// Every other parked parameter, written after all output processing.
    output: Vec<(Instance<Parameter>, ParameterDmxValue)>,
    /// Parameters whose parked state changed since the last frame, flagged as changed once so
    /// the compositor recomposites them.
    pending_refresh: Vec<Instance<Parameter>>,
}

impl ParkTargets {
    /// Returns every parameter entity currently held by park.
    fn parameters(&self) -> impl Iterator<Item = Instance<Parameter>> + '_ {
        self.virtual_intensity
            .iter()
            .chain(&self.output)
            .map(|(parameter, _)| *parameter)
    }
}

/// Re-resolves parked parameters to entities when the parked set or the patch changed.
///
/// Parameters of fixtures that are no longer patched are skipped but stay parked, so a fixture
/// that is patched again with the same UID returns to its parked value. The parameters that
/// were held before and after the change are queued to be flagged once, so the compositor
/// recomposites the ones that were unparked.
pub fn resolve_park_targets(
    parked: Res<ParkedParameters>,
    fixtures: Res<FixtureDataProviderExt>,
    mut targets: ResMut<ParkTargets>,
) {
    let index = fixtures.parameter_index();
    let patch_revision = Some(index.revision());
    if !parked.is_changed() && targets.patch_revision == patch_revision {
        return;
    }
    let previous: Vec<_> = targets.parameters().collect();
    let mut virtual_intensity = Vec::new();
    let mut output = Vec::new();
    for (key, value) in parked.iter() {
        let Some(parameter) = index.parameter(&key.element, &key.attribute) else {
            continue;
        };
        if key.attribute == Attribute::VirtualIntensity {
            virtual_intensity.push((parameter, value));
        } else {
            output.push((parameter, value));
        }
    }
    let targets = targets.as_mut();
    targets.patch_revision = patch_revision;
    targets.virtual_intensity = virtual_intensity;
    targets.output = output;
    targets.pending_refresh = previous;
    let current: Vec<_> = targets.parameters().collect();
    targets.pending_refresh.extend(current);
}

/// Writes parked virtual intensity values before virtual dimmers scale their colors.
pub fn apply_parked_virtual_intensity(
    targets: Res<ParkTargets>,
    mut parameters: Query<&mut Parameter>,
    mut final_layer_output: ResMut<FinalLayerOutput>,
) {
    hold_parked_values(
        &targets.virtual_intensity,
        &mut parameters,
        &mut final_layer_output,
    );
}

/// Writes every parked value after all output processing, then flags the parameters whose
/// parked state changed so the next compositor pass recomposites them.
///
/// Parked virtual intensity values are written again here because virtual relations run after
/// they were first written and may have replaced them.
pub fn apply_parked_output(
    mut targets: ResMut<ParkTargets>,
    mut parameters: Query<&mut Parameter>,
    mut final_layer_output: ResMut<FinalLayerOutput>,
) {
    hold_parked_values(
        &targets.virtual_intensity,
        &mut parameters,
        &mut final_layer_output,
    );
    hold_parked_values(&targets.output, &mut parameters, &mut final_layer_output);
    if targets.pending_refresh.is_empty() {
        return;
    }
    for parameter in std::mem::take(&mut targets.pending_refresh) {
        if let Ok(mut parameter) = parameters.get_mut(parameter.entity()) {
            parameter.set_changed();
        }
    }
}

/// Holds each target at its parked value in the parameter and in the final layer output.
///
/// A value is only written when it differs, and without flagging the parameter as changed, so a
/// steady park leaves the compositor free to skip passes. Parameters awaiting a refresh are
/// flagged later by [`apply_parked_output`].
fn hold_parked_values(
    targets: &[(Instance<Parameter>, ParameterDmxValue)],
    parameters: &mut Query<&mut Parameter>,
    final_layer_output: &mut ResMut<FinalLayerOutput>,
) {
    for &(parameter, value) in targets {
        let Ok(mut component) = parameters.get_mut(parameter.entity()) else {
            continue;
        };
        if component.values.current_value != value {
            component.bypass_change_detection().set_raw_value(value);
        }
        if final_layer_output.0.absolute.get(parameter) != Some(&value) {
            final_layer_output.0.absolute.insert(parameter, value);
        }
        if final_layer_output.0.relative.contains_key(parameter) {
            final_layer_output.0.relative.remove(parameter);
        }
    }
}
