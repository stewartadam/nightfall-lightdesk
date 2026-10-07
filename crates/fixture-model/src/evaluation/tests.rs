// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use nightfall_dmx::prelude::*;

use super::*;
use crate::parameter::{
    DmxSlots, FunctionRelation, MergeStrategy, ModeMasterCondition, ParameterFunction,
    ParameterFunctionSet, ProfilePoint,
};

/// Builds 8-bit metadata for `attribute` with `functions`, at `dmx_slots`.
fn parameter(
    attribute: Attribute,
    functions: Vec<ParameterFunction>,
    dmx_slots: DmxSlots,
) -> ParameterMetadata {
    ParameterMetadata {
        dmx_slots,
        functions,
        value_polarity: attribute.value_polarity(),
        attribute,
        max: 255.0,
        merge_type: MergeStrategy::LTP,
        ..Default::default()
    }
}

/// Builds a function over a DMX range with a 0-1 physical scale.
fn function(name: &str, dmx_from: u32, dmx_to: u32) -> ParameterFunction {
    ParameterFunction {
        name: name.to_string(),
        attribute: name.to_string(),
        dmx_from,
        dmx_to,
        physical_to: 1.0,
        ..Default::default()
    }
}

/// Returns `function` following `attribute` of `element` with `kind`.
fn following(
    mut function: ParameterFunction,
    element: u32,
    attribute: Attribute,
    kind: RelationKind,
) -> ParameterFunction {
    function.relations.push(FunctionRelation {
        master: ElementParameterRef { element, attribute },
        kind,
    });
    function
}

/// Returns `function` active only while `attribute` of `element` is in a DMX range.
fn under_mode(
    mut function: ParameterFunction,
    element: u32,
    attribute: Attribute,
    dmx_from: u32,
    dmx_to: u32,
) -> ParameterFunction {
    function.mode_master = Some(ModeMasterCondition {
        master: ElementParameterRef { element, attribute },
        dmx_from,
        dmx_to,
    });
    function
}

/// Slots of a real one-byte channel.
fn real() -> DmxSlots {
    DmxSlots::Explicit {
        dmx_break: 1,
        offsets: vec![1],
    }
}

/// The attribute of the mode-selecting control channel.
fn control() -> Attribute {
    Attribute::Custom {
        label: "Control".to_string(),
    }
}

/// A body dimmer at `slots` and a red pixel following it with `kind`.
fn pixel_bar(slots: DmxSlots, kind: RelationKind) -> FixtureModel {
    FixtureModel::new(
        [
            vec![parameter(
                Attribute::Intensity,
                vec![function("Dimmer", 0, 255)],
                slots,
            )],
            vec![parameter(
                Attribute::Red,
                vec![following(
                    function("ColorAdd_R", 0, 255),
                    0,
                    Attribute::Intensity,
                    kind,
                )],
                real(),
            )],
        ],
        true,
    )
}

/// Asserts a value lies within 0.01 of the expected value.
fn near(actual: Option<f32>, expected: f32, message: &str) {
    let actual = actual.unwrap_or_else(|| panic!("{message}: no value"));
    assert!(
        (actual - expected).abs() < 0.01,
        "{message}: expected {expected}, got {actual}"
    );
}

/// Returns the value of `index` after the console's relations.
fn console(model: FixtureModel, inputs: &[f32], index: usize) -> Option<f32> {
    let inputs: Vec<Option<f32>> = inputs.iter().copied().map(Some).collect();
    FixtureEvaluator::new(model).resolve(RelationScope::Console, &inputs)[index]
}

/// Returns the fixture's readings for `inputs`.
fn read(model: FixtureModel, inputs: &[Option<f32>]) -> Vec<Option<ChannelReading>> {
    FixtureEvaluator::new(model).read(inputs).to_vec()
}

/// Verifies the console scales and replaces followers of virtual masters.
#[test]
fn console_applies_virtual_masters() {
    let multiply = || pixel_bar(DmxSlots::Virtual, RelationKind::Multiply);
    near(
        console(multiply(), &[127.5, 255.0], 1),
        127.5,
        "half dimmer",
    );
    near(console(multiply(), &[0.0, 255.0], 1), 0.0, "dimmer at zero");
    near(
        console(
            pixel_bar(DmxSlots::Virtual, RelationKind::Override),
            &[51.0, 255.0],
            1,
        ),
        51.0,
        "override",
    );
}

/// Verifies the console leaves relations between real channels to the fixture.
#[test]
fn console_leaves_real_masters_to_the_fixture() {
    let model = pixel_bar(real(), RelationKind::Multiply);
    assert!(!model.has_relations(RelationScope::Console));
    near(
        console(model, &[0.0, 255.0], 1),
        255.0,
        "unchanged follower",
    );
}

/// Verifies a real master of a virtual follower is the console's: the
/// fixture never sees the virtual follower.
#[test]
fn console_applies_real_masters_of_virtual_followers() {
    let model = FixtureModel::new(
        [
            vec![parameter(Attribute::Intensity, Vec::new(), real())],
            vec![
                parameter(
                    Attribute::Intensity,
                    vec![following(
                        function("Dimmer", 0, 255),
                        0,
                        Attribute::Intensity,
                        RelationKind::Multiply,
                    )],
                    DmxSlots::Virtual,
                ),
                parameter(
                    Attribute::Red,
                    vec![following(
                        function("R", 0, 255),
                        1,
                        Attribute::Intensity,
                        RelationKind::Multiply,
                    )],
                    real(),
                ),
            ],
        ],
        true,
    );
    near(
        console(model, &[127.5, 255.0, 255.0], 2),
        127.5,
        "red × pixel × body",
    );
}

/// Verifies chains of virtual masters compose.
#[test]
fn console_composes_virtual_chains() {
    let dimmer = |follows: Option<u32>| {
        let function = function("Dimmer", 0, 255);
        let function = match follows {
            Some(element) => following(
                function,
                element,
                Attribute::Intensity,
                RelationKind::Multiply,
            ),
            None => function,
        };
        vec![parameter(
            Attribute::Intensity,
            vec![function],
            DmxSlots::Virtual,
        )]
    };
    let model = FixtureModel::new(
        [
            dimmer(None),
            dimmer(Some(0)),
            vec![parameter(
                Attribute::Red,
                vec![following(
                    function("R", 0, 255),
                    1,
                    Attribute::Intensity,
                    RelationKind::Multiply,
                )],
                real(),
            )],
        ],
        true,
    );
    near(
        console(model, &[127.5, 127.5, 255.0], 2),
        63.75,
        "red × pixel × group",
    );
}

/// Builds a fixture whose red follows a virtual dimmer only in the mode
/// selected while the control channel is below 128.
fn moded_red(control_slots: DmxSlots, control_follows_group: bool) -> FixtureModel {
    let control_functions = if control_follows_group {
        vec![following(
            function("Control", 0, 255),
            2,
            Attribute::Intensity,
            RelationKind::Multiply,
        )]
    } else {
        Vec::new()
    };
    FixtureModel::new(
        [
            vec![parameter(control(), control_functions, control_slots)],
            vec![parameter(
                Attribute::Intensity,
                Vec::new(),
                DmxSlots::Virtual,
            )],
            vec![parameter(
                Attribute::Intensity,
                Vec::new(),
                DmxSlots::Virtual,
            )],
            vec![parameter(
                Attribute::Red,
                vec![
                    under_mode(
                        following(
                            function("ColorAdd_R", 0, 255),
                            1,
                            Attribute::Intensity,
                            RelationKind::Multiply,
                        ),
                        0,
                        control(),
                        0,
                        127,
                    ),
                    under_mode(function("ColorAdd_R", 0, 255), 0, control(), 128, 255),
                ],
                real(),
            )],
        ],
        true,
    )
}

/// Verifies relations only apply through the function the mode master selects.
#[test]
fn relations_follow_the_mode_master_selected_function() {
    near(
        console(moded_red(real(), false), &[10.0, 0.0, 255.0, 255.0], 3),
        0.0,
        "dimmed in the related mode",
    );
    near(
        console(moded_red(real(), false), &[200.0, 0.0, 255.0, 255.0], 3),
        255.0,
        "unrelated mode is not dimmed",
    );
}

/// Verifies a channel whose functions are all inactive, because its only
/// function's mode master condition fails, has no output level.
#[test]
fn channels_without_an_active_function_have_no_level() {
    let model = || {
        FixtureModel::new(
            [
                vec![parameter(control(), Vec::new(), real())],
                vec![parameter(
                    Attribute::Red,
                    vec![under_mode(
                        function("ColorAdd_R", 0, 255),
                        0,
                        control(),
                        0,
                        127,
                    )],
                    real(),
                )],
            ],
            true,
        )
    };
    let red = |control: f32| read(model(), &[Some(control), Some(255.0)])[1].unwrap();
    near(Some(red(10.0).level), 1.0, "active function");
    let inactive = red(200.0);
    assert_eq!(inactive.function, None);
    assert_eq!(inactive.level, 0.0, "no function active");
}

/// Verifies a mode master is read after the relations it follows: a virtual
/// control scaled to zero selects the related mode although its own value
/// selects the other one.
#[test]
fn mode_masters_are_read_after_their_own_relations() {
    let model = || moded_red(DmxSlots::Virtual, true);
    near(
        console(model(), &[200.0, 0.0, 255.0, 255.0], 3),
        255.0,
        "the control keeps the unrelated mode",
    );
    near(
        console(model(), &[200.0, 0.0, 0.0, 255.0], 3),
        0.0,
        "the scaled control selects the related mode",
    );
}

/// Verifies a mode master in another element selects between overlapping
/// functions, and that a mode master without a value does not block its function.
#[test]
fn mode_masters_select_overlapping_functions() {
    let model = || {
        FixtureModel::new(
            [
                vec![parameter(control(), Vec::new(), real())],
                vec![parameter(
                    Attribute::StrobeShutter,
                    vec![
                        under_mode(function("Shutter1", 0, 255), 0, control(), 0, 127),
                        under_mode(function("Shutter1Strobe", 0, 255), 0, control(), 128, 255),
                    ],
                    real(),
                )],
            ],
            true,
        )
    };
    let shutter =
        |control: Option<f32>| read(model(), &[control, Some(200.0)])[1].unwrap().function;
    assert_eq!(shutter(Some(10.0)), Some(0));
    assert_eq!(shutter(Some(200.0)), Some(1));
    assert_eq!(shutter(None), Some(0), "a master without output holds");
}

/// Verifies the fixture scales or replaces follower levels by real masters.
#[test]
fn fixture_applies_real_masters() {
    let red = |kind, dimmer, red| {
        read(pixel_bar(real(), kind), &[Some(dimmer), Some(red)])[1].map(|reading| reading.level)
    };
    near(red(RelationKind::Multiply, 127.5, 255.0), 0.5, "multiply");
    near(red(RelationKind::Override, 127.5, 255.0), 0.5, "override");
    near(
        red(RelationKind::Override, 51.0, 0.0),
        0.2,
        "override ignores the follower",
    );
}

/// Verifies the fixture leaves relations with virtual masters, which the
/// console already applied, alone.
#[test]
fn fixture_leaves_virtual_masters_to_the_console() {
    let readings = read(
        pixel_bar(DmxSlots::Virtual, RelationKind::Multiply),
        &[Some(0.0), Some(255.0)],
    );
    near(
        readings[1].map(|reading| reading.level),
        1.0,
        "console-scaled follower",
    );
}

/// Verifies relation levels resolve through chains of real masters.
#[test]
fn fixture_composes_real_chains() {
    let dimmer = |follows: Option<u32>| {
        let function = function("D", 0, 255);
        let function = match follows {
            Some(element) => following(
                function,
                element,
                Attribute::Intensity,
                RelationKind::Multiply,
            ),
            None => function,
        };
        vec![parameter(Attribute::Intensity, vec![function], real())]
    };
    let model = FixtureModel::new(
        [
            dimmer(None),
            dimmer(Some(0)),
            vec![parameter(
                Attribute::Red,
                vec![following(
                    function("R", 0, 255),
                    1,
                    Attribute::Intensity,
                    RelationKind::Multiply,
                )],
                real(),
            )],
        ],
        true,
    );
    let readings = read(model, &[Some(127.5), Some(127.5), Some(255.0)]);
    near(
        readings[2].map(|reading| reading.level),
        0.25,
        "red × cell × group",
    );
}

/// Verifies a dimmer masters its own emitters only through the emitter's
/// active function, and that unlinked real dimmers master the fixture.
#[test]
fn dimmers_master_own_emitters_through_active_functions() {
    let model = || {
        FixtureModel::new(
            [
                vec![parameter(control(), Vec::new(), real())],
                vec![
                    parameter(
                        Attribute::Intensity,
                        vec![function("Dimmer", 0, 255)],
                        real(),
                    ),
                    parameter(
                        Attribute::Red,
                        vec![
                            under_mode(
                                following(
                                    function("ColorAdd_R", 0, 255),
                                    1,
                                    Attribute::Intensity,
                                    RelationKind::Multiply,
                                ),
                                0,
                                control(),
                                0,
                                127,
                            ),
                            under_mode(function("ColorAdd_R", 0, 255), 0, control(), 128, 255),
                        ],
                        real(),
                    ),
                ],
            ],
            true,
        )
    };
    let head = |control: f32| read(model(), &[Some(control), Some(51.0), Some(255.0)]);
    let related = head(10.0);
    assert!(related[1].unwrap().masters_own_emitters);
    near(
        related[2].map(|reading| reading.level),
        0.2,
        "red through the relation",
    );
    let unrelated = head(200.0);
    assert!(!unrelated[1].unwrap().masters_own_emitters);
    near(
        unrelated[2].map(|reading| reading.level),
        1.0,
        "red on its own",
    );
}

/// Verifies which dimmers master the whole fixture: real dimmers no relation
/// names, including ones that only follow a virtual master.
#[test]
fn unlinked_real_dimmers_master_the_fixture() {
    let body = vec![
        parameter(
            Attribute::VirtualIntensity,
            vec![function("Master", 0, 255)],
            DmxSlots::Virtual,
        ),
        parameter(
            Attribute::Intensity,
            vec![following(
                function("Dimmer", 0, 255),
                0,
                Attribute::VirtualIntensity,
                RelationKind::Multiply,
            )],
            real(),
        ),
    ];
    let pixel = vec![parameter(Attribute::Red, Vec::new(), real())];
    let mut evaluator = FixtureEvaluator::new(FixtureModel::new([body, pixel], true));
    evaluator.read(&[Some(255.0), Some(51.0), Some(255.0)]);
    near(evaluator.fixture_dimmer_level(), 0.2, "body dimmer");

    let virtual_only = FixtureModel::new(
        [
            vec![parameter(
                Attribute::Intensity,
                Vec::new(),
                DmxSlots::Virtual,
            )],
            vec![parameter(Attribute::Red, Vec::new(), real())],
        ],
        true,
    );
    let mut evaluator = FixtureEvaluator::new(virtual_only);
    evaluator.read(&[Some(0.0), Some(255.0)]);
    assert_eq!(evaluator.fixture_dimmer_level(), None);
}

/// Verifies DMX profiles shape a function's position and sets override its physical range.
#[test]
fn profiles_and_sets_map_dmx_to_physical_values() {
    let zoom = ParameterFunction {
        physical_from: 10.0,
        physical_to: 50.0,
        profile: vec![ProfilePoint {
            dmx_percent: 0.0,
            cfc0: 0.0,
            cfc1: 0.0,
            cfc2: 0.01,
            cfc3: 0.0,
        }],
        sets: vec![ParameterFunctionSet {
            name: "Narrow".to_string(),
            dmx_from: 250,
            dmx_to: 255,
            physical_from: Some(4.0),
            physical_to: Some(5.0),
            ..Default::default()
        }],
        ..function("Zoom", 0, 255)
    };
    let model = || {
        FixtureModel::new(
            [vec![parameter(Attribute::Zoom, vec![zoom.clone()], real())]],
            false,
        )
    };
    let half = read(model(), &[Some(127.5)])[0].unwrap();
    near(Some(half.fraction), 0.25, "squared profile at half DMX");
    assert!(
        (half.physical - 20.0).abs() < 0.1,
        "physical {}",
        half.physical
    );
    let narrow = read(model(), &[Some(255.0)])[0].unwrap();
    assert_eq!(narrow.set, Some(0));
    near(Some(narrow.physical), 5.0, "set physical range");
}

/// Verifies signed parameters convert to DMX around their logical centre.
#[test]
fn signed_values_convert_to_dmx_around_the_centre() {
    let pan = ParameterMetadata {
        value_polarity: ParameterValuePolarity::Signed,
        ..parameter(Attribute::Pan, Vec::new(), real())
    };
    let dmx = |value| {
        read(
            FixtureModel::new([vec![pan.clone()]], false),
            &[Some(value)],
        )[0]
        .unwrap()
        .dmx
    };
    assert_eq!(dmx(0.0), 128);
    assert_eq!(dmx(-127.5), 0);
}

/// Verifies an unlinked model ignores mode masters and relations naming other elements.
#[test]
fn unlinked_models_ignore_links() {
    let model = FixtureModel::new(
        [
            vec![parameter(Attribute::Intensity, Vec::new(), real())],
            vec![parameter(
                Attribute::Red,
                vec![following(
                    function("R", 0, 255),
                    0,
                    Attribute::Intensity,
                    RelationKind::Multiply,
                )],
                real(),
            )],
        ],
        false,
    );
    let readings = read(model, &[Some(0.0), Some(255.0)]);
    near(
        readings[1].map(|reading| reading.level),
        1.0,
        "unscaled red",
    );
}
