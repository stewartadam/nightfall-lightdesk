// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Serializable metadata describing bindable actions to automation surfaces and the UI.

use serde::{Deserialize, Serialize};

use crate::source::ControlBehavior;

/// Stable identifier for an action exposed through automation surfaces.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct ActionId(pub String);

impl ActionId {
    /// Creates an action identifier from a stable string.
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// Returns the stable string value used to register and dispatch the action.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Surface that invoked a registered action, retained for provenance and diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub enum ActionSurface {
    /// A timeline event invoked the action.
    Timeline,
    /// A MIDI mapping invoked the action.
    Midi,
    /// An OSC mapping invoked the action.
    Osc,
    /// A command palette entry invoked the action.
    CommandPalette,
    /// A user keybinding invoked the action.
    Keyboard,
    /// A websocket client invoked the action directly.
    Websocket,
}

impl ActionSurface {
    /// Every surface, in declaration order; the default set an action may be invoked from.
    pub const ALL: [Self; 6] = [
        Self::Timeline,
        Self::Midi,
        Self::Osc,
        Self::CommandPalette,
        Self::Keyboard,
        Self::Websocket,
    ];

    /// Returns the user-facing name of the surface.
    pub fn label(self) -> &'static str {
        match self {
            Self::Timeline => "Timeline",
            Self::Midi => "MIDI",
            Self::Osc => "OSC",
            Self::CommandPalette => "Command palette",
            Self::Keyboard => "Keyboard",
            Self::Websocket => "Websocket",
        }
    }
}

/// Shape of the runtime input an action consumes.
///
/// Surfaces use this to decide which physical controls can drive the action: buttons and
/// timeline events produce triggers, held buttons produce momentary press/release pairs,
/// and faders or knobs produce absolute values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub enum ActionInputKind {
    /// A discrete edge; press-style inputs fire once and releases are ignored.
    Trigger,
    /// A held input that reacts to both press and release.
    Momentary,
    /// A continuously varying normalized value in `0.0..=1.0`.
    Absolute,
}

/// Semantic kind of one persisted action argument, used to render pickers and capture targets.
///
/// The kind also fixes how the value is stored under the parameter's name in the persisted
/// arguments object: object references (`Clip`, `Master`, `Timeline`, `Cue`) are UID strings,
/// `Control` is a one-based slot index, `Panel` is a panel ID string, numeric kinds are JSON
/// numbers, and `Text` is a string. Clients rely on this to build arguments generically.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum ActionParameterKind {
    /// A clip referenced by its persistent UID.
    Clip,
    /// A master referenced by its persistent UID.
    Master,
    /// A control slot referenced by its one-based index.
    Control,
    /// A timeline referenced by its persistent UID.
    Timeline,
    /// A cue referenced by its persistent UID.
    Cue,
    /// A UI panel referenced by its panel ID.
    Panel,
    /// A whole number within an inclusive range.
    Integer {
        /// Smallest accepted value.
        min: u32,
        /// Largest accepted value, when bounded.
        max: Option<u32>,
    },
    /// A decimal number within an inclusive range.
    Number {
        /// Smallest accepted value.
        min: f64,
        /// Largest accepted value.
        max: f64,
    },
    /// Free-form text.
    Text,
}

/// One named argument accepted by an action.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct ActionParameter {
    /// Argument property name inside the persisted arguments object.
    pub name: String,
    /// User-facing argument label.
    pub label: String,
    /// Semantic argument kind.
    pub kind: ActionParameterKind,
    /// Whether the argument must be present.
    pub required: bool,
}

impl ActionParameter {
    /// Creates a required argument definition.
    pub fn required(
        name: impl Into<String>,
        label: impl Into<String>,
        kind: ActionParameterKind,
    ) -> Self {
        Self {
            name: name.into(),
            label: label.into(),
            kind,
            required: true,
        }
    }

    /// Creates an optional argument definition.
    pub fn optional(
        name: impl Into<String>,
        label: impl Into<String>,
        kind: ActionParameterKind,
    ) -> Self {
        Self {
            required: false,
            ..Self::required(name, label, kind)
        }
    }
}

/// Metadata describing one action available to automation surfaces.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct ActionDescriptor {
    /// Stable action identifier.
    pub id: ActionId,
    /// User-facing action label.
    pub label: String,
    /// User-facing grouping used by pickers and the command palette.
    pub category: String,
    /// Optional longer explanation of what the action does.
    pub description: Option<String>,
    /// Runtime input shape the action consumes.
    pub input: ActionInputKind,
    /// Persisted arguments the action accepts.
    pub parameters: Vec<ActionParameter>,
    /// Action invoked with the same arguments when a Hold binding is released, such as
    /// `clip.stop` for `clip.start`.
    #[serde(default)]
    pub hold_release: Option<ActionId>,
    /// Surfaces allowed to bind and invoke the action; every surface unless restricted.
    #[serde(default = "all_surfaces")]
    pub surfaces: Vec<ActionSurface>,
}

/// Returns every surface, the default set an action may be invoked from.
fn all_surfaces() -> Vec<ActionSurface> {
    ActionSurface::ALL.to_vec()
}

impl ActionDescriptor {
    /// Creates a trigger-driven descriptor without arguments.
    pub fn new(
        id: impl Into<String>,
        label: impl Into<String>,
        category: impl Into<String>,
    ) -> Self {
        Self {
            id: ActionId::new(id),
            label: label.into(),
            category: category.into(),
            description: None,
            input: ActionInputKind::Trigger,
            parameters: Vec::new(),
            hold_release: None,
            surfaces: all_surfaces(),
        }
    }

    /// Sets the runtime input shape the action consumes.
    pub fn with_input(mut self, input: ActionInputKind) -> Self {
        self.input = input;
        self
    }

    /// Sets the longer user-facing explanation.
    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Appends one accepted argument.
    pub fn with_parameter(mut self, parameter: ActionParameter) -> Self {
        self.parameters.push(parameter);
        self
    }

    /// Declares the action a Hold binding invokes with the same arguments on release.
    pub fn with_hold_release(mut self, action_id: impl Into<String>) -> Self {
        self.hold_release = Some(ActionId::new(action_id));
        self
    }

    /// Restricts which surfaces may bind and invoke the action.
    ///
    /// Use this for actions that only make sense in one context, such as timeline-owned
    /// actions whose effect depends on the timeline action that placed them.
    pub fn with_surfaces(mut self, surfaces: impl IntoIterator<Item = ActionSurface>) -> Self {
        self.surfaces = surfaces.into_iter().collect();
        self.surfaces.sort();
        self.surfaces.dedup();
        self
    }

    /// Returns whether the action may be bound to or invoked from `surface`.
    pub fn allows_surface(&self, surface: ActionSurface) -> bool {
        self.surfaces.contains(&surface)
    }
}

/// Descriptor plus the names of optional capabilities the owning domain registered.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct ActionCatalogEntry {
    /// Registered action metadata.
    pub descriptor: ActionDescriptor,
    /// Stable names of deterministic capabilities, such as timeline planning.
    pub capabilities: Vec<String>,
    /// Controller binding behaviors the action supports.
    pub behaviors: Vec<ControlBehavior>,
}
