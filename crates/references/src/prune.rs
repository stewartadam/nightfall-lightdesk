// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Command that removes missing resolved fixture references from every stored object.

use bevy_app::App;
use bevy_ecs::prelude::*;
use nightfall_cues::prelude::CueCommand;
use nightfall_desk::prelude::{GroupCommand, MasterCommand};
use nightfall_engine::prelude::*;
use nightfall_flow::prelude::FlowCommand;
use nightfall_fx::prelude::{FxCommand, StepFxCommand};
use nightfall_selection::{ReferenceLookup, ReferenceSource, prune_missing_fixture_refs};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ReferenceSources;

/// Commands that act on the show's references.
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum ReferenceCommand {
    /// Removes resolved fixture references whose fixture or element no longer exists from every
    /// stored object, as one undo step.
    PruneMissingFixtureRefs,
}

impl IngressCommand for ReferenceCommand {}

/// Registers the reference command and its handler.
pub(crate) fn register(app: &mut App) {
    register_ingress_command::<ReferenceCommand>(app);
    register_command_deserializer::<ReferenceCommand>(app, deserialize_reference_command);
    app.add_systems(
        bevy_app::Update,
        handle_reference_commands.in_set(EventHandling),
    );
}

/// Deserializes a [`ReferenceCommand`] from a client and queues it for dispatch.
fn deserialize_reference_command(
    world: &mut World,
    json: Value,
    command_id: CommandId,
    undo_id: UndoId,
) -> Result<(), String> {
    let command: ReferenceCommand = serde_json::from_value(json)
        .map_err(|error| format!("Failed to parse ReferenceCommand: {error}"))?;
    world
        .resource_mut::<PendingCommandBuffer>()
        .push(PayloadEnvelope::with_context(
            command_id,
            undo_id,
            Box::new(command),
        ));
    Ok(())
}

/// Handles reference commands.
///
/// Pruning stores each changed object through its own domain command, all sharing the prune
/// command's undo group, so one undo restores every pruned reference. The prune command
/// completes once every store has completed.
pub fn handle_reference_commands(
    mut events: MessageReader<CommandEnvelope<ReferenceCommand>>,
    sources: ReferenceSources,
    mut pending: ResMut<PendingCommandBuffer>,
    mut responder: CommandResponder,
) {
    for event in events.read() {
        match event.command {
            ReferenceCommand::PruneMissingFixtureRefs => {
                let stores = prune_store_commands(&sources, &sources.lookup());
                complete_with_stores(event, stores, &mut pending, &mut responder);
            }
        }
    }
}

/// Queues `stores` as delegated work of `event`, or completes `event` when there is none.
fn complete_with_stores(
    event: &CommandEnvelope<ReferenceCommand>,
    stores: Vec<DynEnginePayload>,
    pending: &mut PendingCommandBuffer,
    responder: &mut CommandResponder,
) {
    let completion = if stores.is_empty() {
        responder.succeed(event.command_id)
    } else {
        responder.expect_completions(event.command_id, stores.len())
    };
    if let Err(error) = completion {
        tracing::error!(command_id = %event.command_id, %error, "reference_command_completion_failed");
        return;
    }
    for store in stores {
        pending.push(PayloadEnvelope::with_context(
            event.command_id,
            event.undo_id,
            store,
        ));
    }
}

/// Returns a copy of `object` with missing resolved fixture references removed, or `None` when
/// it holds none.
fn pruned<T: ReferenceSource + Clone>(object: &T, lookup: &ReferenceLookup) -> Option<T> {
    let mut pruned = object.clone();
    let mut removed = 0;
    pruned.visit_selections_mut(&mut |selection| {
        removed += prune_missing_fixture_refs(selection, lookup);
    });
    (removed > 0).then_some(pruned)
}

/// Builds the store command for every object that holds a missing resolved fixture reference.
fn prune_store_commands(
    sources: &ReferenceSources,
    lookup: &ReferenceLookup,
) -> Vec<DynEnginePayload> {
    let mut stores: Vec<DynEnginePayload> = Vec::new();
    for entry in sources.groups.iter() {
        if let Some(group) = pruned(entry.value(), lookup) {
            stores.push(Box::new(GroupCommand::StoreGroup(group)));
        }
    }
    for entry in sources.cues.iter() {
        if let Some(cue) = pruned(entry.value(), lookup) {
            stores.push(Box::new(CueCommand::StoreCue(Box::new(cue))));
        }
    }
    for entry in sources.sequences.iter() {
        if let Some(sequence) = pruned(entry.value(), lookup) {
            stores.push(Box::new(CueCommand::StoreSequence(Box::new(sequence))));
        }
    }
    for entry in sources.fx.iter() {
        if let Some(fx) = pruned(entry.value(), lookup) {
            stores.push(Box::new(FxCommand::StoreFx(fx)));
        }
    }
    for (_, step_fx) in &sources.step_fx {
        if let Some(step_fx) = pruned(step_fx, lookup) {
            stores.push(Box::new(StepFxCommand::Store(step_fx)));
        }
    }
    #[cfg(feature = "fx-module-host")]
    for entry in sources.fx_modules.iter() {
        if let Some(fx_module) = pruned(entry.value(), lookup) {
            stores.push(Box::new(
                nightfall_fx_module::FxModuleCommand::StoreFxModule(
                    nightfall_fx_module::StoredFxModuleRequest {
                        identifiers: fx_module.identifiers,
                        module_name: fx_module.module_name,
                        selection: Some(fx_module.selection),
                        config: fx_module.config,
                        merge: false,
                    },
                ),
            ));
        }
    }
    for entry in sources.flows.iter() {
        if let Some(flow) = pruned(entry.value(), lookup) {
            stores.push(Box::new(FlowCommand::StoreFlow(flow)));
        }
    }
    for entry in sources.masters.iter() {
        if let Some(master) = pruned(entry.value(), lookup) {
            stores.push(Box::new(MasterCommand::StoreMaster(master)));
        }
    }
    stores
}
