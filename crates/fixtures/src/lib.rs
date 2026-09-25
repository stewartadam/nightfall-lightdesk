// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! This crate provides fixture and parameters for the lighting desk.

#![warn(missing_docs)]

pub mod ast_conv;
pub mod binding_resolution;
pub mod binding_validation;
pub mod bindings;
pub mod compositor;
pub mod data_provider_ext;
pub mod events;
pub mod fixture;
pub mod geometry;
pub mod input_apply;
pub mod library;
pub mod parameter;
pub mod physical;
pub mod placement;
pub mod selection;
pub mod undo;
pub mod universe;
pub mod websocket;
pub mod wire_layout;

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall::command_types::DmxChannelExpr;
use nightfall::prelude::{ColorPathId, FixtureRef};
use nightfall_dmx::ChannelDmxValue;
use nightfall_dmx::prelude::{Attribute, ParameterValue};
use nightfall_engine::prelude::*;
use nightfall_io::OutputTransport;
use nightfall_undo::prelude::*;
use serde::{Deserialize, Serialize};

use crate::bindings::DmxRange;
use crate::placement::{PlacementPosition, PlacementRotation};

/// Runtime actions owned by fixture-level DMX processing.
#[derive(Debug, Clone, PartialEq)]
pub enum DmxAction {
    /// Release DMX channels.
    ReleaseChannels {
        /// Channels to release.
        channels: DmxChannelExpr,
    },
}

impl EnginePayload for DmxAction {}
impl EngineAction for DmxAction {}

/// Prelude for ergonomic imports
pub mod prelude {
    pub use nightfall_dmx::prelude::ParameterValuePolarity;

    pub use crate::binding_validation::{
        BindingValidationIssue, BindingValidationMode, BindingValidationSettings,
    };
    pub use crate::bindings::{
        ConsoleDmxAddress, ConsoleDmxAddresses, DisabledBinding, DisabledBindings, DmxRange,
        InputBinding, InputBindings, InputSource, InputTarget, OutputBinding, OutputBindings,
        OutputDestination, OutputSource, OutputTarget, ResolvedConsoleTarget, ResolvedInputBinding,
        ResolvedInputBindings, ResolvedInputDestination, ResolvedInputSource, ResolvedInputTarget,
        ResolvedOutputDestinations, ResolvedTransportTarget,
    };
    pub use crate::compositor::{
        FixtureCompositorPlugin, MANUAL_ASSERTION_LAYER_PRIORITY, ManualAssertionLayer,
        TRANSPORT_INPUT_LAYER_PRIORITY, TransportInputAssertionOwners, TransportInputLayer,
        clear_stale_parameter_assertions, clear_unbound_parameter_assertions,
    };
    pub use crate::data_provider_ext::{FixtureDataProviderExt, ResolvedElementParameter};
    pub use crate::fixture::{Fixture, FixtureElement, FixtureLayout};
    pub use crate::geometry::{
        AxisType, FixtureGeometry, GeometryModel, GeometryNode, GeometryProvider,
        GeometryProviderResource, GeometryType, MeshFormat, MeshResource, PrimitiveType, Transform,
    };
    pub use crate::input_apply::{ParameterAssertion, ParameterAssertionSource};
    pub use crate::parameter::{
        DmxSlots, MergeStrategy, Parameter, ParameterMetadata, ParameterValues,
    };
    pub use crate::physical::{
        BeamOptics, BeamType, FixturePhysical, OpticalChannel, OpticalChannelSet,
        OpticalDmxProfile, OpticalDmxProfilePoint, OpticalFunction, OpticalModeCondition,
        OpticalPrismFacet, OpticalWheel, OpticalWheelSlot,
    };
    pub use crate::placement::FixturePlacement;
    pub use crate::selection::{SelectionResolver, SpatialSelectionResolver};
    pub use crate::universe::{
        ConsoleChannelOrigin, ConsoleDmxUniverses, DEFAULT_INPUT_UNIVERSE_STALE_TIMEOUT_MS,
        InputDmxUniverses, InputUniverseStaleTimeout, UniverseTransportMap,
    };
    pub use crate::wire_layout::{PlacedParameter, WireLayout};
    pub use crate::{
        BindingEndpoint, DmxAction, FixtureCommand, FixturePlacementPositionUpdate,
        FixturePlacementRotationUpdate, FixturePlugin,
    };
}

/// Plugin for fixtures
pub struct FixturePlugin;
impl Plugin for FixturePlugin {
    fn build(&self, app: &mut App) {
        tracing::debug!("Registering FixturePlugin");
        app.add_plugins(input_apply::TransportInputPlugin);
        register_ingress_command::<FixtureCommand>(app);
        register_engine_action::<DmxAction>(app);
        nightfall_engine::protocol::dispatch_ast::register_converter::<ast_conv::FixtureAstConverter>(
        );
        register_command_deserializer::<FixtureCommand>(
            app,
            websocket::deserialize_fixture_command,
        );

        app.init_resource::<data_provider_ext::FixtureDataProviderExt>();
        app.init_resource::<bindings::InputBindings>();
        app.init_resource::<bindings::OutputBindings>();
        app.init_resource::<bindings::DisabledBindings>();
        app.init_resource::<bindings::ResolvedInputBindings>();
        app.init_resource::<bindings::ConsoleDmxAddresses>();
        app.init_resource::<binding_validation::BindingValidationSettings>();
        app.init_resource::<universe::ConsoleDmxUniverses>();
        app.init_resource::<universe::InputDmxUniverses>();
        app.init_resource::<universe::InputUniverseStaleTimeout>();
        app.init_resource::<universe::UniverseTransportMap>();
        app.init_resource::<nightfall_io::NetworkDmxOutputTargets>();
        app.init_resource::<nightfall_io::UsbDmxOutputTargets>();
        app.init_resource::<nightfall_io::InputUniverseVisibilityMode>();
        app.add_message::<websocket::SuppressFixtureChangedSnapshot>();
        websocket::register_fixture_websocket_diagnostics(app);

        // Register undoable commands
        {
            let mut registry = app.world_mut().resource_mut::<UndoRegistry>();
            registry.register::<FixtureCommand>();
            registry.register_action::<undo::RestoreFixtureSnapshot>();
            registry.register_action::<undo::RestoreBindingSnapshot>();
            registry.register_action::<undo::RestorePatchBindingsSnapshot>();
            registry.register_action::<undo::RestoreOffsetSnapshot>();
            registry.register_action::<undo::RestoreColorPathDefaultsSnapshot>();
            registry.register_action::<undo::ClearDmxChannels>();
        }

        // Register event dispatchers for undo helper commands
        register_engine_action::<undo::RestoreFixtureSnapshot>(app);
        register_engine_action::<undo::RestoreBindingSnapshot>(app);
        register_engine_action::<undo::RestorePatchBindingsSnapshot>(app);
        register_engine_action::<undo::RestoreOffsetSnapshot>(app);
        register_engine_action::<undo::RestoreColorPathDefaultsSnapshot>(app);
        register_engine_action::<undo::ClearDmxChannels>(app);

        app.add_systems(
            Update,
            (
                events::handle_set_dmx_channels,
                events::handle_restore_fixture_snapshot
                    .after(nightfall_undo::systems::handle_undo_commands),
                events::handle_restore_binding_snapshot,
                events::handle_restore_patch_bindings_snapshot,
                events::handle_restore_offset_snapshot,
                events::handle_restore_color_path_defaults_snapshot,
                events::handle_clear_dmx_channels,
            )
                .chain()
                .in_set(EventHandling),
        );

        app.add_systems(
            Update,
            (
                binding_validation::validate_bindings_on_change
                    .before(binding_resolution::derive_console_addresses),
                binding_resolution::derive_console_addresses,
                binding_resolution::resolve_input_bindings,
            )
                .chain()
                .in_set(InputHandling),
        );

        app.add_systems(
            Update,
            (
                binding_resolution::resolve_output_bindings,
                universe::update_transport_map,
                universe::dmx_universes,
                universe::dmx_universes_debug,
            )
                .chain()
                .in_set(DmxOutput),
        );

        // WebSocket forwarding and sends owned by fixtures plugin
        app.add_systems(
            Update,
            (
                websocket::forward_fixture_commands,
                websocket::send_fixtures_on_change,
                websocket::send_dmx_universes.after(DmxOutput),
                websocket::send_bindings_on_change,
                websocket::send_color_path_defaults_on_change,
                websocket::send_binding_validation_settings_on_change,
                websocket::send_parameter_state.after(DmxOutput),
            )
                .in_set(ClientOutput),
        );

        app.add_systems(
            Update,
            websocket::handle_resync_state.in_set(ResyncHandling),
        );
    }
}

/// Update to fixture 3D position (all coordinates or individual axis)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum FixturePlacementPositionUpdate {
    /// Set all position coordinates at once
    All(PlacementPosition),
    /// Set only X coordinate
    X(f32),
    /// Set only Y coordinate
    Y(f32),
    /// Set only Z coordinate
    Z(f32),
}

/// Update to fixture 3D rotation (all angles or individual axis)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum FixturePlacementRotationUpdate {
    /// Set all rotation angles at once
    All(PlacementRotation),
    /// Set only X rotation (pitch)
    X(f32),
    /// Set only Y rotation (yaw)
    Y(f32),
    /// Set only Z rotation (roll)
    Z(f32),
}

/// A per-fixture placement update payload for batch placement operations.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct FixturePlacementUpdateEntry {
    /// ID of the fixture
    pub id: u32,
    /// Position update (None = no change)
    pub position: Option<FixturePlacementPositionUpdate>,
    /// Rotation update (None = no change)
    pub rotation: Option<FixturePlacementRotationUpdate>,
}

/// Binding endpoint reference for patch commands (fixture IDs, transports, console, disabled).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum BindingEndpoint {
    /// Console endpoint (optionally scoped to a universe range and address)
    Console {
        /// Optional universe range
        universe: Option<DmxRange>,
        /// Optional DMX address
        address: Option<u16>,
    },
    /// Transport endpoint (sACN/Art-Net/uDMX)
    Transport {
        /// Protocol name for input sources or output transport target ID for output targets
        target: String,
        /// Optional universe range
        universe: Option<DmxRange>,
        /// Optional DMX address
        address: Option<u16>,
    },
    /// Fixture endpoint (fixture IDs with optional element/param)
    Fixture {
        /// Fixture IDs
        ids: Vec<u32>,
        /// Optional element index (1-based)
        element: Option<u16>,
        /// Optional parameter name
        param: Option<String>,
    },
    /// Disabled endpoint (filter)
    Disabled,
}

/// Commands for fixture-related operations
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum FixtureCommand {
    /// Store a fixture
    StoreFixture(fixture::Fixture),

    /// Rename a fixture
    RenameFixture {
        /// ID of the fixture
        id: u32,
        /// New ID for the fixture
        new_id: u32,
    },

    /// Delete a fixture
    DeleteFixture(u32),

    /// Set raw DMX channel values
    SetDmxChannels {
        /// DMX channel selection expression
        channels: DmxChannelExpr,
        /// Raw DMX value (0-255)
        value: ChannelDmxValue,
    },

    /// Update placement for multiple fixtures in one command.
    UpdateFixturePlacements {
        /// Per-fixture updates to apply.
        updates: Vec<FixturePlacementUpdateEntry>,
    },

    /// Update fixture patch (universe/address/transport)
    UpdateFixturePatch {
        /// ID of the fixture
        id: u32,
        /// DMX universe (1-based)
        universe: u16,
        /// DMX start address (1-512)
        address: u16,
        /// Optional transport override (None = keep current)
        transport: Option<OutputTransport>,
    },

    /// Add a patch binding (input/output/disabled)
    PatchBinding {
        /// Binding source endpoint
        source: BindingEndpoint,
        /// Binding target endpoint
        target: BindingEndpoint,
        /// Binding priority (lower runs first)
        priority: i32,
        /// Clone source address across target range
        clone: bool,
    },

    /// Remove patch bindings matching the filter
    RemovePatchBinding {
        /// Optional source filter
        source: Option<BindingEndpoint>,
        /// Optional target filter
        target: Option<BindingEndpoint>,
        /// Optional priority filter
        priority: Option<i32>,
        /// Optional clone filter
        clone: Option<bool>,
    },

    /// Update fixture parameter metadata offset
    UpdateFixtureParameterOffset {
        /// ID of the fixture
        id: u32,
        /// Parameter attribute to update
        attribute: Attribute,
        /// New offset value (raw DMX or percentage of range)
        offset: ParameterValue,
    },

    /// Set or clear the default color path for a fixture or fixture element.
    SetColorPathDefault {
        /// Fixture or fixture element receiving the default.
        fixture: FixtureRef,
        /// Color path ID to assign, or None to clear the default.
        color_path_id: Option<ColorPathId>,
    },

    /// Set or clear the default color path for a fixture or fixture element by fixture ID.
    SetColorPathDefaultById {
        /// Fixture ID receiving the default.
        id: u32,
        /// Optional element index receiving the default.
        element_index: Option<u32>,
        /// Color path ID to assign, or None to clear the default.
        color_path_id: Option<ColorPathId>,
    },
}

impl IngressCommand for FixtureCommand {}
