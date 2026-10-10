// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Change tracking and diagnostics for the domain objects stored bindings address.
//!
//! Domains register read-only target validators per parameter kind on the
//! [`crate::ActionRegistry`] and mark [`ActionTargets`] changed when the state those
//! validators read changes. Binding surfaces recompute their diagnostics only when their
//! bindings, the registry, or [`ActionTargets`] changed, never on every invocation.

use bevy_ecs::prelude::{DetectChanges, DetectChangesMut, Res, ResMut, Resource, SystemSet};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::invocation::InvocationError;
use crate::registry::ActionRegistry;

/// Change marker for domain state that action target validators resolve against.
///
/// Its change tick is the only meaningful state: domains mark it changed with
/// [`crate::ActionAppExt::invalidate_action_targets_when`] when objects such as clips or
/// masters are added, removed, or renamed.
#[derive(Resource, Default, Debug)]
pub struct ActionTargets;

/// System set in which domains mark [`ActionTargets`] changed.
///
/// Runs after domain command handling and before client output, so binding diagnostics
/// computed during client output see the same frame's target changes.
#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub struct ActionTargetTracking;

/// Marks action targets changed so binding diagnostics are recomputed.
pub fn mark_action_targets_changed(mut targets: ResMut<ActionTargets>) {
    targets.set_changed();
}

/// Run condition reporting whether bindings stored in `T` need their diagnostics recomputed.
///
/// Diagnostics go stale when the bindings change, when action registrations change, or
/// when a domain marked the objects that bindings address as changed.
pub fn bindings_need_diagnosis<T: Resource>(
    bindings: Res<T>,
    registry: Res<ActionRegistry>,
    targets: Res<ActionTargets>,
) -> bool {
    bindings.is_changed() || registry.is_changed() || targets.is_changed()
}

/// A stored binding that cannot currently invoke its action, and why.
///
/// Bindings stay stored while invalid so they recover when their target reappears, such
/// as after an undo or when a showfile is loaded in stages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct BindingDiagnostic {
    /// Identity of the binding, such as a MIDI or OSC mapping ID.
    #[typeshare(serialized_as = "String")]
    pub binding_id: Uuid,
    /// Why the binding cannot invoke its action.
    pub error: InvocationError,
}

/// Collects the failed validations of a set of bindings, in binding order.
pub fn collect_binding_diagnostics(
    results: impl IntoIterator<Item = (Uuid, Result<(), InvocationError>)>,
) -> Vec<BindingDiagnostic> {
    results
        .into_iter()
        .filter_map(|(binding_id, result)| {
            result
                .err()
                .map(|error| BindingDiagnostic { binding_id, error })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use bevy_app::{App, Update};
    use bevy_ecs::prelude::{IntoScheduleConfigs, Local, Res, ResMut, Resource, World};
    use bevy_ecs::schedule::common_conditions::resource_changed;
    use serde::Deserialize;
    use serde_json::json;

    use super::*;
    use crate::{
        ActionAppExt, ActionDescriptor, ActionParameter, ActionParameterKind, ActionReference,
        ActionSurface, ActionsPlugin, InvocationDispatch,
    };

    /// Clip UIDs the test domain knows about, standing in for domain storage.
    #[derive(Resource, Default)]
    struct KnownClips(HashSet<Uuid>);

    /// Bindings stored by the test surface, keyed by binding ID.
    #[derive(Resource, Default)]
    struct TestBindings(Vec<(Uuid, ActionReference)>);

    /// Diagnostics recomputed by the test surface, plus how often they were recomputed.
    #[derive(Resource, Default)]
    struct TestDiagnostics {
        diagnostics: Vec<BindingDiagnostic>,
        recomputed: usize,
    }

    /// Typed arguments of the test clip action.
    #[derive(Deserialize)]
    #[allow(dead_code)]
    struct ClipArguments {
        clip: Uuid,
        rate: Option<f64>,
    }

    /// Builds an app with a clip action, a clip target validator, and a diagnosing surface.
    fn target_app() -> App {
        let mut app = App::new();
        app.add_plugins(ActionsPlugin);
        app.init_resource::<KnownClips>();
        app.init_resource::<TestBindings>();
        app.init_resource::<TestDiagnostics>();
        app.register_action::<ClipArguments, _>(
            ActionDescriptor::new("test.clip", "Test clip", "Tests")
                .with_parameter(ActionParameter::required(
                    "clip",
                    "Clip",
                    ActionParameterKind::Clip,
                ))
                .with_parameter(ActionParameter::optional(
                    "rate",
                    "Rate",
                    ActionParameterKind::Number { min: 0.0, max: 4.0 },
                )),
            |_world, _arguments, _invocation| Ok(InvocationDispatch::succeeded()),
        )
        .register_action_target_validator::<Uuid, _>(ActionParameterKind::Clip, |world, uid| {
            if world.resource::<KnownClips>().0.contains(&uid) {
                Ok(())
            } else {
                Err(InvocationError::new(
                    "clip.not_found",
                    "Clip does not exist",
                ))
            }
        })
        .invalidate_action_targets_when(resource_changed::<KnownClips>);
        app.add_systems(
            Update,
            diagnose_test_bindings
                .run_if(bindings_need_diagnosis::<TestBindings>)
                .after(ActionTargetTracking),
        );
        app
    }

    /// Recomputes diagnostics of the test bindings, counting each recomputation.
    fn diagnose_test_bindings(world: &mut World) {
        let diagnostics = {
            let registry = world.resource::<ActionRegistry>();
            let bindings = world.resource::<TestBindings>();
            collect_binding_diagnostics(bindings.0.iter().map(|(id, action)| {
                (
                    *id,
                    registry
                        .validate_reference(action, ActionSurface::Midi)
                        .and_then(|()| registry.validate_target(world, action)),
                )
            }))
        };
        let mut state = world.resource_mut::<TestDiagnostics>();
        state.diagnostics = diagnostics;
        state.recomputed += 1;
    }

    /// Returns the registry of a test app.
    fn registry(app: &App) -> &ActionRegistry {
        app.world().resource::<ActionRegistry>()
    }

    /// Verifies argument validation rejects missing, mistyped, and out-of-range arguments.
    #[test]
    fn argument_validation_rejects_bad_arguments() {
        let app = target_app();
        let registry = registry(&app);
        let uid = Uuid::from_u128(1);

        assert!(
            registry
                .validate_arguments(&ActionReference::new("test.clip", json!({ "clip": uid })))
                .is_ok()
        );
        let missing = registry
            .validate_arguments(&ActionReference::new("test.clip", json!({})))
            .expect_err("missing clip should be rejected");
        assert_eq!(missing.code, "action.missing_argument");
        let mistyped = registry
            .validate_arguments(&ActionReference::new(
                "test.clip",
                json!({ "clip": "not-a-uid" }),
            ))
            .expect_err("a non-UID clip should be rejected");
        assert_eq!(mistyped.code, "action.invalid_arguments");
        let out_of_range = registry
            .validate_arguments(&ActionReference::new(
                "test.clip",
                json!({ "clip": uid, "rate": 9.0 }),
            ))
            .expect_err("a rate above its range should be rejected");
        assert_eq!(out_of_range.code, "action.invalid_arguments");
        assert_eq!(out_of_range.details, Some(json!({ "parameter": "rate" })));
        let unregistered = registry
            .validate_arguments(&ActionReference::new("test.missing", json!({})))
            .expect_err("an unregistered action should be rejected");
        assert_eq!(unregistered.code, "action.not_registered");
    }

    /// Verifies target validation resolves arguments through the kind's domain validator.
    #[test]
    fn target_validation_reports_missing_targets() {
        let mut app = target_app();
        let uid = Uuid::from_u128(7);
        let action = ActionReference::new("test.clip", json!({ "clip": uid }));

        let error = registry(&app)
            .validate_target(app.world(), &action)
            .expect_err("unknown clip should be reported");
        assert_eq!(error.code, "clip.not_found");

        app.world_mut().resource_mut::<KnownClips>().0.insert(uid);
        assert!(registry(&app).validate_target(app.world(), &action).is_ok());
        assert!(
            registry(&app)
                .validate_target(
                    app.world(),
                    &ActionReference::new("ui.open-panel", json!({}))
                )
                .is_ok(),
            "client-hosted actions have no backend targets"
        );
    }

    /// Verifies a second validator for the same parameter kind is refused.
    #[test]
    #[should_panic(expected = "already registered")]
    fn duplicate_target_validator_panics() {
        let mut app = target_app();
        app.register_action_target_validator::<Uuid, _>(ActionParameterKind::Clip, |_, _| Ok(()));
    }

    /// Verifies diagnostics recompute only when bindings or their targets change.
    #[test]
    fn diagnostics_recompute_only_when_bindings_or_targets_change() {
        let mut app = target_app();
        let uid = Uuid::from_u128(3);
        let binding = Uuid::from_u128(10);
        app.world_mut().resource_mut::<TestBindings>().0.push((
            binding,
            ActionReference::new("test.clip", json!({ "clip": uid })),
        ));
        app.update();
        let first = app.world().resource::<TestDiagnostics>();
        assert_eq!(first.recomputed, 1);
        assert_eq!(first.diagnostics.len(), 1);
        assert_eq!(first.diagnostics[0].binding_id, binding);
        assert_eq!(first.diagnostics[0].error.code, "clip.not_found");

        app.update();
        app.update();
        assert_eq!(
            app.world().resource::<TestDiagnostics>().recomputed,
            1,
            "unchanged bindings and targets must not be re-diagnosed"
        );

        app.world_mut().resource_mut::<KnownClips>().0.insert(uid);
        app.update();
        let recovered = app.world().resource::<TestDiagnostics>();
        assert_eq!(recovered.recomputed, 2);
        assert!(recovered.diagnostics.is_empty());
    }

    /// Verifies the change marker is untouched on frames where the domain condition fails.
    #[test]
    fn target_marker_follows_domain_condition() {
        /// Counts frames on which the target marker reported a change.
        fn count_changes(
            targets: Res<ActionTargets>,
            mut changes: Local<usize>,
            mut out: ResMut<Changes>,
        ) {
            if targets.is_changed() {
                *changes += 1;
            }
            out.0 = *changes;
        }
        /// Number of frames on which action targets changed.
        #[derive(Resource, Default)]
        struct Changes(usize);

        let mut app = target_app();
        app.init_resource::<Changes>();
        app.add_systems(Update, count_changes.after(ActionTargetTracking));
        app.update();
        app.update();
        let baseline = app.world().resource::<Changes>().0;
        app.update();
        assert_eq!(app.world().resource::<Changes>().0, baseline);
        app.world_mut()
            .resource_mut::<KnownClips>()
            .0
            .insert(Uuid::nil());
        app.update();
        assert_eq!(app.world().resource::<Changes>().0, baseline + 1);
    }
}
