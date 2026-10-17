// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! What held slot Flash and Swop buttons do to running playbacks.
//!
//! The effects are resolved once per frame into [`HeldButtonEffects`], which rendering applies
//! and every client view reports, so a playback a Swop takes out never looks normal anywhere.

use std::collections::HashMap;

use bevy_ecs::prelude::*;
use nightfall_instances::{EditorPreviewInstance, InstanceId, InstanceKind, InstanceMetadata};
use serde::{Deserialize, Serialize};

use super::Controls;
use crate::clips::MaterializedClip;

/// How a held slot button changes one playback.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum HeldButtonEffect {
    /// A Flash held on the control slot plays the playback at full intensity.
    Flashed { control_index: u32 },
    /// A Swop held on the control slot plays the playback at full intensity on its own.
    Swopping { control_index: u32 },
    /// A Swop held on the control slot takes the playback out entirely.
    SwoppedOut { control_index: u32 },
}

/// Held-button effect on each running playback, resolved every frame by
/// [`resolve_held_button_effects`].
#[derive(Resource, Debug, Default, PartialEq)]
pub struct HeldButtonEffects {
    by_instance: HashMap<InstanceId, HeldButtonEffect>,
}

impl HeldButtonEffects {
    /// Returns how held buttons change the playback, or `None` when none concerns it.
    pub fn get(&self, instance_id: &InstanceId) -> Option<HeldButtonEffect> {
        self.by_instance.get(instance_id).copied()
    }
}

/// Resolves which playbacks held Flash and Swop buttons play at full and which a Swop takes
/// out.
///
/// A Swop only takes other playbacks out while its own clip is running, so the stage never goes
/// dark while the swopped clip is still starting, has ended, or failed to start.
///
/// The Programmer stays live during a swop so the operator can keep working, and editor
/// previews are not show playbacks, so neither is ever taken out. The resource only changes
/// when an effect does, so views listening for changes resend only then.
pub fn resolve_held_button_effects(
    controls: Res<Controls>,
    materialized_clips: Query<&MaterializedClip>,
    playbacks: Query<(&InstanceId, &InstanceMetadata, Has<EditorPreviewInstance>)>,
    mut effects: ResMut<HeldButtonEffects>,
) {
    let mut by_instance = HashMap::new();
    let mut swop_slot = None;
    for (control_index, clip_id, swop) in controls.flashed_clips() {
        let effect = if swop {
            HeldButtonEffect::Swopping { control_index }
        } else {
            HeldButtonEffect::Flashed { control_index }
        };
        let mut running = false;
        for materialized in materialized_clips
            .iter()
            .filter(|materialized| materialized.clip_id == clip_id)
        {
            running = true;
            by_instance
                .entry(materialized.attached_instance)
                .or_insert(effect);
        }
        if swop && running {
            swop_slot.get_or_insert(control_index);
        }
    }
    if let Some(control_index) = swop_slot {
        for (instance_id, metadata, is_preview) in &playbacks {
            if is_preview || metadata.kind == InstanceKind::Programmer {
                continue;
            }
            by_instance
                .entry(*instance_id)
                .or_insert(HeldButtonEffect::SwoppedOut { control_index });
        }
    }
    effects.set_if_neq(HeldButtonEffects { by_instance });
}

#[cfg(test)]
mod tests {
    use bevy_app::{App, Update};
    use nightfall_instances::InstanceKind;

    use super::*;
    use crate::controls::{ControlAssignment, ControlButtonMode, ControlSlotConfig};

    /// Builds an app whose control slots 1 and 2 swop clip 5 and flash clip 6 respectively.
    fn held_app(slot_1: ControlButtonMode) -> App {
        let mut app = App::new();
        app.init_resource::<HeldButtonEffects>();
        app.insert_resource(Controls::from_slot_configs(&[
            ControlSlotConfig {
                assignment: Some(ControlAssignment::Clip(5)),
                button_mode: slot_1,
            },
            ControlSlotConfig {
                assignment: Some(ControlAssignment::Clip(6)),
                button_mode: ControlButtonMode::Flash,
            },
        ]));
        app.add_systems(Update, resolve_held_button_effects);
        app
    }

    /// Spawns a running playback of `kind`, bound to `clip_id` when set, and returns its id.
    fn spawn_playback(app: &mut App, kind: InstanceKind, clip_id: Option<u32>) -> InstanceId {
        let instance_id = InstanceId::new();
        app.world_mut()
            .spawn((instance_id, InstanceMetadata::new(kind)));
        if let Some(clip_id) = clip_id {
            app.world_mut().spawn(MaterializedClip {
                clip_id,
                attached_instance: instance_id,
                auto_release_on_stop: false,
            });
        }
        instance_id
    }

    /// Marks slot `control_index` as held by a web client.
    fn hold(app: &mut App, control_index: u32) {
        app.world_mut()
            .resource_mut::<Controls>()
            .hold_for_test(control_index);
    }

    /// Verifies a held Swop plays its clip at full, names its slot on every other playback it
    /// takes out, leaves the Programmer and editor previews alone, and lets a second slot's
    /// Flash keep its own clip at full.
    #[test]
    fn swop_names_its_slot_on_the_playbacks_it_takes_out() {
        let mut app = held_app(ControlButtonMode::Swop);
        let swopped = spawn_playback(&mut app, InstanceKind::Fx, Some(5));
        let flashed = spawn_playback(&mut app, InstanceKind::Sequence, Some(6));
        let other = spawn_playback(&mut app, InstanceKind::Sequence, Some(7));
        let programmer = spawn_playback(&mut app, InstanceKind::Programmer, None);
        let preview = spawn_playback(&mut app, InstanceKind::Fx, None);
        let preview_entity = app
            .world_mut()
            .query::<(Entity, &InstanceId)>()
            .iter(app.world())
            .find_map(|(entity, id)| (*id == preview).then_some(entity))
            .expect("preview playback exists");
        app.world_mut()
            .entity_mut(preview_entity)
            .insert(EditorPreviewInstance);

        hold(&mut app, 1);
        hold(&mut app, 2);
        app.update();
        let effects = app.world().resource::<HeldButtonEffects>();
        assert_eq!(
            effects.get(&swopped),
            Some(HeldButtonEffect::Swopping { control_index: 1 })
        );
        assert_eq!(
            effects.get(&flashed),
            Some(HeldButtonEffect::Flashed { control_index: 2 })
        );
        assert_eq!(
            effects.get(&other),
            Some(HeldButtonEffect::SwoppedOut { control_index: 1 })
        );
        assert_eq!(effects.get(&programmer), None);
        assert_eq!(effects.get(&preview), None);
    }

    /// Verifies a held Swop whose clip is not running, such as one still starting or one that
    /// already ended, takes nothing out.
    #[test]
    fn swop_without_a_running_clip_takes_nothing_out() {
        let mut app = held_app(ControlButtonMode::Swop);
        let other = spawn_playback(&mut app, InstanceKind::Sequence, Some(7));

        hold(&mut app, 1);
        app.update();
        assert_eq!(
            app.world().resource::<HeldButtonEffects>().get(&other),
            None
        );
    }

    /// Verifies a plain Flash takes nothing out and nothing is reported once nobody holds a
    /// button.
    #[test]
    fn flash_takes_nothing_out() {
        let mut app = held_app(ControlButtonMode::Flash);
        let flashed = spawn_playback(&mut app, InstanceKind::Fx, Some(5));
        let other = spawn_playback(&mut app, InstanceKind::Sequence, Some(7));

        app.update();
        assert_eq!(
            *app.world().resource::<HeldButtonEffects>(),
            HeldButtonEffects::default()
        );

        hold(&mut app, 1);
        app.update();
        let effects = app.world().resource::<HeldButtonEffects>();
        assert_eq!(
            effects.get(&flashed),
            Some(HeldButtonEffect::Flashed { control_index: 1 })
        );
        assert_eq!(effects.get(&other), None);
    }
}
