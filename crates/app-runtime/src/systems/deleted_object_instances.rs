// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Releases materialized instances whose source definitions no longer exist.

use bevy::ecs::system::SystemParam;
use bevy::prelude::*;
use nightfall::prelude::*;
use nightfall_clips::Clip;
use nightfall_compositor::prelude::{ObjectRefMarker, ReleaseMarker};
use nightfall_cues::prelude::{Cue, Sequence};
use nightfall_engine::prelude::DataProvider;
use nightfall_fixtures::prelude::FixtureDataProviderExt;
use nightfall_flow::prelude::FlowDefinition;
use nightfall_fx::prelude::{Fx, StepFx};
use nightfall_fx_module::prelude::StoredFxModule;
use nightfall_instances::{
    EditorPreviewInstance, InstanceControls, InstanceId, InstanceKind, InstanceMetadata,
};
use nightfall_timecode::prelude::Timecode;
use nightfall_timeline::prelude::Timeline;
use uuid::Uuid;

/// Definition stores used to resolve materialized instance object references.
#[derive(SystemParam)]
pub struct ObjectDefinitionSources<'w, 's> {
    cues: Res<'w, DataProvider<Cue>>,
    sequences: Res<'w, DataProvider<Sequence>>,
    timelines: Res<'w, DataProvider<Timeline>>,
    fx: Res<'w, DataProvider<Fx>>,
    step_fx: Query<'w, 's, &'static StepFx>,
    fx_modules: Res<'w, DataProvider<StoredFxModule>>,
    flows: Res<'w, DataProvider<FlowDefinition>>,
    clips: Query<'w, 's, &'static Clip>,
    groups: Res<'w, DataProvider<Group>>,
    fixtures: Res<'w, FixtureDataProviderExt>,
    timecodes: Res<'w, DataProvider<Timecode>>,
}

impl ObjectDefinitionSources<'_, '_> {
    /// Returns whether the given source object reference still resolves.
    fn contains_object_ref(&self, object_ref: &ObjectRef) -> bool {
        match object_ref {
            ObjectRef::ByUid { object_type, uid } => self.contains_uid(*object_type, *uid),
            ObjectRef::ById { object_type, id } => self.contains_id(*object_type, *id),
        }
    }

    /// Returns whether an object type contains the given UID.
    fn contains_uid(&self, object_type: ObjectType, uid: Uuid) -> bool {
        match object_type {
            ObjectType::Cue => {
                self.cues.get(uid).is_ok() || self.sequence_embedded_cue_uid_exists(uid)
            }
            ObjectType::Sequence => self.sequences.get(uid).is_ok(),
            ObjectType::Timeline => self.timelines.get(uid).is_ok(),
            ObjectType::Fx => self.fx.get(uid).is_ok(),
            ObjectType::FxModule => self.fx_modules.get(uid).is_ok(),
            ObjectType::StepFx => self.step_fx.iter().any(|fx| fx.identifiers.uid == uid),
            ObjectType::Flow => self.flows.get(uid).is_ok(),
            ObjectType::Clip => self.clips.iter().any(|clip| clip.identifiers.uid == uid),
            ObjectType::Group => self.groups.get(uid).is_ok(),
            ObjectType::Fixture => self.fixtures.inner.get(uid).is_ok(),
            ObjectType::Timecode => self.timecodes.get(uid).is_ok(),
            ObjectType::Master | ObjectType::Parameter | ObjectType::Palette => true,
        }
    }

    /// Returns whether an object type contains the given user-facing ID.
    fn contains_id(&self, object_type: ObjectType, id: u32) -> bool {
        match object_type {
            ObjectType::Cue => self.cues.from_id(id).is_ok(),
            ObjectType::Sequence => self.sequences.from_id(id).is_ok(),
            ObjectType::Timeline => self.timelines.from_id(id).is_ok(),
            ObjectType::Fx => self.fx.from_id(id).is_ok(),
            ObjectType::FxModule => self.fx_modules.from_id(id).is_ok(),
            ObjectType::StepFx => self.step_fx.iter().any(|fx| fx.identifiers.id == id),
            ObjectType::Flow => self.flows.from_id(id).is_ok(),
            ObjectType::Clip => self.clips.iter().any(|clip| clip.identifiers.id == id),
            ObjectType::Group => self.groups.from_id(id).is_ok(),
            ObjectType::Fixture => self.fixtures.inner.from_id(id).is_ok(),
            ObjectType::Timecode => self.timecodes.from_id(id).is_ok(),
            ObjectType::Master | ObjectType::Parameter | ObjectType::Palette => true,
        }
    }

    /// Returns whether a sequence-owned setup or release cue UID still exists.
    fn sequence_embedded_cue_uid_exists(&self, cue_uid: Uuid) -> bool {
        self.sequences.iter().any(|sequence| {
            sequence.setup_cue.identifiers.uid == cue_uid
                || sequence.release_cue.identifiers.uid == cue_uid
        })
    }
}

type PlaybackCleanupItem<'a> = (
    Entity,
    Option<&'a InstanceId>,
    Option<&'a InstanceMetadata>,
    Option<&'a ObjectRefMarker>,
    Option<&'a EditorPreviewInstance>,
    Option<&'a InstanceControls>,
    Option<&'a ReleaseMarker>,
);

/// Runtime entities that can remain materialized after their backing object is deleted.
#[derive(SystemParam)]
pub struct MaterializedRuntimeTargets<'w, 's> {
    instances: Query<'w, 's, PlaybackCleanupItem<'static>, With<InstanceId>>,
}

/// Releases active materialized instances whose source definitions were deleted.
pub fn release_deleted_object_instances(
    mut commands: Commands,
    sources: ObjectDefinitionSources,
    targets: MaterializedRuntimeTargets,
) {
    release_instances_for_deleted_source_refs(&mut commands, &sources, &targets.instances);
}

/// Releases playback entities whose direct source object reference no longer resolves.
fn release_instances_for_deleted_source_refs(
    commands: &mut Commands,
    sources: &ObjectDefinitionSources,
    instances: &Query<PlaybackCleanupItem<'static>, With<InstanceId>>,
) {
    for (entity, _, metadata, object_ref_marker, editor_preview, controls, release_marker) in
        instances
    {
        let Some(object_ref_marker) = object_ref_marker else {
            continue;
        };
        if editor_preview.is_some()
            || metadata.is_some_and(|metadata| metadata.kind == InstanceKind::Programmer)
        {
            continue;
        }
        if sources.contains_object_ref(&object_ref_marker.0) {
            continue;
        }
        if release_playback_entity(commands, entity, controls, release_marker) {
            tracing::debug!(
                object_ref = %object_ref_marker.0,
                "Releasing materialized instance for deleted object"
            );
        }
    }
}

/// Marks a playback for release and resumes it if it was paused.
fn release_playback_entity(
    commands: &mut Commands,
    entity: Entity,
    controls: Option<&InstanceControls>,
    release_marker: Option<&ReleaseMarker>,
) -> bool {
    if release_marker.is_some() {
        return false;
    }

    commands.entity(entity).insert(ReleaseMarker::default());

    if let Some(controls) = controls.filter(|controls| controls.rate == 0.0) {
        let mut resumed_controls = controls.clone();
        resumed_controls.rate = 1.0;
        commands.entity(entity).insert(resumed_controls);
    }

    true
}

#[cfg(test)]
mod tests {
    use bevy::ecs::system::RunSystemOnce;

    use super::*;

    /// Builds identifiers with stable IDs and UIDs for lifecycle tests.
    fn identifiers(id: u32, uid: u128, label: &str) -> Identifiers {
        Identifiers {
            id,
            uid: Uuid::from_u128(uid),
            label: label.to_owned(),
        }
    }

    /// Builds a minimal cue definition for lifecycle tests.
    fn cue(id: u32, uid: u128, label: &str) -> Cue {
        Cue {
            identifiers: identifiers(id, uid, label),
            ..Default::default()
        }
    }

    /// Builds a minimal sequence with embedded setup and release cues.
    fn sequence(id: u32, uid: u128, setup_uid: u128, release_uid: u128) -> Sequence {
        Sequence {
            identifiers: identifiers(id, uid, "Sequence"),
            setup_cue: cue(0, setup_uid, "Setup"),
            release_cue: cue(0, release_uid, "Release"),
            ..Default::default()
        }
    }

    /// Inserts the resources required by the deleted object playback cleanup system.
    fn insert_required_resources(world: &mut World) {
        world.insert_resource(DataProvider::<Cue>::default());
        world.insert_resource(DataProvider::<Sequence>::default());
        world.insert_resource(DataProvider::<Timeline>::default());
        world.insert_resource(DataProvider::<Fx>::default());
        world.insert_resource(DataProvider::<StoredFxModule>::default());
        world.insert_resource(DataProvider::<FlowDefinition>::default());
        world.insert_resource(DataProvider::<Group>::default());
        world.insert_resource(FixtureDataProviderExt::default());
        world.insert_resource(DataProvider::<Timecode>::default());
    }

    /// Runs the cleanup system for deleted direct object references and clips.
    fn run_deleted_object_cleanup(world: &mut World) {
        world
            .run_system_once(release_deleted_object_instances)
            .expect("deleted object playback cleanup should run");
    }

    /// Verifies a deleted normal cue releases the matching materialized layer.
    #[test]
    fn cleanup_releases_playback_for_deleted_cue_uid() {
        let mut world = World::new();
        insert_required_resources(&mut world);
        let cue_uid = Uuid::from_u128(0x100);
        let playback = world
            .spawn((
                InstanceId::new(),
                InstanceMetadata::new(InstanceKind::Cue),
                ObjectRefMarker(ObjectRef::ByUid {
                    object_type: ObjectType::Cue,
                    uid: cue_uid,
                }),
                InstanceControls {
                    intensity_scale: 1.0,
                    rate: 0.0,
                    ..Default::default()
                },
            ))
            .id();

        run_deleted_object_cleanup(&mut world);

        assert!(world.get::<ReleaseMarker>(playback).is_some());
        assert_eq!(
            world
                .get::<InstanceControls>(playback)
                .expect("controls should remain attached")
                .rate,
            1.0
        );
    }

    /// Verifies sequence-owned setup cues are live until their owning sequence is deleted.
    #[test]
    fn cleanup_keeps_embedded_cue_playback_until_sequence_deleted() {
        let mut world = World::new();
        insert_required_resources(&mut world);
        let setup_uid = Uuid::from_u128(0x201);
        world
            .resource_mut::<DataProvider<Sequence>>()
            .add(sequence(7, 0x200, 0x201, 0x202))
            .expect("sequence should insert");
        let playback = world
            .spawn((
                InstanceId::new(),
                InstanceMetadata::new(InstanceKind::Cue),
                ObjectRefMarker(ObjectRef::ByUid {
                    object_type: ObjectType::Cue,
                    uid: setup_uid,
                }),
            ))
            .id();

        run_deleted_object_cleanup(&mut world);
        assert!(world.get::<ReleaseMarker>(playback).is_none());

        world
            .resource_mut::<DataProvider<Sequence>>()
            .remove(&Uuid::from_u128(0x200))
            .expect("sequence should remove");
        run_deleted_object_cleanup(&mut world);

        assert!(world.get::<ReleaseMarker>(playback).is_some());
    }

    /// Equal numeric IDs in other FX domains cannot keep a deleted object's playback alive.
    #[test]
    fn cleanup_keeps_fx_object_namespaces_separate() {
        let mut world = World::new();
        insert_required_resources(&mut world);
        world
            .resource_mut::<DataProvider<Fx>>()
            .add(Fx {
                identifiers: identifiers(3, 0x301, "FX"),
                ..Default::default()
            })
            .unwrap();
        world
            .resource_mut::<DataProvider<StoredFxModule>>()
            .add(StoredFxModule {
                identifiers: identifiers(3, 0x302, "Module"),
                ..Default::default()
            })
            .unwrap();
        let mut playbacks = Vec::new();
        for object_type in [ObjectType::Fx, ObjectType::StepFx, ObjectType::FxModule] {
            playbacks.push(
                world
                    .spawn((
                        InstanceId::new(),
                        InstanceMetadata::new(InstanceKind::Fx),
                        ObjectRefMarker(ObjectRef::ById { object_type, id: 3 }),
                    ))
                    .id(),
            );
        }
        run_deleted_object_cleanup(&mut world);
        assert!(world.get::<ReleaseMarker>(playbacks[0]).is_none());
        assert!(world.get::<ReleaseMarker>(playbacks[1]).is_some());
        assert!(world.get::<ReleaseMarker>(playbacks[2]).is_none());
        world
            .resource_mut::<DataProvider<StoredFxModule>>()
            .remove(&Uuid::from_u128(0x302))
            .unwrap();
        run_deleted_object_cleanup(&mut world);
        assert!(world.get::<ReleaseMarker>(playbacks[2]).is_some());
    }

    /// Verifies active step FX definitions satisfy references in their own namespace.
    #[test]
    fn cleanup_resolves_step_fx_refs() {
        let mut world = World::new();
        insert_required_resources(&mut world);
        let step_fx_uid = Uuid::from_u128(0x300);
        let step_fx = world
            .spawn(StepFx {
                identifiers: identifiers(3, 0x300, "Step FX"),
                selection: SpatialSelection::default(),
                ..Default::default()
            })
            .id();
        let playback = world
            .spawn((
                InstanceId::new(),
                InstanceMetadata::new(InstanceKind::Fx),
                ObjectRefMarker(ObjectRef::ByUid {
                    object_type: ObjectType::StepFx,
                    uid: step_fx_uid,
                }),
            ))
            .id();

        run_deleted_object_cleanup(&mut world);
        assert!(world.get::<ReleaseMarker>(playback).is_none());

        world.despawn(step_fx);
        run_deleted_object_cleanup(&mut world);

        assert!(world.get::<ReleaseMarker>(playback).is_some());
    }

    /// Verifies programmer instances with synthetic cue refs are not treated as deleted definitions.
    #[test]
    fn cleanup_ignores_programmer_playback_object_refs() {
        let mut world = World::new();
        insert_required_resources(&mut world);
        let playback = world
            .spawn((
                InstanceId::new(),
                InstanceMetadata::new(InstanceKind::Programmer),
                ObjectRefMarker(ObjectRef::ByUid {
                    object_type: ObjectType::Cue,
                    uid: Uuid::from_u128(0x900),
                }),
            ))
            .id();

        run_deleted_object_cleanup(&mut world);

        assert!(world.get::<ReleaseMarker>(playback).is_none());
    }

    /// Verifies editor previews keep compositor markers without requiring stored definitions.
    #[test]
    fn cleanup_ignores_editor_preview_object_refs() {
        let mut world = World::new();
        insert_required_resources(&mut world);
        let playback = world
            .spawn((
                InstanceId::new(),
                InstanceMetadata::new(InstanceKind::Fx),
                EditorPreviewInstance,
                ObjectRefMarker(ObjectRef::ByUid {
                    object_type: ObjectType::Fx,
                    uid: Uuid::from_u128(0x901),
                }),
            ))
            .id();

        run_deleted_object_cleanup(&mut world);

        assert!(world.get::<ReleaseMarker>(playback).is_none());
    }
}
