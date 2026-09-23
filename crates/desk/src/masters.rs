// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::collections::{HashMap, HashSet};

use bevy_ecs::prelude::*;
use moonshine_kind::prelude::*;
use nightfall::prelude::*;
use nightfall_compositor::prelude::*;
use nightfall_dmx::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_fixtures::prelude::*;
use nightfall_fixtures::selection::SpatialSelectionResolver;
use nightfall_instances::{EditorPreviewInstance, InstanceControls, InstanceId};
use serde::{Deserialize, Serialize};
use smart_default::SmartDefault;
use uuid::Uuid;

use crate::clips::MaterializedClip;

/// Intensity attributes controlled by inhibitive masters.
pub const MASTER_INTENSITY_ATTRIBUTES: &[Attribute] =
    &[Attribute::Intensity, Attribute::VirtualIntensity];

/// Persisted master behavior class.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, SmartDefault)]
#[typeshare::typeshare]
pub enum MasterKind {
    /// Proportionally limits selected intensity output.
    #[default]
    InhibitiveIntensity,
    /// Multiplies matching live playback rates.
    PlaybackRate,
}

/// Persisted fixture target affected by an intensity master.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, SmartDefault)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum FixtureMasterTarget {
    /// All eligible fixture intensity parameters.
    #[default]
    All,
    /// Fixtures resolved from the referenced group at runtime.
    Group(#[serde(with = "nightfall::serde_uuid_simple")] Uuid),
    /// Fixtures captured by a stored spatial selection.
    Selection(SpatialSelection),
}

/// Persisted instance target affected by a rate master.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, SmartDefault)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum InstanceMasterTarget {
    /// All live non-preview instances.
    #[default]
    All,
    /// Live instances attached to these clip IDs.
    Clips(Vec<u32>),
}

/// Persisted target affected by a master.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, SmartDefault)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum MasterTarget {
    /// Fixture scope for intensity masters.
    #[default]
    Fixtures(FixtureMasterTarget),
    /// Instance scope for rate masters.
    Instances(InstanceMasterTarget),
}

/// Persisted activation mode for a master.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, SmartDefault)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
pub enum MasterMode {
    /// Master always contributes its level.
    #[default]
    AlwaysOn,
    /// Master contributes only when active.
    Toggle {
        /// Whether the toggle-mode master is active.
        active: bool,
    },
    /// Master is bypassed.
    Disabled,
}

/// Persistent master data stored in showfiles.
#[derive(Debug, Clone, Component, Serialize, Deserialize, PartialEq, SmartDefault)]
#[typeshare::typeshare]
pub struct Master {
    /// Stable showfile identifiers.
    pub identifiers: Identifiers,
    /// Master behavior class.
    #[serde(default)]
    pub kind: MasterKind,
    /// Fixture or playback scope this master affects.
    #[serde(default)]
    pub target: MasterTarget,
    /// Activation behavior.
    #[serde(default)]
    pub mode: MasterMode,
    /// Control level in user-facing percent; interpretation depends on the master kind.
    #[serde(default = "default_master_level")]
    pub level_percent: f32,
}

impl HasIdentifiers for Master {
    fn identifiers(&self) -> &Identifiers {
        &self.identifiers
    }
}

impl Master {
    /// Returns the normalized intensity limit used by inhibitive master math.
    pub fn normalized_level(&self) -> f32 {
        (self.level_percent / 100.0).clamp(0.0, 1.0)
    }

    /// Returns the playback rate multiplier represented by this master.
    pub fn playback_rate_scale(&self) -> f32 {
        (self.level_percent / 100.0).clamp(0.0, 2.0)
    }

    /// Converts the stored level into a normalized control position.
    pub fn control_position_percent(&self) -> f32 {
        match self.kind {
            MasterKind::InhibitiveIntensity => self.level_percent.clamp(0.0, 100.0),
            MasterKind::PlaybackRate => (self.level_percent / 2.0).clamp(0.0, 100.0),
        }
    }

    /// Converts a normalized control position into the stored level for a master kind.
    pub fn level_percent_from_control(kind: MasterKind, control_percent: f32) -> f32 {
        match kind {
            MasterKind::InhibitiveIntensity => control_percent.clamp(0.0, 100.0),
            MasterKind::PlaybackRate => (control_percent * 2.0).clamp(0.0, 200.0),
        }
    }

    /// Returns whether this master should affect output in the current frame.
    pub fn is_active(&self) -> bool {
        match self.mode {
            MasterMode::AlwaysOn => true,
            MasterMode::Toggle { active } => active,
            MasterMode::Disabled => false,
        }
    }
}

/// User and UI commands that mutate master configuration or levels.
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum MasterCommand {
    /// Store or replace a master definition.
    StoreMaster(Master),
    /// Rename a master numeric ID.
    RenameMaster {
        /// Existing master ID.
        id: u32,
        /// New master ID.
        new_id: u32,
    },
    /// Delete a master by numeric ID.
    DeleteMaster(u32),
    /// Sets a master's control level.
    SetMasterLevel {
        /// Master numeric ID.
        id: u32,
        /// New level in percent.
        level_percent: f32,
    },
    /// Set a master's activation mode.
    SetMasterMode {
        /// Master numeric ID.
        id: u32,
        /// New activation mode.
        mode: MasterMode,
    },
    /// Toggle a toggle-mode master.
    ToggleMaster {
        /// Master numeric ID.
        id: u32,
    },
}

impl IngressCommand for MasterCommand {}

/// High-frequency master state changes produced by local control surfaces.
#[derive(Clone, Debug, Message)]
pub enum MasterUpdate {
    /// Set a master's level without creating a user-command lifecycle.
    SetLevel {
        /// Master numeric ID.
        id: u32,
        /// New level in percent.
        level_percent: f32,
    },
}

impl crate::object_crud::ObjectCrud for Master {
    type Command = MasterCommand;

    fn type_name() -> &'static str {
        "master"
    }

    fn extract_store(command: &Self::Command) -> Option<Self> {
        match command {
            MasterCommand::StoreMaster(master) => {
                let mut master = master.clone();
                master.level_percent = clamp_master_level(master.kind, master.level_percent);
                Some(master)
            }
            _ => None,
        }
    }

    fn extract_rename(command: &Self::Command) -> Option<(u32, u32)> {
        match command {
            MasterCommand::RenameMaster { id, new_id } => Some((*id, *new_id)),
            _ => None,
        }
    }

    fn extract_delete(command: &Self::Command) -> Option<u32> {
        match command {
            MasterCommand::DeleteMaster(id) => Some(*id),
            _ => None,
        }
    }

    fn set_id(&mut self, new_id: u32) {
        self.identifiers.id = new_id;
    }
}

/// Handles master CRUD and runtime-level commands.
pub fn handle_master_commands(
    mut events: MessageReader<CommandEnvelope<MasterCommand>>,
    mut master_data_provider: ResMut<DataProvider<Master>>,
    mut responder: CommandResponder,
    selection_resolver: SpatialSelectionResolver,
) {
    for event in events.read() {
        let mut command = event.command.clone();
        stabilize_master_group_refs(&mut command, &selection_resolver);

        if let Some(result) = crate::object_crud::apply_object_crud_command::<Master>(
            &command,
            &mut master_data_provider,
        ) {
            finish_master_command(&mut responder, event.command_id, result);
            continue;
        }

        let result = match &command {
            MasterCommand::SetMasterLevel { id, level_percent } => {
                update_master_by_id(*id, &mut master_data_provider, |master| {
                    master.level_percent = clamp_master_level(master.kind, *level_percent);
                })
            }
            MasterCommand::SetMasterMode { id, mode } => {
                update_master_by_id(*id, &mut master_data_provider, |master| {
                    master.mode = mode.clone();
                })
            }
            MasterCommand::ToggleMaster { id } => {
                update_master_by_id(*id, &mut master_data_provider, |master| {
                    master.mode = match master.mode {
                        MasterMode::Toggle { active } => MasterMode::Toggle { active: !active },
                        _ => MasterMode::Toggle { active: true },
                    };
                })
            }
            MasterCommand::StoreMaster(_)
            | MasterCommand::RenameMaster { .. }
            | MasterCommand::DeleteMaster(_) => unreachable!("CRUD commands returned above"),
        };
        finish_master_command(&mut responder, event.command_id, result);
    }
}

/// Rewrites dynamic group references in stored master selections to stable UID references.
fn stabilize_master_group_refs(
    command: &mut MasterCommand,
    selection_resolver: &SpatialSelectionResolver,
) {
    let MasterCommand::StoreMaster(Master {
        target: MasterTarget::Fixtures(FixtureMasterTarget::Selection(selection)),
        ..
    }) = command
    else {
        return;
    };

    let stabilized = selection_resolver.stabilize_group_refs_selection(selection);
    for warning in &stabilized.issues {
        tracing::warn!("{}", warning);
    }
    *selection = stabilized.value;
}

/// Applies untracked master updates produced by continuous local inputs.
pub fn handle_master_updates(
    mut events: MessageReader<MasterUpdate>,
    mut master_data_provider: ResMut<DataProvider<Master>>,
) {
    for event in events.read() {
        let result = match event {
            MasterUpdate::SetLevel { id, level_percent } => {
                update_master_by_id(*id, &mut master_data_provider, |master| {
                    master.level_percent = clamp_master_level(master.kind, *level_percent);
                })
            }
        };
        if let Err(error) = result {
            tracing::warn!(code = %error.code, message = %error.message, "master_update_failed");
        }
    }
}

/// Publishes one terminal outcome for an applied master command.
fn finish_master_command(
    responder: &mut CommandResponder,
    command_id: CommandId,
    result: Result<(), CommandError>,
) {
    let response = match result {
        Ok(()) => responder.succeed(command_id),
        Err(error) => responder.fail(command_id, error),
    };
    if let Err(error) = response {
        tracing::error!(%command_id, %error, "master_command_completion_failed");
    }
}

/// Applies active playback rate masters before realtime clocks advance.
pub fn apply_playback_rate_masters(
    master_data_provider: Res<DataProvider<Master>>,
    materialized_clips: Query<&MaterializedClip>,
    mut instances: Query<(
        &InstanceId,
        &mut InstanceControls,
        Option<&EditorPreviewInstance>,
    )>,
) {
    let live_instance_ids = instances
        .iter()
        .filter_map(|(instance_id, _controls, preview)| preview.is_none().then_some(*instance_id))
        .collect::<HashSet<_>>();

    let active_rate_masters = master_data_provider.iter().filter_map(|entry| {
        let master = entry.value().clone();
        (master.kind == MasterKind::PlaybackRate && master.is_active()).then_some(master)
    });

    let mut playback_scales: HashMap<InstanceId, f32> = HashMap::new();
    for master in active_rate_masters {
        let scale = master.playback_rate_scale();
        match &master.target {
            MasterTarget::Instances(InstanceMasterTarget::All) => {
                for instance_id in &live_instance_ids {
                    *playback_scales.entry(*instance_id).or_insert(1.0) *= scale;
                }
            }
            MasterTarget::Instances(InstanceMasterTarget::Clips(clip_ids)) => {
                for instance_id in
                    targeted_clip_instances(clip_ids, materialized_clips.iter(), &live_instance_ids)
                {
                    *playback_scales.entry(instance_id).or_insert(1.0) *= scale;
                }
            }
            MasterTarget::Fixtures(_) => {}
        }
    }

    for (instance_id, mut controls, preview) in &mut instances {
        let scale = if preview.is_none() {
            playback_scales.remove(instance_id).unwrap_or(1.0)
        } else {
            1.0
        };
        if controls.rate_master_scale != scale {
            controls.set_rate_master_scale(scale);
        }
    }
}

/// Applies active inhibitive masters to final output before virtual dimmer and DMX output.
pub fn apply_master_inhibition(
    master_data_provider: Res<DataProvider<Master>>,
    group_data_provider: Res<DataProvider<Group>>,
    fixture_data_provider: Res<FixtureDataProviderExt>,
    selection_resolver: SpatialSelectionResolver,
    mut final_layer_output: ResMut<FinalLayerOutput>,
    mut param_query: Query<InstanceMut<Parameter>>,
) {
    let active_masters: Vec<_> = master_data_provider
        .iter()
        .filter_map(|entry| {
            let master = entry.value().clone();
            (master.kind == MasterKind::InhibitiveIntensity && master.is_active()).then_some(master)
        })
        .collect();

    if active_masters.is_empty() {
        return;
    }

    let master_targets: Vec<_> = active_masters
        .into_iter()
        .map(|master| {
            let targets = target_fixture_refs(&master, &group_data_provider, &selection_resolver);
            (master, targets)
        })
        .collect();

    for mut parameter in &mut param_query {
        if !parameter.metadata.use_grandmaster
            || !MASTER_INTENSITY_ATTRIBUTES.contains(&parameter.metadata.attribute)
        {
            continue;
        }

        let parameter_instance = parameter.instance();
        let Some(fixture_ref) =
            fixture_data_provider.try_fixture_ref_for_parameter(&parameter_instance)
        else {
            continue;
        };

        let scale = master_targets
            .iter()
            .filter(|(master, targets)| master_targets_parameter(master, targets, &fixture_ref))
            .fold(1.0, |scale, (master, _)| scale * master.normalized_level());

        if (scale - 1.0).abs() <= f32::EPSILON {
            continue;
        }

        parameter.values.current_value *= f64::from(scale);
        scale_final_layer_parameter(&mut final_layer_output.0, parameter_instance, scale);
    }
}

/// Returns the default neutral master level.
fn default_master_level() -> f32 {
    100.0
}

/// Clamp a user-supplied master level to the supported percent range.
fn clamp_master_level(kind: MasterKind, level_percent: f32) -> f32 {
    match kind {
        MasterKind::InhibitiveIntensity => level_percent.clamp(0.0, 100.0),
        MasterKind::PlaybackRate => level_percent.clamp(0.0, 200.0),
    }
}

/// Mutate one master by numeric ID and persist it back into the provider.
fn update_master_by_id(
    id: u32,
    master_data_provider: &mut DataProvider<Master>,
    update: impl FnOnce(&mut Master),
) -> Result<(), CommandError> {
    let Ok(mut master) = master_data_provider
        .from_id(id)
        .map(|master| master.clone())
    else {
        return Err(CommandError::new(
            "master.not_found",
            format!("Failed to update master {id}: not found"),
        ));
    };

    update(&mut master);
    master_data_provider.add(master).map_err(|error| {
        CommandError::new(
            "master.update_failed",
            format!("Failed to update master {id}: {error}"),
        )
    })
}

/// Resolve the fixture refs directly targeted by a master.
fn target_fixture_refs(
    master: &Master,
    group_data_provider: &DataProvider<Group>,
    selection_resolver: &SpatialSelectionResolver,
) -> Option<Vec<FixtureRef>> {
    match &master.target {
        MasterTarget::Fixtures(FixtureMasterTarget::All) => None,
        MasterTarget::Fixtures(FixtureMasterTarget::Group(uid)) => group_data_provider
            .get(*uid)
            .ok()
            .map(|group| resolve_spatial_selection(selection_resolver, &group.selection))
            .or_else(|| {
                tracing::warn!(
                    group_uid = %uid,
                    master_id = master.identifiers.id,
                    "Master target group was missing"
                );
                Some(Vec::new())
            }),
        MasterTarget::Fixtures(FixtureMasterTarget::Selection(selection)) => {
            Some(resolve_spatial_selection(selection_resolver, selection))
        }
        MasterTarget::Instances(_) => Some(Vec::new()),
    }
}

/// Returns live instance IDs attached to the requested clip IDs.
fn targeted_clip_instances<'a>(
    clip_ids: &[u32],
    materialized_clips: impl Iterator<Item = &'a MaterializedClip>,
    live_instance_ids: &HashSet<InstanceId>,
) -> Vec<InstanceId> {
    materialized_clips
        .filter(|materialized_clip| clip_ids.contains(&materialized_clip.clip_id))
        .map(|materialized_clip| materialized_clip.attached_instance)
        .filter(|instance_id| live_instance_ids.contains(instance_id))
        .collect()
}

/// Resolve a spatial selection and log any non-fatal resolution issues.
fn resolve_spatial_selection(
    selection_resolver: &SpatialSelectionResolver,
    selection: &SpatialSelection,
) -> Vec<FixtureRef> {
    let result = selection_resolver.resolve(selection);
    if !result.issues.is_empty() {
        tracing::warn!(
            issues = ?result.issues,
            "Master target selection resolved with issues"
        );
    }
    result.into_value().canonical_fixtures().to_vec()
}

/// Return whether one master applies to a parameter owned by `fixture_ref`.
fn master_targets_parameter(
    _master: &Master,
    targets: &Option<Vec<FixtureRef>>,
    fixture_ref: &FixtureRef,
) -> bool {
    let Some(targets) = targets else {
        return true;
    };

    targets.iter().any(|target| {
        target == fixture_ref
            || (target.index.is_none() && target.fixture_uid == fixture_ref.fixture_uid)
    })
}

/// Scale final layer output maps so layer/output inspection matches mastered values.
fn scale_final_layer_parameter(
    final_layer_output: &mut ComputedLayer,
    parameter: Instance<Parameter>,
    scale: f32,
) {
    if let Some(value) = final_layer_output.absolute.get_mut(parameter) {
        *value *= f64::from(scale);
    }
    if let Some(value) = final_layer_output.relative.get_mut(parameter) {
        *value *= f64::from(scale);
    }
}

#[cfg(test)]
mod tests {
    use bevy_app::{App, Update};

    use super::*;

    /// Builds a master with a deterministic ID and level.
    fn master(id: u32, target: MasterTarget, level_percent: f32) -> Master {
        Master {
            identifiers: Identifiers {
                id,
                uid: Uuid::from_u128(id as u128),
                label: format!("Master {id}"),
            },
            kind: MasterKind::InhibitiveIntensity,
            target,
            mode: MasterMode::AlwaysOn,
            level_percent,
        }
    }

    /// Builds a playback rate master with a deterministic ID and level.
    fn rate_master(id: u32, target: InstanceMasterTarget, level_percent: f32) -> Master {
        Master {
            identifiers: Identifiers {
                id,
                uid: Uuid::from_u128(id as u128),
                label: format!("Rate Master {id}"),
            },
            kind: MasterKind::PlaybackRate,
            target: MasterTarget::Instances(target),
            mode: MasterMode::AlwaysOn,
            level_percent,
        }
    }

    /// Builds the focused lifecycle resources required by master command tests.
    fn master_command_app() -> App {
        let mut app = App::new();
        app.init_resource::<DataProvider<Master>>();
        app.init_resource::<DataProvider<Group>>();
        app.init_resource::<FixtureDataProviderExt>();
        app.init_resource::<CommandTracker>();
        app.add_message::<CommandEnvelope<MasterCommand>>();
        app.add_message::<CommandResult>();
        app.add_message::<CommandReply>();
        app.add_message::<FinishedCommand>();
        app.add_message::<CommandNotice>();
        app.add_systems(Update, handle_master_commands);
        app
    }

    /// Verifies master selection stores bind authored group aliases to stable group identities.
    #[test]
    fn store_master_stabilizes_group_selection() {
        let mut app = master_command_app();
        let group_uid = Uuid::from_u128(500);
        app.world_mut()
            .resource_mut::<DataProvider<Group>>()
            .add(Group {
                identifiers: Identifiers {
                    id: 5,
                    uid: group_uid,
                    label: "Master target".to_owned(),
                },
                selection: SpatialSelection::default(),
                description: String::new(),
            })
            .expect("group should store");
        submit_master_command(
            &mut app,
            MasterCommand::StoreMaster(master(
                1,
                MasterTarget::Fixtures(FixtureMasterTarget::Selection(SpatialSelection::identity(
                    SelectionExpr::Group(GroupRefExpr::ById(5)),
                ))),
                100.0,
            )),
        );

        app.update();

        let stored = app
            .world()
            .resource::<DataProvider<Master>>()
            .from_id(1)
            .expect("master should store");
        assert_eq!(
            stored.target,
            MasterTarget::Fixtures(FixtureMasterTarget::Selection(SpatialSelection::identity(
                SelectionExpr::Group(GroupRefExpr::ByUid { uid: group_uid })
            ),))
        );
    }

    /// Registers and submits one master command to the focused handler app.
    fn submit_master_command(app: &mut App, command: MasterCommand) -> CommandId {
        let envelope = CommandEnvelope::new(command, CommandOrigin::WebUi, ReplyTarget::Detached);
        let command_id = envelope.command_id;
        app.world_mut()
            .resource_mut::<CommandTracker>()
            .register(&envelope)
            .expect("master command should register");
        app.world_mut().write_message(envelope);
        command_id
    }

    /// Drains the terminal result emitted by one master command.
    fn take_master_result(app: &mut App) -> CommandResult {
        app.world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .next()
            .expect("master command should return a terminal result")
    }

    /// Verifies master level mutation is visible before terminal success.
    #[test]
    fn master_level_command_mutates_before_success() {
        let mut app = master_command_app();
        app.world_mut()
            .resource_mut::<DataProvider<Master>>()
            .add(master(
                1,
                MasterTarget::Fixtures(FixtureMasterTarget::All),
                100.0,
            ))
            .expect("master should store");
        let command_id = submit_master_command(
            &mut app,
            MasterCommand::SetMasterLevel {
                id: 1,
                level_percent: 35.0,
            },
        );

        app.update();

        assert_eq!(
            app.world()
                .resource::<DataProvider<Master>>()
                .from_id(1)
                .expect("master should remain stored")
                .level_percent,
            35.0
        );
        let result = take_master_result(&mut app);
        assert_eq!(result.command_id, command_id);
        assert!(matches!(result.outcome, CommandOutcome::Succeeded { .. }));
    }

    /// Verifies a missing master update returns a stable structured failure.
    #[test]
    fn missing_master_command_returns_failure() {
        let mut app = master_command_app();
        submit_master_command(
            &mut app,
            MasterCommand::SetMasterLevel {
                id: 99,
                level_percent: 35.0,
            },
        );

        app.update();

        assert!(matches!(
            take_master_result(&mut app).outcome,
            CommandOutcome::Failed(error) if error.code == "master.not_found"
        ));
    }

    /// Verifies continuous master input applies without a command lifecycle.
    #[test]
    fn master_update_applies_without_command_identity() {
        let mut app = App::new();
        let mut masters = DataProvider::<Master>::default();
        masters
            .add(master(
                1,
                MasterTarget::Fixtures(FixtureMasterTarget::All),
                100.0,
            ))
            .expect("master should store");
        app.insert_resource(masters);
        app.add_message::<MasterUpdate>();
        app.add_systems(Update, handle_master_updates);
        app.world_mut().write_message(MasterUpdate::SetLevel {
            id: 1,
            level_percent: 45.0,
        });

        app.update();

        assert_eq!(
            app.world()
                .resource::<DataProvider<Master>>()
                .from_id(1)
                .expect("master should remain stored")
                .level_percent,
            45.0
        );
    }

    /// Verifies disabled masters do not contribute to output scaling.
    #[test]
    fn disabled_master_is_inactive() {
        let mut master = master(1, MasterTarget::Fixtures(FixtureMasterTarget::All), 50.0);
        master.mode = MasterMode::Disabled;

        assert!(!master.is_active());
        assert_eq!(master.normalized_level(), 0.5);
    }

    /// Verifies intensity and rate masters clamp to their own supported ranges.
    #[test]
    fn master_level_clamps_by_kind() {
        assert_eq!(
            clamp_master_level(MasterKind::InhibitiveIntensity, 150.0),
            100.0
        );
        assert_eq!(clamp_master_level(MasterKind::PlaybackRate, 250.0), 200.0);
        assert_eq!(clamp_master_level(MasterKind::PlaybackRate, -10.0), 0.0);
    }

    /// Verifies normalized control positions map to playback-rate master levels.
    #[test]
    fn rate_master_control_mapping_centers_normal_speed() {
        assert_eq!(
            Master::level_percent_from_control(MasterKind::PlaybackRate, 50.0),
            100.0
        );
        assert_eq!(
            rate_master(1, InstanceMasterTarget::All, 100.0).control_position_percent(),
            50.0
        );
        assert_eq!(
            rate_master(1, InstanceMasterTarget::All, 200.0).playback_rate_scale(),
            2.0
        );
    }

    /// Verifies whole-fixture targets match element-owned parameters.
    #[test]
    fn whole_fixture_target_matches_element_parameter() {
        let fixture_uid = Uuid::from_u128(7);
        let targets = Some(vec![FixtureRef {
            fixture_uid,
            index: None,
        }]);
        let fixture_ref = FixtureRef {
            fixture_uid,
            index: Some(2),
        };

        assert!(master_targets_parameter(
            &master(1, MasterTarget::Fixtures(FixtureMasterTarget::All), 100.0),
            &targets,
            &fixture_ref
        ));
    }

    /// Verifies unrelated fixture targets do not match a parameter.
    #[test]
    fn unrelated_target_does_not_match_parameter() {
        let targets = Some(vec![FixtureRef {
            fixture_uid: Uuid::from_u128(7),
            index: None,
        }]);
        let fixture_ref = FixtureRef {
            fixture_uid: Uuid::from_u128(8),
            index: Some(1),
        };

        assert!(!master_targets_parameter(
            &master(1, MasterTarget::Fixtures(FixtureMasterTarget::All), 100.0),
            &targets,
            &fixture_ref
        ));
    }

    /// Verifies empty resolved targets do not behave like all-fixture targets.
    #[test]
    fn empty_target_does_not_match_parameter() {
        let fixture_ref = FixtureRef {
            fixture_uid: Uuid::from_u128(8),
            index: Some(1),
        };

        assert!(!master_targets_parameter(
            &master(1, MasterTarget::Fixtures(FixtureMasterTarget::All), 100.0),
            &Some(Vec::new()),
            &fixture_ref
        ));
    }

    /// Verifies clip-targeted playback master resolution ignores unrelated instances.
    #[test]
    fn targeted_clip_instances_match_requested_clip_ids() {
        let mut world = World::new();
        let matched_playback = InstanceId(Uuid::from_u128(1));
        let unrelated_playback = InstanceId(Uuid::from_u128(2));
        world.spawn(MaterializedClip {
            clip_id: 7,
            attached_instance: matched_playback,
            auto_release_on_stop: true,
        });
        world.spawn(MaterializedClip {
            clip_id: 8,
            attached_instance: unrelated_playback,
            auto_release_on_stop: true,
        });

        let mut query_state = world.query::<&MaterializedClip>();
        let live_instances = HashSet::from([matched_playback, unrelated_playback]);

        assert_eq!(
            targeted_clip_instances(&[7], query_state.iter(&world), &live_instances),
            vec![matched_playback]
        );
    }

    /// Verifies active playback-rate masters multiply matching live playback scales.
    #[test]
    fn apply_playback_rate_masters_multiplies_matching_instances() {
        let mut app = App::new();
        let mut masters = DataProvider::<Master>::default();
        masters
            .add(rate_master(1, InstanceMasterTarget::All, 50.0))
            .expect("global rate master should store");
        masters
            .add(rate_master(2, InstanceMasterTarget::Clips(vec![7]), 200.0))
            .expect("clip rate master should store");
        app.insert_resource(masters);
        app.add_systems(Update, apply_playback_rate_masters);

        let targeted_playback = InstanceId(Uuid::from_u128(10));
        let unrelated_playback = InstanceId(Uuid::from_u128(11));
        app.world_mut()
            .spawn((targeted_playback, InstanceControls::default()));
        app.world_mut()
            .spawn((unrelated_playback, InstanceControls::default()));
        app.world_mut().spawn(MaterializedClip {
            clip_id: 7,
            attached_instance: targeted_playback,
            auto_release_on_stop: true,
        });
        app.world_mut().spawn(MaterializedClip {
            clip_id: 8,
            attached_instance: unrelated_playback,
            auto_release_on_stop: true,
        });

        app.update();

        let mut controls = app.world_mut().query::<(&InstanceId, &InstanceControls)>();
        let scales = controls
            .iter(app.world())
            .map(|(instance_id, controls)| (*instance_id, controls.rate_master_scale))
            .collect::<HashMap<_, _>>();
        assert_eq!(scales[&targeted_playback], 1.0);
        assert_eq!(scales[&unrelated_playback], 0.5);

        app.world_mut().clear_trackers();
        app.update();

        let mut controls = app.world_mut().query::<Ref<InstanceControls>>();
        assert!(
            controls
                .iter(app.world())
                .all(|controls| !controls.is_changed()),
            "stable master scales must not mark playback controls changed"
        );
    }
}
