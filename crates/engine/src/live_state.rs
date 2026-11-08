// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! The live state of a running show: what is playing, at which level and position, the tempo
//! and the programmer, as opposed to the stored show.
//!
//! Each domain registers a section that captures its live state and restores it. A backup
//! applies the primary's checkpoints over and over, so a restore reconciles: it changes only
//! what differs and leaves matching playback alone, which keeps a repeated checkpoint free of
//! visible jumps.

use std::{collections::BTreeMap, time::Duration};

use bevy_app::App;
use bevy_ecs::prelude::{Resource, World};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;

/// Live state captured from every registered domain, keyed by section.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct LiveStateSnapshot {
    /// Each domain's captured state.
    pub sections: BTreeMap<String, Value>,
}

/// How old a checkpoint is when it is restored.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LiveStateRestore {
    /// Time since the primary captured the checkpoint. Running clocks restore this far ahead
    /// of their captured position.
    pub age: Duration,
}

/// Captures one domain's live state.
type CaptureFn = Box<dyn Fn(&mut World) -> Result<Value, String> + Send + Sync>;

/// Restores one domain's live state.
type RestoreFn =
    Box<dyn Fn(&mut World, Value, LiveStateRestore) -> Result<(), String> + Send + Sync>;

/// One domain's registered live state.
struct LiveStateSection {
    key: &'static str,
    capture: CaptureFn,
    restore: RestoreFn,
}

/// Every domain's live state section, in registration order.
#[derive(Resource, Default)]
pub struct LiveStateRegistry {
    sections: Vec<LiveStateSection>,
}

impl LiveStateRegistry {
    /// Returns the registered section keys in registration order.
    pub fn keys(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.sections.iter().map(|section| section.key)
    }
}

/// Registers live state sections on an app.
pub trait LiveStateAppExt {
    /// Registers a domain's live state under `key`: `capture` reads it from the world and
    /// `restore` reconciles the world with a captured value.
    ///
    /// # Panics
    ///
    /// Panics when another section already uses `key`.
    fn register_live_state<T>(
        &mut self,
        key: &'static str,
        capture: fn(&mut World) -> T,
        restore: fn(&mut World, T, LiveStateRestore),
    ) -> &mut Self
    where
        T: Serialize + DeserializeOwned + 'static;
}

impl LiveStateAppExt for App {
    /// Adds the section to the registry, creating the registry on first use.
    fn register_live_state<T>(
        &mut self,
        key: &'static str,
        capture: fn(&mut World) -> T,
        restore: fn(&mut World, T, LiveStateRestore),
    ) -> &mut Self
    where
        T: Serialize + DeserializeOwned + 'static,
    {
        let mut registry = self.world_mut().get_resource_or_init::<LiveStateRegistry>();
        assert!(
            registry.sections.iter().all(|section| section.key != key),
            "live state section {key} is registered twice"
        );
        registry.sections.push(LiveStateSection {
            key,
            capture: Box::new(move |world| {
                serde_json::to_value(capture(world)).map_err(|error| error.to_string())
            }),
            restore: Box::new(move |world, value, context| {
                let state = serde_json::from_value(value).map_err(|error| error.to_string())?;
                restore(world, state, context);
                Ok(())
            }),
        });
        self
    }
}

/// Captures every registered section from the world.
///
/// A section that fails to serialize is left out and logged, so one domain cannot hold back
/// the rest of the checkpoint.
pub fn capture_live_state(world: &mut World) -> LiveStateSnapshot {
    if !world.contains_resource::<LiveStateRegistry>() {
        return LiveStateSnapshot::default();
    }
    world.resource_scope(
        |world, registry: bevy_ecs::change_detection::Mut<LiveStateRegistry>| {
            let mut snapshot = LiveStateSnapshot::default();
            for section in &registry.sections {
                match (section.capture)(world) {
                    Ok(value) => {
                        snapshot.sections.insert(section.key.to_string(), value);
                    }
                    Err(error) => {
                        tracing::warn!(section = section.key, %error, "live_state_capture_failed");
                    }
                }
            }
            snapshot
        },
    )
}

/// Restores every section the snapshot holds and this world registered, in registration order,
/// and returns a description of each section that could not be read.
///
/// Sections the snapshot lacks are left alone, as are sections this world does not know.
pub fn restore_live_state(
    world: &mut World,
    snapshot: &LiveStateSnapshot,
    context: LiveStateRestore,
) -> Vec<String> {
    if !world.contains_resource::<LiveStateRegistry>() {
        return Vec::new();
    }
    world.resource_scope(
        |world, registry: bevy_ecs::change_detection::Mut<LiveStateRegistry>| {
            let mut errors = Vec::new();
            for section in &registry.sections {
                let Some(value) = snapshot.sections.get(section.key) else {
                    continue;
                };
                if let Err(error) = (section.restore)(world, value.clone(), context) {
                    errors.push(format!("{}: {error}", section.key));
                }
            }
            errors
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A counter standing in for a domain's live state.
    #[derive(Resource, Default)]
    struct Level(u32);

    /// Reads the counter.
    fn capture_level(world: &mut World) -> u32 {
        world.resource::<Level>().0
    }

    /// Writes the counter plus the checkpoint's age in seconds, to show the age arrives.
    fn restore_level(world: &mut World, level: u32, context: LiveStateRestore) {
        world.resource_mut::<Level>().0 = level + context.age.as_secs() as u32;
    }

    /// Builds an app with the counter registered as a live state section.
    fn app_with_level(level: u32) -> App {
        let mut app = App::new();
        app.insert_resource(Level(level));
        app.register_live_state("level", capture_level, restore_level);
        app
    }

    /// A checkpoint captured in one world restores into another, carrying its age.
    #[test]
    fn checkpoint_round_trips_between_worlds() {
        let mut primary = app_with_level(7);
        let snapshot = capture_live_state(primary.world_mut());
        assert_eq!(snapshot.sections["level"], serde_json::json!(7));

        let mut backup = app_with_level(0);
        let errors = restore_live_state(
            backup.world_mut(),
            &snapshot,
            LiveStateRestore {
                age: Duration::from_secs(2),
            },
        );
        assert!(errors.is_empty());
        assert_eq!(backup.world().resource::<Level>().0, 9);
    }

    /// Unreadable sections are reported and missing ones leave the world alone.
    #[test]
    fn unreadable_or_missing_sections_change_nothing() {
        let mut backup = app_with_level(3);
        let mut snapshot = LiveStateSnapshot::default();
        assert!(
            restore_live_state(backup.world_mut(), &snapshot, LiveStateRestore::default())
                .is_empty()
        );
        snapshot
            .sections
            .insert("level".into(), serde_json::json!("loud"));
        let errors = restore_live_state(backup.world_mut(), &snapshot, LiveStateRestore::default());
        assert_eq!(errors.len(), 1);
        assert_eq!(backup.world().resource::<Level>().0, 3);
    }

    /// Two domains cannot claim the same section key.
    #[test]
    #[should_panic(expected = "registered twice")]
    fn duplicate_keys_are_rejected() {
        let mut app = app_with_level(0);
        app.register_live_state("level", capture_level, restore_level);
    }
}
