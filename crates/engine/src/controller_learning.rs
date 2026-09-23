// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Transport-independent capture of one controller source before normal mapping dispatch.

use std::time::Duration;

use bevy_app::{App, Update};
use bevy_ecs::prelude::*;
use nightfall_actions::ActionSurface;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;
use web_time::Instant;

use crate::prelude::*;

const LEARNING_TIMEOUT: Duration = Duration::from_secs(15);

/// Interpretation of the first fresh gesture, before selecting a destination action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub enum LearnedGesture {
    /// A button became active; subsequent release does not replace this choice.
    Press,
    /// A held button was released after learning started.
    Release,
    /// A changing absolute value identifies a fader or knob.
    Continuous,
    /// A message without a value represents a discrete activation.
    Pulse,
}

/// Opaque transport-owned selector captured once, independently of subsequent values.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
pub struct LearnedControllerSource {
    /// Adapter responsible for interpreting the selector when saving the binding.
    pub surface: ActionSurface,
    /// Transport-owned source coordinates, without an action or destination.
    #[typeshare(serialized_as = "unknown")]
    pub selector: Value,
    /// Human-readable description supplied by the adapter.
    pub label: String,
    /// Initial gesture; slider samples and button release cannot overwrite it.
    pub gesture: LearnedGesture,
}

/// Client-visible learning state, also resent when a client reconnects.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[typeshare::typeshare]
pub struct ControllerLearningSnapshot {
    /// Token identifying the client-owned learning interaction.
    pub session_id: Uuid,
    /// Transport armed by the operator.
    pub surface: ActionSurface,
    /// First source touched after arming, retained until cancellation or completion.
    pub captured: Option<LearnedControllerSource>,
    /// Explains why the last input could not be learned; cleared by a usable source.
    pub input_diagnostic: Option<String>,
}

/// Commands controlling the short-lived learning interaction.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum ControllerLearningCommand {
    /// Arms one transport; an active session owned by another client is rejected.
    Begin {
        session_id: Uuid,
        surface: ActionSurface,
    },
    /// Keeps learning active while its UI is connected and visible.
    Heartbeat { session_id: Uuid },
    /// Ends learning without affecting stored bindings.
    Cancel { session_id: Uuid },
}

impl EnginePayload for ControllerLearningCommand {}
impl IngressCommand for ControllerLearningCommand {}
impl EngineIngressMeta for ControllerLearningCommand {
    const COMMAND_MODULE: &'static str = "ControllerLearningCommand";
}

/// Runtime learning state; transports consult it before dispatching existing bindings.
#[derive(Default, Resource)]
pub struct ControllerLearning {
    owner: Option<ClientConnection>,
    snapshot: Option<ControllerLearningSnapshot>,
    deadline: Option<Instant>,
    started_at: Option<Instant>,
    held_button: Option<LearnedControllerSource>,
    release_guards: Vec<(LearnedControllerSource, Instant)>,
    held_numeric: Option<LearnedControllerSource>,
    numeric_release_guards: Vec<(LearnedControllerSource, Instant)>,
}

/// Routing decision that keeps ambiguous numeric button tails from firing trigger actions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControllerInputRoute {
    Dispatch,
    SuppressAll,
    SuppressTriggers,
}

impl ControllerLearning {
    /// Consumes fresh unsupported input in the learning scope without occupying the source slot.
    pub fn reject_unsupported_input(
        &mut self,
        surface: ActionSurface,
        selector: &Value,
        received_at: Instant,
        diagnostic: &str,
    ) -> bool {
        self.expire(Instant::now());
        let Some(snapshot) = self.snapshot.as_mut() else {
            return false;
        };
        if snapshot.surface != surface || self.started_at.is_some_and(|start| received_at < start) {
            return false;
        }
        if let Some(captured) = &snapshot.captured {
            return captured.selector == *selector;
        }
        snapshot.input_diagnostic = Some(diagnostic.to_owned());
        true
    }

    /// Ends the old show's interaction while still consuming any unfinished button release.
    pub fn end_for_show_change(&mut self) {
        self.finish(Instant::now());
    }

    /// Consumes learning input and protects unfinished numeric gestures without freezing faders.
    pub fn route_received_input(
        &mut self,
        source: LearnedControllerSource,
        received_at: Instant,
        numeric_active: Option<bool>,
    ) -> ControllerInputRoute {
        self.expire(Instant::now());
        if let Some(index) = self.numeric_release_guards.iter().position(|(guard, _)| {
            guard.surface == source.surface && guard.selector == source.selector
        }) {
            let rearmed = self
                .snapshot
                .as_ref()
                .is_some_and(|snapshot| snapshot.surface == source.surface);
            if rearmed && numeric_active == Some(true) {
                // A fader may never return to zero; a new session can learn its next movement.
                self.numeric_release_guards.remove(index);
            } else {
                if numeric_active == Some(false) || source.gesture == LearnedGesture::Release {
                    self.numeric_release_guards.remove(index);
                }
                return if rearmed {
                    ControllerInputRoute::SuppressAll
                } else {
                    ControllerInputRoute::SuppressTriggers
                };
            }
        }
        let consumed = self.capture_received_at(source.clone(), received_at);
        if consumed
            && self.snapshot.as_ref().is_some_and(|snapshot| {
                snapshot.captured.as_ref().is_some_and(|captured| {
                    captured.surface == source.surface && captured.selector == source.selector
                })
            })
        {
            match numeric_active {
                Some(true) => self.held_numeric = Some(source),
                Some(false) => self.held_numeric = None,
                None => {}
            }
        }
        if consumed {
            ControllerInputRoute::SuppressAll
        } else {
            ControllerInputRoute::Dispatch
        }
    }

    /// Rejects attempts to operate another connection's session even with its visible token.
    pub fn authorize_client(
        &mut self,
        connection: Option<&ClientConnection>,
    ) -> Result<(), CommandError> {
        self.expire(Instant::now());
        if connection.is_some_and(|connection| !connection.is_connected()) {
            return Err(CommandError::new(
                "mapping.client_disconnected",
                "The learning client has disconnected",
            ));
        }
        if self.snapshot.is_some()
            && !match (&self.owner, connection) {
                (Some(owner), Some(connection)) => owner.same_connection(connection),
                (None, None) => true,
                _ => false,
            }
        {
            return Err(CommandError::new(
                "mapping.learning_busy",
                "Another client is learning a controller",
            ));
        }
        Ok(())
    }

    /// Applies a transition using connection identity supplied by the host command bridge.
    fn apply_for_client(
        &mut self,
        command: &ControllerLearningCommand,
        connection: Option<ClientConnection>,
        now: Instant,
    ) -> Result<(), CommandError> {
        self.authorize_client(connection.as_ref())?;
        self.apply(command, now)?;
        if matches!(command, ControllerLearningCommand::Begin { .. }) {
            self.owner = connection;
        }
        Ok(())
    }

    /// Ends learning only after the adapter successfully commits its validated binding.
    pub fn complete_with_binding<T>(
        &mut self,
        session_id: Uuid,
        surface: ActionSurface,
        commit: impl FnOnce(LearnedControllerSource) -> Result<T, CommandError>,
    ) -> Result<T, CommandError> {
        let source = self.captured(session_id, surface)?;
        let binding = commit(source)?;
        self.finish(Instant::now());
        Ok(binding)
    }

    /// Resolves the current session token and adapter after the caller checks connection ownership.
    pub fn captured(
        &mut self,
        session_id: Uuid,
        surface: ActionSurface,
    ) -> Result<LearnedControllerSource, CommandError> {
        self.expire(Instant::now());
        let state = self
            .snapshot
            .as_ref()
            .filter(|state| state.session_id == session_id && state.surface == surface)
            .ok_or_else(|| {
                CommandError::new(
                    "mapping.learning_expired",
                    "The learning session is no longer available",
                )
            })?;
        state.captured.clone().ok_or_else(|| {
            CommandError::new(
                "mapping.source_required",
                "Touch a controller before selecting an action",
            )
        })
    }
    /// Latches the first matching source and consumes it while the operator selects a target.
    pub fn capture(&mut self, source: LearnedControllerSource) -> bool {
        self.capture_received_at(source, Instant::now())
    }

    /// Leaves pre-session queued events on their normal route instead of learning them.
    pub fn capture_received_at(
        &mut self,
        source: LearnedControllerSource,
        received_at: Instant,
    ) -> bool {
        self.expire(Instant::now());
        if let Some(index) = self.release_guards.iter().position(|(guard, _)| {
            guard.surface == source.surface && guard.selector == source.selector
        }) {
            if source.gesture == LearnedGesture::Release {
                self.release_guards.remove(index);
            }
            return true;
        }
        let Some(snapshot) = self.snapshot.as_mut() else {
            return false;
        };
        if self.started_at.is_some_and(|start| received_at < start) {
            return false;
        }
        if snapshot.surface != source.surface {
            return false;
        }
        if let Some(captured) = &snapshot.captured {
            if captured.selector != source.selector {
                return false;
            }
        } else {
            snapshot.captured = Some(source.clone());
            snapshot.input_diagnostic = None;
        }
        match source.gesture {
            LearnedGesture::Press => self.held_button = Some(source),
            LearnedGesture::Release => self.held_button = None,
            _ => {}
        }
        true
    }

    /// Ends capture while consuming the remaining release of a button pressed during learning.
    fn finish(&mut self, now: Instant) {
        if let Some(source) = self.held_numeric.take() {
            if self.numeric_release_guards.len() == 64 {
                self.numeric_release_guards.remove(0);
            }
            self.numeric_release_guards
                .push((source, now + LEARNING_TIMEOUT));
        }
        if let Some(source) = self.held_button.take() {
            // Bound abandoned sources when controllers disappear without sending their release.
            if self.release_guards.len() == 64 {
                self.release_guards.remove(0);
            }
            self.release_guards.push((source, now + LEARNING_TIMEOUT));
        }
        self.snapshot = None;
        self.deadline = None;
        self.started_at = None;
        self.owner = None;
    }

    /// Releases the session when its host connection closes or its heartbeat expires.
    fn expire(&mut self, now: Instant) {
        self.release_guards.retain(|(_, deadline)| now < *deadline);
        self.numeric_release_guards
            .retain(|(_, deadline)| now < *deadline);
        if self.deadline.is_some_and(|deadline| now >= deadline)
            || self
                .owner
                .as_ref()
                .is_some_and(|owner| !owner.is_connected())
        {
            self.finish(now);
        }
    }

    /// Applies session-token transitions without modifying persistent mappings.
    fn apply(
        &mut self,
        command: &ControllerLearningCommand,
        now: Instant,
    ) -> Result<(), CommandError> {
        self.expire(now);
        let session_id = match command {
            ControllerLearningCommand::Begin { session_id, .. }
            | ControllerLearningCommand::Heartbeat { session_id }
            | ControllerLearningCommand::Cancel { session_id } => *session_id,
        };
        if self
            .snapshot
            .as_ref()
            .is_some_and(|state| state.session_id != session_id)
        {
            return Err(CommandError::new(
                "mapping.learning_busy",
                "Another client is learning a controller",
            ));
        }
        match command {
            ControllerLearningCommand::Begin { surface, .. } => {
                if !matches!(surface, ActionSurface::Midi | ActionSurface::Osc) {
                    return Err(CommandError::new(
                        "mapping.invalid_transport",
                        "Choose MIDI or OSC for controller learning",
                    ));
                }
                self.finish(now);
                self.snapshot = Some(ControllerLearningSnapshot {
                    session_id,
                    surface: *surface,
                    captured: None,
                    input_diagnostic: None,
                });
                self.deadline = Some(now + LEARNING_TIMEOUT);
                self.started_at = Some(now);
            }
            ControllerLearningCommand::Heartbeat { .. } => {
                if self.snapshot.is_none() {
                    return Err(CommandError::new(
                        "mapping.learning_expired",
                        "Controller learning has ended",
                    ));
                }
                self.deadline = Some(now + LEARNING_TIMEOUT);
            }
            ControllerLearningCommand::Cancel { .. } => {
                self.finish(now);
            }
        }
        Ok(())
    }
}

/// Reliable state envelope; capture must not be lost among droppable input telemetry.
#[derive(Serialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum ControllerLearningMessage {
    /// Complete learning snapshot, or null when inactive.
    ControllerLearning(Option<ControllerLearningSnapshot>),
}

/// Installs learning commands and snapshot publication without depending on input adapters.
pub(crate) fn install(app: &mut App) {
    app.init_resource::<ControllerLearning>();
    register_ingress_command::<ControllerLearningCommand>(app);
    register_command_deserializer::<ControllerLearningCommand>(app, deserialize);
    app.add_systems(Update, handle_commands.before(InputHandling));
    app.add_systems(Update, publish.in_set(ResyncHandling));
}

/// Admits learning commands through the existing tracked client command route.
fn deserialize(
    world: &mut World,
    value: Value,
    command_id: CommandId,
    undo_id: UndoId,
) -> Result<(), String> {
    let command = serde_json::from_value::<ControllerLearningCommand>(value)
        .map_err(|error| error.to_string())?;
    world.write_message(CommandEnvelope::with_context(
        command_id,
        undo_id,
        CommandOrigin::WebUi,
        ReplyTarget::ClientBroadcast,
        command,
    ));
    Ok(())
}

/// Applies learning transitions before the next batch of hardware events is processed.
fn handle_commands(
    mut commands: MessageReader<CommandEnvelope<ControllerLearningCommand>>,
    mut learning: ResMut<ControllerLearning>,
    mut responder: CommandResponder,
) {
    learning.expire(Instant::now());
    for command in commands.read() {
        let connection = responder.client_connection(command.command_id);
        let result = match learning.apply_for_client(&command.command, connection, Instant::now()) {
            Ok(()) => responder.succeed(command.command_id),
            Err(error) => responder.fail(command.command_id, error),
        };
        if let Err(error) = result {
            tracing::error!(%error, "learning_command_completion_failed");
        }
    }
}

/// Publishes only visible changes or explicit resync, avoiding heartbeat snapshot traffic.
fn publish(
    learning: Res<ControllerLearning>,
    mut resync: MessageReader<ResyncRequested>,
    sink: Res<ClientEventSink>,
    mut previous: Local<Option<ControllerLearningSnapshot>>,
) {
    if resync.read().count() == 0 && *previous == learning.snapshot {
        return;
    }
    *previous = learning.snapshot.clone();
    sink.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &ControllerLearningMessage::ControllerLearning(learning.snapshot.clone()),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Submits a host-stamped learning command through JSON ingress and returns its outcome.
    fn submit_client_command(
        app: &mut App,
        connection: ClientConnection,
        command: ControllerLearningCommand,
    ) -> CommandOutcome {
        let command_id = CommandId::new();
        app.world()
            .resource::<ClientBridgeHost>()
            .command_sender()
            .try_send(CommandJsonEnvelope {
                client_connection: Some(connection),
                command_id,
                undo_id: None,
                module: "ControllerLearningCommand".into(),
                command: serde_json::to_value(command).unwrap(),
            })
            .unwrap();
        app.update();
        app.update();
        app.world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .find(|result| result.command_id == command_id)
            .unwrap()
            .outcome
    }

    /// A visible session token cannot transfer ownership; disconnect immediately releases the lease.
    #[test]
    fn connection_ownership_survives_ingress_and_disconnect_ends_learning() {
        let mut app = App::new();
        app.add_plugins(EnginePlugin);
        app.init_resource::<PendingCommandBuffer>();
        app.add_plugins(ClientBridgePlugin);
        let owner = ClientConnectionLease::default();
        let other = ClientConnectionLease::default();
        let session_id = Uuid::new_v4();
        assert_eq!(
            submit_client_command(
                &mut app,
                owner.connection(),
                ControllerLearningCommand::Begin {
                    session_id,
                    surface: ActionSurface::Midi,
                }
            ),
            CommandOutcome::succeeded()
        );
        for command in [
            ControllerLearningCommand::Begin {
                session_id,
                surface: ActionSurface::Osc,
            },
            ControllerLearningCommand::Heartbeat { session_id },
            ControllerLearningCommand::Cancel { session_id },
        ] {
            assert!(
                matches!(submit_client_command(&mut app, other.connection(), command), CommandOutcome::Failed(error) if error.code == "mapping.learning_busy")
            );
        }
        {
            let mut learning = app.world_mut().resource_mut::<ControllerLearning>();
            assert!(learning.capture(source(42, LearnedGesture::Press)));
            assert!(
                learning
                    .authorize_client(Some(&other.connection()))
                    .is_err()
            );
            assert!(learning.authorize_client(Some(&owner.connection())).is_ok());
        }
        let disconnected = owner.connection();
        drop(owner);
        app.update();
        assert!(
            app.world()
                .resource::<ControllerLearning>()
                .snapshot
                .is_none()
        );
        assert!(
            matches!(submit_client_command(&mut app, disconnected, ControllerLearningCommand::Begin {
            session_id, surface: ActionSurface::Midi,
        }), CommandOutcome::Failed(error) if error.code == "mapping.client_disconnected")
        );
        assert_eq!(
            submit_client_command(
                &mut app,
                other.connection(),
                ControllerLearningCommand::Begin {
                    session_id: Uuid::new_v4(),
                    surface: ActionSurface::Midi,
                }
            ),
            CommandOutcome::succeeded()
        );
        let mut learning = app.world_mut().resource_mut::<ControllerLearning>();
        assert!(learning.capture(source(42, LearnedGesture::Release)));
        assert!(learning.snapshot.as_ref().unwrap().captured.is_none());
        assert!(learning.capture(source(43, LearnedGesture::Press)));
    }

    /// Failed saves retain capture for correction; successful saves consume the session exactly once.
    #[test]
    fn binding_completion_is_atomic_with_learning_lifecycle() {
        let mut learning = ControllerLearning::default();
        let session_id = Uuid::new_v4();
        learning
            .apply(
                &ControllerLearningCommand::Begin {
                    session_id,
                    surface: ActionSurface::Midi,
                },
                Instant::now(),
            )
            .unwrap();
        assert!(learning.capture(source(42, LearnedGesture::Press)));
        let failed: Result<(), CommandError> =
            learning.complete_with_binding(session_id, ActionSurface::Midi, |_| {
                Err(CommandError::new("test.conflict", "Conflict"))
            });
        assert_eq!(failed.unwrap_err().code, "test.conflict");
        assert!(learning.captured(session_id, ActionSurface::Midi).is_ok());
        let result = learning
            .complete_with_binding(session_id, ActionSurface::Midi, |captured| {
                assert_eq!(
                    captured.selector,
                    source(42, LearnedGesture::Press).selector
                );
                Ok(123)
            })
            .unwrap();
        assert_eq!(result, 123);
        assert!(learning.snapshot.is_none());
        assert!(
            learning
                .complete_with_binding(
                    session_id,
                    ActionSurface::Midi,
                    |_| -> Result<(), CommandError> {
                        panic!("a completed session must not write a second binding")
                    }
                )
                .is_err()
        );
        assert!(learning.capture(source(42, LearnedGesture::Release)));
        assert!(!learning.capture(source(42, LearnedGesture::Press)));
    }

    /// A previous held press cannot become the first learned release of a new session.
    #[test]
    fn rearming_ignores_previous_gesture_tail_and_guards_eventually_expire() {
        let mut learning = ControllerLearning::default();
        let now = Instant::now();
        let session_id = Uuid::new_v4();
        let begin = ControllerLearningCommand::Begin {
            session_id,
            surface: ActionSurface::Midi,
        };
        learning.apply(&begin, now).unwrap();
        assert!(learning.capture(source(42, LearnedGesture::Press)));
        learning.apply(&begin, now).unwrap();
        assert!(learning.capture(source(42, LearnedGesture::Release)));
        assert!(learning.snapshot.as_ref().unwrap().captured.is_none());
        assert!(learning.capture(source(43, LearnedGesture::Press)));
        learning
            .apply(&ControllerLearningCommand::Cancel { session_id }, now)
            .unwrap();
        let mut other_transport = source(43, LearnedGesture::Release);
        other_transport.surface = ActionSurface::Osc;
        assert!(!learning.capture(other_transport));
        learning.expire(now + LEARNING_TIMEOUT);
        assert!(learning.release_guards.is_empty());
        assert!(!learning.capture(source(43, LearnedGesture::Press)));
    }

    /// Canceling or expiring a held button consumes its release, then allows the next full gesture.
    #[test]
    fn ending_learning_consumes_only_the_remaining_button_gesture() {
        for expire in [false, true] {
            let mut learning = ControllerLearning::default();
            let now = Instant::now();
            let session_id = Uuid::new_v4();
            learning
                .apply(
                    &ControllerLearningCommand::Begin {
                        session_id,
                        surface: ActionSurface::Midi,
                    },
                    now,
                )
                .unwrap();
            assert!(learning.capture(source(42, LearnedGesture::Press)));
            if expire {
                learning.expire(now + LEARNING_TIMEOUT);
            } else {
                learning
                    .apply(&ControllerLearningCommand::Cancel { session_id }, now)
                    .unwrap();
            }
            assert!(!learning.capture(source(43, LearnedGesture::Press)));
            assert!(learning.capture(source(42, LearnedGesture::Press)));
            assert!(learning.capture(source(42, LearnedGesture::Release)));
            assert!(!learning.capture(source(42, LearnedGesture::Press)));
            assert!(!learning.capture(source(42, LearnedGesture::Release)));
        }
    }

    /// Numeric tails suppress trigger actions until zero, while scalar mappings keep receiving values.
    #[test]
    fn numeric_learning_tail_protects_triggers_without_freezing_faders() {
        for completion in [false, true] {
            let mut learning = ControllerLearning::default();
            let now = Instant::now();
            let session_id = Uuid::new_v4();
            learning
                .apply(
                    &ControllerLearningCommand::Begin {
                        session_id,
                        surface: ActionSurface::Midi,
                    },
                    now,
                )
                .unwrap();
            assert_eq!(
                learning.route_received_input(
                    source(42, LearnedGesture::Continuous),
                    now,
                    Some(true)
                ),
                ControllerInputRoute::SuppressAll
            );
            if completion {
                learning
                    .complete_with_binding(session_id, ActionSurface::Midi, |_| Ok(()))
                    .unwrap();
            } else {
                learning
                    .apply(&ControllerLearningCommand::Cancel { session_id }, now)
                    .unwrap();
            }
            assert_eq!(
                learning.route_received_input(
                    source(43, LearnedGesture::Continuous),
                    now,
                    Some(true)
                ),
                ControllerInputRoute::Dispatch
            );
            assert_eq!(
                learning.route_received_input(
                    source(42, LearnedGesture::Continuous),
                    now,
                    Some(true)
                ),
                ControllerInputRoute::SuppressTriggers
            );
            assert_eq!(
                learning.route_received_input(
                    source(42, LearnedGesture::Release),
                    now,
                    Some(false)
                ),
                ControllerInputRoute::SuppressTriggers
            );
            assert_eq!(
                learning.route_received_input(
                    source(42, LearnedGesture::Continuous),
                    now,
                    Some(true)
                ),
                ControllerInputRoute::Dispatch
            );
            assert_eq!(
                learning.route_received_input(
                    source(42, LearnedGesture::Release),
                    now,
                    Some(false)
                ),
                ControllerInputRoute::Dispatch
            );
        }
    }

    /// Re-arming ignores a pending release but can immediately learn another fader movement.
    #[test]
    fn numeric_guards_protect_rearming_and_expire() {
        let mut learning = ControllerLearning::default();
        let now = Instant::now();
        let session_id = Uuid::new_v4();
        learning
            .apply(
                &ControllerLearningCommand::Begin {
                    session_id,
                    surface: ActionSurface::Midi,
                },
                now,
            )
            .unwrap();
        learning.route_received_input(source(42, LearnedGesture::Continuous), now, Some(true));
        learning
            .apply(
                &ControllerLearningCommand::Begin {
                    session_id,
                    surface: ActionSurface::Midi,
                },
                now,
            )
            .unwrap();
        assert_eq!(
            learning.route_received_input(source(42, LearnedGesture::Release), now, Some(false)),
            ControllerInputRoute::SuppressAll
        );
        assert!(learning.snapshot.as_ref().unwrap().captured.is_none());
        learning.route_received_input(source(42, LearnedGesture::Continuous), now, Some(true));
        assert!(learning.snapshot.as_ref().unwrap().captured.is_some());
        learning
            .apply(
                &ControllerLearningCommand::Begin {
                    session_id,
                    surface: ActionSurface::Midi,
                },
                now,
            )
            .unwrap();
        assert_eq!(
            learning.route_received_input(source(42, LearnedGesture::Continuous), now, Some(true)),
            ControllerInputRoute::SuppressAll
        );
        assert!(learning.snapshot.as_ref().unwrap().captured.is_some());
        learning
            .apply(&ControllerLearningCommand::Cancel { session_id }, now)
            .unwrap();
        learning.expire(now + LEARNING_TIMEOUT);
        assert!(learning.numeric_release_guards.is_empty());
        assert_eq!(
            learning.route_received_input(source(42, LearnedGesture::Release), now, Some(false)),
            ControllerInputRoute::Dispatch
        );
    }

    /// Zero samples and releases completed while learning do not guard a later full gesture.
    #[test]
    fn numeric_zero_at_learning_end_leaves_no_guard() {
        for starts_active in [false, true] {
            let mut learning = ControllerLearning::default();
            let now = Instant::now();
            let session_id = Uuid::new_v4();
            learning
                .apply(
                    &ControllerLearningCommand::Begin {
                        session_id,
                        surface: ActionSurface::Midi,
                    },
                    now,
                )
                .unwrap();
            if starts_active {
                learning.route_received_input(
                    source(42, LearnedGesture::Continuous),
                    now,
                    Some(true),
                );
            }
            learning.route_received_input(source(42, LearnedGesture::Release), now, Some(false));
            learning
                .apply(&ControllerLearningCommand::Cancel { session_id }, now)
                .unwrap();
            assert_eq!(
                learning.route_received_input(
                    source(42, LearnedGesture::Continuous),
                    now,
                    Some(true)
                ),
                ControllerInputRoute::Dispatch
            );
            assert!(learning.numeric_release_guards.is_empty());
        }
    }

    /// Completed gestures and continuous controls require no post-learning suppression.
    #[test]
    fn completed_buttons_and_faders_resume_immediately() {
        for gesture in [LearnedGesture::Release, LearnedGesture::Continuous] {
            let mut learning = ControllerLearning::default();
            let now = Instant::now();
            let session_id = Uuid::new_v4();
            learning
                .apply(
                    &ControllerLearningCommand::Begin {
                        session_id,
                        surface: ActionSurface::Midi,
                    },
                    now,
                )
                .unwrap();
            if gesture == LearnedGesture::Release {
                assert!(learning.capture(source(42, LearnedGesture::Press)));
            }
            assert!(learning.capture(source(42, gesture)));
            learning
                .apply(&ControllerLearningCommand::Cancel { session_id }, now)
                .unwrap();
            assert!(!learning.capture(source(42, gesture)));
        }
    }

    /// Creates a source whose changing gesture does not change its physical identity.
    fn source(note: u8, gesture: LearnedGesture) -> LearnedControllerSource {
        LearnedControllerSource {
            surface: ActionSurface::Midi,
            selector: serde_json::json!({ "note": note }),
            label: format!("Note {note}"),
            gesture,
        }
    }

    /// Input queued before arming remains dispatchable and cannot choose the learned source.
    #[test]
    fn learning_ignores_pre_session_events_even_after_heartbeat() {
        let mut learning = ControllerLearning::default();
        let start = Instant::now();
        let session_id = Uuid::new_v4();
        learning
            .apply(
                &ControllerLearningCommand::Begin {
                    session_id,
                    surface: ActionSurface::Midi,
                },
                start,
            )
            .unwrap();
        assert!(!learning.capture_received_at(
            source(42, LearnedGesture::Press),
            start - Duration::from_millis(1),
        ));
        assert!(learning.snapshot.as_ref().unwrap().captured.is_none());
        learning
            .apply(
                &ControllerLearningCommand::Heartbeat { session_id },
                start + Duration::from_secs(1),
            )
            .unwrap();
        assert!(learning.capture_received_at(source(43, LearnedGesture::Press), start));
        assert_eq!(
            learning
                .captured(session_id, ActionSurface::Midi)
                .unwrap()
                .selector,
            source(43, LearnedGesture::Press).selector
        );
    }

    /// A button press remains selected after release, and other controls remain operational.
    #[test]
    fn capture_latches_first_source_and_gesture() {
        let mut learning = ControllerLearning::default();
        learning
            .apply(
                &ControllerLearningCommand::Begin {
                    session_id: Uuid::new_v4(),
                    surface: ActionSurface::Midi,
                },
                Instant::now(),
            )
            .unwrap();
        assert!(learning.capture(source(42, LearnedGesture::Press)));
        assert!(learning.capture(source(42, LearnedGesture::Release)));
        assert!(!learning.capture(source(43, LearnedGesture::Press)));
        assert_eq!(
            learning.snapshot.unwrap().captured.unwrap().gesture,
            LearnedGesture::Press
        );
    }

    /// Unsupported feedback respects freshness and source scope, and usable input clears it.
    #[test]
    fn unsupported_input_does_not_capture_or_escape_learning() {
        let mut learning = ControllerLearning::default();
        let start = Instant::now();
        let selector = source(42, LearnedGesture::Press).selector;
        learning
            .apply(
                &ControllerLearningCommand::Begin {
                    session_id: Uuid::new_v4(),
                    surface: ActionSurface::Midi,
                },
                start,
            )
            .unwrap();
        assert!(!learning.reject_unsupported_input(
            ActionSurface::Midi,
            &selector,
            start - Duration::from_secs(1),
            "stale",
        ));
        assert!(!learning.reject_unsupported_input(
            ActionSurface::Osc,
            &selector,
            start,
            "other transport",
        ));
        assert!(
            learning
                .snapshot
                .as_ref()
                .unwrap()
                .input_diagnostic
                .is_none()
        );
        assert!(learning.reject_unsupported_input(
            ActionSurface::Midi,
            &selector,
            start,
            "Unsupported message",
        ));
        let snapshot = learning.snapshot.as_ref().unwrap();
        assert!(snapshot.captured.is_none());
        assert_eq!(
            snapshot.input_diagnostic.as_deref(),
            Some("Unsupported message")
        );
        assert!(learning.capture(source(42, LearnedGesture::Press)));
        assert!(
            learning
                .snapshot
                .as_ref()
                .unwrap()
                .input_diagnostic
                .is_none()
        );
        assert!(learning.reject_unsupported_input(
            ActionSurface::Midi,
            &selector,
            start,
            "same source",
        ));
        assert!(!learning.reject_unsupported_input(
            ActionSurface::Midi,
            &source(43, LearnedGesture::Press).selector,
            start,
            "other source",
        ));
        learning.end_for_show_change();
        assert!(!learning.reject_unsupported_input(
            ActionSurface::Midi,
            &selector,
            start,
            "finished",
        ));
    }

    /// Holding a button before arming allows its fresh release to be captured intentionally.
    #[test]
    fn first_release_is_preserved() {
        let mut learning = ControllerLearning::default();
        assert!(!learning.capture(source(42, LearnedGesture::Press)));
        learning
            .apply(
                &ControllerLearningCommand::Begin {
                    session_id: Uuid::new_v4(),
                    surface: ActionSurface::Midi,
                },
                Instant::now(),
            )
            .unwrap();
        assert!(learning.capture(source(42, LearnedGesture::Release)));
        assert_eq!(
            learning.snapshot.unwrap().captured.unwrap().gesture,
            LearnedGesture::Release
        );
    }

    /// A second client cannot cancel another client's session, and expiration releases input.
    #[test]
    fn learning_has_exclusive_ownership_and_expires() {
        let mut learning = ControllerLearning::default();
        let now = Instant::now();
        let session_id = Uuid::new_v4();
        learning
            .apply(
                &ControllerLearningCommand::Begin {
                    session_id,
                    surface: ActionSurface::Midi,
                },
                now,
            )
            .unwrap();
        assert_eq!(
            learning
                .apply(
                    &ControllerLearningCommand::Cancel {
                        session_id: Uuid::new_v4()
                    },
                    now
                )
                .unwrap_err()
                .code,
            "mapping.learning_busy"
        );
        learning.expire(now + LEARNING_TIMEOUT);
        assert!(!learning.capture(source(42, LearnedGesture::Press)));
        assert_eq!(
            learning
                .apply(
                    &ControllerLearningCommand::Heartbeat { session_id },
                    now + LEARNING_TIMEOUT
                )
                .unwrap_err()
                .code,
            "mapping.learning_expired"
        );
    }
}
