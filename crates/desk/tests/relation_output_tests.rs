// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Console application of profile relations to DMX output.

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use moonshine_kind::Instance;
use nightfall::prelude::*;
use nightfall_compositor::prelude::*;
use nightfall_desk::prelude::apply_virtual_relations;
use nightfall_dmx::prelude::*;
use nightfall_fixtures::prelude::*;
use nightfall_fixtures::universe::dmx_universes;
use nightfall_io::prelude::*;
use uuid::Uuid;

/// A parameter of the test fixture with the value the programmer gives it.
struct Channel {
    /// Metadata, including slots and relations.
    metadata: ParameterMetadata,
    /// Programmed logical value.
    value: f32,
}

/// Builds one-byte metadata for `attribute` at `dmx_slots`, following `relations`.
fn param(
    attribute: Attribute,
    dmx_slots: DmxSlots,
    relations: Vec<FunctionRelation>,
) -> ParameterMetadata {
    ParameterMetadata {
        dmx_slots,
        functions: vec![ParameterFunction {
            name: "Function".to_string(),
            attribute: "Function".to_string(),
            dmx_to: 255,
            physical_to: 1.0,
            relations,
            ..Default::default()
        }],
        native_unit: attribute.native_unit(),
        value_polarity: attribute.value_polarity(),
        attribute,
        max: 255.0,
        merge_type: MergeStrategy::LTP,
        ..Default::default()
    }
}

/// Returns a relation to the intensity of element `element`.
fn intensity_of(element: u32, kind: RelationKind) -> FunctionRelation {
    FunctionRelation {
        master: ElementParameterRef {
            element,
            attribute: Attribute::Intensity,
        },
        kind,
    }
}

/// Slot 1 of break 1, where every test places the red follower.
fn red_slot() -> DmxSlots {
    DmxSlots::Explicit {
        dmx_break: 1,
        offsets: vec![1],
    }
}

/// Runs frames for a fixture with one channel per element and returns the DMX
/// output at slot 1, checking it stays stable across frames.
fn slot_one_output(channels: Vec<Channel>) -> u8 {
    let mut app = App::new();
    app.init_resource::<FixtureDataProviderExt>();
    app.init_resource::<FinalLayerAttributedAssertions>();
    app.init_resource::<ConsoleDmxUniverses>();
    app.add_systems(
        Update,
        (
            compositor::<Parameter>,
            apply_virtual_relations,
            dmx_universes,
        )
            .chain(),
    );

    let fixture_uid = Uuid::new_v4();
    let fixture = Fixture {
        identifiers: Identifiers {
            id: 1,
            uid: fixture_uid,
            label: "bar".to_string(),
        },
        elements: channels
            .iter()
            .enumerate()
            .map(|(index, channel)| FixtureElement {
                label: format!("Element {index}"),
                parameters: vec![channel.metadata.clone()],
            })
            .collect(),
        ..Default::default()
    };
    app.world_mut()
        .resource_mut::<FixtureDataProviderExt>()
        .inner
        .add(fixture)
        .ok();

    let mut layer = Layer::new("programmer".to_string(), Priority(127));
    for (index, channel) in channels.into_iter().enumerate() {
        let attribute = channel.metadata.attribute.clone();
        let slots = channel.metadata.dmx_slots.clone();
        let instance = unsafe {
            Instance::<Parameter>::from_entity_unchecked(
                app.world_mut()
                    .spawn(Parameter {
                        metadata: channel.metadata,
                        values: Default::default(),
                    })
                    .id(),
            )
        };
        if let DmxSlots::Explicit { offsets, .. } = slots {
            app.world_mut()
                .entity_mut(instance.entity())
                .insert(ResolvedOutputDestinations {
                    destinations: vec![OutputDestination {
                        transport: OutputTransport::Sacn {
                            mode: SacnDelivery::Multicast,
                        },
                        universe: 1,
                        addresses: offsets,
                    }],
                });
        }
        app.world_mut()
            .resource_mut::<FixtureDataProviderExt>()
            .add_parameter(
                FixtureRef {
                    fixture_uid,
                    index: Some(index as u32 + 1),
                },
                attribute,
                instance,
            );
        layer.absolute.insert(
            instance,
            (
                ParameterValue::Absolute {
                    value: channel.value,
                },
                None,
            ),
        );
    }
    app.world_mut().spawn((
        ObjectRefMarker(ObjectRef::ById {
            object_type: ObjectType::Cue,
            id: 1,
        }),
        layer,
    ));

    // Relations modify values in place; later frames must not compound them.
    let output = |app: &App| {
        app.world()
            .resource::<ConsoleDmxUniverses>()
            .get_value(1, 1)
            .unwrap()
    };
    app.update();
    let first = output(&app);
    app.update();
    app.update();
    assert_eq!(first, output(&app), "relation output drifted across frames");
    first
}

/// Returns slot 1 for a body dimmer at `master_slots` and a red pixel following it.
fn red_output(master_slots: DmxSlots, kind: RelationKind, dimmer: f32, red: f32) -> u8 {
    slot_one_output(vec![
        Channel {
            metadata: param(Attribute::Intensity, master_slots, Vec::new()),
            value: dimmer,
        },
        Channel {
            metadata: param(Attribute::Red, red_slot(), vec![intensity_of(0, kind)]),
            value: red,
        },
    ])
}

/// Verifies a virtual master dimmer scales its follower's DMX output.
#[test]
fn virtual_multiply_master_scales_follower_output() {
    assert_eq!(
        red_output(DmxSlots::Virtual, RelationKind::Multiply, 127.5, 255.0),
        128
    );
    assert_eq!(
        red_output(DmxSlots::Virtual, RelationKind::Multiply, 0.0, 255.0),
        0
    );
}

/// Verifies a virtual override master replaces its follower's DMX output.
#[test]
fn virtual_override_master_replaces_follower_output() {
    assert_eq!(
        red_output(DmxSlots::Virtual, RelationKind::Override, 51.0, 255.0),
        51
    );
}

/// Verifies a master with its own DMX slots is left for the fixture to apply.
#[test]
fn physical_master_leaves_follower_output_unchanged() {
    let slots = DmxSlots::Explicit {
        dmx_break: 1,
        offsets: vec![2],
    };
    assert_eq!(red_output(slots, RelationKind::Multiply, 0.0, 255.0), 255);
}

/// Verifies a virtual master that follows another virtual master passes the
/// whole chain to its follower: red × pixel dimmer × group dimmer.
#[test]
fn chained_virtual_masters_compose() {
    let output = slot_one_output(vec![
        Channel {
            metadata: param(Attribute::Intensity, DmxSlots::Virtual, Vec::new()),
            value: 127.5,
        },
        Channel {
            metadata: param(
                Attribute::Intensity,
                DmxSlots::Virtual,
                vec![intensity_of(0, RelationKind::Multiply)],
            ),
            value: 127.5,
        },
        Channel {
            metadata: param(
                Attribute::Red,
                red_slot(),
                vec![intensity_of(1, RelationKind::Multiply)],
            ),
            value: 255.0,
        },
    ]);
    assert_eq!(output, 64);
}

/// Verifies a real dimmer that a virtual pixel dimmer follows still reaches
/// the pixel: the fixture never sees the virtual dimmer, so the console
/// applies the whole chain.
#[test]
fn physical_master_of_a_virtual_follower_is_applied() {
    let body_slot = DmxSlots::Explicit {
        dmx_break: 1,
        offsets: vec![3],
    };
    let output = |body: f32| {
        slot_one_output(vec![
            Channel {
                metadata: param(Attribute::Intensity, body_slot.clone(), Vec::new()),
                value: body,
            },
            Channel {
                metadata: param(
                    Attribute::Intensity,
                    DmxSlots::Virtual,
                    vec![intensity_of(0, RelationKind::Multiply)],
                ),
                value: 255.0,
            },
            Channel {
                metadata: param(
                    Attribute::Red,
                    red_slot(),
                    vec![intensity_of(1, RelationKind::Multiply)],
                ),
                value: 255.0,
            },
        ])
    };
    assert_eq!(output(0.0), 0);
    assert_eq!(output(255.0), 255);
}

/// Verifies the follower's active function honours its mode master: a
/// relation on a function whose mode is not selected does not apply.
#[test]
fn relations_follow_the_mode_master_selected_function() {
    let control = Attribute::Custom {
        label: "Control".to_string(),
    };
    let under_mode = |from: u32, to: u32, relations: Vec<FunctionRelation>| ParameterFunction {
        name: format!("Mode {from}"),
        attribute: "ColorAdd_R".to_string(),
        dmx_to: 255,
        physical_to: 1.0,
        mode_master: Some(ModeMasterCondition {
            master: ElementParameterRef {
                element: 0,
                attribute: control.clone(),
            },
            dmx_from: from,
            dmx_to: to,
        }),
        relations,
        ..Default::default()
    };
    let output = |mode: f32| {
        slot_one_output(vec![
            Channel {
                metadata: param(
                    control.clone(),
                    DmxSlots::Explicit {
                        dmx_break: 1,
                        offsets: vec![2],
                    },
                    Vec::new(),
                ),
                value: mode,
            },
            Channel {
                metadata: param(Attribute::Intensity, DmxSlots::Virtual, Vec::new()),
                value: 0.0,
            },
            Channel {
                metadata: ParameterMetadata {
                    functions: vec![
                        under_mode(0, 127, vec![intensity_of(1, RelationKind::Multiply)]),
                        under_mode(128, 255, Vec::new()),
                    ],
                    ..param(Attribute::Red, red_slot(), Vec::new())
                },
                value: 255.0,
            },
        ])
    };
    assert_eq!(output(10.0), 0, "dimmed in the related mode");
    assert_eq!(output(200.0), 255, "unrelated mode is not dimmed");
}

/// Verifies a follower's function is selected from its mode master's value
/// after the relations the master follows: a virtual control channel that
/// follows a dimmer at zero selects the related mode even though its own
/// programmed value selects the unrelated one.
#[test]
fn mode_masters_are_read_after_their_own_relations() {
    let control = Attribute::Custom {
        label: "Control".to_string(),
    };
    let under_mode = |from: u32, to: u32, relations: Vec<FunctionRelation>| ParameterFunction {
        name: format!("Mode {from}"),
        attribute: "ColorAdd_R".to_string(),
        dmx_to: 255,
        physical_to: 1.0,
        mode_master: Some(ModeMasterCondition {
            master: ElementParameterRef {
                element: 1,
                attribute: control.clone(),
            },
            dmx_from: from,
            dmx_to: to,
        }),
        relations,
        ..Default::default()
    };
    let output = |group: f32| {
        slot_one_output(vec![
            Channel {
                metadata: param(Attribute::Intensity, DmxSlots::Virtual, Vec::new()),
                value: group,
            },
            Channel {
                metadata: param(
                    control.clone(),
                    DmxSlots::Virtual,
                    vec![intensity_of(0, RelationKind::Multiply)],
                ),
                value: 200.0,
            },
            Channel {
                metadata: param(Attribute::Intensity, DmxSlots::Virtual, Vec::new()),
                value: 0.0,
            },
            Channel {
                metadata: ParameterMetadata {
                    functions: vec![
                        under_mode(0, 127, vec![intensity_of(2, RelationKind::Multiply)]),
                        under_mode(128, 255, Vec::new()),
                    ],
                    ..param(Attribute::Red, red_slot(), Vec::new())
                },
                value: 255.0,
            },
        ])
    };
    assert_eq!(output(255.0), 255, "the control keeps the unrelated mode");
    assert_eq!(
        output(0.0),
        0,
        "the scaled control selects the related mode"
    );
}
