// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Engine commands that preview, import and discard a read rig.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use bevy_ecs::prelude::*;
use bevy_ecs::system::SystemParam;
use nightfall::prelude::{FixtureRef, Group, Identifiers, SelectionExpr, SpatialSelection};
use nightfall_engine::prelude::*;
use nightfall_fixture_library::FixtureLibraryManager;
use nightfall_fixtures::prelude::*;
use nightfall_fixtures::{FixtureCommand, PatchRoute, RigFixtureUpdate, RouteEndpoint};
use nightfall_programming::prelude::GroupCommand;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::plan::{ImportPlan, ShowFixture, ShowFixtures, ShowGroup, plan_import};
use crate::preview::RigImportOptions;
use crate::rig::{RigFile, RigPatch};
use crate::sessions::RigImportSessions;

/// Commands for importing a rig the upload route has read.
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum RigImportCommand {
    /// Work out what importing the rig with `options` would do, without changing the show.
    /// Replies with a `RigImportPreview`.
    Preview {
        /// Session the upload returned.
        #[serde(with = "nightfall::serde_uuid_simple")]
        #[typeshare(serialized_as = "String")]
        session: Uuid,
        /// Choices shaping the import.
        options: RigImportOptions,
    },
    /// Import the rig as one undoable step: add its new fixtures with their patch and
    /// placement, update fixtures already in the show, and make or refresh its groups.
    ///
    /// Fixture types taken from the file are added to the show first (and to the user's
    /// library when asked), which undo does not remove.
    Commit {
        /// Session the upload returned.
        #[serde(with = "nightfall::serde_uuid_simple")]
        #[typeshare(serialized_as = "String")]
        session: Uuid,
        /// Choices shaping the import; the same as the preview's.
        options: RigImportOptions,
    },
    /// Forget a read rig and delete its extracted files.
    Discard {
        /// Session the upload returned.
        #[serde(with = "nightfall::serde_uuid_simple")]
        #[typeshare(serialized_as = "String")]
        session: Uuid,
    },
}

impl IngressCommand for RigImportCommand {}

/// The parts of the show an import is planned against.
#[derive(SystemParam)]
pub struct ShowState<'w> {
    /// Fixtures in the show.
    fixtures: Res<'w, FixtureDataProviderExt>,
    /// Output routes, which hold the console patch.
    output_routes: Res<'w, OutputRoutes>,
    /// Groups in the show.
    groups: Res<'w, DataProvider<Group>>,
}

impl ShowState<'_> {
    /// Reads the fixtures with their console patch, and the groups.
    fn snapshot(&self) -> ShowFixtures {
        let mut patches: std::collections::HashMap<Uuid, (Vec<RigPatch>, bool)> =
            std::collections::HashMap::new();
        for route in &self.output_routes.routes {
            let OutputTarget::Console { universe, address } = &route.target else {
                continue;
            };
            let (uids, dmx_break, whole) = match &route.source {
                OutputSource::Fixture {
                    uids,
                    element,
                    param,
                } => (uids, 1, element.is_none() && param.is_none()),
                OutputSource::FixtureBreak { uids, dmx_break } => (uids, *dmx_break, true),
                _ => continue,
            };
            // Any console route naming several fixtures blocks a repatch, as in `PatchRig`.
            let shared = uids.len() > 1;
            for uid in uids {
                let entry = patches.entry(*uid).or_default();
                entry.1 |= shared;
                if let (false, true, Some(universe), Some(address)) =
                    (shared, whole, universe, address)
                {
                    entry.0.push(RigPatch {
                        dmx_break,
                        universe: universe.start,
                        address: *address,
                    });
                }
            }
        }

        let mut show = ShowFixtures::default();
        for entry in self.fixtures.inner.iter() {
            let fixture = entry.value();
            let (mut patch, shared_patch) = patches.remove(entry.key()).unwrap_or_default();
            patch.sort_by_key(|entry| entry.dmx_break);
            show.ids.insert(fixture.identifiers.id);
            show.fixtures.insert(
                *entry.key(),
                ShowFixture {
                    id: fixture.identifiers.id,
                    label: fixture.identifiers.label.clone(),
                    make: fixture.make.clone(),
                    model: fixture.model.clone(),
                    mode: fixture.mode.clone(),
                    placement: fixture.placement.clone(),
                    patch,
                    shared_patch,
                },
            );
        }
        show.groups = self
            .groups
            .iter()
            .map(|entry| ShowGroup {
                id: entry.identifiers.id,
                uid: entry.identifiers.uid,
                label: entry.identifiers.label.clone(),
                members: plain_members(&entry.selection),
            })
            .collect();
        show
    }
}

/// Returns a group's members when its selection is a plain list of whole fixtures, the form
/// the import writes, or `None` for any other selection.
fn plain_members(selection: &SpatialSelection) -> Option<Vec<Uuid>> {
    if !selection.clauses.is_empty() || !selection.union.is_empty() {
        return None;
    }
    let SelectionExpr::Resolved(refs) = &selection.source else {
        return None;
    };
    refs.iter()
        .map(|reference| reference.index.is_none().then_some(reference.fixture_uid))
        .collect()
}

/// Returns the error for a session that is unknown or was dropped.
fn unknown_session(session: Uuid) -> CommandError {
    CommandError::new(
        "rig_import.unknown_session",
        format!("Rig import session {session} has expired; open the file again"),
    )
}

/// Logs a command lifecycle error, which only happens for commands the tracker lost.
fn log_lifecycle(result: Result<(), CommandLifecycleError>) {
    if let Err(error) = result {
        tracing::error!(%error, "rig_import_command_completion_failed");
    }
}

/// Answers preview and discard commands.
///
/// Commits are turned into fixture commands before this runs, so one reaching it means the
/// expansion stage did not run and it fails.
pub fn handle_rig_import_commands(
    mut events: MessageReader<CommandEnvelope<RigImportCommand>>,
    sessions: Res<RigImportSessions>,
    library: Res<FixtureLibraryManager>,
    show: ShowState,
    mut responder: CommandResponder,
) {
    for event in events.read() {
        let result = match &event.command {
            RigImportCommand::Preview { session, options } => match sessions.get(*session) {
                Some(rig) => {
                    let plan = plan_import(*session, &rig, &*library, &show.snapshot(), options);
                    responder.succeed_with_output(event.command_id, &plan.preview)
                }
                None => responder.fail(event.command_id, unknown_session(*session)),
            },
            RigImportCommand::Discard { session } => {
                sessions.remove(*session);
                responder.succeed(event.command_id)
            }
            RigImportCommand::Commit { .. } => responder.fail(
                event.command_id,
                CommandError::new(
                    "rig_import.not_expanded",
                    "The rig import could not be applied",
                ),
            ),
        };
        log_lifecycle(result);
    }
}

/// Group stores of commits waiting for their `PatchRig` to settle, by commit.
///
/// A commit's groups name its fixtures, so they are stored only once the fixtures are in the
/// show. When `PatchRig` fails, the groups are never stored and the show is left as it was.
#[derive(Resource, Default)]
pub struct DeferredGroupStores(HashMap<CommandId, DeferredGroups>);

impl DeferredGroupStores {
    /// Returns whether no commit is still waiting for its fixtures before storing groups.
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// The group stores one commit queues once its fixtures are imported.
struct DeferredGroups {
    /// Undo group of the commit, which the group stores join.
    undo_id: UndoId,
    /// One `StoreGroup` command per group.
    stores: Vec<DynEnginePayload>,
}

/// Replaces each queued rig import commit with a `PatchRig` fixture command, followed by a
/// group store for each group once `PatchRig` succeeds.
///
/// Runs in the pending command expansion stage, so the replacement commands inherit the
/// commit's command and undo IDs: the commit finishes when all of them have, and undo
/// captures the whole import as one step. Fixture types from the file are installed into
/// the show package (and the user library when asked) first, because the fixtures are built
/// from the library. The group stores wait in [`DeferredGroupStores`] for
/// [`release_deferred_group_stores`].
pub fn expand_rig_import_commits(
    mut pending: ResMut<PendingCommandBuffer>,
    mut deferred: ResMut<DeferredGroupStores>,
    sessions: Res<RigImportSessions>,
    mut library: ResMut<FixtureLibraryManager>,
    show_state: ShowState,
    mut responder: CommandResponder,
) {
    // Commits in one frame are planned against what earlier commits will change.
    let mut show = show_state.snapshot();
    for envelope in pending.drain() {
        let Some(RigImportCommand::Commit { session, options }) = envelope
            .payload
            .as_any()
            .downcast_ref::<RigImportCommand>()
            .cloned()
        else {
            pending.push(envelope);
            continue;
        };
        let Some(rig) = sessions.get(session) else {
            log_lifecycle(responder.fail(envelope.command_id, unknown_session(session)));
            continue;
        };
        let plan = plan_import(session, &rig, &*library, &show, &options);
        let commands = match build_import(&rig, &plan, &mut library, &show_state.groups, &options) {
            Ok(commands) => commands,
            Err(error) => {
                log_lifecycle(responder.fail(envelope.command_id, error));
                continue;
            }
        };
        let ImportCommands { patch, groups } = commands;
        let total = usize::from(patch.is_some()) + groups.len();
        if let Err(error) = responder.expect_completions(envelope.command_id, total) {
            tracing::error!(%error, "rig_import_command_completion_failed");
            log_lifecycle(responder.fail(
                envelope.command_id,
                CommandError::new(
                    "rig_import.not_tracked",
                    "The rig import could not be applied",
                ),
            ));
            continue;
        }
        show.apply(&rig, &plan);
        let now = match patch {
            Some(patch) => {
                if !groups.is_empty() {
                    deferred.0.insert(
                        envelope.command_id,
                        DeferredGroups {
                            undo_id: envelope.undo_id,
                            stores: groups,
                        },
                    );
                }
                vec![patch]
            }
            None => groups,
        };
        for command in now {
            pending.push(PayloadEnvelope::with_context(
                envelope.command_id,
                envelope.undo_id,
                command,
            ));
        }
    }
}

/// Queues the group stores of each commit whose `PatchRig` has succeeded, under the
/// commit's command and undo IDs, and fails them unqueued when it has failed.
///
/// A commit that already finished, for example because it was canceled, just drops its
/// group stores.
pub fn release_deferred_group_stores(
    mut pending: ResMut<PendingCommandBuffer>,
    mut deferred: ResMut<DeferredGroupStores>,
    mut responder: CommandResponder,
) {
    let waiting = std::mem::take(&mut deferred.0);
    for (command_id, groups) in waiting {
        let Some(command) = responder.active_command(command_id) else {
            continue;
        };
        if command.received_completions() == 0 {
            deferred.0.insert(command_id, groups);
            continue;
        }
        if command.first_error().is_some() {
            // The commit reports PatchRig's error, the first one it received.
            for _ in &groups.stores {
                log_lifecycle(responder.fail(
                    command_id,
                    CommandError::new(
                        "rig_import.groups_skipped",
                        "Groups were not stored because the fixtures could not be imported",
                    ),
                ));
            }
            continue;
        }
        for store in groups.stores {
            pending.push(PayloadEnvelope::with_context(
                command_id,
                groups.undo_id,
                store,
            ));
        }
    }
}

/// The commands that apply one import plan.
struct ImportCommands {
    /// The `PatchRig` adding and updating fixtures, when any change.
    patch: Option<DynEnginePayload>,
    /// One `StoreGroup` per group the import makes or refreshes.
    groups: Vec<DynEnginePayload>,
}

/// Installs the fixture types the plan needs and builds the commands that apply it: one
/// `PatchRig` for the fixtures, when any change, and one group store per group.
fn build_import(
    rig: &RigFile,
    plan: &ImportPlan,
    library: &mut FixtureLibraryManager,
    groups: &DataProvider<Group>,
    options: &RigImportOptions,
) -> Result<ImportCommands, CommandError> {
    if plan.is_empty() {
        return Err(CommandError::new(
            "rig_import.nothing_to_import",
            "The file has nothing to import or update",
        ));
    }
    install_fixture_types(plan, library, options.add_to_user_library)?;

    let mut add = Vec::with_capacity(plan.fixtures.len());
    let mut routes = Vec::new();
    for planned in &plan.fixtures {
        let source = &planned.source;
        let rig_fixture = &rig.fixtures[planned.index];
        let (mut fixture, _geometry) = library
            .create_fixture_from_revision(
                &source.make,
                &source.model,
                source.revision.as_deref(),
                &planned.mode,
                planned.id,
            )
            .map_err(|error| {
                CommandError::new(
                    "rig_import.fixture_type_failed",
                    format!("{}: {error}", rig_fixture.name),
                )
            })?;
        fixture.identifiers.uid = rig_fixture.uid;
        fixture.identifiers.label = planned.label.clone();
        fixture.placement = rig_fixture.placement.clone();
        routes.extend(
            rig_fixture
                .patch
                .iter()
                .map(|patch| patch_route(planned.id, patch)),
        );
        add.push(fixture);
    }
    let mut update = Vec::with_capacity(plan.updates.len());
    for planned in &plan.updates {
        let rig_fixture = &rig.fixtures[planned.index];
        if planned.repatch {
            routes.extend(
                rig_fixture
                    .patch
                    .iter()
                    .map(|patch| patch_route(planned.id, patch)),
            );
        }
        update.push(RigFixtureUpdate {
            uid: rig_fixture.uid,
            label: planned.label.clone(),
            placement: planned.placement.clone(),
            repatch: planned.repatch,
        });
    }

    let patch = (!add.is_empty() || !update.is_empty()).then(|| {
        Box::new(FixtureCommand::PatchRig {
            add,
            update,
            routes,
        }) as DynEnginePayload
    });
    let mut stores: Vec<DynEnginePayload> = Vec::new();
    for planned in &plan.groups {
        let selection = SpatialSelection::identity(SelectionExpr::Resolved(
            planned
                .members
                .iter()
                .map(|uid| FixtureRef {
                    fixture_uid: *uid,
                    index: None,
                })
                .collect(),
        ));
        let group = match planned.existing.and_then(|uid| groups.get(uid).ok()) {
            Some(existing) => Group {
                selection,
                ..(*existing).clone()
            },
            None => Group {
                identifiers: Identifiers {
                    id: planned.id,
                    uid: planned.uid,
                    label: planned.name.clone(),
                },
                selection,
                description: format!("Imported from {}", rig.file_name),
            },
        };
        stores.push(Box::new(GroupCommand::StoreGroup(group)));
    }
    Ok(ImportCommands {
        patch,
        groups: stores,
    })
}

/// Builds the route patching one break of a fixture to its console address.
fn patch_route(id: u32, patch: &RigPatch) -> PatchRoute {
    let source = if patch.dmx_break <= 1 {
        RouteEndpoint::Fixture {
            ids: vec![id],
            element: None,
            param: None,
        }
    } else {
        RouteEndpoint::FixtureBreak {
            ids: vec![id],
            dmx_break: patch.dmx_break,
        }
    };
    PatchRoute {
        source,
        target: RouteEndpoint::Console {
            universe: Some(DmxRange::single(patch.universe)),
            address: Some(patch.address),
        },
    }
}

/// Copies the GDTF files the plan takes from the rig into the show package, and into the
/// user library when asked, then rescans the library so fixtures can be built from them.
fn install_fixture_types(
    plan: &ImportPlan,
    library: &mut FixtureLibraryManager,
    add_to_user_library: bool,
) -> Result<(), CommandError> {
    let mut files: Vec<&Path> = plan
        .fixtures
        .iter()
        .filter_map(|planned| planned.source.install.as_deref())
        .collect();
    files.sort();
    files.dedup();
    if files.is_empty() {
        return Ok(());
    }

    let install_failed = |error: std::io::Error| {
        CommandError::new(
            "rig_import.install_failed",
            format!("Could not add the fixture types to the show: {error}"),
        )
    };
    let show_dir = library
        .showfile_directory()
        .map(Path::to_path_buf)
        .or_else(nightfall::active_show_data_dir)
        .ok_or_else(|| {
            CommandError::new(
                "rig_import.no_show_folder",
                "The show has no folder to add fixture types to",
            )
        })?;
    let package_fixtures = show_dir.join("fixtures");
    for file in &files {
        copy_unique(file, &package_fixtures).map_err(install_failed)?;
        if add_to_user_library {
            copy_unique(file, library.library_path()).map_err(install_failed)?;
        }
    }
    // One full scan picks up the package and the user library. Selecting a package folder
    // when another is selected already does that scan; selecting the first one only
    // overlays the package, so the user library needs its own scan.
    let reload = match library.showfile_directory() {
        Some(current) if current == show_dir => library.scan(),
        Some(_) => library.set_showfile_directory(Some(show_dir)),
        None => library
            .set_showfile_directory(Some(show_dir))
            .and_then(|()| {
                if add_to_user_library {
                    library.scan()
                } else {
                    Ok(())
                }
            }),
    };
    reload.map_err(|error| {
        CommandError::new(
            "rig_import.rescan_failed",
            format!("Could not load the added fixture types: {error}"),
        )
    })
}

/// Copies a file into `dir` under its own name unless an identical file is already there.
///
/// Extracted GDTF files are named by their content fingerprint, so a file of the same name
/// is the same fixture type revision.
fn copy_unique(file: &Path, dir: &Path) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let name = file
        .file_name()
        .ok_or_else(|| std::io::Error::other("fixture type file has no name"))?;
    let target = dir.join(name);
    if !target.exists() {
        std::fs::copy(file, &target)?;
    }
    Ok(target)
}
