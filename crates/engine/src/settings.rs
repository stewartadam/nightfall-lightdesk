// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Settings sections: typed settings that each owning crate keeps, saves with the showfile, and
//! sends to clients.
//!
//! An owner defines a plain resource for its settings and registers it once with
//! [`SettingsAppExt::register_settings_section`] under a stable key. Owners read and write their
//! resource like any other. The registry does the rest:
//!
//! - Every frame after event handling, [`sync_settings_values`] serializes each section whose
//!   resource changed into [`SettingsValues`].
//! - Later that frame, one [`EngineClientMessage::Settings`] message carries the sections whose
//!   value changed. A resync sends every section.
//! - Showfile saves write [`SettingsValues::saved`] as one map keyed by section, and loads hand
//!   that map to [`load_saved_settings`], which restores each registered section and keeps the
//!   sections with no registered owner, such as the settings of a disabled plugin, to save back.

use std::{
    borrow::Cow,
    collections::{BTreeMap, BTreeSet},
};

use bevy_app::prelude::*;
use bevy_ecs::{
    change_detection::Tick,
    component::{Component, Mutable},
    prelude::*,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;

use crate::{
    ClientFeedback, EventHandling, ResyncHandling,
    client::{Undo, register_client_command},
    prelude::{
        ClientEventSink, CommandEnvelope, CommandError, CommandResponder,
        DISCRIMINATOR_NON_DROPPABLE, EngineClientMessage, EngineIngressMeta, EnginePayload,
        IngressCommand, ResyncReplies, ResyncRequested,
    },
};

pub mod panel_layouts;
pub mod ui_preferences;

/// Value types a settings section can hold.
pub trait SettingsValue:
    Resource + Component<Mutability = Mutable> + Default + Clone + Serialize + DeserializeOwned
{
}

impl<T> SettingsValue for T where
    T: Resource + Component<Mutability = Mutable> + Default + Clone + Serialize + DeserializeOwned
{
}

/// Describes one settings section: the key it is saved and sent under, and the form it is saved
/// in.
///
/// Owners usually keep one as a constant next to their settings type and pass it to
/// [`SettingsAppExt::register_settings_section`].
pub struct SettingsSection<T: Clone + 'static> {
    /// Key the section is saved and sent under; unique across the app.
    key: &'static str,
    /// Returns the value as the showfile stores it.
    saved: fn(&T) -> Cow<'_, T>,
}

impl<T: Clone + 'static> SettingsSection<T> {
    /// Describes a section saved under `key` exactly as clients see it.
    pub const fn new(key: &'static str) -> Self {
        Self {
            key,
            saved: borrowed,
        }
    }

    /// Saves the section in the form `saved` returns, such as without session-only entries.
    pub const fn saved_as(self, saved: fn(&T) -> Cow<'_, T>) -> Self {
        Self {
            key: self.key,
            saved,
        }
    }

    /// Returns the key the section is saved and sent under.
    pub const fn key(&self) -> &'static str {
        self.key
    }
}

/// Saves a section exactly as clients see it.
fn borrowed<T: Clone>(value: &T) -> Cow<'_, T> {
    Cow::Borrowed(value)
}

/// A section's current value serialized for clients and for the showfile.
struct CapturedSection {
    /// Value clients see.
    current: Value,
    /// Value the showfile stores.
    saved: Value,
}

/// Type-erased access to one registered section's resource.
trait ErasedSection: Send + Sync {
    /// Returns the key the section is saved and sent under.
    fn key(&self) -> &'static str;

    /// Returns when the section's resource last changed, or `None` while it is absent.
    fn changed_tick(&self, world: &World) -> Option<Tick>;

    /// Serializes the section's resource, which must be present.
    fn capture(&self, world: &World) -> Result<CapturedSection, serde_json::Error>;

    /// Replaces the section's resource with `saved`, or with its default when `saved` is `None`.
    fn load(&self, world: &mut World, saved: Option<&Value>) -> Result<(), serde_json::Error>;

    /// Returns `saved` as this build would save it after loading it: missing fields and an invalid
    /// or missing section take their defaults, and the saved form is applied.
    fn canonical_saved(&self, saved: Option<&Value>) -> Value;
}

impl<T: SettingsValue> ErasedSection for SettingsSection<T> {
    /// Returns the section key.
    fn key(&self) -> &'static str {
        self.key
    }

    /// Reads the resource's change tick without borrowing the value.
    fn changed_tick(&self, world: &World) -> Option<Tick> {
        world
            .get_resource_change_ticks::<T>()
            .map(|ticks| ticks.changed)
    }

    /// Serializes the resource as clients see it and as the showfile stores it.
    fn capture(&self, world: &World) -> Result<CapturedSection, serde_json::Error> {
        let value = world.resource::<T>();
        let current = serde_json::to_value(value)?;
        let saved = match (self.saved)(value) {
            Cow::Borrowed(_) => current.clone(),
            Cow::Owned(saved) => serde_json::to_value(&saved)?,
        };
        Ok(CapturedSection { current, saved })
    }

    /// Deserializes `saved` into the resource, falling back to the default for a missing value.
    fn load(&self, world: &mut World, saved: Option<&Value>) -> Result<(), serde_json::Error> {
        let value = match saved {
            Some(saved) => T::deserialize(saved)?,
            None => T::default(),
        };
        world.insert_resource(value);
        Ok(())
    }

    /// Round-trips `saved` through `T`, the way loading and then saving it would.
    fn canonical_saved(&self, saved: Option<&Value>) -> Value {
        let value = saved
            .and_then(|saved| T::deserialize(saved).ok())
            .unwrap_or_default();
        serde_json::to_value((self.saved)(&value).as_ref())
            .expect("a settings section that deserialized serializes again")
    }
}

/// One registered section and the resource change it was last serialized at.
struct RegisteredSection {
    /// Type-erased access to the section's resource.
    section: Box<dyn ErasedSection>,
    /// Change tick of the resource when it was last serialized.
    synced_at: Option<Tick>,
}

/// Every settings section registered in this app.
#[derive(Resource, Default)]
pub struct SettingsRegistry {
    /// Sections in registration order.
    sections: Vec<RegisteredSection>,
}

impl SettingsRegistry {
    /// Returns whether a section is registered under `key`.
    pub fn contains(&self, key: &str) -> bool {
        self.sections.iter().any(|entry| entry.section.key() == key)
    }

    /// Returns a showfile's settings map as this app would save it right after loading it.
    ///
    /// Each registered section is filled in with its defaults, and keys with no registered owner
    /// are kept as they are. Comparing two maps in this form ignores differences that loading
    /// would erase, such as a field the file left out.
    pub fn canonical_saved(&self, saved: &BTreeMap<String, Value>) -> BTreeMap<String, Value> {
        let mut canonical: BTreeMap<String, Value> = saved
            .iter()
            .filter(|(key, _)| !self.contains(key))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        for entry in &self.sections {
            let key = entry.section.key();
            canonical.insert(
                key.to_string(),
                entry.section.canonical_saved(saved.get(key)),
            );
        }
        canonical
    }
}

/// Serialized value of every registered section, kept current by [`sync_settings_values`].
#[derive(Resource, Default, Debug)]
pub struct SettingsValues {
    /// Values clients see, by section key.
    current: BTreeMap<&'static str, Value>,
    /// Values the showfile stores, by section key.
    saved: BTreeMap<&'static str, Value>,
    /// Sections whose client value changed since it was last sent.
    unsent: BTreeSet<&'static str>,
    /// Sections from the loaded showfile that no plugin in this app owns, saved back unchanged.
    unowned: BTreeMap<String, Value>,
}

impl SettingsValues {
    /// Returns every section as the showfile stores it, keyed by section, including the loaded
    /// show's sections that no plugin in this app owns.
    pub fn saved(&self) -> BTreeMap<String, Value> {
        let mut saved = self.unowned.clone();
        saved.extend(
            self.saved
                .iter()
                .map(|(key, value)| ((*key).to_string(), value.clone())),
        );
        saved
    }

    /// Returns the value clients see for the section saved under `key`.
    pub fn current(&self, key: &str) -> Option<&Value> {
        self.current.get(key)
    }
}

/// Settings sections sent to clients, keyed by section.
///
/// A resync carries every section; other messages carry only the sections that changed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[typeshare::typeshare]
pub struct SettingsUpdate {
    /// Section values by section key.
    #[typeshare(serialized_as = "HashMap<String, unknown>")]
    pub sections: BTreeMap<String, Value>,
}

/// `Update` system set in which [`SettingsValues`] catches up with this frame's settings changes.
///
/// Runs after [`EventHandling`], so settings commands applied this frame are saved and sent in the
/// same frame. Showfile saves and resyncs order themselves after this set.
#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub struct SettingsSync;

/// `Update` system set, inside [`EventHandling`], holding the handlers that
/// [`SettingsAppExt::add_settings_command`] adds.
///
/// Event handlers that react to a settings change in the same frame order themselves after it.
#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub struct SettingsCommandHandling;

/// App extension for registering settings sections and the commands that edit them.
pub trait SettingsAppExt {
    /// Adds `T` as a settings section saved and sent under the section's key, initializing the
    /// resource to its default.
    ///
    /// # Panics
    ///
    /// Panics when another section already uses the key.
    fn register_settings_section<T: SettingsValue>(
        &mut self,
        section: SettingsSection<T>,
    ) -> &mut Self;

    /// Registers `C` as a client command that edits the settings resource `T` with `apply`, and
    /// answers each command with success or the error `apply` returns.
    ///
    /// Settings edits skip the undo stack.
    fn add_settings_command<C, T>(
        &mut self,
        apply: fn(&C, &mut T) -> Result<(), CommandError>,
    ) -> &mut Self
    where
        C: IngressCommand + EnginePayload + EngineIngressMeta + Clone + DeserializeOwned,
        CommandEnvelope<C>: Message,
        T: Resource + Component<Mutability = Mutable> + Clone;
}

impl SettingsAppExt for App {
    /// Records the section in the registry and initializes its resource.
    fn register_settings_section<T: SettingsValue>(
        &mut self,
        section: SettingsSection<T>,
    ) -> &mut Self {
        register_settings_section(self.world_mut(), section);
        self
    }

    /// Registers the command and a handler system that applies it in [`EventHandling`].
    fn add_settings_command<C, T>(
        &mut self,
        apply: fn(&C, &mut T) -> Result<(), CommandError>,
    ) -> &mut Self
    where
        C: IngressCommand + EnginePayload + EngineIngressMeta + Clone + DeserializeOwned,
        CommandEnvelope<C>: Message,
        T: Resource + Component<Mutability = Mutable> + Clone,
    {
        register_client_command::<C>(self, Undo::Skipped);
        self.add_systems(
            Update,
            (move |mut commands: MessageReader<CommandEnvelope<C>>,
                   mut settings: ResMut<T>,
                   mut responder: CommandResponder| {
                for envelope in commands.read() {
                    // A refused edit leaves the resource untouched, so it is not saved or sent again.
                    let mut edited = settings.clone();
                    let response = match apply(&envelope.command, &mut edited) {
                        Ok(()) => {
                            *settings = edited;
                            responder.succeed(envelope.command_id)
                        }
                        Err(error) => responder.fail(envelope.command_id, error),
                    };
                    if let Err(error) = response {
                        tracing::error!(
                            command_id = %envelope.command_id,
                            command = C::COMMAND_MODULE,
                            %error,
                            "settings_command_completion_failed"
                        );
                    }
                }
            })
            .in_set(EventHandling)
            .in_set(SettingsCommandHandling),
        );
        self
    }
}

/// Adds the settings registry and the systems that sync, send, and resync its sections.
///
/// [`EnginePlugin`](crate::EnginePlugin) adds it and registers the engine's own sections; tests of
/// one owner's settings add it alone.
pub struct SettingsPlugin;

impl Plugin for SettingsPlugin {
    /// Initializes the registry, orders [`SettingsSync`] after event handling and before resyncs,
    /// and adds the sync, resync and change publication systems.
    fn build(&self, app: &mut App) {
        app.init_resource::<SettingsRegistry>();
        app.init_resource::<SettingsValues>();
        app.add_message::<ResyncRequested>();
        app.configure_sets(
            Update,
            (
                SettingsSync.after(EventHandling),
                ResyncHandling.after(SettingsSync),
            ),
        );
        app.add_systems(Update, sync_settings_values.in_set(SettingsSync));
        app.add_systems(Update, send_settings_on_resync.in_set(ResyncHandling));
        app.add_systems(PostUpdate, send_changed_settings.in_set(ClientFeedback));
    }
}

/// Adds `T` to the world's settings registry under the section's key and initializes the
/// resource to its default, for worlds built without an [`App`] such as portable showfile worlds.
///
/// # Panics
///
/// Panics when another section already uses the key.
pub fn register_settings_section<T: SettingsValue>(world: &mut World, section: SettingsSection<T>) {
    world.init_resource::<T>();
    world.init_resource::<SettingsValues>();
    let mut registry = world.get_resource_or_init::<SettingsRegistry>();
    assert!(
        !registry.contains(section.key),
        "settings section key {:?} is registered twice",
        section.key
    );
    registry.sections.push(RegisteredSection {
        section: Box::new(section),
        synced_at: None,
    });
}

/// Registers the engine's own settings sections and their commands.
pub(crate) fn register_engine_sections(app: &mut App) {
    ui_preferences::build(app);
    panel_layouts::build(app);
}

/// Serializes every registered section whose resource changed since it was last serialized, and
/// marks the sections whose client value changed as unsent.
///
/// Runs as a system in [`SettingsSync`]; callers that build a showfile snapshot outside the
/// schedule call it first so the snapshot sees the latest settings.
pub fn sync_settings_values(world: &mut World) {
    if !world.contains_resource::<SettingsValues>() {
        return;
    }
    // Changes made after this sync but outside any system would otherwise share the tick the
    // sync saw, and look already synced.
    world.increment_change_tick();
    world.resource_scope(|world, mut registry: Mut<SettingsRegistry>| {
        let mut captured = Vec::new();
        for entry in &mut registry.sections {
            let Some(changed) = entry.section.changed_tick(world) else {
                continue;
            };
            if entry.synced_at == Some(changed) {
                continue;
            }
            entry.synced_at = Some(changed);
            match entry.section.capture(world) {
                Ok(section) => captured.push((entry.section.key(), section)),
                Err(error) => {
                    tracing::error!(key = entry.section.key(), %error, "settings_section_unserializable");
                }
            }
        }
        if captured.is_empty() {
            return;
        }
        let mut values = world.resource_mut::<SettingsValues>();
        for (key, section) in captured {
            if values.current.get(key) != Some(&section.current) {
                values.unsent.insert(key);
                values.current.insert(key, section.current);
            }
            values.saved.insert(key, section.saved);
        }
    });
}

/// Restores every registered section from a showfile's settings map.
///
/// A section missing from the map, or one that no longer parses, gets its default. Sections with
/// no registered owner, such as audio settings in the browser demo, are kept unchanged and saved
/// back with the show. [`SettingsValues`] is brought up to date before returning, so a save or a
/// client update later in the same frame sees the loaded values. Does nothing in a world without
/// a settings registry.
pub fn load_saved_settings(world: &mut World, saved: &BTreeMap<String, Value>) {
    if !world.contains_resource::<SettingsRegistry>() {
        return;
    }
    world.resource_scope(|world, registry: Mut<SettingsRegistry>| {
        for entry in &registry.sections {
            let key = entry.section.key();
            if let Err(error) = entry.section.load(world, saved.get(key)) {
                tracing::warn!(key, %error, "Showfile settings section is invalid; using defaults");
                entry
                    .section
                    .load(world, None)
                    .expect("loading a default settings section cannot fail");
            }
        }
        let unowned = saved
            .iter()
            .filter(|(key, _)| !registry.contains(key))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        world.resource_mut::<SettingsValues>().unowned = unowned;
    });
    sync_settings_values(world);
}

/// Sends the sections whose client value changed this frame in one message.
fn send_changed_settings(mut values: ResMut<SettingsValues>, sink: Option<Res<ClientEventSink>>) {
    if values.unsent.is_empty() {
        return;
    }
    let unsent = std::mem::take(&mut values.unsent);
    let Some(sink) = sink else {
        return;
    };
    let update = SettingsUpdate {
        sections: unsent
            .into_iter()
            .filter_map(|key| {
                values
                    .current
                    .get(key)
                    .map(|value| (key.to_string(), value.clone()))
            })
            .collect(),
    };
    sink.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &EngineClientMessage::Settings(&update),
    );
}

/// Sends every section to the clients that asked for a resync.
fn send_settings_on_resync(mut resync: ResyncReplies, values: Res<SettingsValues>) {
    let Some(sink) = resync.sink() else {
        return;
    };
    let update = SettingsUpdate {
        sections: values
            .current
            .iter()
            .map(|(key, value)| ((*key).to_string(), value.clone()))
            .collect(),
    };
    sink.publish(
        DISCRIMINATOR_NON_DROPPABLE,
        &EngineClientMessage::Settings(&update),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal settings section for registry tests.
    #[derive(Resource, Default, Clone, Debug, PartialEq, Serialize, Deserialize)]
    #[serde(default)]
    struct TestSettings {
        level: u32,
        session_only: bool,
    }

    /// Saves the test section without its session-only flag.
    fn without_session_only(settings: &TestSettings) -> Cow<'_, TestSettings> {
        Cow::Owned(TestSettings {
            session_only: false,
            ..settings.clone()
        })
    }

    /// Builds an app holding the registry and one test section.
    fn app() -> App {
        let mut app = App::new();
        app.init_resource::<SettingsRegistry>();
        app.init_resource::<SettingsValues>();
        app.register_settings_section(
            SettingsSection::<TestSettings>::new("test").saved_as(without_session_only),
        );
        app
    }

    /// Takes the keys of the sections waiting to be sent.
    fn take_unsent(app: &mut App) -> Vec<&'static str> {
        std::mem::take(&mut app.world_mut().resource_mut::<SettingsValues>().unsent)
            .into_iter()
            .collect()
    }

    /// A changed section is marked unsent once, and an unchanged one is not serialized again.
    #[test]
    fn changed_sections_are_marked_unsent_once() {
        let mut app = app();
        sync_settings_values(app.world_mut());
        assert_eq!(take_unsent(&mut app), ["test"]);

        sync_settings_values(app.world_mut());
        assert!(take_unsent(&mut app).is_empty());

        app.world_mut().resource_mut::<TestSettings>().level = 3;
        sync_settings_values(app.world_mut());
        assert_eq!(take_unsent(&mut app), ["test"]);
        assert_eq!(
            app.world().resource::<SettingsValues>().current("test"),
            Some(&serde_json::json!({ "level": 3, "session_only": false }))
        );
    }

    /// Writing an equal value marks the resource changed but sends nothing new.
    #[test]
    fn rewriting_an_equal_value_sends_nothing() {
        let mut app = app();
        sync_settings_values(app.world_mut());
        take_unsent(&mut app);

        app.world_mut().resource_mut::<TestSettings>().level = 0;
        sync_settings_values(app.world_mut());
        assert!(take_unsent(&mut app).is_empty());
    }

    /// The saved form drops session-only state while clients still see it.
    #[test]
    fn saved_form_differs_from_client_form() {
        let mut app = app();
        app.world_mut().resource_mut::<TestSettings>().session_only = true;
        sync_settings_values(app.world_mut());
        let values = app.world().resource::<SettingsValues>();
        assert_eq!(
            values.current("test"),
            Some(&serde_json::json!({ "level": 0, "session_only": true }))
        );
        assert_eq!(
            values.saved().get("test"),
            Some(&serde_json::json!({ "level": 0, "session_only": false }))
        );
    }

    /// Loading restores registered sections and defaults missing or invalid ones.
    #[test]
    fn load_restores_registered_sections() {
        let mut app = app();
        let saved = BTreeMap::from([
            (
                "test".to_string(),
                serde_json::json!({ "level": 7, "session_only": false }),
            ),
            (
                "disabled".to_string(),
                serde_json::json!({ "anything": true }),
            ),
        ]);
        load_saved_settings(app.world_mut(), &saved);
        assert_eq!(app.world().resource::<TestSettings>().level, 7);

        load_saved_settings(app.world_mut(), &BTreeMap::new());
        assert_eq!(
            *app.world().resource::<TestSettings>(),
            TestSettings::default()
        );

        app.world_mut().resource_mut::<TestSettings>().level = 2;
        let invalid = BTreeMap::from([("test".to_string(), serde_json::json!("not a section"))]);
        load_saved_settings(app.world_mut(), &invalid);
        assert_eq!(
            *app.world().resource::<TestSettings>(),
            TestSettings::default()
        );
    }

    /// A loaded section with no owner in this app is saved back unchanged, and the loaded values
    /// are ready to save without waiting for the next sync.
    #[test]
    fn load_keeps_unowned_sections_and_syncs_values() {
        let mut app = app();
        let unowned = serde_json::json!({ "output_device": "USB DAC" });
        let saved = BTreeMap::from([
            ("test".to_string(), serde_json::json!({ "level": 7 })),
            ("audio".to_string(), unowned.clone()),
        ]);
        load_saved_settings(app.world_mut(), &saved);

        let values = app.world().resource::<SettingsValues>().saved();
        assert_eq!(values.get("audio"), Some(&unowned));
        assert_eq!(
            values.get("test"),
            Some(&serde_json::json!({ "level": 7, "session_only": false }))
        );
    }

    /// The canonical form fills in defaults for registered sections, applies the saved form, and
    /// keeps unowned sections as they are.
    #[test]
    fn canonical_saved_matches_what_a_save_writes() {
        let mut app = app();
        let unowned = serde_json::json!({ "anything": true });
        let saved = BTreeMap::from([
            (
                "test".to_string(),
                serde_json::json!({ "session_only": true }),
            ),
            ("disabled".to_string(), unowned.clone()),
        ]);
        let canonical = app
            .world()
            .resource::<SettingsRegistry>()
            .canonical_saved(&saved);

        load_saved_settings(app.world_mut(), &saved);
        assert_eq!(canonical, app.world().resource::<SettingsValues>().saved());
        assert_eq!(
            canonical.get("test"),
            Some(&serde_json::json!({ "level": 0, "session_only": false }))
        );
        assert_eq!(canonical.get("disabled"), Some(&unowned));
    }

    /// One message carries only the sections that changed, and nothing is sent while nothing
    /// changes.
    #[test]
    fn changed_sections_reach_clients_in_one_message() {
        /// Second section, so the test can show an unchanged section is left out.
        #[derive(Resource, Default, Clone, Debug, PartialEq, Serialize, Deserialize)]
        struct OtherSettings {
            enabled: bool,
        }

        let (sender, receiver) = async_channel::unbounded();
        let mut app = App::new();
        app.add_plugins(SettingsPlugin);
        app.insert_resource(ClientEventSink::new(sender));
        app.register_settings_section(SettingsSection::<TestSettings>::new("test"));
        app.register_settings_section(SettingsSection::<OtherSettings>::new("other"));
        app.update();
        while receiver.try_recv().is_ok() {}

        app.update();
        assert!(receiver.try_recv().is_err());

        app.world_mut().resource_mut::<TestSettings>().level = 4;
        app.update();
        let frame = receiver.try_recv().expect("a settings message");
        let message: Value = minicbor_serde::from_slice(&frame.bytes[1..]).unwrap();
        assert_eq!(
            message,
            serde_json::json!({
                "type": "Settings",
                "data": { "sections": { "test": { "level": 4, "session_only": false } } }
            })
        );
        assert!(receiver.try_recv().is_err());
    }

    /// Two sections cannot share a key.
    #[test]
    #[should_panic(expected = "registered twice")]
    fn duplicate_keys_panic() {
        let mut app = app();
        app.register_settings_section(SettingsSection::<TestSettings>::new("test"));
    }
}
