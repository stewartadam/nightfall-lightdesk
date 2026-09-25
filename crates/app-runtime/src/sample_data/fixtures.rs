// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall_scene_objects::prelude::{
    SceneObject, SceneObjectDataProvider, SceneObjectPlacement, StageElementProperties,
};

use super::*;

/// Fixture IDs for each tier, ordered from the audience's right edge to left edge.
pub(super) const PIXEL_ROWS: [[u32; 8]; 4] = [
    [323, 322, 321, 320, 310, 311, 312, 313],
    [343, 342, 341, 340, 330, 331, 332, 333],
    [363, 362, 361, 360, 350, 351, 352, 353],
    [383, 382, 381, 380, 370, 371, 372, 373],
];

/// Curated default-show rig: ID, built-in model, mode, position in meters, rotation in degrees.
/// Profiles come from the compiled registry; this table contains no local assets or transport settings.
#[rustfmt::skip]
const FIXTURE_LAYOUT: &[(u32, &str, &str, [f32; 3], [f32; 3])] = &[
    (310, "RGBPixelTape 120ch RGB", "RGB", [-1.0, 0.05, -4.0], [-90.0, 0.0, 180.0]),
    (311, "RGBPixelTape 120ch RGB", "RGB", [-2.5, 0.05, -4.0], [-90.0, 0.0, 180.0]),
    (312, "RGBPixelTape 120ch RGB", "RGB", [-3.5, 0.05, -3.5], [-90.0, -45.0, 180.0]),
    (313, "RGBPixelTape 120ch RGB", "RGB", [-4.0, 0.05, -2.5], [-90.0, -90.0, 180.0]),
    (320, "RGBPixelTape 120ch RGB", "RGB", [1.0, 0.05, -4.0], [-90.0, 0.0, 0.0]),
    (321, "RGBPixelTape 120ch RGB", "RGB", [2.5, 0.05, -4.0], [-90.0, 0.0, 0.0]),
    (322, "RGBPixelTape 120ch RGB", "RGB", [3.5, 0.05, -3.5], [-90.0, -45.0, 0.0]),
    (323, "RGBPixelTape 120ch RGB", "RGB", [4.0, 0.05, -2.5], [-90.0, -90.0, 0.0]),
    (330, "RGBPixelTape 120ch RGB", "RGB", [-1.0, 0.5, -4.0], [-90.0, 0.0, 180.0]),
    (331, "RGBPixelTape 120ch RGB", "RGB", [-2.5, 0.5, -4.0], [-90.0, 0.0, 180.0]),
    (332, "RGBPixelTape 120ch RGB", "RGB", [-3.5, 0.5, -3.5], [-90.0, -45.0, 180.0]),
    (333, "RGBPixelTape 120ch RGB", "RGB", [-4.0, 0.5, -2.5], [-90.0, -90.0, 180.0]),
    (340, "RGBPixelTape 120ch RGB", "RGB", [1.0, 0.5, -4.0], [-90.0, 0.0, 0.0]),
    (341, "RGBPixelTape 120ch RGB", "RGB", [2.5, 0.5, -4.0], [-90.0, 0.0, 0.0]),
    (342, "RGBPixelTape 120ch RGB", "RGB", [3.5, 0.5, -3.5], [-90.0, -45.0, 0.0]),
    (343, "RGBPixelTape 120ch RGB", "RGB", [4.0, 0.5, -2.5], [-90.0, -90.0, 0.0]),
    (350, "RGBPixelTape 120ch RGB", "RGB", [-1.0, 1.0, -4.0], [-90.0, 0.0, 180.0]),
    (351, "RGBPixelTape 120ch RGB", "RGB", [-2.5, 1.0, -4.0], [-90.0, 0.0, 180.0]),
    (352, "RGBPixelTape 120ch RGB", "RGB", [-3.5, 1.0, -3.5], [-90.0, -45.0, 180.0]),
    (353, "RGBPixelTape 120ch RGB", "RGB", [-4.0, 1.0, -2.5], [-90.0, -90.0, 180.0]),
    (360, "RGBPixelTape 120ch RGB", "RGB", [1.0, 1.0, -4.0], [-90.0, 0.0, 0.0]),
    (361, "RGBPixelTape 120ch RGB", "RGB", [2.5, 1.0, -4.0], [-90.0, 0.0, 0.0]),
    (362, "RGBPixelTape 120ch RGB", "RGB", [3.5, 1.0, -3.5], [-90.0, -45.0, 0.0]),
    (363, "RGBPixelTape 120ch RGB", "RGB", [4.0, 1.0, -2.5], [-90.0, -90.0, 0.0]),
    (370, "RGBPixelTape 120ch RGB", "RGB", [-1.0, 1.5, -4.0], [-90.0, 0.0, 180.0]),
    (371, "RGBPixelTape 120ch RGB", "RGB", [-2.5, 1.5, -4.0], [-90.0, 0.0, 180.0]),
    (372, "RGBPixelTape 120ch RGB", "RGB", [-3.5, 1.5, -3.5], [-90.0, -45.0, 180.0]),
    (373, "RGBPixelTape 120ch RGB", "RGB", [-4.0, 1.5, -2.5], [-90.0, -90.0, 180.0]),
    (380, "RGBPixelTape 120ch RGB", "RGB", [1.0, 1.5, -4.0], [-90.0, 0.0, 0.0]),
    (381, "RGBPixelTape 120ch RGB", "RGB", [2.5, 1.5, -4.0], [-90.0, 0.0, 0.0]),
    (382, "RGBPixelTape 120ch RGB", "RGB", [3.5, 1.5, -3.5], [-90.0, -45.0, 0.0]),
    (383, "RGBPixelTape 120ch RGB", "RGB", [4.0, 1.5, -2.5], [-90.0, -90.0, 0.0]),
    (501, "Moving Head Spot 16ch", "Spot", [-3.0948555, 0.05, 0.0], [180.0, 0.0, 0.0]),
    (502, "Moving Head Spot 16ch", "Spot", [-1.7730371, 0.05, 0.0], [180.0, 0.0, 0.0]),
    (503, "Moving Head Spot 16ch", "Spot", [-0.45121926, 0.05, 0.0], [180.0, 0.0, 0.0]),
    (504, "Moving Head Spot 16ch", "Spot", [0.8705991, 0.05, 0.0], [180.0, 0.0, 0.0]),
    (505, "Moving Head Spot 16ch", "Spot", [2.1924174, 0.05, 0.0], [180.0, 0.0, 0.0]),
    (506, "Moving Head Spot 16ch", "Spot", [3.5142357, 0.05, 0.0], [180.0, 0.0, 0.0]),
    (601, "Strobe Matrix 308ch", "Strobe", [-3.0, 0.05, -2.0], [180.0, 180.0, 0.0]),
    (602, "Strobe Matrix 312ch", "Strobe", [-2.5, 0.05, -0.5], [180.0, 180.0, 0.0]),
    (603, "Strobe Matrix 312ch", "Strobe", [-1.0, 0.05, -0.33642617], [180.0, 180.0, 0.0]),
    (604, "Strobe Matrix 312ch", "Strobe", [1.0, 0.05, -0.4071127], [180.0, 180.0, 0.0]),
    (605, "Strobe Matrix 312ch", "Strobe", [2.5, 0.05, -0.5], [180.0, 180.0, 0.0]),
    (606, "Strobe Matrix 308ch", "Strobe", [3.0, 0.05, -2.0], [180.0, 180.0, 0.0]),
    (1004, "RGB Strobe Bar 168ch", "Strobe", [-2.5, 0.75, -4.0], [0.0, 0.0, 180.0]),
    (1005, "RGB Strobe Bar 168ch", "Strobe", [-3.5, 0.75, -3.5], [0.0, -45.0, 180.0]),
    (1006, "RGB Strobe Bar 168ch", "Strobe", [-4.0, 0.75, -2.5], [0.0, -90.0, 180.0]),
    (1007, "RGB Strobe Bar 168ch", "Strobe", [2.5, 0.75, -4.0], [0.0, 0.0, 0.0]),
    (1008, "RGB Strobe Bar 168ch", "Strobe", [3.5, 0.75, -3.5], [0.0, -45.0, 0.0]),
    (1009, "RGB Strobe Bar 168ch", "Strobe", [4.0, 0.75, -2.5], [0.0, -90.0, 0.0]),
    (1010, "12-segment Rotating Wash Beam", "Beam", [-2.25, 0.25, -2.5], [0.0, 90.0, 0.0]),
    (1011, "12-segment Rotating Wash Beam", "Beam", [-2.0, 0.25, -1.35], [0.0, 130.0, 0.0]),
    (1012, "12-segment Rotating Wash Beam", "Beam", [-0.75, 0.25, -0.8], [0.0, 170.0, 0.0]),
    (1013, "12-segment Rotating Wash Beam", "Beam", [0.75, 0.25, -0.8], [0.0, 190.0, 0.0]),
    (1014, "12-segment Rotating Wash Beam", "Beam", [2.0, 0.25, -1.35], [0.0, 230.0, 0.0]),
    (1015, "12-segment Rotating Wash Beam", "Beam", [2.25, 0.25, -2.5], [0.0, -90.0, 0.0]),
];

/// Seed the default-show arrangement from built-in profiles with disabled output bindings.
pub(super) fn add_fixtures(world: &mut World) {
    for &(id, model, mode, [x, y, z], [rx, ry, rz]) in FIXTURE_LAYOUT {
        let mut fixture =
            nightfall_fixtures::library::create_fixture_from_library(id, "Generic", model, mode)
                .expect("sample rig must use a compiled-in fixture profile");
        fixture.mode = mode.to_owned();
        fixture.placement = FixturePlacement {
            position: PlacementPosition { x, y, z },
            rotation: PlacementRotation {
                x: rx,
                y: ry,
                z: rz,
            },
        };
        add_fixture(world, fixture);
    }

    let mut objects = world.resource_mut::<SceneObjectDataProvider>();
    for (id, x) in [(1, 0.0), (2, -1.0), (3, 1.0)] {
        let mut stage = SceneObject::new_stage_element(
            id,
            format!("Stage Block {id}"),
            StageElementProperties::default(),
        );
        stage.placement = SceneObjectPlacement::at_position(x, 0.0, -2.0);
        objects.add(stage).expect("sample stage IDs must be unique");
    }
}

/// Persist an embedded profile and initialize its runtime parameters with output disabled.
fn add_fixture(world: &mut World, fixture: Fixture) {
    for (element_idx, element) in fixture.elements.iter().enumerate() {
        let element_ref = FixtureRef {
            index: Some(element_idx as u32 + 1),
            fixture_uid: fixture.identifiers.uid,
        };

        element.parameters.iter().for_each(|parameter_metadata| {
            let mut commands: Commands<'_, '_> = world.commands();

            // VirtualIntensity defaults to 100% (255) so fixtures are visible when patched
            let values = if parameter_metadata.attribute == Attribute::VirtualIntensity {
                ParameterValues {
                    default_value: 255.0,
                    current_value: 255.0,
                    highlight_value: 255.0,
                }
            } else {
                ParameterValues::default()
            };

            let parameter_cmds = commands.spawn_instance(Parameter {
                metadata: parameter_metadata.clone(),
                values,
            });
            let parameter_entity = parameter_cmds.instance();

            let mut system_state: SystemState<(ResMut<FixtureDataProviderExt>,)> =
                SystemState::new(world);
            let (fixture_data_provider,) = system_state
                .get_mut(world)
                .expect("sample data system parameters should be available");

            fixture_data_provider.add_parameter(
                element_ref.clone(),
                parameter_metadata.attribute.clone(),
                parameter_entity,
            );
        });
    }

    {
        let mut system_state: SystemState<(ResMut<FixtureDataProviderExt>,)> =
            SystemState::new(world);
        let (mut fixture_data_provider,) = system_state
            .get_mut(world)
            .expect("sample data system parameters should be available");

        // Embedded profiles and physical metadata work without installed geometry assets.
        fixture_data_provider
            .inner
            .add(fixture.clone())
            .expect("sample fixture IDs must be unique");
    }
    world
        .resource_mut::<DisabledBindings>()
        .bindings
        .push(DisabledBinding::Output {
            source: OutputSource::Fixture {
                uids: vec![fixture.identifiers.uid],
                element: None,
                param: None,
            },
            priority: 0,
            clone: false,
        });
}
