// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Resolution of board elements to buttons and of each button's live on/off state.
//!
//! State is always derived from the objects themselves (running clips, the Programmer's
//! selection and values, master modes), never stored on the board, so it stays correct when
//! the show is changed from the command line or another device.

use std::collections::{HashMap, HashSet};

use bevy_ecs::{prelude::*, system::SystemParam};
use nightfall::prelude::*;
use nightfall_clips::{Clip, MaterializedClip};
use nightfall_desk::prelude::Master;
use nightfall_engine::prelude::*;
use nightfall_fixtures::{prelude::FixtureDataProviderExt, selection::SpatialSelectionResolver};
use nightfall_programmer::prelude::Programmer;
use serde::Serialize;
use uuid::Uuid;

/// Live state of one board button.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[typeshare::typeshare]
pub enum BoardItemState {
    /// The target exists and is not engaged.
    Off,
    /// The target is engaged (running, selected, applied or active).
    On,
    /// The target is engaged for only part of the current selection.
    Partial,
    /// The pinned target no longer exists.
    Missing,
}

impl BoardItemState {
    /// Returns whether a press on this button should release it rather than engage it.
    pub fn is_on(self) -> bool {
        matches!(self, Self::On)
    }
}

/// One button resolved from a board element.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[typeshare::typeshare]
pub struct BoardItem {
    /// Object the button presses.
    pub target: ObjectIdentity,
    /// Current user-facing ID of the target.
    pub id: u32,
    /// Current label of the target.
    pub label: String,
    /// Live on/off state.
    pub state: BoardItemState,
}

/// The resolved buttons of one board element.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[typeshare::typeshare]
pub struct BoardElementStatus {
    /// Element the buttons belong to.
    #[serde(with = "nightfall::serde_uuid_simple")]
    #[typeshare(serialized_as = "String")]
    pub element_uid: Uuid,
    /// Buttons in display order: one for a pinned target, every match for a collection.
    pub items: Vec<BoardItem>,
}

/// The resolved buttons of every pressable element on one board.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[typeshare::typeshare]
pub struct BoardStatus {
    /// Board the status describes.
    #[serde(with = "nightfall::serde_uuid_simple")]
    #[typeshare(serialized_as = "String")]
    pub board_uid: Uuid,
    /// Status for each target and collection element.
    pub elements: Vec<BoardElementStatus>,
}

/// Read access to every object a board button can target, plus the state each one is in.
#[derive(SystemParam)]
pub struct BoardObjects<'w, 's> {
    /// Persistent clip definitions.
    clips: Query<'w, 's, &'static Clip>,
    /// Running clips.
    materialized_clips: Query<'w, 's, &'static MaterializedClip>,
    /// Stored groups.
    groups: Res<'w, DataProvider<Group>>,
    /// Stored blueprints.
    blueprints: Res<'w, DataProvider<Blueprint>>,
    /// Stored masters.
    masters: Res<'w, DataProvider<Master>>,
    /// Live Programmer selection and values.
    programmer: Res<'w, Programmer>,
    /// Patched fixtures, watched so group states follow patch changes.
    fixtures: Res<'w, FixtureDataProviderExt>,
    /// Resolver for group and Programmer selections.
    selection_resolver: SpatialSelectionResolver<'w>,
}

/// One snapshot of everything that decides button states, computed once per evaluation.
pub struct BoardStateContext {
    /// Fixtures in the Programmer's active selection.
    selected: HashSet<FixtureRef>,
    /// Fixtures holding Programmer values that reference each blueprint UID.
    blueprint_fixtures: HashMap<Uuid, HashSet<FixtureRef>>,
    /// Console IDs of running clips.
    running_clips: HashSet<u32>,
}

impl BoardStateContext {
    /// Fixtures in the Programmer's active selection.
    pub fn selected_fixtures(&self) -> &HashSet<FixtureRef> {
        &self.selected
    }

    /// Fixtures carrying Programmer values from `blueprint_uid`.
    pub fn blueprint_fixtures(&self, blueprint_uid: Uuid) -> Option<&HashSet<FixtureRef>> {
        self.blueprint_fixtures.get(&blueprint_uid)
    }
}

impl BoardObjects<'_, '_> {
    /// Returns whether any input that decides board contents or states changed this update.
    pub fn changed(&self) -> bool {
        self.groups.is_changed()
            || self.blueprints.is_changed()
            || self.masters.is_changed()
            || self.programmer.is_changed()
            || self.fixtures.is_changed()
    }

    /// Captures the selection, Programmer and playback state used to evaluate buttons.
    pub fn state_context(&self) -> BoardStateContext {
        let selected = self.resolve(&self.programmer.active_spatial_selection());
        let mut blueprint_fixtures: HashMap<Uuid, HashSet<FixtureRef>> = HashMap::new();
        for (_, instruction) in self.programmer.active_instructions().iter() {
            let Some(application) = &instruction.cue_instruction.blueprint_application else {
                continue;
            };
            blueprint_fixtures
                .entry(application.blueprint_uid)
                .or_default()
                .extend(self.resolve(&instruction.selection));
        }
        let running_clips = self
            .materialized_clips
            .iter()
            .map(|clip| clip.clip_id)
            .collect();
        BoardStateContext {
            selected,
            blueprint_fixtures,
            running_clips,
        }
    }

    /// Resolves a spatial selection to its canonical fixtures.
    fn resolve(&self, selection: &SpatialSelection) -> HashSet<FixtureRef> {
        self.selection_resolver
            .resolve(selection)
            .into_value()
            .canonical
            .into_iter()
            .collect()
    }

    /// Returns the identifiers of the object `identity` names, if it still exists.
    pub fn identifiers(&self, identity: &ObjectIdentity) -> Option<Identifiers> {
        match identity.object_type {
            ObjectType::Clip => self
                .clips
                .iter()
                .find(|clip| clip.identifiers.uid == identity.uid)
                .map(|clip| clip.identifiers.clone()),
            ObjectType::Group => provider_identifiers(&self.groups, identity.uid),
            ObjectType::Blueprint => provider_identifiers(&self.blueprints, identity.uid),
            ObjectType::Master => provider_identifiers(&self.masters, identity.uid),
            _ => None,
        }
    }

    /// Returns the stored blueprint with `uid`.
    pub fn blueprint(&self, uid: Uuid) -> Option<Blueprint> {
        self.blueprints
            .get(uid)
            .ok()
            .map(|blueprint| blueprint.clone())
    }

    /// Returns the stored master with `uid`.
    pub fn master(&self, uid: Uuid) -> Option<Master> {
        self.masters.get(uid).ok().map(|master| master.clone())
    }

    /// Lists the identifiers of every object of a supported board target type.
    fn identifiers_of_type(&self, object_type: ObjectType) -> Vec<Identifiers> {
        match object_type {
            ObjectType::Clip => self
                .clips
                .iter()
                .map(|clip| clip.identifiers.clone())
                .collect(),
            ObjectType::Group => all_identifiers(&self.groups),
            ObjectType::Blueprint => all_identifiers(&self.blueprints),
            ObjectType::Master => all_identifiers(&self.masters),
            _ => Vec::new(),
        }
    }

    /// Returns the targets currently shown by a pinned or collection element.
    pub fn element_targets(&self, element: &BoardElement) -> Vec<ObjectIdentity> {
        match &element.kind {
            BoardElementKind::Target { target } => vec![*target],
            BoardElementKind::Collection { query, .. } => {
                let identifiers = self.identifiers_of_type(query.object_type);
                query
                    .select(identifiers.iter(), |identifiers| identifiers)
                    .into_iter()
                    .map(|identifiers| ObjectIdentity {
                        object_type: query.object_type,
                        uid: identifiers.uid,
                    })
                    .collect()
            }
            BoardElementKind::Frame { .. } | BoardElementKind::Label | BoardElementKind::Tempo => {
                Vec::new()
            }
        }
    }

    /// Computes the live state of one target.
    pub fn item_state(
        &self,
        context: &BoardStateContext,
        target: &ObjectIdentity,
    ) -> BoardItemState {
        let Some(identifiers) = self.identifiers(target) else {
            return BoardItemState::Missing;
        };
        let on = match target.object_type {
            ObjectType::Clip => context.running_clips.contains(&identifiers.id),
            ObjectType::Group => {
                let Ok(group) = self.groups.get(target.uid) else {
                    return BoardItemState::Missing;
                };
                let group_fixtures = self.resolve(&group.selection);
                !group_fixtures.is_empty() && group_fixtures == context.selected
            }
            ObjectType::Blueprint => {
                return blueprint_state(context, target.uid);
            }
            ObjectType::Master => self
                .master(target.uid)
                .is_some_and(|master| master.is_active()),
            _ => false,
        };
        if on {
            BoardItemState::On
        } else {
            BoardItemState::Off
        }
    }

    /// Resolves every pressable element on a board to its buttons and their states.
    pub fn board_status(&self, context: &BoardStateContext, board: &Board) -> BoardStatus {
        let elements = board
            .elements
            .iter()
            .filter(|element| {
                matches!(
                    element.kind,
                    BoardElementKind::Target { .. } | BoardElementKind::Collection { .. }
                )
            })
            .map(|element| BoardElementStatus {
                element_uid: element.uid,
                items: self
                    .element_targets(element)
                    .into_iter()
                    .map(|target| {
                        let identifiers = self.identifiers(&target);
                        BoardItem {
                            target,
                            id: identifiers.as_ref().map_or(0, |identifiers| identifiers.id),
                            label: identifiers
                                .map(|identifiers| identifiers.label)
                                .unwrap_or_default(),
                            state: self.item_state(context, &target),
                        }
                    })
                    .collect(),
            })
            .collect();
        BoardStatus {
            board_uid: board.identifiers.uid,
            elements,
        }
    }
}

/// Decides a blueprint button's state from the fixtures its Programmer values cover.
///
/// With a selection, the button is on when every selected fixture carries the blueprint and
/// partial when only some do. With no selection it is on whenever the blueprint is applied.
fn blueprint_state(context: &BoardStateContext, blueprint_uid: Uuid) -> BoardItemState {
    let Some(fixtures) = context.blueprint_fixtures(blueprint_uid) else {
        return BoardItemState::Off;
    };
    if context.selected.is_empty() {
        return if fixtures.is_empty() {
            BoardItemState::Off
        } else {
            BoardItemState::On
        };
    }
    let covered = context
        .selected
        .iter()
        .filter(|fixture| fixtures.contains(*fixture))
        .count();
    match covered {
        0 => BoardItemState::Off,
        count if count == context.selected.len() => BoardItemState::On,
        _ => BoardItemState::Partial,
    }
}

/// Returns a stored object's identifiers by UID.
fn provider_identifiers<T>(provider: &DataProvider<T>, uid: Uuid) -> Option<Identifiers>
where
    T: HasIdentifiers + Clone + Send + Sync + 'static,
{
    provider
        .get(uid)
        .ok()
        .map(|object| object.identifiers().clone())
}

/// Lists the identifiers of every object in a provider.
fn all_identifiers<T>(provider: &DataProvider<T>) -> Vec<Identifiers>
where
    T: HasIdentifiers + Clone + Send + Sync + 'static,
{
    provider
        .iter()
        .map(|entry| entry.value().identifiers().clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a fixture reference for state tests.
    fn fixture(n: u128) -> FixtureRef {
        FixtureRef {
            fixture_uid: Uuid::from_u128(n),
            index: None,
        }
    }

    /// Builds a context with the given selection and blueprint coverage.
    fn context(selected: &[u128], blueprint: Uuid, covered: &[u128]) -> BoardStateContext {
        BoardStateContext {
            selected: selected.iter().copied().map(fixture).collect(),
            blueprint_fixtures: HashMap::from([(
                blueprint,
                covered.iter().copied().map(fixture).collect(),
            )]),
            running_clips: HashSet::new(),
        }
    }

    /// Blueprint buttons are on, partial or off depending on how much of the selection they cover.
    #[test]
    fn blueprint_state_follows_selection_coverage() {
        let red = Uuid::from_u128(77);
        assert_eq!(
            blueprint_state(&context(&[1, 2], red, &[1, 2, 3]), red),
            BoardItemState::On
        );
        assert_eq!(
            blueprint_state(&context(&[1, 2], red, &[2]), red),
            BoardItemState::Partial
        );
        assert_eq!(
            blueprint_state(&context(&[1, 2], red, &[3]), red),
            BoardItemState::Off
        );
        assert_eq!(
            blueprint_state(&context(&[], red, &[3]), red),
            BoardItemState::On
        );
        assert_eq!(
            blueprint_state(&context(&[1], red, &[1]), Uuid::from_u128(78)),
            BoardItemState::Off
        );
    }
}
