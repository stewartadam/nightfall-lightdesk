// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Undo/redo implementations for fixture commands.

use nightfall::command_types::DmxChannelExpr;
use nightfall::prelude::{ColorPathDefault, FixtureRef};
use nightfall_dmx::prelude::*;
use nightfall_engine::prelude::*;
#[cfg(test)]
use nightfall_io::prelude::{OutputTransport, SacnDelivery};
use nightfall_undo::prelude::*;
use serde::{Deserialize, Serialize};

use crate::prelude::*;

/// Snapshot of a single parameter's data for restoration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParameterSnapshot {
    /// Fixture element index (1-based)
    pub element_index: u32,
    /// Parameter metadata (attribute, resolution, etc.)
    pub metadata: ParameterMetadata,
    /// Parameter values (default, current, highlight)
    pub values: ParameterValues,
}

/// Complete snapshot of a fixture including all parameter state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FixtureSnapshot {
    /// The fixture data
    pub fixture: Fixture,
    /// Snapshots of all parameters
    pub parameters: Vec<ParameterSnapshot>,
    /// Fixture and fixture-element color path defaults owned by this fixture.
    pub color_path_defaults: Vec<ColorPathDefault>,
}

/// Snapshot of binding configuration for a fixture.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BindingSnapshot {
    /// Fixture ID this snapshot belongs to
    pub fixture_id: u32,
    /// Output bindings tied to the fixture.
    pub output_bindings: Vec<OutputBinding>,
    /// Disabled bindings tied to the fixture.
    pub disabled_bindings: Vec<DisabledBinding>,
}

/// Command to restore binding configuration for a fixture.
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
pub struct RestoreBindingSnapshot(pub BindingSnapshot);

/// Snapshot of all patch bindings (input, output, and disabled).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatchBindingsSnapshot {
    /// Input bindings.
    pub input_bindings: Vec<InputBinding>,
    /// Output bindings.
    pub output_bindings: Vec<OutputBinding>,
    /// Disabled bindings.
    pub disabled_bindings: Vec<DisabledBinding>,
}

/// Command to restore all patch bindings.
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
pub struct RestorePatchBindingsSnapshot(pub PatchBindingsSnapshot);

/// Snapshot of parameter offset configuration for a fixture.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OffsetSnapshot {
    /// Fixture ID this offset belongs to
    pub fixture_id: u32,
    /// Attribute that was changed
    pub attribute: Attribute,
    /// Previous offset values for each element (element_index 1-based, offset)
    pub offsets: Vec<(u32, ParameterValue)>,
}

/// Command to restore parameter offset configuration.
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
pub struct RestoreOffsetSnapshot(pub OffsetSnapshot);

/// Snapshot of DMX channel values for restoration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DmxChannelSnapshot {
    /// The original channel expression
    pub channels: DmxChannelExpr,
    /// The DMX value that was set (used for description)
    pub value: ChannelDmxValue,
}

/// Command to clear DMX channel manual override.
///
/// Restores the affected parameters to their default values, clearing
/// the manual override set by SetDmxChannels.
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
pub struct ClearDmxChannels(pub DmxChannelSnapshot);

/// Snapshot of all color path defaults before restoring a fixture-default edit.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColorPathDefaultsSnapshot {
    /// Persistable fixture and fixture-element default entries.
    pub defaults: Vec<ColorPathDefault>,
}

/// Command to restore the full fixture color path default table.
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
pub struct RestoreColorPathDefaultsSnapshot(pub ColorPathDefaultsSnapshot);

/// Command to restore a fixture from a complete snapshot.
///
/// This re-creates the fixture in DataProvider and respawns all Parameter entities.
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
pub struct RestoreFixtureSnapshot(pub FixtureSnapshot);

impl EngineAction for RestoreBindingSnapshot {}

impl EngineAction for RestorePatchBindingsSnapshot {}

impl EngineAction for RestoreOffsetSnapshot {}

impl EngineAction for ClearDmxChannels {}

impl EngineAction for RestoreColorPathDefaultsSnapshot {}

impl EngineAction for RestoreFixtureSnapshot {}

impl UndoableOperation for RestoreFixtureSnapshot {
    fn inverse(&self, _ctx: &UndoContext) -> Option<Box<dyn UndoableOperation>> {
        // Inverse of restore is delete
        Some(Box::new(FixtureCommand::DeleteFixture(
            self.0.fixture.identifiers.id,
        )))
    }

    fn description(&self) -> String {
        format!("Restore Fixture {}", self.0.fixture.identifiers.id)
    }
}

impl UndoableOperation for RestoreBindingSnapshot {
    fn inverse(&self, ctx: &UndoContext) -> Option<Box<dyn UndoableOperation>> {
        // Capture current binding state before restoring the old one
        let snapshot = snapshot_binding_state(ctx, self.0.fixture_id)?;
        Some(Box::new(RestoreBindingSnapshot(snapshot)))
    }

    fn description(&self) -> String {
        format!("Restore Fixture {} Bindings", self.0.fixture_id)
    }
}

impl UndoableOperation for RestorePatchBindingsSnapshot {
    fn inverse(&self, ctx: &UndoContext) -> Option<Box<dyn UndoableOperation>> {
        Some(Box::new(RestorePatchBindingsSnapshot(
            snapshot_patch_bindings(ctx),
        )))
    }

    fn description(&self) -> String {
        "Restore Patch Bindings".to_string()
    }
}

impl UndoableOperation for RestoreOffsetSnapshot {
    fn inverse(&self, ctx: &UndoContext) -> Option<Box<dyn UndoableOperation>> {
        // Capture current offsets for all elements before restoring
        let fixtures = ctx.world.resource::<FixtureDataProviderExt>();
        let fixture = fixtures.inner.from_id(self.0.fixture_id).ok()?;

        let mut offsets = Vec::new();
        for (idx, element) in fixture.elements.iter().enumerate() {
            let element_index = idx as u32 + 1;
            for param in &element.parameters {
                if param.attribute == self.0.attribute {
                    offsets.push((element_index, param.offset));
                }
            }
        }

        if offsets.is_empty() {
            return None;
        }

        Some(Box::new(RestoreOffsetSnapshot(OffsetSnapshot {
            fixture_id: self.0.fixture_id,
            attribute: self.0.attribute.clone(),
            offsets,
        })))
    }

    fn description(&self) -> String {
        format!(
            "Restore Fixture {} {:?} Offset",
            self.0.fixture_id, self.0.attribute
        )
    }
}

impl UndoableOperation for ClearDmxChannels {
    fn inverse(&self, _ctx: &UndoContext) -> Option<Box<dyn UndoableOperation>> {
        // Inverse of clearing is to set the value again
        Some(Box::new(FixtureCommand::SetDmxChannels {
            channels: self.0.channels.clone(),
            value: self.0.value,
        }))
    }

    fn description(&self) -> String {
        format!("Clear DMX {}", self.0.channels)
    }
}

impl UndoableOperation for RestoreColorPathDefaultsSnapshot {
    fn inverse(&self, ctx: &UndoContext) -> Option<Box<dyn UndoableOperation>> {
        let fixtures = ctx.world.resource::<FixtureDataProviderExt>();
        Some(Box::new(RestoreColorPathDefaultsSnapshot(
            ColorPathDefaultsSnapshot {
                defaults: fixtures.color_path_default_entries(),
            },
        )))
    }

    fn description(&self) -> String {
        "Restore Fixture Color Path Defaults".to_string()
    }
}

impl UndoableOperation for FixtureCommand {
    fn inverse(&self, ctx: &UndoContext) -> Option<Box<dyn UndoableOperation>> {
        let fixtures = ctx.world.resource::<FixtureDataProviderExt>();
        match self {
            FixtureCommand::StoreFixture(fixture) => {
                // Check if this is update vs create
                match fixtures.inner.get(fixture.identifiers.uid) {
                    Ok(existing) => {
                        // Update: snapshot existing state for restoration
                        let snapshot = snapshot_fixture(ctx, &existing);
                        Some(Box::new(RestoreFixtureSnapshot(snapshot)))
                    }
                    Err(_) => {
                        // Create: inverse is delete
                        Some(Box::new(FixtureCommand::DeleteFixture(
                            fixture.identifiers.id,
                        )))
                    }
                }
            }
            FixtureCommand::DeleteFixture(id) => {
                // Capture full fixture state before deletion
                fixtures.inner.from_id(*id).ok().map(|fixture_ref| {
                    let snapshot = snapshot_fixture(ctx, &fixture_ref);
                    Box::new(RestoreFixtureSnapshot(snapshot)) as Box<dyn UndoableOperation>
                })
            }
            FixtureCommand::RenameFixture { id, new_id } => {
                Some(Box::new(FixtureCommand::RenameFixture {
                    id: *new_id,
                    new_id: *id,
                }))
            }
            FixtureCommand::SetDmxChannels { channels, value } => {
                // Undo clears the manual override by setting affected parameters to default
                Some(Box::new(ClearDmxChannels(DmxChannelSnapshot {
                    channels: channels.clone(),
                    value: *value,
                })))
            }
            FixtureCommand::UpdateFixturePlacements { updates } => {
                let mut inverse_updates = Vec::new();
                for update in updates {
                    let fixture_ref = fixtures.inner.from_id(update.id).ok()?;
                    let old_placement = fixture_ref.placement.clone();
                    inverse_updates.push(crate::FixturePlacementUpdateEntry {
                        id: update.id,
                        position: Some(FixturePlacementPositionUpdate::All(old_placement.position)),
                        rotation: Some(FixturePlacementRotationUpdate::All(old_placement.rotation)),
                    });
                }

                Some(Box::new(FixtureCommand::UpdateFixturePlacements {
                    updates: inverse_updates,
                }))
            }
            FixtureCommand::UpdateFixturePatch { id, .. } => {
                snapshot_binding_state(ctx, *id).map(|snapshot| {
                    Box::new(RestoreBindingSnapshot(snapshot)) as Box<dyn UndoableOperation>
                })
            }
            FixtureCommand::PatchBinding { .. } => Some(Box::new(RestorePatchBindingsSnapshot(
                snapshot_patch_bindings(ctx),
            ))),
            FixtureCommand::RemovePatchBinding { .. } => Some(Box::new(
                RestorePatchBindingsSnapshot(snapshot_patch_bindings(ctx)),
            )),
            FixtureCommand::UpdateFixtureParameterOffset { id, attribute, .. } => {
                // Snapshot current offsets for all elements with this attribute before update
                fixtures.inner.from_id(*id).ok().and_then(|fixture_ref| {
                    let mut offsets = Vec::new();
                    for (idx, element) in fixture_ref.elements.iter().enumerate() {
                        let element_index = idx as u32 + 1;
                        for param in &element.parameters {
                            if param.attribute == *attribute {
                                offsets.push((element_index, param.offset));
                            }
                        }
                    }

                    if offsets.is_empty() {
                        return None;
                    }

                    Some(Box::new(RestoreOffsetSnapshot(OffsetSnapshot {
                        fixture_id: *id,
                        attribute: attribute.clone(),
                        offsets,
                    })) as Box<dyn UndoableOperation>)
                })
            }
            FixtureCommand::SetColorPathDefault { .. }
            | FixtureCommand::SetColorPathDefaultById { .. } => Some(Box::new(
                RestoreColorPathDefaultsSnapshot(ColorPathDefaultsSnapshot {
                    defaults: fixtures.color_path_default_entries(),
                }),
            )),
        }
    }

    fn description(&self) -> String {
        match self {
            FixtureCommand::StoreFixture(f) => format!("Store Fixture {}", f.identifiers.id),
            FixtureCommand::DeleteFixture(id) => format!("Delete Fixture {}", id),
            FixtureCommand::RenameFixture { id, new_id } => {
                format!("Rename Fixture {} → {}", id, new_id)
            }
            FixtureCommand::SetDmxChannels { channels, value } => {
                format!("Set DMX {} @ {}", channels, value)
            }
            FixtureCommand::UpdateFixturePlacements { updates } => {
                format!("Update {} Fixture Placements", updates.len())
            }
            FixtureCommand::UpdateFixturePatch { id, .. } => {
                format!("Update Fixture {} Bindings", id)
            }
            FixtureCommand::PatchBinding { .. } => "Patch Binding".to_string(),
            FixtureCommand::RemovePatchBinding { .. } => "Remove Patch Binding".to_string(),
            FixtureCommand::UpdateFixtureParameterOffset { id, .. } => {
                format!("Update Fixture {} Parameter Offset", id)
            }
            FixtureCommand::SetColorPathDefault {
                fixture,
                color_path_id,
            } => match color_path_id {
                Some(color_path_id) => format!(
                    "Set Fixture {} Color Path {}",
                    fixture.fixture_uid, color_path_id
                ),
                None => format!("Clear Fixture {} Color Path", fixture.fixture_uid),
            },
            FixtureCommand::SetColorPathDefaultById {
                id,
                element_index,
                color_path_id,
            } => {
                let target = match element_index {
                    Some(element_index) => format!("{}.{}", id, element_index),
                    None => id.to_string(),
                };
                match color_path_id {
                    Some(color_path_id) => {
                        format!("Set Fixture {} Color Path {}", target, color_path_id)
                    }
                    None => format!("Clear Fixture {} Color Path", target),
                }
            }
        }
    }
}

/// Creates a snapshot of a fixture including metadata and live values for all its parameters.
///
/// Parameter entities are respawned from this metadata and value state during restoration.
fn snapshot_fixture(ctx: &UndoContext, fixture: &Fixture) -> FixtureSnapshot {
    let fixtures = ctx.world.resource::<FixtureDataProviderExt>();
    let mut parameters = Vec::new();

    for (idx, element) in fixture.elements.iter().enumerate() {
        let element_index = idx as u32 + 1;
        let element_ref = FixtureRef {
            fixture_uid: fixture.identifiers.uid,
            index: Some(element_index),
        };

        for param_metadata in &element.parameters {
            let parameter_instance = fixtures
                .try_parameter_for_element_attribute(&element_ref, &param_metadata.attribute);
            let values = parameter_instance
                .and_then(|parameter| {
                    ctx.world
                        .get::<Parameter>(parameter.entity())
                        .map(|parameter| parameter.values.clone())
                })
                .unwrap_or_default();

            parameters.push(ParameterSnapshot {
                element_index,
                metadata: param_metadata.clone(),
                values,
            });
        }
    }

    FixtureSnapshot {
        fixture: fixture.clone(),
        parameters,
        color_path_defaults: fixtures
            .color_path_default_entries()
            .into_iter()
            .filter(|default| default.fixture.fixture_uid == fixture.identifiers.uid)
            .collect(),
    }
}

fn output_binding_matches_fixture(binding: &OutputBinding, uid: uuid::Uuid) -> bool {
    match &binding.source {
        OutputSource::Fixture { uids, .. } => uids.contains(&uid),
        _ => false,
    }
}

fn disabled_binding_matches_fixture(binding: &DisabledBinding, uid: uuid::Uuid) -> bool {
    match binding {
        DisabledBinding::Output {
            source: OutputSource::Fixture { uids, .. },
            ..
        } => uids.contains(&uid),
        _ => false,
    }
}

fn snapshot_binding_state(ctx: &UndoContext, fixture_id: u32) -> Option<BindingSnapshot> {
    let fixtures = ctx.world.resource::<FixtureDataProviderExt>();
    let fixture = fixtures.inner.from_id(fixture_id).ok()?;
    let output_bindings = ctx.world.resource::<OutputBindings>();
    let disabled_bindings = ctx.world.resource::<DisabledBindings>();

    let output_snapshot = output_bindings
        .bindings
        .iter()
        .filter(|binding| output_binding_matches_fixture(binding, fixture.identifiers.uid))
        .cloned()
        .collect();
    let disabled_snapshot = disabled_bindings
        .bindings
        .iter()
        .filter(|binding| disabled_binding_matches_fixture(binding, fixture.identifiers.uid))
        .cloned()
        .collect();

    Some(BindingSnapshot {
        fixture_id,
        output_bindings: output_snapshot,
        disabled_bindings: disabled_snapshot,
    })
}

fn snapshot_patch_bindings(ctx: &UndoContext) -> PatchBindingsSnapshot {
    let input_bindings = ctx.world.resource::<InputBindings>();
    let output_bindings = ctx.world.resource::<OutputBindings>();
    let disabled_bindings = ctx.world.resource::<DisabledBindings>();

    PatchBindingsSnapshot {
        input_bindings: input_bindings.bindings.clone(),
        output_bindings: output_bindings.bindings.clone(),
        disabled_bindings: disabled_bindings.bindings.clone(),
    }
}

#[cfg(test)]
mod tests {
    use bevy_ecs::world::World;
    use moonshine_kind::Instance;
    use nightfall::prelude::{ColorPathId, Identifiers};
    use uuid::Uuid;

    use super::*;

    fn create_test_fixture(id: u32, num_elements: usize) -> Fixture {
        let uid = Uuid::new_v4();
        Fixture {
            identifiers: Identifiers {
                id,
                uid,
                label: format!("Test Fixture {}", id),
            },
            make: "Test".to_string(),
            model: "LED Bar".to_string(),
            mode: "RGB".to_string(),
            elements: (0..num_elements)
                .map(|i| FixtureElement {
                    label: format!("Pixel {}", i + 1),
                    parameters: vec![ParameterMetadata {
                        dmx_slots: Default::default(),
                        resolution: DmxValueResolution::Coarse,
                        attribute: Attribute::Intensity,
                        native_unit: Attribute::Intensity.native_unit(),
                        value_polarity: Attribute::Intensity.value_polarity(),
                        min: 0.0,
                        max: 255.0,
                        offset: ParameterValue::Absolute { value: 0.0 },
                        is_inverted: false,
                        is_snap: false,
                        merge_type: MergeStrategy::LTP,
                        use_grandmaster: true,
                    }],
                })
                .collect(),
            physical: None,
            placement: Default::default(),
            layout: None,
            library_asset_etag: None,
        }
    }

    #[test]
    fn test_binding_snapshot_captures_fixture_bindings() {
        let mut world = World::new();

        let fixture = create_test_fixture(1, 1);
        let fixture_uid = fixture.identifiers.uid;

        let mut data_provider = FixtureDataProviderExt::default();
        data_provider.inner.add(fixture).unwrap();
        world.insert_resource(data_provider);

        world.insert_resource(OutputBindings {
            bindings: vec![
                OutputBinding {
                    source: OutputSource::Fixture {
                        uids: vec![fixture_uid],
                        element: None,
                        param: None,
                    },
                    target: OutputTarget::Transport {
                        target: "sacn".to_string(),
                        universe: Some(DmxRange::single(1)),
                        address: Some(10),
                    },
                    priority: 0,
                    clone: false,
                },
                OutputBinding {
                    source: OutputSource::Fixture {
                        uids: vec![Uuid::new_v4()],
                        element: None,
                        param: None,
                    },
                    target: OutputTarget::Transport {
                        target: "udmx".to_string(),
                        universe: Some(DmxRange::single(2)),
                        address: Some(5),
                    },
                    priority: 0,
                    clone: false,
                },
            ],
        });

        world.insert_resource(DisabledBindings {
            bindings: vec![DisabledBinding::Output {
                source: OutputSource::Fixture {
                    uids: vec![fixture_uid],
                    element: None,
                    param: None,
                },
                priority: 0,
                clone: false,
            }],
        });

        let ctx = UndoContext { world: &world };
        let snapshot = snapshot_binding_state(&ctx, 1).expect("Snapshot should exist");

        assert_eq!(snapshot.output_bindings.len(), 1);
        assert_eq!(snapshot.disabled_bindings.len(), 1);

        let binding = &snapshot.output_bindings[0];
        assert!(matches!(
            binding.target,
            OutputTarget::Transport {
                ref target,
                universe: Some(_),
                address: Some(10),
            } if target == "sacn"
        ));
    }

    #[test]
    fn test_delete_fixture_inverse_captures_live_parameter_values() {
        let mut world = World::new();

        let fixture = create_test_fixture(1, 1);
        let fixture_uid = fixture.identifiers.uid;
        let parameter_values = ParameterValues {
            default_value: 11.0,
            highlight_value: 222.0,
            current_value: 123.0,
        };
        let parameter_metadata = fixture.elements[0].parameters[0].clone();
        let parameter_entity = world
            .spawn(Parameter {
                metadata: parameter_metadata,
                values: parameter_values.clone(),
            })
            .id();

        let mut data_provider = FixtureDataProviderExt::default();
        data_provider.inner.add(fixture).unwrap();
        let parameter = unsafe { Instance::<Parameter>::from_entity_unchecked(parameter_entity) };
        data_provider.add_parameter(
            FixtureRef {
                fixture_uid,
                index: Some(1),
            },
            Attribute::Intensity,
            parameter,
        );
        let element_ref = FixtureRef {
            fixture_uid,
            index: Some(1),
        };
        data_provider.set_color_path_default(element_ref.clone(), Some(ColorPathId(2)));
        world.insert_resource(data_provider);

        let ctx = UndoContext { world: &world };
        let inverse = FixtureCommand::DeleteFixture(1)
            .inverse(&ctx)
            .expect("delete fixture should produce a restore inverse");
        let restore = inverse
            .as_any()
            .downcast_ref::<RestoreFixtureSnapshot>()
            .expect("delete fixture inverse should restore a fixture snapshot");

        assert_eq!(restore.0.parameters.len(), 1);
        assert_eq!(
            restore.0.parameters[0].values.default_value,
            parameter_values.default_value
        );
        assert_eq!(
            restore.0.parameters[0].values.highlight_value,
            parameter_values.highlight_value
        );
        assert_eq!(
            restore.0.parameters[0].values.current_value,
            parameter_values.current_value
        );
        assert_eq!(
            restore.0.color_path_defaults,
            vec![ColorPathDefault {
                fixture: element_ref,
                color_path_id: ColorPathId(2),
            }]
        );
    }

    #[test]
    fn test_offset_snapshot_captures_per_element_offsets() {
        let mut world = World::new();

        // Create a 3-element fixture with different offsets per element
        let uid = Uuid::new_v4();
        let fixture = Fixture {
            identifiers: Identifiers {
                id: 1,
                uid,
                label: "Test Fixture".to_string(),
            },
            make: "Test".to_string(),
            model: "LED Bar".to_string(),
            mode: "RGB".to_string(),
            elements: vec![
                FixtureElement {
                    label: "Pixel 1".to_string(),
                    parameters: vec![ParameterMetadata {
                        dmx_slots: Default::default(),
                        resolution: DmxValueResolution::Coarse,
                        attribute: Attribute::Intensity,
                        native_unit: Attribute::Intensity.native_unit(),
                        value_polarity: Attribute::Intensity.value_polarity(),
                        min: 0.0,
                        max: 255.0,
                        offset: ParameterValue::Absolute { value: 10.0 }, // Different offset
                        is_inverted: false,
                        is_snap: false,
                        merge_type: MergeStrategy::LTP,
                        use_grandmaster: true,
                    }],
                },
                FixtureElement {
                    label: "Pixel 2".to_string(),
                    parameters: vec![ParameterMetadata {
                        dmx_slots: Default::default(),
                        resolution: DmxValueResolution::Coarse,
                        attribute: Attribute::Intensity,
                        native_unit: Attribute::Intensity.native_unit(),
                        value_polarity: Attribute::Intensity.value_polarity(),
                        min: 0.0,
                        max: 255.0,
                        offset: ParameterValue::Absolute { value: 20.0 }, // Different offset
                        is_inverted: false,
                        is_snap: false,
                        merge_type: MergeStrategy::LTP,
                        use_grandmaster: true,
                    }],
                },
                FixtureElement {
                    label: "Pixel 3".to_string(),
                    parameters: vec![ParameterMetadata {
                        dmx_slots: Default::default(),
                        resolution: DmxValueResolution::Coarse,
                        attribute: Attribute::Intensity,
                        native_unit: Attribute::Intensity.native_unit(),
                        value_polarity: Attribute::Intensity.value_polarity(),
                        min: 0.0,
                        max: 255.0,
                        offset: ParameterValue::Absolute { value: 30.0 }, // Different offset
                        is_inverted: false,
                        is_snap: false,
                        merge_type: MergeStrategy::LTP,
                        use_grandmaster: true,
                    }],
                },
            ],
            physical: None,
            placement: Default::default(),
            layout: None,
            library_asset_etag: None,
        };

        // Create FixtureDataProviderExt and add fixture
        let mut data_provider = FixtureDataProviderExt::default();
        data_provider.inner.add(fixture).unwrap();

        // Insert the data provider as a resource
        world.insert_resource(data_provider);

        // Create undo context
        let ctx = UndoContext { world: &world };

        // Create command and get inverse
        let command = FixtureCommand::UpdateFixtureParameterOffset {
            id: 1,
            attribute: Attribute::Intensity,
            offset: ParameterValue::Absolute { value: 50.0 },
        };

        let inverse = command.inverse(&ctx).expect("Should create inverse");

        // Downcast to RestoreOffsetSnapshot to inspect
        let restore_cmd = inverse
            .as_any()
            .downcast_ref::<RestoreOffsetSnapshot>()
            .expect("Should be RestoreOffsetSnapshot");

        // Verify we captured offsets for all 3 elements
        assert_eq!(
            restore_cmd.0.offsets.len(),
            3,
            "Should capture offsets for all 3 elements"
        );

        // Verify each element has its own offset
        let offset_by_element: std::collections::HashMap<u32, ParameterValue> =
            restore_cmd.0.offsets.iter().cloned().collect();

        assert_eq!(
            offset_by_element.get(&1),
            Some(&ParameterValue::Absolute { value: 10.0 }),
            "Element 1 should have offset 10"
        );
        assert_eq!(
            offset_by_element.get(&2),
            Some(&ParameterValue::Absolute { value: 20.0 }),
            "Element 2 should have offset 20"
        );
        assert_eq!(
            offset_by_element.get(&3),
            Some(&ParameterValue::Absolute { value: 30.0 }),
            "Element 3 should have offset 30"
        );
    }

    #[test]
    fn test_update_fixture_patch_inverse_captures_bindings() {
        let mut world = World::new();

        let fixture = create_test_fixture(1, 1);
        let fixture_uid = fixture.identifiers.uid;

        let mut data_provider = FixtureDataProviderExt::default();
        data_provider.inner.add(fixture).unwrap();
        world.insert_resource(data_provider);

        world.insert_resource(OutputBindings {
            bindings: vec![
                OutputBinding {
                    source: OutputSource::Fixture {
                        uids: vec![fixture_uid],
                        element: None,
                        param: None,
                    },
                    target: OutputTarget::Transport {
                        target: "sacn".to_string(),
                        universe: Some(DmxRange::single(1)),
                        address: Some(10),
                    },
                    priority: 0,
                    clone: false,
                },
                OutputBinding {
                    source: OutputSource::Fixture {
                        uids: vec![Uuid::new_v4()],
                        element: None,
                        param: None,
                    },
                    target: OutputTarget::Transport {
                        target: "udmx".to_string(),
                        universe: Some(DmxRange::single(2)),
                        address: Some(5),
                    },
                    priority: 0,
                    clone: false,
                },
            ],
        });

        world.insert_resource(DisabledBindings {
            bindings: vec![DisabledBinding::Output {
                source: OutputSource::Fixture {
                    uids: vec![fixture_uid],
                    element: None,
                    param: None,
                },
                priority: 0,
                clone: false,
            }],
        });

        let ctx = UndoContext { world: &world };

        let command = FixtureCommand::UpdateFixturePatch {
            id: 1,
            universe: 5,
            address: 100,
            transport: Some(OutputTransport::Sacn {
                mode: SacnDelivery::Multicast,
            }),
        };

        let inverse = command.inverse(&ctx).expect("Should create inverse");

        let restore_cmd = inverse
            .as_any()
            .downcast_ref::<RestoreBindingSnapshot>()
            .expect("Should be RestoreBindingSnapshot");

        assert_eq!(restore_cmd.0.output_bindings.len(), 1);
        assert_eq!(restore_cmd.0.disabled_bindings.len(), 1);
    }

    #[test]
    fn test_patch_binding_inverse_captures_all_bindings() {
        let mut world = World::new();

        let fixture = create_test_fixture(1, 1);
        let fixture_uid = fixture.identifiers.uid;

        let mut data_provider = FixtureDataProviderExt::default();
        data_provider.inner.add(fixture).unwrap();
        world.insert_resource(data_provider);

        world.insert_resource(InputBindings {
            bindings: vec![InputBinding {
                source: InputSource::Console {
                    universe: Some(DmxRange::single(1)),
                    address: Some(1),
                },
                target: InputTarget::Disabled,
                priority: 1,
                clone: false,
            }],
        });

        world.insert_resource(OutputBindings {
            bindings: vec![OutputBinding {
                source: OutputSource::Fixture {
                    uids: vec![fixture_uid],
                    element: None,
                    param: None,
                },
                target: OutputTarget::Transport {
                    target: "sacn".to_string(),
                    universe: Some(DmxRange::single(1)),
                    address: Some(10),
                },
                priority: 0,
                clone: false,
            }],
        });

        world.insert_resource(DisabledBindings {
            bindings: vec![DisabledBinding::Output {
                source: OutputSource::Fixture {
                    uids: vec![fixture_uid],
                    element: None,
                    param: None,
                },
                priority: 0,
                clone: false,
            }],
        });

        let ctx = UndoContext { world: &world };

        let command = FixtureCommand::PatchBinding {
            source: BindingEndpoint::Console {
                universe: Some(DmxRange::single(1)),
                address: Some(1),
            },
            target: BindingEndpoint::Disabled,
            priority: 0,
            clone: false,
        };

        let inverse = command.inverse(&ctx).expect("Should create inverse");
        let restore_cmd = inverse
            .as_any()
            .downcast_ref::<RestorePatchBindingsSnapshot>()
            .expect("Should be RestorePatchBindingsSnapshot");

        assert_eq!(restore_cmd.0.input_bindings.len(), 1);
        assert_eq!(restore_cmd.0.output_bindings.len(), 1);
        assert_eq!(restore_cmd.0.disabled_bindings.len(), 1);
    }

    #[test]
    fn test_remove_patch_binding_inverse_captures_all_bindings() {
        let mut world = World::new();

        let fixture = create_test_fixture(1, 1);
        let fixture_uid = fixture.identifiers.uid;

        let mut data_provider = FixtureDataProviderExt::default();
        data_provider.inner.add(fixture).unwrap();
        world.insert_resource(data_provider);

        world.insert_resource(InputBindings {
            bindings: vec![InputBinding {
                source: InputSource::Console {
                    universe: Some(DmxRange::single(1)),
                    address: Some(1),
                },
                target: InputTarget::Disabled,
                priority: 1,
                clone: false,
            }],
        });

        world.insert_resource(OutputBindings {
            bindings: vec![OutputBinding {
                source: OutputSource::Fixture {
                    uids: vec![fixture_uid],
                    element: None,
                    param: None,
                },
                target: OutputTarget::Transport {
                    target: "sacn".to_string(),
                    universe: Some(DmxRange::single(1)),
                    address: Some(10),
                },
                priority: 0,
                clone: false,
            }],
        });

        world.insert_resource(DisabledBindings {
            bindings: vec![DisabledBinding::Output {
                source: OutputSource::Fixture {
                    uids: vec![fixture_uid],
                    element: None,
                    param: None,
                },
                priority: 0,
                clone: false,
            }],
        });

        let ctx = UndoContext { world: &world };

        let command = FixtureCommand::RemovePatchBinding {
            source: None,
            target: None,
            priority: None,
            clone: None,
        };

        let inverse = command.inverse(&ctx).expect("Should create inverse");
        let restore_cmd = inverse
            .as_any()
            .downcast_ref::<RestorePatchBindingsSnapshot>()
            .expect("Should be RestorePatchBindingsSnapshot");

        assert_eq!(restore_cmd.0.input_bindings.len(), 1);
        assert_eq!(restore_cmd.0.output_bindings.len(), 1);
        assert_eq!(restore_cmd.0.disabled_bindings.len(), 1);
    }
}
