// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Websocket publication of group and Blueprint definitions and Blueprint dependencies.

use bevy_ecs::prelude::*;
use bevy_ecs::system::SystemParam;
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

/// The group definitions feed.
#[derive(SystemParam)]
pub(crate) struct GroupsFeed<'w> {
    groups: Res<'w, DataProvider<Group>>,
}

impl ClientFeed for GroupsFeed<'static> {
    /// Publishes every group definition.
    fn publish(feed: &GroupsFeed<'_>, sink: &ClientEventSink) {
        let groups: Vec<Group> = feed
            .groups
            .iter()
            .map(|entry| entry.value().clone())
            .collect();
        sink.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &DefinitionWsMessage::GroupDefinitions(&groups),
        );
    }
}

/// The Blueprint definitions feed.
#[derive(SystemParam)]
pub(crate) struct BlueprintsFeed<'w> {
    blueprints: Res<'w, DataProvider<Blueprint>>,
}

impl ClientFeed for BlueprintsFeed<'static> {
    /// Publishes every Blueprint definition.
    fn publish(feed: &BlueprintsFeed<'_>, sink: &ClientEventSink) {
        let blueprints: Vec<Blueprint> = feed
            .blueprints
            .iter()
            .map(|entry| entry.value().clone())
            .collect();
        sink.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &DefinitionWsMessage::BlueprintDefinitions(&blueprints),
        );
    }
}

/// The Blueprint reverse dependency feed used by Blueprint panels and navigation, sent after an
/// indexing subsystem changes the index.
#[derive(SystemParam)]
pub(crate) struct BlueprintDependenciesFeed<'w> {
    reference_index: Res<'w, BlueprintReferenceIndex>,
}

impl ClientFeed for BlueprintDependenciesFeed<'static> {
    /// Publishes every Blueprint with a live authored reference and what references it.
    fn publish(feed: &BlueprintDependenciesFeed<'_>, sink: &ClientEventSink) {
        let dependencies = feed
            .reference_index
            .snapshot()
            .into_iter()
            .map(|(blueprint_uid, dependents)| OutboundBlueprintDependency {
                blueprint_uid,
                dependents,
            })
            .collect::<Vec<_>>();
        sink.publish(
            DISCRIMINATOR_NON_DROPPABLE,
            &DefinitionWsMessage::BlueprintDependencies(&dependencies),
        );
    }
}
