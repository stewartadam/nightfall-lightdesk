// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! This crate provides scene objects for non-fixture 3D objects in the visualizer.
//!
//! Scene objects include trusses, audience members, stage elements, and custom 3D models.
//! Unlike fixtures, these objects have no DMX control and are purely visual.

#![warn(missing_docs)]

pub mod events;
pub mod undo;
pub mod websocket;

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
use nightfall::data::{HasIdentifiers, Identifiers};
use nightfall_engine::prelude::*;
use nightfall_fixtures::placement::{PlacementPosition, PlacementRotation};
use nightfall_undo::prelude::*;
use serde::{Deserialize, Serialize};
use smart_default::SmartDefault;
use strum::{Display, EnumString};
use uuid::Uuid;

/// Prelude for ergonomic imports
pub mod prelude {
    pub use crate::websocket::SceneObjectDataProvider;
    pub use crate::{
        AudienceProperties, CustomProperties, SceneObject, SceneObjectCommand,
        SceneObjectPlacement, SceneObjectPlacementPositionUpdate,
        SceneObjectPlacementRotationUpdate, SceneObjectPlugin, SceneObjectProperties,
        SceneObjectType, StageElementProperties, TrussProperties, TrussType,
    };
}

/// Plugin for scene objects
pub struct SceneObjectPlugin;

impl Plugin for SceneObjectPlugin {
    fn build(&self, app: &mut App) {
        tracing::debug!("Registering SceneObjectPlugin");
        register_ingress_command::<SceneObjectCommand>(app);
        register_command_deserializer::<SceneObjectCommand>(
            app,
            websocket::deserialize_scene_object_command,
        );

        // Initialize the scene object data provider
        app.init_resource::<websocket::SceneObjectDataProvider>();

        // Register undoable commands
        app.world_mut()
            .resource_mut::<UndoRegistry>()
            .register::<SceneObjectCommand>();

        // Event handling
        app.add_systems(Update, events::crud_events.in_set(EventHandling));

        // WebSocket forwarding and sends
        app.add_systems(
            Update,
            websocket::send_scene_objects_on_change.in_set(ClientOutput),
        );

        app.add_systems(
            Update,
            websocket::handle_resync_state.in_set(ResyncHandling),
        );
    }
}

/// Type of scene object
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Display, EnumString)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
#[derive(Default)]
pub enum SceneObjectType {
    /// Structural truss for rigging
    Truss,
    /// Audience area with multiple people
    Audience,
    /// Generic stage element (riser, platform, curtain, etc.)
    StageElement,
    /// Custom user-provided 3D model
    #[default]
    Custom,
}

/// Type of truss structure
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Display, EnumString, Default,
)]
/// Scene-object truss geometry categories supported by the visualizer.
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
pub enum TrussType {
    /// Square/box truss (e.g., 12" box)
    #[default]
    Box,
    /// Triangular truss
    Triangle,
    /// Ladder/flat truss
    Ladder,
}

/// Properties specific to truss objects
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, SmartDefault)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub struct TrussProperties {
    /// Length of the truss in meters
    #[default = 2.0]
    pub length: f32,
    /// Type of truss structure
    pub truss_type: TrussType,
    /// Outer diameter/width of the truss in meters
    #[default = 0.3]
    pub diameter: f32,
}

/// Properties specific to audience areas
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, SmartDefault)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub struct AudienceProperties {
    /// Width of the audience area in meters (stage left-right)
    #[default = 10.0]
    pub width: f32,
    /// Depth of the audience area in meters (upstage-downstage)
    #[default = 10.0]
    pub depth: f32,
    /// Density of audience members per square meter
    #[default = 1.0]
    pub density: f32,
    /// Height variation of audience members (randomness factor 0-1)
    #[default = 0.1]
    pub height_variation: f32,
}

/// Properties specific to stage elements
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, SmartDefault)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub struct StageElementProperties {
    /// Path to the GLTF/GLB model file (relative to assets)
    pub model_path: String,
    /// Uniform scale factor for the model
    #[default = 1.0]
    pub scale: f32,
}

/// Properties specific to custom objects
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, SmartDefault)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub struct CustomProperties {
    /// Path to the GLTF/GLB model file (user-provided)
    pub model_path: String,
    /// Uniform scale factor for the model
    #[default = 1.0]
    pub scale: f32,
    /// Optional material color override (hex color string like "#ff0000")
    pub color_override: Option<String>,
    /// Optional library object name when sourced from object library
    #[serde(default)]
    pub library_object_name: Option<String>,
    /// Optional object library content version fingerprint
    #[serde(default)]
    pub library_object_version: Option<String>,
}

/// Type-specific properties for scene objects
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum SceneObjectProperties {
    /// Truss-specific properties
    Truss(TrussProperties),
    /// Audience-specific properties
    Audience(AudienceProperties),
    /// Stage element properties
    StageElement(StageElementProperties),
    /// Custom object properties
    Custom(CustomProperties),
}

impl Default for SceneObjectProperties {
    fn default() -> Self {
        Self::Custom(CustomProperties::default())
    }
}

impl SceneObjectProperties {
    /// Get the object type from the properties variant
    pub fn object_type(&self) -> SceneObjectType {
        match self {
            Self::Truss(_) => SceneObjectType::Truss,
            Self::Audience(_) => SceneObjectType::Audience,
            Self::StageElement(_) => SceneObjectType::StageElement,
            Self::Custom(_) => SceneObjectType::Custom,
        }
    }
}

/// 3D position vector for scene object placement.
#[derive(Default, Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[typeshare::typeshare]
pub struct SceneObjectPosition {
    /// X coordinate in meters (stage right is positive)
    pub x: f32,
    /// Y coordinate in meters (up is positive)
    pub y: f32,
    /// Z coordinate in meters (downstage is positive)
    pub z: f32,
}

impl From<PlacementPosition> for SceneObjectPosition {
    fn from(p: PlacementPosition) -> Self {
        Self {
            x: p.x,
            y: p.y,
            z: p.z,
        }
    }
}

impl From<SceneObjectPosition> for PlacementPosition {
    fn from(p: SceneObjectPosition) -> Self {
        Self {
            x: p.x,
            y: p.y,
            z: p.z,
        }
    }
}

/// Rotation as Euler angles in degrees for scene objects.
#[derive(Default, Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[typeshare::typeshare]
pub struct SceneObjectRotation {
    /// Rotation around X axis in degrees (pitch)
    pub x: f32,
    /// Rotation around Y axis in degrees (yaw)
    pub y: f32,
    /// Rotation around Z axis in degrees (roll)
    pub z: f32,
}

impl From<PlacementRotation> for SceneObjectRotation {
    fn from(r: PlacementRotation) -> Self {
        Self {
            x: r.x,
            y: r.y,
            z: r.z,
        }
    }
}

impl From<SceneObjectRotation> for PlacementRotation {
    fn from(r: SceneObjectRotation) -> Self {
        Self {
            x: r.x,
            y: r.y,
            z: r.z,
        }
    }
}

/// Per-instance 3D placement for scene objects in the venue.
#[derive(Component, Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[typeshare::typeshare]
pub struct SceneObjectPlacement {
    /// World position in meters
    pub position: SceneObjectPosition,
    /// Base orientation as Euler angles in degrees
    pub rotation: SceneObjectRotation,
}

impl SceneObjectPlacement {
    /// Create placement at specific position with identity rotation.
    pub fn at_position(x: f32, y: f32, z: f32) -> Self {
        Self {
            position: SceneObjectPosition { x, y, z },
            rotation: SceneObjectRotation::default(),
        }
    }
}

/// A non-fixture 3D object in the scene (truss, audience, stage element, etc.)
#[derive(Component, Debug, Clone, PartialEq, Serialize, Deserialize, SmartDefault)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub struct SceneObject {
    /// Identifiers for the scene object (id, uid, label)
    pub identifiers: Identifiers,
    /// Type of scene object
    pub object_type: SceneObjectType,
    /// 3D placement in world space
    pub placement: SceneObjectPlacement,
    /// Type-specific properties
    pub properties: SceneObjectProperties,
}

impl HasIdentifiers for SceneObject {
    fn identifiers(&self) -> &Identifiers {
        &self.identifiers
    }
}

impl SceneObject {
    /// Create a new truss scene object
    pub fn new_truss(id: u32, label: impl Into<String>, properties: TrussProperties) -> Self {
        Self {
            identifiers: Identifiers {
                id,
                uid: Uuid::new_v4(),
                label: label.into(),
            },
            object_type: SceneObjectType::Truss,
            placement: SceneObjectPlacement::default(),
            properties: SceneObjectProperties::Truss(properties),
        }
    }

    /// Create a new audience scene object
    pub fn new_audience(id: u32, label: impl Into<String>, properties: AudienceProperties) -> Self {
        Self {
            identifiers: Identifiers {
                id,
                uid: Uuid::new_v4(),
                label: label.into(),
            },
            object_type: SceneObjectType::Audience,
            placement: SceneObjectPlacement::default(),
            properties: SceneObjectProperties::Audience(properties),
        }
    }

    /// Create a new stage element scene object
    pub fn new_stage_element(
        id: u32,
        label: impl Into<String>,
        properties: StageElementProperties,
    ) -> Self {
        Self {
            identifiers: Identifiers {
                id,
                uid: Uuid::new_v4(),
                label: label.into(),
            },
            object_type: SceneObjectType::StageElement,
            placement: SceneObjectPlacement::default(),
            properties: SceneObjectProperties::StageElement(properties),
        }
    }

    /// Create a new custom scene object
    pub fn new_custom(id: u32, label: impl Into<String>, properties: CustomProperties) -> Self {
        Self {
            identifiers: Identifiers {
                id,
                uid: Uuid::new_v4(),
                label: label.into(),
            },
            object_type: SceneObjectType::Custom,
            placement: SceneObjectPlacement::default(),
            properties: SceneObjectProperties::Custom(properties),
        }
    }
}

/// Update to scene object 3D position (all coordinates or individual axis)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum SceneObjectPlacementPositionUpdate {
    /// Set all position coordinates at once
    All(SceneObjectPosition),
    /// Set only X coordinate
    X(f32),
    /// Set only Y coordinate
    Y(f32),
    /// Set only Z coordinate
    Z(f32),
}

/// Update to scene object 3D rotation (all angles or individual axis)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum SceneObjectPlacementRotationUpdate {
    /// Set all rotation angles at once
    All(SceneObjectRotation),
    /// Set only X rotation (pitch)
    X(f32),
    /// Set only Y rotation (yaw)
    Y(f32),
    /// Set only Z rotation (roll)
    Z(f32),
}

/// Commands for scene object operations
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum SceneObjectCommand {
    /// Store a scene object (create or update)
    StoreSceneObject(SceneObject),

    /// Delete a scene object by ID
    DeleteSceneObject(u32),

    /// Update scene object 3D placement (position and/or rotation)
    UpdateSceneObjectPlacement {
        /// ID of the scene object
        id: u32,
        /// Position update (None = no change)
        position: Option<SceneObjectPlacementPositionUpdate>,
        /// Rotation update (None = no change)
        rotation: Option<SceneObjectPlacementRotationUpdate>,
    },

    /// Update scene object properties
    UpdateSceneObjectProperties {
        /// ID of the scene object
        id: u32,
        /// New properties for the scene object
        properties: SceneObjectProperties,
    },
}

impl IngressCommand for SceneObjectCommand {}
