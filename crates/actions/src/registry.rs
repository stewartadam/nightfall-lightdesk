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

use crate::descriptor::{ActionCatalogEntry, ActionDescriptor, ActionId, ActionInputKind};
use crate::invocation::{ActionInvocation, ActionReference, InvocationDispatch, InvocationError};

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
}

/// App-wide registry of action descriptors and domain-owned invokers.
#[derive(Default, Resource)]
pub struct ActionRegistry {
    actions: BTreeMap<ActionId, RegisteredAction>,
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
        let registered = self.registered(&invocation.action.id)?;
        let Some(input) = invocation.input.resolve_for(registered.descriptor.input)? else {
            return Ok(InvocationDispatch::Ignored);
        };
        let resolved = ActionInvocation {
            input,
            ..invocation.clone()
        };
        (registered.invoker)(world, &resolved)
    }

    /// Validates that a stored binding can invoke its action before it is persisted.
    ///
    /// Checks that the action exists, that every required argument is present, and that the
    /// binding's source can drive the action's input kind. Actions in the reserved `ui.`
    /// namespace are hosted by connected clients and are accepted without a registration.
    pub fn validate_binding(
        &self,
        action: &ActionReference,
        can_drive: impl Fn(ActionInputKind) -> bool,
    ) -> Result<(), InvocationError> {
        if action.id.as_str().starts_with(CLIENT_ACTION_PREFIX) {
            return Ok(());
        }
        let descriptor = &self.registered(&action.id)?.descriptor;
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

    /// Returns the input kind of a registered action, if any.
    pub fn input_kind(&self, id: &ActionId) -> Option<ActionInputKind> {
        self.get(id).map(|descriptor| descriptor.input)
    }

    /// Looks up a registration or reports a structured missing-action failure.
    fn registered(&self, id: &ActionId) -> Result<&RegisteredAction, InvocationError> {
        self.actions.get(id).ok_or_else(|| {
            InvocationError::new(
                "action.not_registered",
                format!("Action '{}' is not registered", id.as_str()),
            )
        })
    }
}
