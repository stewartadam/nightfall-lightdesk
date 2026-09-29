// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Resolution of the fixture emitters a Step FX color lane owns on one element.

use bevy_ecs::prelude::*;
use moonshine_kind::prelude::Instance;
use nightfall::prelude::*;
use nightfall_dmx::prelude::*;
use nightfall_fixtures::prelude::*;

/// Emitter model used to express a color on one fixture element.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ColorEmitterModel {
    /// Additive red, green, and blue emitters, optionally with white and amber mixing.
    Rgb,
    /// Subtractive cyan, magenta, and yellow flags.
    Cmy,
}

impl ColorEmitterModel {
    /// Returns the three primary attributes of this model in component order.
    fn primaries(self) -> [Attribute; 3] {
        match self {
            Self::Rgb => [Attribute::Red, Attribute::Green, Attribute::Blue],
            Self::Cmy => [Attribute::Cyan, Attribute::Magenta, Attribute::Yellow],
        }
    }
}

/// Emitters on one fixture element that the color lane drives.
#[derive(Clone, Debug)]
pub(crate) struct ColorLaneEmitters {
    /// Model used to convert the sampled color into primary emitter levels.
    pub model: ColorEmitterModel,
    /// Primary emitters in component order.
    pub primaries: [Instance<Parameter>; 3],
    /// White and amber emitters that receive the RGB decomposition.
    pub color_mix: Vec<(Attribute, Instance<Parameter>)>,
}

impl ColorLaneEmitters {
    /// Resolves the color lane's emitters on one element, preferring RGB over CMY.
    ///
    /// Returns `None` when the element lacks a complete primary set, in which case the
    /// color lane leaves the element entirely to attribute lanes.
    pub fn resolve(
        element_ref: &FixtureRef,
        fixture_data_provider: &FixtureDataProviderExt,
        parameter_query: &Query<&Parameter>,
    ) -> Option<Self> {
        let resolve_parameter = |attribute: &Attribute| {
            let resolved = fixture_data_provider
                .try_parameter_for_logical_attribute(element_ref, attribute)?;
            parameter_query
                .contains(resolved.instance.entity())
                .then_some(resolved.instance)
        };
        [ColorEmitterModel::Rgb, ColorEmitterModel::Cmy]
            .into_iter()
            .find_map(|model| {
                let [first, second, third] = model.primaries();
                let primaries = [
                    resolve_parameter(&first)?,
                    resolve_parameter(&second)?,
                    resolve_parameter(&third)?,
                ];
                let color_mix = match model {
                    ColorEmitterModel::Rgb => RGB_COLOR_MIX_ATTRIBUTES
                        .iter()
                        .filter_map(|attribute| {
                            resolve_parameter(attribute)
                                .map(|parameter| (attribute.clone(), parameter))
                        })
                        .collect(),
                    ColorEmitterModel::Cmy => Vec::new(),
                };
                Some(Self {
                    model,
                    primaries,
                    color_mix,
                })
            })
    }

    /// Returns every parameter this lane writes on the element.
    pub fn claimed_parameters(&self) -> impl Iterator<Item = Instance<Parameter>> + '_ {
        self.primaries
            .iter()
            .copied()
            .chain(self.color_mix.iter().map(|(_, parameter)| *parameter))
    }

    /// Converts a sampled color into normalized levels for every claimed parameter.
    ///
    /// Color-mix emitters that the decomposition does not drive are held at zero so they
    /// never leak light from lower-priority sources into the lane's color.
    pub fn levels(&self, color: ColorPathRgb) -> Vec<(Instance<Parameter>, f32)> {
        let color = color.clamped();
        let (primary, mix_levels) = match self.model {
            ColorEmitterModel::Rgb => {
                let available = self
                    .color_mix
                    .iter()
                    .map(|(attribute, _)| attribute.clone())
                    .collect::<Vec<_>>();
                let decomposed = decompose_rgb_color_mix(color, &available);
                let residual = rgb_after_color_mix(color, &decomposed);
                ([residual.red, residual.green, residual.blue], decomposed)
            }
            ColorEmitterModel::Cmy => (
                [1.0 - color.red, 1.0 - color.green, 1.0 - color.blue],
                Vec::new(),
            ),
        };
        let mix = self.color_mix.iter().map(|(attribute, parameter)| {
            let level = mix_levels
                .iter()
                .find_map(|(mixed, level)| (mixed == attribute).then_some(*level))
                .unwrap_or(0.0);
            (*parameter, level)
        });
        self.primaries
            .iter()
            .copied()
            .zip(primary)
            .chain(mix)
            .collect()
    }
}
