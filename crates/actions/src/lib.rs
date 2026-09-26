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

/// Runtime input accepted by an action, independently of its persisted arguments.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub enum ActionInputKind {
    /// One discrete activation, after the transport has interpreted button edges.
    Trigger,
    /// An absolute, finite value in the inclusive range `0.0..=1.0`.
    Scalar,
}

/// Metadata describing one action available to automation surfaces.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct ActionDescriptor {
    /// Capabilities installed through typed registry registration, never inferred from the action ID.
    pub capabilities: Vec<ActionCapabilityDescriptor>,
    /// Stable action identifier.
    pub id: ActionId,
    /// User-facing action label.
    pub label: String,
    /// Surfaces allowed to store or invoke the action.
    pub allowed_surfaces: Vec<ActionSurface>,
    /// Input a hardware binding must produce before invoking this action.
    pub input_kind: ActionInputKind,
    /// JSON Schema describing the action's persisted arguments.
    #[typeshare(serialized_as = "unknown")]
    pub argument_schema: Value,
}

/// Stable discovery metadata paired with a typed capability resolver.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct ActionCapabilityDescriptor {
    /// Contract identifier owned by the capability's defining module.
    pub id: String,
    /// Surface permitted to resolve this capability.
    pub surface: ActionSurface,
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
            input: ActionInput::Scalar(value),
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
#[derive(Debug, Clone, Message, Serialize, Deserialize)]
#[typeshare::typeshare]
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

type CapabilityResolver = Box<
    dyn Fn(&ActionReference) -> Result<Box<dyn Any + Send + Sync>, InvocationError> + Send + Sync,
>;

type TargetValidator = Box<dyn Fn(&World, &Value) -> Result<(), InvocationError> + Send + Sync>;

struct RegisteredCapability {
    surface: ActionSurface,
    resolve: CapabilityResolver,
}

struct RegisteredAction {
    descriptor: ActionDescriptor,
    invoker: RegisteredInvoker,
    validate_arguments: Box<dyn Fn(&Value) -> Result<(), InvocationError> + Send + Sync>,
    validate_target: Option<TargetValidator>,
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
            descriptor.capabilities.is_empty(),
            "capability metadata must be installed with its typed resolver"
        );
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
                validate_arguments: Box::new(|arguments| {
                    serde_json::from_value::<A>(arguments.clone())
                        .map(|_| ())
                        .map_err(|error| {
                            InvocationError::new("action.invalid_arguments", error.to_string())
                        })
                }),
                capabilities: HashMap::new(),
                validate_target: None,
            },
        );
    }

    /// Registers read-only domain target checks for saved bindings and live dispatch.
    ///
    /// Validators inspect current domain storage without mutating it or executing the action.
    /// They must not depend on a mounted UI panel or transient playback state.
    ///
    /// # Panics
    ///
    /// Panics if the action is missing or already has a target validator.
    pub fn register_target_validator<A, F>(&mut self, action_id: &str, validator: F)
    where
        A: DeserializeOwned + 'static,
        F: Fn(&World, A) -> Result<(), InvocationError> + Send + Sync + 'static,
    {
        let registered = self
            .actions
            .get_mut(&ActionId::new(action_id))
            .unwrap_or_else(|| {
                panic!("action '{action_id}' must be registered before its target validator")
            });
        assert!(
            registered.validate_target.is_none(),
            "action '{action_id}' already has a target validator"
        );
        registered.validate_target = Some(Box::new(move |world, arguments| {
            let arguments = serde_json::from_value::<A>(arguments.clone()).map_err(|error| {
                InvocationError::new("action.invalid_arguments", error.to_string())
            })?;
            validator(world, arguments)
        }));
    }

    /// Registers a typed, deterministic capability separately from live invocation.
    ///
    /// # Panics
    ///
    /// Panics when the action is unknown, the surface is disallowed, or the capability's
    /// output type or nonempty identifier is already registered for the action.
    pub fn register_capability<A, C, F>(
        &mut self,
        action_id: &str,
        capability_id: &str,
        surface: ActionSurface,
        capability: F,
    ) where
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
            registered.descriptor.allowed_surfaces.contains(&surface),
            "capability surface must be allowed by its action"
        );
        assert!(
            !capability_id.is_empty()
                && !registered
                    .descriptor
                    .capabilities
                    .iter()
                    .any(|entry| entry.id == capability_id),
            "capability identifier must be nonempty and unique within its action"
        );
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
        registered.capabilities.insert(
            capability_type,
            RegisteredCapability {
                surface,
                resolve: Box::new(registered_capability),
            },
        );
        registered
            .descriptor
            .capabilities
            .push(ActionCapabilityDescriptor {
                id: capability_id.into(),
                surface,
            });
    }

    /// Resolves one deterministic capability without invoking live domain behavior.
    pub fn resolve_capability<C>(
        &self,
        action: &ActionReference,
        surface: ActionSurface,
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
        self.validate_binding(action, surface, registered.descriptor.input_kind)?;
        let Some(capability) = registered.capabilities.get(&TypeId::of::<C>()) else {
            return Ok(None);
        };
        if capability.surface != surface {
            return Err(InvocationError::new(
                "action.capability_surface_not_allowed",
                "This capability is not available on the requested surface",
            ));
        }
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

    /// Checks a stored binding without executing domain behavior or requiring a live target.
    /// Use `validate_resolved_binding` when current domain storage is available.
    pub fn validate_binding(
        &self,
        action: &ActionReference,
        surface: ActionSurface,
        input_kind: ActionInputKind,
    ) -> Result<(), InvocationError> {
        let registered = self.actions.get(&action.id).ok_or_else(|| {
            InvocationError::new(
                "action.not_registered",
                format!("Action '{}' is not registered", action.id.as_str()),
            )
        })?;
        if !registered.descriptor.allowed_surfaces.contains(&surface) {
            return Err(InvocationError::new(
                "action.surface_not_allowed",
                format!(
                    "Action '{}' cannot be invoked from {surface:?}",
                    action.id.as_str()
                ),
            ));
        }
        if registered.descriptor.input_kind != input_kind {
            return Err(InvocationError::new(
                "action.input_not_allowed",
                format!(
                    "Action '{}' requires {:?} input",
                    action.id.as_str(),
                    registered.descriptor.input_kind
                ),
            ));
        }
        (registered.validate_arguments)(&action.arguments)
    }

    /// Checks the binding contract and current target availability without executing the action.
    pub fn validate_resolved_binding(
        &self,
        world: &World,
        action: &ActionReference,
        surface: ActionSurface,
        input_kind: ActionInputKind,
    ) -> Result<(), InvocationError> {
        self.validate_binding(action, surface, input_kind)?;
        self.validate_target(world, action)
    }

    /// Checks domain arguments and target existence independently of transport input conversion.
    pub fn validate_target(
        &self,
        world: &World,
        action: &ActionReference,
    ) -> Result<(), InvocationError> {
        let registered = self.actions.get(&action.id).ok_or_else(|| {
            InvocationError::new(
                "action.not_registered",
                format!("Action '{}' is not registered", action.id.as_str()),
            )
        })?;
        (registered.validate_arguments)(&action.arguments)?;
        if let Some(validate) = &registered.validate_target {
            validate(world, &action.arguments)?;
        }
        Ok(())
    }

    /// Resolves and invokes one action through its owning domain registration.
    pub fn invoke(
        &self,
        world: &mut World,
        invocation: &ActionInvocation,
    ) -> Result<InvocationDispatch, InvocationError> {
        let input_kind = match invocation.input {
            ActionInput::Trigger => ActionInputKind::Trigger,
            ActionInput::Scalar(value) => {
                if !value.is_finite() || !(0.0..=1.0).contains(&value) {
                    return Err(InvocationError::new(
                        "action.invalid_input",
                        "Scalar input must be finite and between zero and one",
                    ));
                }
                ActionInputKind::Scalar
            }
        };
        self.validate_resolved_binding(world, &invocation.action, invocation.surface, input_kind)?;
        let registered = self
            .actions
            .get(&invocation.action.id)
            .expect("validated action remains registered during immutable lookup");
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
            capabilities: Vec::new(),
            label: "Apply test action".to_string(),
            allowed_surfaces: vec![ActionSurface::Midi],
            input_kind: ActionInputKind::Trigger,
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
            .register_capability::<TestArguments, TestCapability, _>(
                "test.apply",
                "test.capability.v1",
                ActionSurface::Midi,
                |arguments| Ok(TestCapability(arguments.value)),
            );
    }

    /// Saving a binding validates its arguments and input without executing it.
    #[test]
    fn binding_validation_is_side_effect_free() {
        let mut app = App::new();
        app.add_plugins(ActionsPlugin);
        register_test_action(&mut app);
        let registry = app.world().resource::<ActionRegistry>();
        let action = ActionReference::new("test.apply", json!({ "value": 42 }));
        assert!(
            registry
                .validate_binding(&action, ActionSurface::Midi, ActionInputKind::Trigger)
                .is_ok()
        );
        assert_eq!(
            registry
                .validate_binding(&action, ActionSurface::Midi, ActionInputKind::Scalar)
                .unwrap_err()
                .code,
            "action.input_not_allowed"
        );
        assert_eq!(
            registry
                .validate_binding(
                    &ActionReference::new("test.apply", json!({})),
                    ActionSurface::Midi,
                    ActionInputKind::Trigger
                )
                .unwrap_err()
                .code,
            "action.invalid_arguments"
        );
        assert!(
            app.world()
                .resource::<Messages<TestActionApplied>>()
                .is_empty()
        );
    }

    /// Domain checks observe current storage and reject dispatch without applying side effects.
    #[test]
    fn resolved_binding_validation_tracks_domain_storage_without_invocation() {
        #[derive(Resource)]
        struct Target(u32);

        let mut app = App::new();
        app.add_plugins(ActionsPlugin);
        register_test_action(&mut app);
        app.insert_resource(Target(42));
        app.world_mut()
            .resource_mut::<ActionRegistry>()
            .register_target_validator::<TestArguments, _>("test.apply", |world, arguments| {
                if world
                    .get_resource::<Target>()
                    .is_some_and(|target| target.0 == arguments.value)
                {
                    Ok(())
                } else {
                    Err(InvocationError::new(
                        "test.target_missing",
                        "Target is unavailable",
                    ))
                }
            });
        let action = ActionReference::new("test.apply", json!({"value": 42}));
        assert!(
            app.world()
                .resource::<ActionRegistry>()
                .validate_resolved_binding(
                    app.world(),
                    &action,
                    ActionSurface::Midi,
                    ActionInputKind::Trigger,
                )
                .is_ok()
        );
        assert!(
            app.world()
                .resource::<Messages<TestActionApplied>>()
                .is_empty()
        );
        app.world_mut().remove_resource::<Target>();
        assert_eq!(
            app.world()
                .resource::<ActionRegistry>()
                .validate_resolved_binding(
                    app.world(),
                    &action,
                    ActionSurface::Midi,
                    ActionInputKind::Trigger,
                )
                .unwrap_err()
                .code,
            "test.target_missing"
        );
        app.world_mut()
            .write_message(ActionInvocation::trigger(action, ActionSurface::Midi));
        app.update();
        assert!(
            app.world()
                .resource::<Messages<TestActionApplied>>()
                .is_empty()
        );
        let result = app
            .world_mut()
            .resource_mut::<Messages<InvocationResult>>()
            .drain()
            .next()
            .unwrap();
        assert!(
            matches!(result.outcome, InvocationOutcome::Failed(error) if error.code == "test.target_missing")
        );
    }

    /// Invalid continuous values are rejected rather than clamped or passed to domain code.
    #[test]
    fn scalar_invocations_reject_nonfinite_and_out_of_range_values() {
        let mut registry = ActionRegistry::default();
        let mut descriptor = test_descriptor();
        descriptor.input_kind = ActionInputKind::Scalar;
        registry.register::<TestArguments, _>(descriptor, |_, _, _| {
            Ok(InvocationDispatch::succeeded())
        });
        let mut world = World::new();
        for value in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY, -0.1, 1.1] {
            let invocation = ActionInvocation::scalar(
                ActionReference::new("test.apply", json!({ "value": 42 })),
                ActionSurface::Midi,
                value,
            );
            assert_eq!(
                registry.invoke(&mut world, &invocation).unwrap_err().code,
                "action.invalid_input"
            );
        }
        for value in [0.0, 0.5, 1.0] {
            let invocation = ActionInvocation::scalar(
                ActionReference::new("test.apply", json!({ "value": 42 })),
                ActionSurface::Midi,
                value,
            );
            assert!(registry.invoke(&mut world, &invocation).is_ok());
        }
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
            .resolve_capability::<TestCapability>(&action, ActionSurface::Midi)
            .expect("valid arguments should resolve")
            .expect("test action should expose its deterministic capability");

        assert_eq!(capability, TestCapability(42));
        let registry = app.world().resource::<ActionRegistry>();
        assert_eq!(
            registry.get(&action.id).unwrap().capabilities,
            vec![ActionCapabilityDescriptor {
                id: "test.capability.v1".into(),
                surface: ActionSurface::Midi,
            }]
        );
        assert!(
            registry
                .resolve_capability::<TestCapability>(&action, ActionSurface::Timeline)
                .is_err(),
            "typed resolution must enforce the action surface"
        );
        assert!(
            app.world_mut()
                .resource_mut::<Messages<TestActionApplied>>()
                .drain()
                .next()
                .is_none(),
            "capability resolution must not execute the live invoker"
        );
    }

    /// Capability metadata cannot claim support without a corresponding resolver.
    #[test]
    #[should_panic(expected = "capability metadata must be installed")]
    fn action_cannot_advertise_unregistered_capability() {
        let mut descriptor = test_descriptor();
        descriptor.capabilities.push(ActionCapabilityDescriptor {
            id: "claimed".into(),
            surface: ActionSurface::Midi,
        });
        ActionRegistry::default().register::<TestArguments, _>(descriptor, |_, _, _| {
            Ok(InvocationDispatch::succeeded())
        });
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
