// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Websocket publication of group and Blueprint definitions and Blueprint dependencies.

use bevy_ecs::prelude::*;
use nightfall::prelude::*;
use nightfall_engine::prelude::*;
use serde::Serialize;
use uuid::Uuid;

/// One Blueprint's current reverse-dependency descriptions.
#[derive(Clone, Debug, Serialize)]
#[typeshare::typeshare]
pub struct OutboundBlueprintDependency {
    /// Stable Blueprint identity used as the dependency lookup key.
    #[serde(with = "nightfall::serde_uuid_simple")]
    pub blueprint_uid: Uuid,
    /// Authored programmer, cue, and sequence objects retaining the live reference.
    pub dependents: Vec<String>,
}

/// Group and Blueprint messages sent to clients.
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
#[typeshare::typeshare]
enum DefinitionWsMessage<'a> {
    /// Definition of all groups
    GroupDefinitions(&'a [Group]),
    /// Definition of all blueprints
    BlueprintDefinitions(&'a [Blueprint]),
    /// Reverse dependencies for every Blueprint with a live authored reference.
    BlueprintDependencies(&'a [OutboundBlueprintDependency]),
}

/// Sends every group definition to clients.
fn send_groups(groups: &DataProvider<Group>, broadcaster: &ClientEventSink) {
    let groups: Vec<Group> = groups.iter().map(|entry| entry.value().clone()).collect();
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &DefinitionWsMessage::GroupDefinitions(&groups),
    );
    tracing::trace!("Sending groups definitions to websocket clients");
}

/// Sends every Blueprint definition to clients.
fn send_blueprints(blueprints: &DataProvider<Blueprint>, broadcaster: &ClientEventSink) {
    let blueprints: Vec<Blueprint> = blueprints
        .iter()
        .map(|entry| entry.value().clone())
        .collect();
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &DefinitionWsMessage::BlueprintDefinitions(&blueprints),
    );
    tracing::trace!("Sending blueprint definitions to websocket clients");
}

/// Sends the reverse dependency index used by Blueprint panels and navigation.
fn send_blueprint_dependencies(
    reference_index: &BlueprintReferenceIndex,
    broadcaster: &ClientEventSink,
) {
    let dependencies = reference_index
        .snapshot()
        .into_iter()
        .map(|(blueprint_uid, dependents)| OutboundBlueprintDependency {
            blueprint_uid,
            dependents,
        })
        .collect::<Vec<_>>();
    broadcaster.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &DefinitionWsMessage::BlueprintDependencies(&dependencies),
    );
}

/// Publishes group definitions when they change.
pub fn send_groups_on_change(groups: Res<DataProvider<Group>>, broadcaster: Res<ClientEventSink>) {
    if groups.is_changed() {
        send_groups(&groups, &broadcaster);
    }
}

/// Publishes Blueprint definitions when they change.
pub fn send_blueprints_on_change(
    blueprints: Res<DataProvider<Blueprint>>,
    broadcaster: Res<ClientEventSink>,
) {
    if blueprints.is_changed() {
        send_blueprints(&blueprints, &broadcaster);
    }
}

/// Publishes Blueprint reverse dependencies after an indexing subsystem changes them.
pub fn send_blueprint_dependencies_on_change(
    reference_index: Res<BlueprintReferenceIndex>,
    broadcaster: Res<ClientEventSink>,
) {
    if reference_index.is_changed() {
        send_blueprint_dependencies(&reference_index, &broadcaster);
    }
}

/// Sends groups, Blueprints, and Blueprint dependencies to clients that asked for a full resync.
pub fn handle_resync_state(
    mut resync: ResyncReplies,
    groups: Res<DataProvider<Group>>,
    blueprints: Res<DataProvider<Blueprint>>,
    reference_index: Res<BlueprintReferenceIndex>,
) {
    let Some(broadcaster) = resync.sink() else {
        return;
    };
    send_groups(&groups, &broadcaster);
    send_blueprints(&blueprints, &broadcaster);
    send_blueprint_dependencies(&reference_index, &broadcaster);
}
