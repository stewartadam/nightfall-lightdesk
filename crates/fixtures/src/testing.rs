// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Synthetic patched fixture worlds shared by benchmarks in dependent crates.

use bevy_ecs::prelude::World;
use moonshine_kind::Instance;
use nightfall::prelude::{FixtureRef, Identifiers};
use nightfall_dmx::prelude::{Attribute, DmxValueResolution, ParameterValue};
use nightfall_fixture_model::parameter::{MergeStrategy, ParameterMetadata};
use nightfall_io::OutputTransport;
use uuid::Uuid;

use crate::bindings::{OutputDestination, ResolvedOutputDestinations};
use crate::data_provider_ext::FixtureDataProviderExt;
use crate::fixture::{Fixture, FixtureElement};
use crate::parameter::{Parameter, ParameterValues};

/// Channels available to fixtures in one universe, leaving a partial fixture footprint unused.
const USABLE_CHANNELS_PER_UNIVERSE: u16 = 510;

/// Per-element attributes, modelled on a moving-head RGBW spot with 16-bit pan and tilt.
pub const BENCH_FIXTURE_PARAMETERS: &[(Attribute, DmxValueResolution)] = &[
    (Attribute::Intensity, DmxValueResolution::Coarse),
    (Attribute::Pan, DmxValueResolution::Fine),
    (Attribute::Tilt, DmxValueResolution::Fine),
    (Attribute::Red, DmxValueResolution::Coarse),
    (Attribute::Green, DmxValueResolution::Coarse),
    (Attribute::Blue, DmxValueResolution::Coarse),
    (Attribute::White, DmxValueResolution::Coarse),
    (Attribute::StrobeShutter, DmxValueResolution::Coarse),
];

/// Per-element attributes of an RGBW LED fixture dimmed through a virtual intensity channel.
pub const BENCH_VDIM_FIXTURE_PARAMETERS: &[(Attribute, DmxValueResolution)] = &[
    (Attribute::VirtualIntensity, DmxValueResolution::Coarse),
    (Attribute::Red, DmxValueResolution::Coarse),
    (Attribute::Green, DmxValueResolution::Coarse),
    (Attribute::Blue, DmxValueResolution::Coarse),
    (Attribute::White, DmxValueResolution::Coarse),
];

/// One patched parameter spawned by [`patch_bench_fixtures`].
#[derive(Clone, Debug)]
pub struct BenchParameter {
    /// Fixture element owning the parameter.
    pub fixture_ref: FixtureRef,
    /// Attribute the parameter controls.
    pub attribute: Attribute,
    /// Spawned parameter entity.
    pub instance: Instance<Parameter>,
}

/// Patches `fixture_count` single-element fixtures with fixture IDs `1..=fixture_count`.
///
/// Each fixture gets one parameter entity per [`BENCH_FIXTURE_PARAMETERS`] entry, registered in
/// [`FixtureDataProviderExt`] (inserted when missing) and given a resolved output destination
/// on `transport`. Fixtures are packed contiguously from address 1 of universe 1, spilling into
/// the next universe when a fixture no longer fits.
pub fn patch_bench_fixtures(
    world: &mut World,
    fixture_count: usize,
    transport: &OutputTransport,
) -> Vec<BenchParameter> {
    patch_bench_fixtures_with_profile(world, fixture_count, transport, BENCH_FIXTURE_PARAMETERS)
}

/// Patches fixtures like [`patch_bench_fixtures`], with one parameter per `profile` entry.
pub fn patch_bench_fixtures_with_profile(
    world: &mut World,
    fixture_count: usize,
    transport: &OutputTransport,
    profile: &[(Attribute, DmxValueResolution)],
) -> Vec<BenchParameter> {
    world.init_resource::<FixtureDataProviderExt>();
    let footprint = bench_fixture_footprint(profile);
    let fixtures_per_universe = USABLE_CHANNELS_PER_UNIVERSE / footprint;
    let mut patched = Vec::with_capacity(fixture_count * profile.len());

    for fixture_index in 0..fixture_count {
        let fixture = bench_fixture(fixture_index, profile);
        let fixture_ref = FixtureRef {
            fixture_uid: fixture.identifiers.uid,
            index: Some(1),
        };
        let universe = (fixture_index as u16 / fixtures_per_universe) + 1;
        let mut address = (fixture_index as u16 % fixtures_per_universe) * footprint + 1;
        let first_parameter = patched.len();

        for (parameter_index, (attribute, resolution)) in profile.iter().enumerate() {
            let byte_count = *resolution as u16 / 8;
            let addresses = (address..address + byte_count).collect();
            address += byte_count;

            let entity = world
                .spawn((
                    Parameter {
                        metadata: bench_parameter_metadata(attribute.clone(), *resolution),
                        values: ParameterValues {
                            current_value: ((fixture_index + parameter_index) % 256) as f32,
                            ..Default::default()
                        },
                    },
                    ResolvedOutputDestinations {
                        destinations: vec![OutputDestination {
                            transport: transport.clone(),
                            universe,
                            addresses,
                        }],
                    },
                ))
                .id();
            patched.push(BenchParameter {
                fixture_ref: fixture_ref.clone(),
                attribute: attribute.clone(),
                // SAFETY: the entity was spawned with a `Parameter` component above.
                instance: unsafe { Instance::from_entity_unchecked(entity) },
            });
        }

        let mut data_provider = world.resource_mut::<FixtureDataProviderExt>();
        let _ = data_provider.inner.add(fixture);
        for parameter in &patched[first_parameter..] {
            data_provider.add_parameter(
                parameter.fixture_ref.clone(),
                parameter.attribute.clone(),
                parameter.instance,
            );
        }
    }

    patched
}

/// Returns the number of universes [`patch_bench_fixtures`] uses for `fixture_count` fixtures.
pub fn bench_universe_count(fixture_count: usize) -> usize {
    let fixtures_per_universe =
        (USABLE_CHANNELS_PER_UNIVERSE / bench_fixture_footprint(BENCH_FIXTURE_PARAMETERS)) as usize;
    fixture_count.div_ceil(fixtures_per_universe)
}

/// Returns the number of DMX channels one fixture with `profile` occupies.
fn bench_fixture_footprint(profile: &[(Attribute, DmxValueResolution)]) -> u16 {
    profile
        .iter()
        .map(|(_, resolution)| *resolution as u16 / 8)
        .sum()
}

/// Builds the single-element fixture definition registered for `fixture_index`.
fn bench_fixture(fixture_index: usize, profile: &[(Attribute, DmxValueResolution)]) -> Fixture {
    Fixture {
        identifiers: Identifiers {
            id: fixture_index as u32 + 1,
            uid: Uuid::from_u128(fixture_index as u128 + 1),
            label: format!("bench fixture {}", fixture_index + 1),
        },
        make: "bench".to_owned(),
        model: "bench spot".to_owned(),
        elements: vec![FixtureElement {
            label: "element 1".to_owned(),
            parameters: profile
                .iter()
                .map(|(attribute, resolution)| {
                    bench_parameter_metadata(attribute.clone(), *resolution)
                })
                .collect(),
        }],
        ..Default::default()
    }
}

/// Builds LTP parameter metadata for one attribute at the given DMX resolution.
fn bench_parameter_metadata(
    attribute: Attribute,
    resolution: DmxValueResolution,
) -> ParameterMetadata {
    ParameterMetadata {
        dmx_slots: Default::default(),
        functions: Vec::new(),
        default_dmx: None,
        highlight_dmx: None,
        resolution,
        native_unit: attribute.native_unit(),
        value_polarity: attribute.value_polarity(),
        attribute,
        min: 0.0,
        max: 255.0,
        offset: ParameterValue::Absolute { value: 0.0 },
        is_inverted: false,
        is_snap: false,
        merge_type: MergeStrategy::LTP,
        use_grandmaster: false,
    }
}
