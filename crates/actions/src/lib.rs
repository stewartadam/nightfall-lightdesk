// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Shared action registry contracts used by automation surfaces.

use std::any::{Any, TypeId};
use std::collections::{BTreeMap, HashMap};

use bevy_app::{App, Plugin, Update};
use bevy_ecs::{
    prelude::{Message, MessageReader, Messages, Resource, SystemSet, World},
    schedule::IntoScheduleConfigs,
    system::SystemState,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use uuid::Uuid;

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

/// Surface that can invoke a registered action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub enum ActionSurface {
    /// A timeline action invoked the action.
    Timeline,
    /// A MIDI mapping invoked the action.
    Midi,
    /// An OSC mapping invoked the action.
    Osc,
    /// A command palette entry invoked the action.
    CommandPalette,
    /// A websocket command invoked the action.
    Websocket,
}

/// Metadata describing one action available to automation surfaces.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct ActionDescriptor {
    /// Stable action identifier.
    pub id: ActionId,
    /// User-facing action label.
    pub label: String,
    /// Surfaces allowed to store or invoke the action.
    pub allowed_surfaces: Vec<ActionSurface>,
    /// JSON Schema describing the action's persisted arguments.
    #[typeshare(serialized_as = "unknown")]
    pub argument_schema: Value,
}

/// Failure reported while resolving or invoking a registered action.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct InvocationError {
    /// Stable machine-readable failure code.
    pub code: String,
    /// User-presentable description of the failure.
    pub message: String,
}

impl InvocationError {
    /// Creates a structured invocation failure.
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

/// Stable identity for one runtime use of a registered action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct InvocationId(#[typeshare(serialized_as = "String")] pub Uuid);

impl InvocationId {
    /// Creates a fresh action invocation identity.
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for InvocationId {
    fn default() -> Self {
        Self::new()
    }
}

/// Runtime input supplied by an automation surface.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum ActionInput {
    /// A discrete trigger without a continuously varying value.
    Trigger,
    /// A normalized scalar in the inclusive range `0.0..=1.0`.
    Scalar(f32),
}

/// Stored reference to a registered action plus domain-owned arguments.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct ActionReference {
    /// Stable action identifier to dispatch.
    pub id: ActionId,
    /// Arguments interpreted only by the domain that registered the action.
    #[typeshare(serialized_as = "unknown")]
    pub arguments: Value,
}

impl ActionReference {
    /// Creates an action reference from already-erased JSON arguments.
    pub fn new(id: impl Into<String>, arguments: Value) -> Self {
        Self {
            id: ActionId::new(id),
            arguments,
        }
    }

    /// Serializes typed domain arguments into a persisted action reference.
    pub fn with_arguments<T: Serialize>(
        id: impl Into<String>,
        arguments: &T,
    ) -> Result<Self, serde_json::Error> {
        Ok(Self::new(id, serde_json::to_value(arguments)?))
    }
}

/// One action invocation submitted by an automation surface.
#[derive(Debug, Clone, Message)]
pub struct ActionInvocation {
    /// Identity of this individual invocation.
    pub invocation_id: InvocationId,
    /// Persisted action ID and arguments to resolve.
    pub action: ActionReference,
    /// Surface that produced the invocation.
    pub surface: ActionSurface,
    /// Runtime trigger or continuous input value.
    pub input: ActionInput,
    /// Optional human-readable source detail for diagnostics and UI feedback.
    pub source: Option<String>,
}

impl ActionInvocation {
    /// Creates a discrete action invocation with a fresh identity.
    pub fn trigger(action: ActionReference, surface: ActionSurface) -> Self {
        Self {
            invocation_id: InvocationId::new(),
            action,
            surface,
            input: ActionInput::Trigger,
            source: None,
        }
    }

    /// Creates a normalized scalar invocation with a fresh identity.
    pub fn scalar(action: ActionReference, surface: ActionSurface, value: f32) -> Self {
        Self {
            invocation_id: InvocationId::new(),
            action,
            surface,
            input: ActionInput::Scalar(value.clamp(0.0, 1.0)),
            source: None,
        }
    }

    /// Attaches human-readable source detail to an invocation.
    pub fn with_source(mut self, source: impl Into<String>) -> Self {
        self.source = Some(source.into());
        self
    }
}

/// Immediate disposition returned by a domain-owned live invoker.
#[derive(Debug, Clone, PartialEq)]
pub enum InvocationDispatch {
    /// The domain queued work whose terminal outcome is not yet known.
    Accepted,
    /// The domain completed the invocation synchronously.
    Succeeded {
        /// Optional domain-owned output erased at the registry boundary.
        output: Option<Value>,
    },
}

impl InvocationDispatch {
    /// Creates a synchronous success without domain output.
    pub fn succeeded() -> Self {
        Self::Succeeded { output: None }
    }

    /// Creates a synchronous success containing domain-owned output.
    pub fn with_output(output: Value) -> Self {
        Self::Succeeded {
            output: Some(output),
        }
    }
}

/// Observable state of registry lookup, dispatch, or terminal domain work.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum InvocationOutcome {
    /// The owning domain accepted work whose terminal outcome is not yet known.
    Accepted,
    /// The owning domain completed the invocation successfully.
    Succeeded {
        /// Optional domain-owned output erased at the registry boundary.
        #[typeshare(serialized_as = "Option<unknown>")]
        output: Option<Value>,
    },
    /// The registry or owning domain rejected the invocation.
    Failed(InvocationError),
}

/// Invocation state observable by an automation surface after dispatch or completion.
#[derive(Debug, Clone, Message)]
pub struct InvocationResult {
    /// Invocation whose dispatch completed.
    pub invocation_id: InvocationId,
    /// Registered action that was resolved.
    pub action_id: ActionId,
    /// Accepted, terminal success, or terminal failure state.
    pub outcome: InvocationOutcome,
}

/// Notification that a registered action intentionally started a user-visible command.
#[derive(Debug, Clone, Message)]
pub struct ExternalCommandInvocation {
    /// Action invocation that created the command.
    pub invocation_id: InvocationId,
    /// Correlation identity of the created command lifecycle.
    pub command_id: Uuid,
    /// Command text presented to the operator.
    pub command: String,
    /// Automation surface that originated the command.
    pub surface: ActionSurface,
    /// Human-readable source label.
    pub source: String,
}

type RegisteredInvoker = Box<
    dyn Fn(&mut World, &ActionInvocation) -> Result<InvocationDispatch, InvocationError>
        + Send
        + Sync,
>;

type RegisteredCapability = Box<
    dyn Fn(&ActionReference) -> Result<Box<dyn Any + Send + Sync>, InvocationError> + Send + Sync,
>;

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

impl ActionRegistry {
    /// Registers a typed action invoker owned by a domain.
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
        let registered_invoker = move |world: &mut World,
                                       invocation: &ActionInvocation|
              -> Result<InvocationDispatch, InvocationError> {
            let arguments = serde_json::from_value::<A>(invocation.action.arguments.clone())
                .map_err(|error| {
                    InvocationError::new(
                        "action.invalid_arguments",
                        format!(
                            "Invalid arguments for action '{}': {error}",
                            invocation.action.id.as_str()
                        ),
                    )
                })?;
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
    /// # Panics
    ///
    /// Panics when the action ID is unknown or the capability output type is already registered.
    pub fn register_capability<A, C, F>(&mut self, action_id: &str, capability: F)
    where
        A: DeserializeOwned + 'static,
        C: Send + Sync + 'static,
        F: Fn(A) -> Result<C, InvocationError> + Send + Sync + 'static,
    {
        let id = ActionId::new(action_id);
        let registered = self.actions.get_mut(&id).unwrap_or_else(|| {
            panic!("action '{action_id}' must be registered before capabilities")
        });
        let capability_type = TypeId::of::<C>();
        assert!(
            !registered.capabilities.contains_key(&capability_type),
            "action '{action_id}' already has capability '{}'",
            std::any::type_name::<C>()
        );
        let registered_capability = move |action: &ActionReference| {
            let arguments =
                serde_json::from_value::<A>(action.arguments.clone()).map_err(|error| {
                    InvocationError::new(
                        "action.invalid_arguments",
                        format!(
                            "Invalid arguments for action '{}': {error}",
                            action.id.as_str()
                        ),
                    )
                })?;
            capability(arguments).map(|value| Box::new(value) as Box<dyn Any + Send + Sync>)
        };
        registered
            .capabilities
            .insert(capability_type, Box::new(registered_capability));
    }

    /// Resolves one deterministic capability without invoking live domain behavior.
    pub fn resolve_capability<C>(
        &self,
        action: &ActionReference,
    ) -> Result<Option<C>, InvocationError>
    where
        C: Send + Sync + 'static,
    {
        let Some(registered) = self.actions.get(&action.id) else {
            return Err(InvocationError::new(
                "action.not_registered",
                format!("Action '{}' is not registered", action.id.as_str()),
            ));
        };
        let Some(capability) = registered.capabilities.get(&TypeId::of::<C>()) else {
            return Ok(None);
        };
        let value = capability(action)?;
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

    /// Resolves and invokes one action through its owning domain registration.
    pub fn invoke(
        &self,
        world: &mut World,
        invocation: &ActionInvocation,
    ) -> Result<InvocationDispatch, InvocationError> {
        let Some(registered) = self.actions.get(&invocation.action.id) else {
            return Err(InvocationError::new(
                "action.not_registered",
                format!(
                    "Action '{}' is not registered",
                    invocation.action.id.as_str()
                ),
            ));
        };
        if !registered
            .descriptor
            .allowed_surfaces
            .contains(&invocation.surface)
        {
            return Err(InvocationError::new(
                "action.surface_not_allowed",
                format!(
                    "Action '{}' cannot be invoked from {:?}",
                    invocation.action.id.as_str(),
                    invocation.surface
                ),
            ));
        }
        (registered.invoker)(world, invocation)
    }
}

/// Plugin that installs the generic registered-action invocation stage.
pub struct ActionsPlugin;

/// System set that resolves generic action invocations before domain event handling.
#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub struct ActionInvocationHandling;

impl Plugin for ActionsPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<ActionRegistry>();
        app.add_message::<ActionInvocation>();
        app.add_message::<InvocationResult>();
        app.add_message::<ExternalCommandInvocation>();
        app.add_systems(
            Update,
            dispatch_action_invocations.in_set(ActionInvocationHandling),
        );
    }
}

/// Dispatches queued invocations and publishes their immediate accepted or terminal state.
pub fn dispatch_action_invocations(
    world: &mut World,
    state: &mut SystemState<MessageReader<ActionInvocation>>,
) {
    let invocations = {
        let mut reader = state
            .get_mut(world)
            .expect("action invocation reader should be available");
        reader.read().cloned().collect::<Vec<_>>()
    };
    for invocation in invocations {
        let outcome = world.resource_scope(
            |world, registry: bevy_ecs::change_detection::Mut<ActionRegistry>| {
                registry.invoke(world, &invocation)
            },
        );
        let outcome = match outcome {
            Ok(InvocationDispatch::Accepted) => InvocationOutcome::Accepted,
            Ok(InvocationDispatch::Succeeded { output }) => InvocationOutcome::Succeeded { output },
            Err(error) => InvocationOutcome::Failed(error),
        };
        world
            .resource_mut::<Messages<InvocationResult>>()
            .write(InvocationResult {
                invocation_id: invocation.invocation_id,
                action_id: invocation.action.id,
                outcome,
            });
    }
}

#[cfg(test)]
mod tests {
    use bevy_ecs::message::Messages;
    use serde::Deserialize;
    use serde_json::json;

    use super::*;

    /// Arguments decoded only by the test action registration.
    #[derive(Deserialize)]
    struct TestArguments {
        value: u32,
    }

    /// Deterministic interpretation exposed independently of live invocation.
    #[derive(Debug, PartialEq, Eq)]
    struct TestCapability(u32);

    /// Message proving a registered invoker reached domain-owned behavior.
    #[derive(Clone, Debug, Message, PartialEq, Eq)]
    struct TestActionApplied(u32);

    /// Creates a descriptor accepted only from MIDI for focused registry tests.
    fn test_descriptor() -> ActionDescriptor {
        ActionDescriptor {
            id: ActionId::new("test.apply"),
            label: "Apply test action".to_string(),
            allowed_surfaces: vec![ActionSurface::Midi],
            argument_schema: json!({ "type": "object" }),
        }
    }

    /// Registers the test action and installs its domain output message.
    fn register_test_action(app: &mut App) {
        app.add_message::<TestActionApplied>();
        app.world_mut()
            .resource_mut::<ActionRegistry>()
            .register::<TestArguments, _>(test_descriptor(), |world, arguments, _invocation| {
                world.write_message(TestActionApplied(arguments.value));
                Ok(InvocationDispatch::succeeded())
            });
        app.world_mut()
            .resource_mut::<ActionRegistry>()
            .register_capability::<TestArguments, TestCapability, _>("test.apply", |arguments| {
                Ok(TestCapability(arguments.value))
            });
    }

    /// Verifies deterministic capability resolution does not invoke live domain behavior.
    #[test]
    fn registered_capability_resolves_without_live_invocation() {
        let mut app = App::new();
        app.add_plugins(ActionsPlugin);
        register_test_action(&mut app);
        let action = ActionReference::new("test.apply", json!({ "value": 42 }));

        let capability = app
            .world()
            .resource::<ActionRegistry>()
            .resolve_capability::<TestCapability>(&action)
            .expect("valid arguments should resolve")
            .expect("test action should expose its deterministic capability");

        assert_eq!(capability, TestCapability(42));
        assert!(
            app.world_mut()
                .resource_mut::<Messages<TestActionApplied>>()
                .drain()
                .next()
                .is_none(),
            "capability resolution must not execute the live invoker"
        );
    }

    /// Verifies a surface invokes registered domain behavior through opaque arguments.
    #[test]
    fn registered_action_dispatches_to_owning_domain() {
        let mut app = App::new();
        app.add_plugins(ActionsPlugin);
        register_test_action(&mut app);
        app.world_mut().write_message(ActionInvocation::trigger(
            ActionReference::new("test.apply", json!({ "value": 42 })),
            ActionSurface::Midi,
        ));

        app.update();

        let applied = app
            .world_mut()
            .resource_mut::<Messages<TestActionApplied>>()
            .drain()
            .collect::<Vec<_>>();
        assert_eq!(applied, vec![TestActionApplied(42)]);
        let results = app
            .world_mut()
            .resource_mut::<Messages<InvocationResult>>()
            .drain()
            .collect::<Vec<_>>();
        assert_eq!(results.len(), 1);
        assert!(matches!(
            results[0].outcome,
            InvocationOutcome::Succeeded { output: None }
        ));
    }

    /// Verifies queued domain work reports acceptance instead of terminal success.
    #[test]
    fn registered_action_distinguishes_acceptance_from_success() {
        let mut app = App::new();
        app.add_plugins(ActionsPlugin);
        app.world_mut()
            .resource_mut::<ActionRegistry>()
            .register::<TestArguments, _>(test_descriptor(), |_world, _arguments, _invocation| {
                Ok(InvocationDispatch::Accepted)
            });
        app.world_mut().write_message(ActionInvocation::trigger(
            ActionReference::new("test.apply", json!({ "value": 42 })),
            ActionSurface::Midi,
        ));

        app.update();

        let result = app
            .world_mut()
            .resource_mut::<Messages<InvocationResult>>()
            .drain()
            .next()
            .expect("accepted invocation should return a result");
        assert!(matches!(result.outcome, InvocationOutcome::Accepted));
    }

    /// Verifies an unsupported surface is rejected before domain behavior runs.
    #[test]
    fn registered_action_rejects_disallowed_surface() {
        let mut app = App::new();
        app.add_plugins(ActionsPlugin);
        register_test_action(&mut app);
        app.world_mut().write_message(ActionInvocation::trigger(
            ActionReference::new("test.apply", json!({ "value": 42 })),
            ActionSurface::Osc,
        ));

        app.update();

        assert!(
            app.world_mut()
                .resource_mut::<Messages<TestActionApplied>>()
                .drain()
                .next()
                .is_none()
        );
        let result = app
            .world_mut()
            .resource_mut::<Messages<InvocationResult>>()
            .drain()
            .next()
            .expect("rejected invocation should return a result");
        assert!(matches!(
            result.outcome,
            InvocationOutcome::Failed(InvocationError { ref code, .. })
                if code == "action.surface_not_allowed"
        ));
    }

    /// Verifies malformed domain arguments produce a structured registry failure.
    #[test]
    fn registered_action_rejects_invalid_arguments() {
        let mut app = App::new();
        app.add_plugins(ActionsPlugin);
        register_test_action(&mut app);
        app.world_mut().write_message(ActionInvocation::trigger(
            ActionReference::new("test.apply", json!({ "wrong": true })),
            ActionSurface::Midi,
        ));

        app.update();

        let result = app
            .world_mut()
            .resource_mut::<Messages<InvocationResult>>()
            .drain()
            .next()
            .expect("invalid arguments should return a result");
        assert!(matches!(
            result.outcome,
            InvocationOutcome::Failed(InvocationError { ref code, .. })
                if code == "action.invalid_arguments"
        ));
    }

    /// Verifies two domains cannot silently replace one another's stable action ID.
    #[test]
    #[should_panic(expected = "action 'test.apply' is already registered")]
    fn duplicate_action_registration_panics() {
        let mut app = App::new();
        app.add_plugins(ActionsPlugin);
        register_test_action(&mut app);
        register_test_action(&mut app);
    }
}
