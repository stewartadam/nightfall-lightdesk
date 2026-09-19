// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Desk command routing for showfile lifecycle operations.

use super::*;

/// Resolves the showfile name targeted by a save command.
pub(super) fn effective_save_showfile_name(
    command: &DeskCommand,
    current_showfile: &CurrentShowfile,
) -> Result<Option<String>, String> {
    match command {
        DeskCommand::SaveNamedShowfile { name, .. } => current_showfile_name(Some(name)),
        DeskCommand::SaveShowfile(_) => Ok(current_showfile.name().map(str::to_string)),
        _ => Ok(None),
    }
}

/// Returns the save options carried by a showfile save command.
fn showfile_save_options(command: &DeskCommand) -> Option<&ShowfileSaveOptions> {
    match command {
        DeskCommand::SaveShowfile(options) => Some(options),
        DeskCommand::SaveNamedShowfile { options, .. } => Some(options),
        DeskCommand::SaveDraftShowfile(options) => Some(options),
        DeskCommand::SaveNamedDraftShowfile { options, .. } => Some(options),
        _ => None,
    }
}

/// Routes showfile save/load commands and emits their terminal command results.
pub fn handle_events(
    mut showfile_state: ParamSet<(ShowfileSaveState, ShowfileLoadState)>,
    mut pending_world_swap_request: Option<ResMut<crate::PendingWorldSwapRequest>>,
    mut current_showfile: ResMut<CurrentShowfile>,
    mut clean_snapshot_hash: ResMut<ShowfileCleanSnapshotHash>,
    mut commands: Commands,
    mut events: MessageReader<CommandEnvelope<DeskCommand>>,
    mut responder: CommandResponder,
    mut ui_notifications: MessageWriter<UiNotification>,
) {
    for event in events.read() {
        match &event.command {
            DeskCommand::NewShowfile | DeskCommand::NewNamedShowfile(_) => {
                if let Some(pending_world_swap_request) = pending_world_swap_request.as_deref_mut()
                {
                    let (showfile_name, include_sample_data) = match &event.command {
                        DeskCommand::NewNamedShowfile(options) => {
                            (Some(options.name.as_str()), options.include_sample_data)
                        }
                        _ => (None, false),
                    };
                    pending_world_swap_request.request_new_showfile(
                        event.command_id.into(),
                        showfile_name,
                        include_sample_data,
                    );
                    continue;
                }

                fail_showfile_command(
                    &mut responder,
                    event.command_id,
                    "new showfile requires world swap support".to_string(),
                );
            }

            DeskCommand::SaveShowfile(_) | DeskCommand::SaveNamedShowfile { .. } => {
                let showfile_name =
                    match effective_save_showfile_name(&event.command, &current_showfile) {
                        Ok(showfile_name) => showfile_name,
                        Err(error) => {
                            fail_showfile_command(&mut responder, event.command_id, error);
                            continue;
                        }
                    };
                let save_options = showfile_save_options(&event.command)
                    .expect("save command branch should carry save options");
                let mut showfile_save_state = showfile_state.p0();
                match save_showfile(
                    &mut showfile_save_state,
                    showfile_name.as_deref(),
                    save_options,
                ) {
                    Err(error) => {
                        tracing::error!("Failed to save showfile: {}", error);
                        fail_showfile_command(&mut responder, event.command_id, error);
                    }
                    Ok(snapshot) => {
                        if matches!(&event.command, DeskCommand::SaveNamedShowfile { .. }) {
                            current_showfile.name = showfile_name.clone();
                            write_current_showfile_changed(
                                showfile_name.clone(),
                                &mut ui_notifications,
                            );
                        }
                        if let Err(error) =
                            update_clean_snapshot_hash(&mut clean_snapshot_hash, &snapshot)
                        {
                            tracing::warn!("Failed to update clean showfile hash: {}", error);
                        }
                        write_showfile_saved_feedback(event, &mut responder, &mut ui_notifications);
                    }
                }
            }

            DeskCommand::SaveDraftShowfile(_) | DeskCommand::SaveNamedDraftShowfile { .. } => {
                let showfile_name = match &event.command {
                    DeskCommand::SaveNamedDraftShowfile { name, .. } => {
                        current_showfile_name(Some(name))
                    }
                    DeskCommand::SaveDraftShowfile(_) => {
                        Ok(current_showfile.name().map(str::to_string))
                    }
                    _ => Ok(None),
                };
                let showfile_name = match showfile_name {
                    Ok(showfile_name) => showfile_name,
                    Err(error) => {
                        fail_showfile_command(&mut responder, event.command_id, error);
                        continue;
                    }
                };
                let save_options = showfile_save_options(&event.command)
                    .expect("draft save command branch should carry save options");
                let mut showfile_save_state = showfile_state.p0();
                match save_draft_showfile_if_dirty(
                    &mut showfile_save_state,
                    showfile_name.as_deref(),
                    &mut clean_snapshot_hash,
                    save_options,
                ) {
                    Ok(_) => {
                        succeed_showfile_command(&mut responder, event.command_id);
                    }
                    Err(error) => {
                        tracing::warn!("Failed to save showfile draft: {}", error);
                        fail_showfile_command(&mut responder, event.command_id, error);
                    }
                }
            }

            DeskCommand::LoadShowfile
            | DeskCommand::LoadNamedShowfile(_)
            | DeskCommand::LoadDraftShowfile(_)
            | DeskCommand::LoadShowfileRevision(_) => {
                let selection = match &event.command {
                    DeskCommand::LoadShowfile => showfile_dir_path(None).map(|path| (None, path)),
                    DeskCommand::LoadNamedShowfile(name) => current_showfile_name(Some(name))
                        .and_then(|name| {
                            showfile_dir_path(name.as_deref()).map(|path| (name, path))
                        }),
                    DeskCommand::LoadDraftShowfile(name) => current_showfile_name(Some(name))
                        .and_then(|name| {
                            showfile_draft_dir_path(name.as_deref()).map(|path| (name, path))
                        }),
                    DeskCommand::LoadShowfileRevision(selection) => {
                        current_showfile_name(Some(&selection.showfile_name)).and_then(|name| {
                            revision::resolve_showfile_revision_directory(selection)
                                .map(|path| (name, path))
                        })
                    }
                    _ => unreachable!("showfile load branch received a non-load command"),
                };
                let (showfile_name, source) = match selection {
                    Ok(selection) => selection,
                    Err(error) => {
                        fail_showfile_command(&mut responder, event.command_id, error);
                        continue;
                    }
                };
                if let Some(pending) = pending_world_swap_request.as_deref_mut() {
                    pending.request_load_showfile(
                        event.command_id.into(),
                        showfile_name.as_deref(),
                        source,
                    );
                    continue;
                }
                let snapshot = match prepare_showfile_session(&source, showfile_name.as_deref()) {
                    Ok(snapshot) => snapshot,
                    Err(error) => {
                        fail_showfile_command(&mut responder, event.command_id, error);
                        continue;
                    }
                };
                let mut showfile_load_state = showfile_state.p1();
                if let Err(error) = load_showfile_snapshot_from_state(
                    snapshot.clone(),
                    &mut showfile_load_state,
                    &mut commands,
                ) {
                    fail_showfile_command(&mut responder, event.command_id, error);
                    continue;
                }
                if let Err(error) = current_showfile.set_name(showfile_name.as_deref()) {
                    fail_showfile_command(&mut responder, event.command_id, error);
                    continue;
                }
                let clean_hash_result =
                    showfile_dir_path(showfile_name.as_deref()).and_then(|saved_dir| {
                        if assets::paths_refer_to_same_file(&source, &saved_dir) {
                            update_clean_snapshot_hash(&mut clean_snapshot_hash, &snapshot)
                        } else {
                            update_clean_snapshot_hash_from_saved_show(
                                &mut clean_snapshot_hash,
                                showfile_name.as_deref(),
                            )
                        }
                    });
                if let Err(error) = clean_hash_result {
                    tracing::warn!("Failed to update clean showfile hash: {}", error);
                }
                succeed_showfile_command(&mut responder, event.command_id);
                write_current_showfile_changed(
                    current_showfile.name().map(str::to_string),
                    &mut ui_notifications,
                );
            }

            DeskCommand::DiscardDraftShowfile(name) => {
                match current_showfile_name(Some(name))
                    .and_then(|showfile_name| remove_draft_showfile(showfile_name.as_deref()))
                {
                    Ok(()) => {
                        succeed_showfile_command(&mut responder, event.command_id);
                    }
                    Err(error) => {
                        fail_showfile_command(&mut responder, event.command_id, error);
                    }
                }
            }

            DeskCommand::ImportShowfile(options) => {
                let import_path = match import_showfile_path(options) {
                    Ok(path) => path,
                    Err(error) => {
                        fail_showfile_command(&mut responder, event.command_id, error);
                        continue;
                    }
                };
                let mut imported_snapshot = match read_showfile_snapshot_from_path(&import_path) {
                    Ok(snapshot) => snapshot,
                    Err(error) => {
                        fail_showfile_command(&mut responder, event.command_id, error);
                        continue;
                    }
                };

                let current_snapshot = {
                    let showfile_save_state = showfile_state.p0();
                    snapshot_from_save_state(&showfile_save_state)
                };

                let current_show_data_dir = match show_data_dir_path() {
                    Ok(path) => path,
                    Err(error) => {
                        fail_showfile_command(&mut responder, event.command_id, error);
                        continue;
                    }
                };

                if let Err(error) = prepare_imported_showfile_assets(
                    &mut imported_snapshot,
                    &current_snapshot,
                    options,
                    &import_path,
                    &current_show_data_dir,
                ) {
                    fail_showfile_command(&mut responder, event.command_id, error);
                    continue;
                }

                let merged_snapshot =
                    match merge_showfile_snapshots(current_snapshot, imported_snapshot, options) {
                        Ok(snapshot) => snapshot,
                        Err(error) => {
                            fail_showfile_command(&mut responder, event.command_id, error);
                            continue;
                        }
                    };

                let mut showfile_load_state = showfile_state.p1();
                if let Err(error) = load_showfile_snapshot_from_state(
                    merged_snapshot,
                    &mut showfile_load_state,
                    &mut commands,
                ) {
                    fail_showfile_command(&mut responder, event.command_id, error);
                    continue;
                }
                write_showfile_imported_feedback(event, &mut responder, &mut ui_notifications);
            }

            _ => {}
        }
    }
}
