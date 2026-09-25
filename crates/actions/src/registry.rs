// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! App-wide registry mapping stable action IDs to domain-owned invokers and capabilities.

use std::any::{Any, TypeId};
use std::collections::{BTreeMap, HashMap};

use bevy_ecs::prelude::{Resource, World};
use serde::de::DeserializeOwned;

use crate::descriptor::{
    ActionCatalogEntry, ActionDescriptor, ActionId, ActionInputKind, ActionSurface,
};
use crate::flash::{FLASH_LEVEL, FlashStates};
use crate::invocation::{
    ActionInput, ActionInvocation, ActionReference, ClientActionInvocation, InvocationDispatch,
    InvocationError,
};
use crate::source::ControlBehavior;

/// ID prefix reserved for actions hosted by connected Web UI clients.
pub const CLIENT_ACTION_PREFIX: &str = "ui.";

type RegisteredInvoker = Box<
    dyn Fn(&mut World, &ActionInvocation) -> Result<InvocationDispatch, InvocationError>
        + Send
        + Sync,
>;

type CapabilityResolver = Box<
    dyn Fn(&ActionReference) -> Result<Box<dyn Any + Send + Sync>, InvocationError> + Send + Sync,
>;

/// Reads the current normalized level an absolute action drives, for restoring after a flash.
type FlashLevelReader =
    Box<dyn Fn(&World, &ActionReference) -> Result<Option<f32>, InvocationError> + Send + Sync>;

/// One deterministic interpretation of an action, keyed by its output type.
struct RegisteredCapability {
    name: &'static str,
    resolve: CapabilityResolver,
}

/// Descriptor, live invoker, and capabilities registered by one owning domain.
struct RegisteredAction {
    descriptor: ActionDescriptor,
    invoker: RegisteredInvoker,
    capabilities: HashMap<TypeId, RegisteredCapability>,
    flash_level: Option<FlashLevelReader>,
}

/// App-wide registry of action descriptors and domain-owned invokers.
#[derive(Default, Resource)]
pub struct ActionRegistry {
    actions: BTreeMap<ActionId, RegisteredAction>,
}

/// Returns whether an action ID is reserved for actions hosted by connected clients.
pub fn is_client_action(id: &ActionId) -> bool {
    id.as_str().starts_with(CLIENT_ACTION_PREFIX)
}

/// Decodes persisted action arguments into the owning domain's typed argument struct.
fn decode_arguments<A: DeserializeOwned>(action: &ActionReference) -> Result<A, InvocationError> {
    serde_json::from_value::<A>(action.arguments.clone()).map_err(|error| {
        InvocationError::new(
            "action.invalid_arguments",
            format!(
                "Invalid arguments for action '{}': {error}",
                action.id.as_str()
            ),
        )
    })
}

/// Rejects binding or invoking an action from a surface its descriptor does not allow.
fn ensure_surface_allowed(
    descriptor: &ActionDescriptor,
    surface: ActionSurface,
) -> Result<(), InvocationError> {
    if descriptor.allows_surface(surface) {
        return Ok(());
    }
    let allowed = descriptor
        .surfaces
        .iter()
        .map(|surface| surface.label())
        .collect::<Vec<_>>()
        .join(", ");
    Err(InvocationError::new(
        "action.surface_not_allowed",
        format!(
            "'{}' cannot be invoked from {}; it only runs from: {allowed}",
            descriptor.label,
            surface.label()
        ),
    )
    .with_details(serde_json::json!({
        "surface": surface,
        "allowed_surfaces": descriptor.surfaces,
    })))
}

/// Lists the controller binding behaviors a registered action supports.
///
/// Triggers fire on press or release, and on Hold when they declare a release counterpart.
/// Absolute actions follow faders directly, and Flash when their level can be read back.
fn supported_behaviors(action: &RegisteredAction) -> Vec<ControlBehavior> {
    match action.descriptor.input {
        ActionInputKind::Trigger => {
            let mut behaviors = vec![ControlBehavior::Press, ControlBehavior::Release];
            if action.descriptor.hold_release.is_some() {
                behaviors.push(ControlBehavior::Hold);
            }
            behaviors
        }
        ActionInputKind::Momentary => vec![ControlBehavior::Hold],
        ActionInputKind::Absolute => {
            let mut behaviors = vec![ControlBehavior::Press];
            if action.flash_level.is_some() {
                behaviors.push(ControlBehavior::Flash);
            }
            behaviors
        }
    }
}

/// Returns the level a flash press or release drives an absolute action to.
///
/// A press captures the current level and returns full; a release returns the captured
/// level, or `None` while other flashes hold the target or after the level was moved.
fn flash_level(
    world: &mut World,
    registered: &RegisteredAction,
    invocation: &ActionInvocation,
    pressed: bool,
) -> Result<Option<f32>, InvocationError> {
    let reader = registered.flash_level.as_ref().ok_or_else(|| {
        InvocationError::new(
            "action.flash_unsupported",
            format!("Action '{}' cannot flash", registered.descriptor.label),
        )
    })?;
    let current = reader(world, &invocation.action)?;
    let mut flashes = world.get_resource_or_insert_with(FlashStates::default);
    if pressed {
        flashes.press(&invocation.action, current);
        Ok(Some(FLASH_LEVEL))
    } else {
        Ok(flashes.release(&invocation.action, current))
    }
}

impl ActionRegistry {
    /// Registers a typed action invoker owned by a domain.
    ///
    /// Prefer the lowering helpers on [`crate::ActionAppExt`], which route through tracked
    /// commands or untracked updates; direct invokers are for actions that need custom
    /// orchestration around those paths.
    ///
    /// # Panics
    ///
    /// Panics when another domain has already claimed the descriptor's stable ID.
    pub fn register<A, F>(&mut self, descriptor: ActionDescriptor, invoker: F)
    where
        A: DeserializeOwned + 'static,
        F: Fn(&mut World, A, &ActionInvocation) -> Result<InvocationDispatch, InvocationError>
            + Send
            + Sync
            + 'static,
    {
        assert!(
            !self.actions.contains_key(&descriptor.id),
            "action '{}' is already registered",
            descriptor.id.as_str()
        );
        let registered_invoker = move |world: &mut World, invocation: &ActionInvocation| {
            let arguments = decode_arguments::<A>(&invocation.action)?;
            invoker(world, arguments, invocation)
        };
        self.actions.insert(
            descriptor.id.clone(),
            RegisteredAction {
                descriptor,
                invoker: Box::new(registered_invoker),
                capabilities: HashMap::new(),
                flash_level: None,
            },
        );
    }

    /// Registers a typed, deterministic capability separately from live invocation.
    ///
    /// `name` is the stable capability identifier published in the action catalog so clients
    /// can tell which actions support features such as deterministic timeline planning.
    ///
    /// # Panics
    ///
    /// Panics when the action ID is unknown or the capability output type is already registered.
    pub fn register_capability<A, C, F>(
        &mut self,
        action_id: &str,
        name: &'static str,
        capability: F,
    ) where
        A: DeserializeOwned + 'static,
        C: Send + Sync + 'static,
        F: Fn(A) -> Result<C, InvocationError> + Send + Sync + 'static,
    {
        let registered = self
            .actions
            .get_mut(&ActionId::new(action_id))
            .unwrap_or_else(|| {
                panic!("action '{action_id}' must be registered before capabilities")
            });
        let capability_type = TypeId::of::<C>();
        assert!(
            !registered.capabilities.contains_key(&capability_type),
            "action '{action_id}' already has capability '{name}'"
        );
        let resolve = move |action: &ActionReference| {
            capability(decode_arguments::<A>(action)?)
                .map(|value| Box::new(value) as Box<dyn Any + Send + Sync>)
        };
        registered.capabilities.insert(
            capability_type,
            RegisteredCapability {
                name,
                resolve: Box::new(resolve),
            },
        );
    }

    /// Resolves one deterministic capability without invoking live domain behavior.
    pub fn resolve_capability<C>(
        &self,
        action: &ActionReference,
    ) -> Result<Option<C>, InvocationError>
    where
        C: Send + Sync + 'static,
    {
        let registered = self.registered(&action.id)?;
        let Some(capability) = registered.capabilities.get(&TypeId::of::<C>()) else {
            return Ok(None);
        };
        let value = (capability.resolve)(action)?;
        value
            .downcast::<C>()
            .map(|value| Some(*value))
            .map_err(|_| {
                InvocationError::new(
                    "action.capability_type_mismatch",
                    format!(
                        "Action '{}' returned the wrong capability type",
                        action.id.as_str()
                    ),
                )
            })
    }

    /// Returns the descriptor registered for `id`, if any.
    pub fn get(&self, id: &ActionId) -> Option<&ActionDescriptor> {
        self.actions.get(id).map(|action| &action.descriptor)
    }

    /// Iterates all registered descriptors in stable action ID order.
    pub fn iter(&self) -> impl Iterator<Item = &ActionDescriptor> {
        self.actions.values().map(|action| &action.descriptor)
    }

    /// Builds the serializable catalog of descriptors and capability names.
    pub fn catalog(&self) -> Vec<ActionCatalogEntry> {
        self.actions
            .values()
            .map(|action| {
                let mut capabilities = action
                    .capabilities
                    .values()
                    .map(|capability| capability.name.to_string())
                    .collect::<Vec<_>>();
                capabilities.sort();
                ActionCatalogEntry {
                    descriptor: action.descriptor.clone(),
                    capabilities,
                    behaviors: supported_behaviors(action),
                }
            })
            .collect()
    }

    /// Resolves and invokes one action through its owning domain registration.
    ///
    /// Surface input is adapted to the action's declared input kind first; inputs that are
    /// valid but meaningless for the action (such as a trigger release) are ignored without
    /// reaching the domain.
    pub fn invoke(
        &self,
        world: &mut World,
        invocation: &ActionInvocation,
    ) -> Result<InvocationDispatch, InvocationError> {
        if is_client_action(&invocation.action.id) {
            let Some(input) = invocation.input.resolve_for(ActionInputKind::Trigger)? else {
                return Ok(InvocationDispatch::Ignored);
            };
            world.write_message(ClientActionInvocation {
                action: invocation.action.clone(),
                input,
                surface: invocation.surface,
                source: invocation.source_label(),
            });
            return Ok(InvocationDispatch::Accepted);
        }
        let registered = self.registered(&invocation.action.id)?;
        ensure_surface_allowed(&registered.descriptor, invocation.surface)?;
        let input = match (registered.descriptor.input, invocation.input) {
            (ActionInputKind::Absolute, ActionInput::Press | ActionInput::Release) => {
                let Some(level) = flash_level(
                    world,
                    registered,
                    invocation,
                    invocation.input == ActionInput::Press,
                )?
                else {
                    return Ok(InvocationDispatch::Ignored);
                };
                ActionInput::Scalar(level)
            }
            (kind, input) => match input.resolve_for(kind)? {
                Some(input) => input,
                None => return Ok(InvocationDispatch::Ignored),
            },
        };
        let resolved = ActionInvocation {
            input,
            ..invocation.clone()
        };
        (registered.invoker)(world, &resolved)
    }

    /// Registers how to read the current normalized level of an absolute action.
    ///
    /// Enables the Flash behavior: pressing pushes the action to full and releasing restores
    /// the level read on press.
    ///
    /// # Panics
    ///
    /// Panics when the action ID is unknown or the action is not absolute.
    pub fn register_flash_level<A, F>(&mut self, action_id: &str, reader: F)
    where
        A: DeserializeOwned + 'static,
        F: Fn(&World, A) -> Result<Option<f32>, InvocationError> + Send + Sync + 'static,
    {
        let registered = self
            .actions
            .get_mut(&ActionId::new(action_id))
            .unwrap_or_else(|| panic!("action '{action_id}' must be registered before its level"));
        assert_eq!(
            registered.descriptor.input,
            ActionInputKind::Absolute,
            "flash level for '{action_id}' requires an absolute action"
        );
        registered.flash_level = Some(Box::new(move |world, action| {
            reader(world, decode_arguments::<A>(action)?)
        }));
    }

    /// Returns the controller binding behaviors an action supports.
    ///
    /// Client-hosted `ui.*` actions fire on press or release; unknown actions support none.
    pub fn behaviors(&self, id: &ActionId) -> Vec<ControlBehavior> {
        if is_client_action(id) {
            return vec![ControlBehavior::Press, ControlBehavior::Release];
        }
        self.actions
            .get(id)
            .map(supported_behaviors)
            .unwrap_or_default()
    }

    /// Returns the action a Hold binding invokes on release, with the bound arguments.
    pub fn hold_release_action(&self, action: &ActionReference) -> Option<ActionReference> {
        let counterpart = self.get(&action.id)?.hold_release.clone()?;
        Some(ActionReference {
            id: counterpart,
            arguments: action.arguments.clone(),
        })
    }

    /// Validates that a stored binding can invoke its action before it is persisted.
    ///
    /// Checks that the action exists, that it may be bound on `surface`, that every required
    /// argument is present, and that the binding's source can drive the action's input kind.
    /// Actions in the reserved `ui.` namespace are hosted by connected clients and are
    /// accepted without a registration.
    pub fn validate_binding(
        &self,
        action: &ActionReference,
        surface: ActionSurface,
        can_drive: impl Fn(ActionInputKind) -> bool,
    ) -> Result<(), InvocationError> {
        if is_client_action(&action.id) {
            return Ok(());
        }
        let descriptor = &self.registered(&action.id)?.descriptor;
        ensure_surface_allowed(descriptor, surface)?;
        if let Some(missing) = descriptor.parameters.iter().find(|parameter| {
            parameter.required
                && action
                    .arguments
                    .get(&parameter.name)
                    .is_none_or(serde_json::Value::is_null)
        }) {
            return Err(InvocationError::new(
                "action.missing_argument",
                format!(
                    "Action '{}' requires the '{}' argument",
                    action.id.as_str(),
                    missing.label
                ),
            ));
        }
        if !can_drive(descriptor.input) {
            return Err(InvocationError::new(
                "action.input_incompatible",
                format!(
                    "This control cannot drive '{}', which needs {:?} input",
                    descriptor.label, descriptor.input
                ),
            ));
        }
        Ok(())
    }

    /// Validates that a controller binding's behavior suits its action and control.
    ///
    /// The action must support the behavior, and every behavior other than Press needs a
    /// control that reports being released.
    pub fn validate_behavior(
        &self,
        action: &ActionReference,
        behavior: ControlBehavior,
        reports_release: bool,
    ) -> Result<(), InvocationError> {
        if !self.behaviors(&action.id).contains(&behavior) {
            let label = self
                .get(&action.id)
                .map_or(action.id.as_str(), |descriptor| descriptor.label.as_str());
            return Err(InvocationError::new(
                "action.behavior_unsupported",
                format!("'{label}' does not support the {behavior:?} behavior"),
            ));
        }
        if behavior.needs_release() && !reports_release {
            return Err(InvocationError::new(
                "action.release_unreported",
                format!("{behavior:?} needs a control that reports being released"),
            ));
        }
        Ok(())
    }

    /// Returns the input kind of a registered action, if any.
    ///
    /// Client-hosted `ui.*` actions are triggers.
    pub fn input_kind(&self, id: &ActionId) -> Option<ActionInputKind> {
        if is_client_action(id) {
            return Some(ActionInputKind::Trigger);
        }
        self.get(id).map(|descriptor| descriptor.input)
    }

    /// Looks up a registration or reports a structured missing-action failure.
    fn registered(&self, id: &ActionId) -> Result<&RegisteredAction, InvocationError> {
        self.actions.get(id).ok_or_else(|| {
            InvocationError::new(
                "action.not_registered",
                format!("Action '{}' is not registered", id.as_str()),
            )
            .with_details(serde_json::json!({ "action_id": id }))
        })
    }
}
