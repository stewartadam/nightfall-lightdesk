// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! What held fader Flash and Swop buttons do to running playbacks.
//!
//! The effects are resolved once per frame into a [`HeldButtonEffect`] on each playback they
//! concern, which rendering applies and every client view reports, so a playback a Swop takes
//! out never looks normal anywhere.

use std::collections::HashMap;

use bevy_ecs::prelude::*;
use nightfall_clips::MaterializedClip;
use nightfall_instances::{
    EditorPreviewInstance, HeldButtonEffect, InstanceId, InstanceKind, InstanceMetadata,
};

use super::Faders;

/// Playback components the held-button resolution reads and updates.
type HeldButtonPlayback = (
    Entity,
    &'static InstanceId,
    Option<&'static InstanceMetadata>,
    Has<EditorPreviewInstance>,
    Option<&'static HeldButtonEffect>,
);

/// Resolves which playbacks held Flash and Swop buttons play at full and which a Swop takes
/// out, and puts the [`HeldButtonEffect`] on each of them.
///
/// A Swop only takes other playbacks out while its own clip is running, so the stage never goes
/// dark while the swopped clip is still starting, has ended, or failed to start.
///
/// The Programmer stays live during a swop so the operator can keep working, and editor
/// previews are not show playbacks, so neither is ever taken out. A playback's component is
/// only inserted or removed when its effect changes, so views listening for changes resend only
/// then.
pub fn resolve_held_button_effects(
    faders: Res<Faders>,
    materialized_clips: Query<&MaterializedClip>,
    playbacks: Query<HeldButtonPlayback>,
    mut commands: Commands,
) {
    let mut by_instance = HashMap::new();
    let mut swop_slot = None;
    for (fader_index, clip_id, swop) in faders.flashed_clips() {
        let effect = if swop {
            HeldButtonEffect::Swopping { fader_index }
        } else {
            HeldButtonEffect::Flashed { fader_index }
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
            swop_slot.get_or_insert(fader_index);
        }
    }
    for (entity, instance_id, metadata, is_preview, current) in &playbacks {
        let swopped_out = swop_slot
            .filter(|_| {
                !is_preview
                    && metadata.is_none_or(|metadata| metadata.kind != InstanceKind::Programmer)
            })
            .map(|fader_index| HeldButtonEffect::SwoppedOut { fader_index });
        let effect = by_instance.get(instance_id).copied().or(swopped_out);
        if current.copied() == effect {
            continue;
        }
        // A playback despawned before the commands apply simply has nothing left to change.
        match effect {
            Some(effect) => commands.entity(entity).try_insert(effect),
            None => commands.entity(entity).try_remove::<HeldButtonEffect>(),
        };
    }
}

#[cfg(test)]
mod tests {
    use bevy_app::{App, Update};
    use nightfall_instances::InstanceKind;

    use super::*;
    use crate::faders::{FaderAssignment, FaderButtonMode, FaderConfig};

    /// Builds an app whose faders 1 and 2 swop clip 5 and flash clip 6 respectively.
    fn held_app(fader_1: FaderButtonMode) -> App {
        let mut app = App::new();
        app.insert_resource(Faders::from_configs(&[
            FaderConfig {
                assignment: Some(FaderAssignment::Clip(5)),
                button_mode: fader_1,
            },
            FaderConfig {
                assignment: Some(FaderAssignment::Clip(6)),
                button_mode: FaderButtonMode::Flash,
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

    /// Returns the held-button effect on the playback `instance_id`, if any.
    fn effect(app: &mut App, instance_id: InstanceId) -> Option<HeldButtonEffect> {
        app.world_mut()
            .query::<(&InstanceId, Option<&HeldButtonEffect>)>()
            .iter(app.world())
            .find_map(|(id, effect)| (*id == instance_id).then_some(effect.copied()))
            .flatten()
    }

    /// Marks fader `fader_index` as held by a web client.
    fn hold(app: &mut App, fader_index: u32) {
        app.world_mut()
            .resource_mut::<Faders>()
            .hold_for_test(fader_index);
    }

    /// Verifies a held Swop plays its clip at full, names its fader on every other playback it
    /// takes out, leaves the Programmer and editor previews alone, and lets a second fader's
    /// Flash keep its own clip at full.
    #[test]
    fn swop_names_its_slot_on_the_playbacks_it_takes_out() {
        let mut app = held_app(FaderButtonMode::Swop);
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
        assert_eq!(
            effect(&mut app, swopped),
            Some(HeldButtonEffect::Swopping { fader_index: 1 })
        );
        assert_eq!(
            effect(&mut app, flashed),
            Some(HeldButtonEffect::Flashed { fader_index: 2 })
        );
        assert_eq!(
            effect(&mut app, other),
            Some(HeldButtonEffect::SwoppedOut { fader_index: 1 })
        );
        assert_eq!(effect(&mut app, programmer), None);
        assert_eq!(effect(&mut app, preview), None);
    }

    /// Verifies a held Swop whose clip is not running, such as one still starting or one that
    /// already ended, takes nothing out.
    #[test]
    fn swop_without_a_running_clip_takes_nothing_out() {
        let mut app = held_app(FaderButtonMode::Swop);
        let other = spawn_playback(&mut app, InstanceKind::Sequence, Some(7));

        hold(&mut app, 1);
        app.update();
        assert_eq!(effect(&mut app, other), None);
    }

    /// Verifies a plain Flash takes nothing out, nothing is reported while nobody holds a
    /// button, and releasing the button takes the effect off again.
    #[test]
    fn flash_takes_nothing_out() {
        let mut app = held_app(FaderButtonMode::Flash);
        let flashed = spawn_playback(&mut app, InstanceKind::Fx, Some(5));
        let other = spawn_playback(&mut app, InstanceKind::Sequence, Some(7));

        app.update();
        assert_eq!(effect(&mut app, flashed), None);
        assert_eq!(effect(&mut app, other), None);

        hold(&mut app, 1);
        app.update();
        assert_eq!(
            effect(&mut app, flashed),
            Some(HeldButtonEffect::Flashed { fader_index: 1 })
        );
        assert_eq!(effect(&mut app, other), None);

        app.world_mut()
            .resource_mut::<Faders>()
            .fader_mut(1)
            .expect("fader exists")
            .flash = None;
        app.update();
        assert_eq!(effect(&mut app, flashed), None);
    }
}
