// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Structural regression tests for built-in fixture profiles.

use std::collections::HashSet;

use bevy_ecs::message::Messages;
use bevy_ecs::prelude::*;
use bevy_ecs::world::CommandQueue;
use nightfall_dmx::DmxValueResolution;
use nightfall_dmx::prelude::{Attribute, ParameterUnit, ParameterValue};
use nightfall_engine::prelude::{CommandEnvelope, CommandError, CommandId, UndoId};
use nightfall_fixture_model::prelude::PhysicalUnit;

use super::catalog::{
    BUILTIN_SOURCE_FORMAT, builtin_fixture_profiles, find_builtin_fixture_profile,
};
use super::commands::{
    FixtureLibraryCommand, LibraryFixtureInstance, deserialize_fixture_library_command,
};
use super::instantiate::{LibraryFixtureRequest, LibraryFixtureTemplate, create_library_fixtures};
use super::{create_fixture_from_library, moving_heads, normalize_fixture_profile, strobes};
use crate::prelude::{Fixture, FixtureDataProviderExt, Parameter};

/// Calculates the non-virtual DMX footprint of a built-in fixture profile.
fn footprint(fixture: &Fixture) -> u16 {
    fixture
        .elements
        .iter()
        .flat_map(|element| element.parameters.iter())
        .filter(|parameter| parameter.attribute != Attribute::VirtualIntensity)
        .map(|parameter| parameter.resolution.channel_width())
        .sum()
}

/// Verifies every generic pixel profile preserves its element count, footprint, and channel order.
#[test]
fn generic_pixel_profiles_preserve_structure_and_channel_order() {
    let rgbw_bar = create_fixture_from_library(1, "Generic", "12-segment RGBW Bar", "")
        .expect("generic RGBW bar should be available");
    assert_eq!(rgbw_bar.elements.len(), 12);
    assert_eq!(footprint(&rgbw_bar), 48);
    assert_eq!(rgbw_bar.elements[0].label, "Pixel 1");
    assert_eq!(rgbw_bar.elements[11].label, "Pixel 12");
    assert_eq!(
        rgbw_bar.elements[0]
            .parameters
            .iter()
            .map(|parameter| &parameter.attribute)
            .collect::<Vec<_>>(),
        vec![
            &Attribute::VirtualIntensity,
            &Attribute::Red,
            &Attribute::Green,
            &Attribute::Blue,
            &Attribute::White,
        ]
    );

    let rgb_tape = create_fixture_from_library(2, "Generic", "RGBPixelTape 180ch", "")
        .expect("generic 180-channel RGB tape should be available");
    assert_eq!(rgb_tape.elements.len(), 60);
    assert_eq!(footprint(&rgb_tape), 180);
    assert_eq!(rgb_tape.elements[0].label, "Pixel 1");
    assert_eq!(rgb_tape.elements[59].label, "Pixel 60");
    assert_eq!(
        rgb_tape.elements[0]
            .parameters
            .iter()
            .map(|parameter| &parameter.attribute)
            .collect::<Vec<_>>(),
        vec![
            &Attribute::VirtualIntensity,
            &Attribute::Red,
            &Attribute::Green,
            &Attribute::Blue,
        ]
    );

    let rgb_tape_40 = create_fixture_from_library(3, "Generic", "RGBPixelTape 120ch RGB", "")
        .expect("generic 120-channel RGB tape should be available");
    assert_eq!(rgb_tape_40.elements.len(), 40);
    assert_eq!(footprint(&rgb_tape_40), 120);
    assert_eq!(rgb_tape_40.elements[0].label, "Pixel 1");
    assert_eq!(rgb_tape_40.elements[39].label, "Pixel 40");
    assert_eq!(
        rgb_tape_40.elements[0]
            .parameters
            .iter()
            .map(|parameter| &parameter.attribute)
            .collect::<Vec<_>>(),
        vec![
            &Attribute::VirtualIntensity,
            &Attribute::Red,
            &Attribute::Green,
            &Attribute::Blue,
        ]
    );
}

/// Verifies the generic moving-head profile keeps its single-element ten-channel layout.
#[test]
fn generic_moving_head_preserves_structure_and_channel_order() {
    let fixture = create_fixture_from_library(1, "Generic", "Moving Head RGBW", "")
        .expect("generic moving head should be available");
    let parameters = &fixture.elements[0].parameters;

    assert_eq!(fixture.elements.len(), 1);
    assert_eq!(fixture.elements[0].label, "Head");
    assert_eq!(parameters.len(), 8);
    assert_eq!(footprint(&fixture), 10);
    assert_eq!(
        parameters
            .iter()
            .map(|parameter| &parameter.attribute)
            .collect::<Vec<_>>(),
        vec![
            &Attribute::Intensity,
            &Attribute::Pan,
            &Attribute::Tilt,
            &Attribute::Red,
            &Attribute::Green,
            &Attribute::Blue,
            &Attribute::White,
            &Attribute::Zoom,
        ]
    );
    assert_eq!(parameters[1].resolution, DmxValueResolution::Fine);
    assert_eq!(parameters[2].resolution, DmxValueResolution::Fine);
}

/// Verifies the GRB pixel tape profile has 40 elements and 120 non-virtual DMX channels.
#[test]
fn grb_pixel_tape_profile_matches_120_channel_order() {
    let fixture = create_fixture_from_library(1, "Generic", "RGBPixelTape 120ch GRB", "GRB")
        .expect("GRB pixel tape should be available");

    assert_eq!(fixture.elements.len(), 40);
    assert_eq!(footprint(&fixture), 120);
    assert_eq!(fixture.elements[0].label, "Pixel 1");
    assert_eq!(fixture.elements[39].label, "Pixel 40");
    assert_eq!(
        fixture.elements[0]
            .parameters
            .iter()
            .map(|parameter| &parameter.attribute)
            .collect::<Vec<_>>(),
        vec![
            &Attribute::VirtualIntensity,
            &Attribute::Green,
            &Attribute::Red,
            &Attribute::Blue,
        ]
    );
}

/// Verifies that the strobe matrix element order and non-virtual footprint match the fixture profile.
#[test]
fn strobe_matrix_profile_matches_308_channel_order() {
    let fixture = strobes::create_strobe(1, "Generic", "Strobe Matrix 308ch", 16);

    assert_eq!(fixture.elements.len(), 115);
    assert_eq!(footprint(&fixture), 308);
    assert_eq!(fixture.elements[0].label, "Tilt Axis");
    assert_eq!(fixture.elements[1].label, "Rotation Speed");
    assert_eq!(fixture.elements[2].label, "Reset");
    assert_eq!(fixture.elements[3].label, "Strobe Dimmer 1");
    assert_eq!(fixture.elements[18].label, "Strobe Dimmer 16");
    assert_eq!(fixture.elements[19].label, "RGB Pixel 1");
    assert_eq!(fixture.elements[114].label, "RGB Pixel 96");
    assert_eq!(
        fixture.elements[3]
            .parameters
            .iter()
            .map(|parameter| &parameter.attribute)
            .collect::<Vec<_>>(),
        vec![&Attribute::VirtualIntensity, &Attribute::White]
    );
}

/// Verifies the 312-channel variant inserts four white segments before the RGB pixels.
#[test]
fn strobe_matrix_profile_matches_312_channel_order() {
    let fixture = strobes::create_strobe(1, "Generic", "Strobe Matrix 312ch", 20);

    assert_eq!(fixture.elements.len(), 119);
    assert_eq!(footprint(&fixture), 312);
    assert_eq!(fixture.elements[0].label, "Tilt Axis");
    assert_eq!(fixture.elements[1].label, "Rotation Speed");
    assert_eq!(fixture.elements[2].label, "Reset");
    assert_eq!(fixture.elements[3].label, "Strobe Dimmer 1");
    assert_eq!(fixture.elements[22].label, "Strobe Dimmer 20");
    assert_eq!(fixture.elements[23].label, "RGB Pixel 1");
    assert_eq!(fixture.elements[118].label, "RGB Pixel 96");
}

/// Verifies the Generic RGB strobe bar preserves its segment layout and DMX footprint.
#[test]
fn rgb_strobe_bar_profile_matches_168_channel_footprint_and_element_order() {
    let fixture = strobes::create_rgb_strobe_bar_168(1, "Generic", "RGB Strobe Bar 168ch");

    assert_eq!(fixture.elements.len(), 72);
    assert_eq!(footprint(&fixture), 168);
    assert_eq!(fixture.elements[0].label, "White Segment 1");
    assert_eq!(fixture.elements[23].label, "White Segment 24");
    assert_eq!(
        fixture.elements[0]
            .parameters
            .iter()
            .map(|parameter| &parameter.attribute)
            .collect::<Vec<_>>(),
        vec![&Attribute::VirtualIntensity, &Attribute::White]
    );
    assert_eq!(fixture.elements[24].label, "Top RGB Segment 1");
    assert_eq!(fixture.elements[47].label, "Top RGB Segment 24");
    assert_eq!(fixture.elements[48].label, "Bottom RGB Segment 1");
    assert_eq!(fixture.elements[71].label, "Bottom RGB Segment 24");
}

/// Verifies the Generic wash beam preserves its control, beam, and strip layout.
#[test]
fn rotating_wash_beam_profile_matches_194_channel_footprint_and_element_order() {
    let fixture =
        moving_heads::create_rotating_wash_beam_194(1, "Generic", "12-segment Rotating Wash Beam");

    assert_eq!(fixture.elements.len(), 37);
    assert_eq!(footprint(&fixture), 194);
    assert_eq!(fixture.elements[0].label, "Control");
    assert_eq!(fixture.elements[1].label, "Beam 1");
    assert_eq!(fixture.elements[12].label, "Beam 12");
    assert_eq!(fixture.elements[13].label, "Top Strip Pixel 1");
    assert_eq!(fixture.elements[24].label, "Top Strip Pixel 12");
    assert_eq!(fixture.elements[25].label, "Bottom Strip Pixel 1");
    assert_eq!(fixture.elements[36].label, "Bottom Strip Pixel 12");
    assert_eq!(
        fixture.elements[13]
            .parameters
            .iter()
            .map(|parameter| &parameter.attribute)
            .collect::<Vec<_>>(),
        vec![
            &Attribute::VirtualIntensity,
            &Attribute::Red,
            &Attribute::Green,
            &Attribute::Blue,
            &Attribute::White,
            &Attribute::Yellow,
        ]
    );
}

/// Returns the evaluated physical zoom angle of a wash beam's control element at a logical value.
fn wash_zoom_degrees(fixture: &Fixture, value: f32) -> f32 {
    use nightfall_fixture_model::prelude::{FixtureEvaluator, FixtureModel};

    let control = &fixture.elements[0].parameters;
    let zoom = control
        .iter()
        .position(|parameter| parameter.attribute == Attribute::Zoom)
        .unwrap();
    let mut evaluator = FixtureEvaluator::new(FixtureModel::new([control.clone()], true));
    let mut inputs = vec![None; control.len()];
    inputs[zoom] = Some(value);
    evaluator.read(&inputs)[zoom].unwrap().physical
}

/// Verifies the built-in wash's zoom is an angular function evaluated by the shared fixture
/// evaluator: DMX 255 (fully zoomed in) is the narrowest 1° beam and DMX 0 the widest 34°.
#[test]
fn wash_beam_zoom_evaluates_from_widest_to_narrowest() {
    let fixture =
        moving_heads::create_rotating_wash_beam_194(1, "Generic", "12-segment Rotating Wash Beam");
    let physical = fixture.physical.clone().unwrap();
    assert_eq!((physical.beam_angle, physical.field_angle), (1.0, 1.2));
    assert_eq!(wash_zoom_degrees(&fixture, 255.0), 1.0);
    assert_eq!(wash_zoom_degrees(&fixture, 0.0), 34.0);
    let zoom = fixture.elements[0]
        .parameters
        .iter()
        .find(|parameter| parameter.attribute == Attribute::Zoom)
        .unwrap();
    assert_eq!(zoom.functions[0].physical_unit, PhysicalUnit::Angle);
    assert_eq!(zoom.native_unit, ParameterUnit::Percent);
}

/// Verifies normalization restores the wash's zoom function and physical optics on persisted
/// fixtures while keeping operator zoom settings such as inversion and offset.
#[test]
fn wash_beam_normalization_restores_zoom_optics_and_keeps_operator_settings() {
    let mut fixture =
        moving_heads::create_rotating_wash_beam_194(1, "Generic", "12-segment Rotating Wash Beam");
    let expected_physical = fixture.physical.clone();
    fixture.physical = None;
    let zoom = fixture.elements[0]
        .parameters
        .iter_mut()
        .find(|parameter| parameter.attribute == Attribute::Zoom)
        .unwrap();
    zoom.functions.clear();
    zoom.is_inverted = true;
    zoom.offset = ParameterValue::Absolute { value: 10.0 };

    normalize_fixture_profile(&mut fixture);

    assert_eq!(fixture.physical, expected_physical);
    let zoom = fixture.elements[0]
        .parameters
        .iter()
        .find(|parameter| parameter.attribute == Attribute::Zoom)
        .unwrap();
    assert_eq!(zoom.functions.len(), 1);
    assert!(zoom.is_inverted);
    assert_eq!(zoom.offset, ParameterValue::Absolute { value: 10.0 });
    // Inverted output sends DMX 0, the widest angle, for a fully zoomed-in logical value.
    assert_eq!(wash_zoom_degrees(&fixture, 255.0), 34.0);

    fixture.physical.as_mut().unwrap().beam_angle = 2.0;
    normalize_fixture_profile(&mut fixture);
    assert_eq!(fixture.physical.unwrap().beam_angle, 2.0);
}

/// Verifies a persisted linear wash bar without photometry or a zoom function normalizes to
/// the same optics as a newly created bar while keeping operator zoom inversion and offset.
#[test]
fn linear_wash_bar_normalization_matches_new_bar_and_keeps_operator_settings() {
    let created = moving_heads::create_linear_wash_bar(1, "Generic", "Linear Wash Bar");
    let mut stored = created.clone();
    stored.physical = None;
    let zoom = stored.elements[0]
        .parameters
        .iter_mut()
        .find(|parameter| parameter.attribute == Attribute::Zoom)
        .unwrap();
    zoom.functions.clear();
    zoom.is_inverted = true;
    zoom.offset = ParameterValue::Absolute { value: 10.0 };

    normalize_fixture_profile(&mut stored);

    assert_eq!(stored.physical, created.physical);
    let zoom = |fixture: &Fixture| {
        fixture.elements[0]
            .parameters
            .iter()
            .find(|parameter| parameter.attribute == Attribute::Zoom)
            .unwrap()
            .clone()
    };
    let (stored_zoom, created_zoom) = (zoom(&stored), zoom(&created));
    assert_eq!(stored_zoom.functions, created_zoom.functions);
    assert!(stored_zoom.is_inverted);
    assert_eq!(stored_zoom.offset, ParameterValue::Absolute { value: 10.0 });
    assert_eq!(wash_zoom_degrees(&created, 255.0), 1.0);
    assert_eq!(wash_zoom_degrees(&stored, 255.0), 34.0);
}

/// Verifies persisted wash-beam emitters gain one virtual intensity without duplicate insertion.
#[test]
fn wash_beam_normalization_restores_missing_virtual_intensity_once() {
    let mut fixture =
        moving_heads::create_rotating_wash_beam_194(1, "Generic", "12-segment Rotating Wash Beam");
    for element in fixture.elements.iter_mut().skip(1) {
        element
            .parameters
            .retain(|parameter| parameter.attribute != Attribute::VirtualIntensity);
    }

    normalize_fixture_profile(&mut fixture);
    normalize_fixture_profile(&mut fixture);

    for element in fixture.elements.iter().skip(1) {
        assert_eq!(
            element
                .parameters
                .iter()
                .filter(|parameter| parameter.attribute == Attribute::VirtualIntensity)
                .count(),
            1
        );
        assert_eq!(element.parameters[0].attribute, Attribute::VirtualIntensity);
    }
}

/// Verifies the Generic spot built-in matches its 16-channel hardware profile.
#[test]
fn moving_spot_profile_matches_16_channel_order() {
    let fixture = create_fixture_from_library(1, "Generic", "Moving Head Spot 16ch", "Spot")
        .expect("Generic moving spot should be available");
    let parameters = &fixture.elements[0].parameters;

    assert_eq!(fixture.elements.len(), 1);
    assert_eq!(fixture.elements[0].label, "Head");
    assert_eq!(parameters.len(), 14);
    assert_eq!(footprint(&fixture), 16);
    assert_eq!(
        parameters
            .iter()
            .map(|parameter| &parameter.attribute)
            .collect::<Vec<_>>(),
        vec![
            &Attribute::Pan,
            &Attribute::Tilt,
            &Attribute::Custom {
                label: "Pan/Tilt Speed".to_owned(),
            },
            &Attribute::Intensity,
            &Attribute::StrobeShutter,
            &Attribute::Custom {
                label: "Color Wheel".to_owned(),
            },
            &Attribute::Gobo,
            &Attribute::Prism,
            &Attribute::Frost,
            &Attribute::Focus,
            &Attribute::Custom {
                label: "Auto Run".to_owned(),
            },
            &Attribute::Custom {
                label: "Reset".to_owned(),
            },
            &Attribute::Custom {
                label: "Ring Color".to_owned(),
            },
            &Attribute::Custom {
                label: "Ring Speed".to_owned(),
            },
        ],
    );
    assert_eq!(parameters[0].resolution, DmxValueResolution::Fine);
    assert_eq!(parameters[1].resolution, DmxValueResolution::Fine);
    assert_eq!(parameters[0].native_unit, ParameterUnit::Degrees);
    assert_eq!(parameters[1].native_unit, ParameterUnit::Degrees);
    assert_eq!(parameters[3].native_unit, ParameterUnit::Percent);
    assert_eq!(parameters[0].max, 540.0);
    assert_eq!(parameters[1].max, 270.0);
}

/// Ensures tilt-capable Generic built-ins share the same declared tilt range.
#[test]
fn generic_tilt_fixtures_share_270_degree_tilt_range() {
    let spot = moving_heads::create_moving_spot_16ch(1, "Generic", "Moving Head Spot 16ch");
    let strobe = strobes::create_strobe(2, "Generic", "Strobe Matrix 308ch", 16);
    let wash =
        moving_heads::create_rotating_wash_beam_194(3, "Generic", "12-segment Rotating Wash Beam");

    let spot_tilt = spot.elements[0]
        .parameters
        .iter()
        .find(|parameter| parameter.attribute == Attribute::Tilt)
        .expect("spot should include tilt metadata");
    let strobe_tilt = strobe.elements[0]
        .parameters
        .iter()
        .find(|parameter| parameter.attribute == Attribute::Tilt)
        .expect("strobe should include tilt metadata");
    let wash_tilt = wash.elements[0]
        .parameters
        .iter()
        .find(|parameter| parameter.attribute == Attribute::Tilt)
        .expect("wash beam should include tilt metadata");

    assert_eq!(spot_tilt.max, 270.0);
    assert_eq!(strobe_tilt.max, 270.0);
    assert_eq!(wash_tilt.max, 270.0);
}

/// Verifies every catalog entry is unique and instantiates in its advertised mode.
#[test]
fn builtin_catalog_profiles_instantiate_in_their_advertised_mode() {
    let profiles = builtin_fixture_profiles();
    assert_eq!(profiles.len(), 12);
    let keys = profiles
        .iter()
        .map(|profile| (profile.make, profile.model))
        .collect::<HashSet<_>>();
    assert_eq!(keys.len(), profiles.len(), "catalog keys must be unique");

    for profile in profiles {
        let fixture = profile
            .create_fixture(7, profile.mode)
            .unwrap_or_else(|| panic!("{} should instantiate", profile.model));
        assert_eq!(fixture.identifiers.id, 7);
        assert_eq!(fixture.make, profile.make);
        assert_eq!(fixture.model, profile.model);
        assert_eq!(fixture.mode, profile.mode);
        assert!(
            !fixture.elements.is_empty(),
            "{} has no elements",
            profile.model
        );
        assert!(
            find_builtin_fixture_profile(profile.make, profile.model)
                .is_some_and(|found| std::ptr::eq(found, profile)),
            "{} should resolve to its own catalog entry",
            profile.model
        );
    }
}

/// Verifies a built-in profile refuses modes it never advertised.
#[test]
fn builtin_profile_rejects_unadvertised_mode() {
    let profile = find_builtin_fixture_profile("Generic", "Moving Head Spot 16ch")
        .expect("moving head spot should be cataloged");
    assert!(profile.create_fixture(1, "Not A Mode").is_none());
    assert!(find_builtin_fixture_profile("Generic", "Missing").is_none());
}

/// Verifies the transport summary labels built-ins and carries their version string.
#[test]
fn builtin_profile_info_reports_builtin_source() {
    let profile = find_builtin_fixture_profile("Generic", "Moving Head Spot 16ch")
        .expect("moving head spot should be cataloged");
    let info = profile.info();
    assert_eq!(info.source_format, BUILTIN_SOURCE_FORMAT);
    assert_eq!(info.modes, vec!["Spot".to_string()]);
    assert_eq!(info.asset_etag, "builtin:generic-moving-head-spot-16ch:v1");
}

/// Resolves the moving-head built-in as a library template for creation tests.
fn moving_head_template() -> Result<LibraryFixtureTemplate, CommandError> {
    let profile = find_builtin_fixture_profile("Generic", "Moving Head Spot 16ch")
        .expect("moving head spot should be cataloged");
    Ok(LibraryFixtureTemplate {
        fixture: profile
            .create_fixture(0, profile.mode)
            .expect("moving head spot should instantiate"),
        asset_etag: profile.asset_etag.to_string(),
    })
}

/// Runs one library fixture creation against a standalone store and applies its spawns.
///
/// Returns the error, if any, and how many times the template was resolved.
fn create_in_world(
    world: &mut World,
    fixtures: &mut FixtureDataProviderExt,
    request: &LibraryFixtureRequest<'_>,
) -> (Result<(), CommandError>, usize) {
    let mut queue = CommandQueue::default();
    let mut resolutions = 0;
    let result = {
        let mut commands = Commands::new(&mut queue, world);
        create_library_fixtures(&mut commands, fixtures, request, || {
            resolutions += 1;
            moving_head_template()
        })
    };
    queue.apply(world);
    (result, resolutions)
}

/// Builds a creation request for the given IDs, labelling each one after its ID.
fn batch_request(ids: &[u32]) -> LibraryFixtureRequest<'static> {
    LibraryFixtureRequest {
        instances: ids
            .iter()
            .map(|id| LibraryFixtureInstance {
                id: *id,
                label: Some(format!("Spot {id}")),
            })
            .collect(),
        update_existing_ids: &[],
    }
}

/// Verifies creation stores the labelled fixture and spawns one parameter per metadata entry.
#[test]
fn create_library_fixture_stores_fixture_and_spawns_parameters() {
    let mut world = World::new();
    let mut fixtures = FixtureDataProviderExt::default();
    create_in_world(
        &mut world,
        &mut fixtures,
        &LibraryFixtureRequest::single(42, Some("Spot A"), &[], false),
    )
    .0
    .expect("creation should succeed");

    let stored = fixtures
        .inner
        .from_id(42)
        .expect("fixture should be stored")
        .clone();
    assert_eq!(stored.identifiers.label, "Spot A");
    assert_eq!(
        stored.library_asset_etag.as_deref(),
        Some("builtin:generic-moving-head-spot-16ch:v1")
    );
    let expected = stored
        .elements
        .iter()
        .map(|element| element.parameters.len())
        .sum::<usize>();
    let parameters = fixtures.parameter_entities_for_fixture(stored.identifiers.uid);
    assert_eq!(parameters.len(), expected);
    assert!(
        parameters
            .iter()
            .all(|parameter| world.get::<Parameter>(parameter.entity()).is_some()),
        "every indexed parameter should exist as a spawned entity"
    );
}

/// Verifies a fixture ID collision fails without mutating stored state.
#[test]
fn create_library_fixture_rejects_used_id() {
    let mut world = World::new();
    let mut fixtures = FixtureDataProviderExt::default();
    let request = LibraryFixtureRequest::single(5, None, &[], false);
    create_in_world(&mut world, &mut fixtures, &request)
        .0
        .expect("first creation should succeed");

    let error = create_in_world(&mut world, &mut fixtures, &request)
        .0
        .expect_err("duplicate ID should be rejected");
    assert_eq!(error.code, "fixture_library.fixture_id_in_use");
    assert_eq!(fixtures.inner.iter().count(), 1);
}

/// Verifies a batch resolves its template once and stores every instance with its own
/// ID, UID, label and parameter entities.
#[test]
fn create_library_fixtures_stores_every_instance_from_one_template() {
    let mut world = World::new();
    let mut fixtures = FixtureDataProviderExt::default();
    let (result, resolutions) =
        create_in_world(&mut world, &mut fixtures, &batch_request(&[10, 11, 12]));
    result.expect("batch creation should succeed");

    assert_eq!(resolutions, 1);
    let stored = [10, 11, 12].map(|id| {
        fixtures
            .inner
            .from_id(id)
            .expect("batch instance should be stored")
            .clone()
    });
    let uids = stored
        .iter()
        .map(|fixture| fixture.identifiers.uid)
        .collect::<HashSet<_>>();
    assert_eq!(uids.len(), 3);
    for fixture in &stored {
        assert_eq!(
            fixture.identifiers.label,
            format!("Spot {}", fixture.identifiers.id)
        );
        let expected = fixture
            .elements
            .iter()
            .map(|element| element.parameters.len())
            .sum::<usize>();
        assert_eq!(
            fixtures
                .parameter_entities_for_fixture(fixture.identifiers.uid)
                .len(),
            expected
        );
    }
}

/// Verifies a batch containing one occupied ID stores none of its instances and never
/// resolves the template.
#[test]
fn create_library_fixtures_with_used_id_is_atomic() {
    let mut world = World::new();
    let mut fixtures = FixtureDataProviderExt::default();
    create_in_world(&mut world, &mut fixtures, &batch_request(&[11]))
        .0
        .expect("first creation should succeed");

    let (result, resolutions) =
        create_in_world(&mut world, &mut fixtures, &batch_request(&[10, 11]));

    assert_eq!(
        result.expect_err("occupied ID should be rejected").code,
        "fixture_library.fixture_id_in_use"
    );
    assert_eq!(resolutions, 0);
    assert!(fixtures.inner.from_id(10).is_err());
}

/// Verifies repeated IDs within one batch are rejected before anything is stored.
#[test]
fn create_library_fixtures_rejects_repeated_ids() {
    let mut world = World::new();
    let mut fixtures = FixtureDataProviderExt::default();
    let (result, _) = create_in_world(&mut world, &mut fixtures, &batch_request(&[10, 10]));

    assert_eq!(
        result.expect_err("repeated ID should be rejected").code,
        "fixture_library.duplicate_fixture_id"
    );
    assert_eq!(fixtures.inner.iter().count(), 0);
}

/// Verifies an empty batch is rejected rather than reported as a no-op success.
#[test]
fn create_library_fixtures_rejects_empty_request() {
    let mut world = World::new();
    let mut fixtures = FixtureDataProviderExt::default();
    let (result, resolutions) = create_in_world(&mut world, &mut fixtures, &batch_request(&[]));

    assert_eq!(
        result.expect_err("empty request should be rejected").code,
        "fixture_library.no_fixtures"
    );
    assert_eq!(resolutions, 0);
}

/// Verifies semantic deserialization preserves command and undo identities.
#[test]
fn deserialize_fixture_library_command_writes_semantic_envelope() {
    let mut world = World::new();
    world.insert_resource(Messages::<CommandEnvelope<FixtureLibraryCommand>>::default());
    let command_id = CommandId::new();
    let undo_id = UndoId::new();
    deserialize_fixture_library_command(
        &mut world,
        serde_json::json!({ "type": "RefreshLibrary" }),
        command_id,
        undo_id,
    )
    .expect("fixture-library command should deserialize");

    let messages = world
        .resource_mut::<Messages<CommandEnvelope<FixtureLibraryCommand>>>()
        .drain()
        .collect::<Vec<_>>();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].command_id, command_id);
    assert_eq!(messages[0].undo_id, undo_id);
    assert!(matches!(
        messages[0].command,
        FixtureLibraryCommand::RefreshLibrary
    ));
}
