// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Applies fixture-editor commands to the draft store.

use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;

use super::commands::{
    DraftId, DraftSource, FixtureEditorCommand, FixtureEditorCommandResult, FixtureEditorSuccess,
    publish_draft, publish_draft_closed,
};
use super::draft::{FixtureDraft, FixtureDrafts};
use super::edit::apply_edit;
use super::save::{SaveRequest, editor_error, open_library_fixture, preview, save};
use super::templates;
use super::view::{FixtureDraftView, draft_view};
use crate::manager::FixtureLibraryManager;

/// Applies fixture-editor commands and emits one result per request.
///
/// Every command that opens or changes a draft broadcasts the draft's new
/// view, so other windows showing it stay current.
pub(super) fn handle_fixture_editor_commands(
    mut events: MessageReader<CommandEnvelope<FixtureEditorCommand>>,
    mut drafts: ResMut<FixtureDrafts>,
    library: Res<FixtureLibraryManager>,
    broadcaster: Res<ClientEventSink>,
    mut results: MessageWriter<FixtureEditorCommandResult>,
) {
    for event in events.read() {
        let result = apply_command(&event.command, &mut drafts, &library, &broadcaster);
        results.write(FixtureEditorCommandResult::new(event.command_id, result));
    }
}

/// Applies one command and returns its outcome.
fn apply_command(
    command: &FixtureEditorCommand,
    drafts: &mut FixtureDrafts,
    library: &FixtureLibraryManager,
    broadcaster: &ClientEventSink,
) -> Result<FixtureEditorSuccess, CommandError> {
    match command {
        FixtureEditorCommand::OpenDraft { source } => {
            let view = open_draft(drafts, library, source)?;
            Ok(changed(broadcaster, view))
        }
        FixtureEditorCommand::ListDrafts => Ok(FixtureEditorSuccess::Drafts(
            drafts.iter().map(draft_view).collect(),
        )),
        FixtureEditorCommand::EditDraft {
            draft_id,
            base_version,
            edit,
        } => {
            let draft = draft_mut(drafts, *draft_id)?;
            if base_version.is_some_and(|version| version != draft.version()) {
                return Err(editor_error(
                    "stale_draft",
                    "The draft changed in another window; apply the edit to its current view",
                ));
            }
            draft
                .apply(|state| apply_edit(state, edit))
                .map_err(|error| editor_error("invalid_edit", error))?;
            Ok(changed(broadcaster, draft_view(draft)))
        }
        FixtureEditorCommand::UndoDraft { draft_id } => {
            let draft = draft_mut(drafts, *draft_id)?;
            if !draft.undo() {
                return Err(editor_error("nothing_to_undo", "There is no edit to undo"));
            }
            Ok(changed(broadcaster, draft_view(draft)))
        }
        FixtureEditorCommand::RedoDraft { draft_id } => {
            let draft = draft_mut(drafts, *draft_id)?;
            if !draft.redo() {
                return Err(editor_error("nothing_to_redo", "There is no edit to redo"));
            }
            Ok(changed(broadcaster, draft_view(draft)))
        }
        FixtureEditorCommand::PreviewDraft { draft_id, mode } => {
            let draft = drafts
                .get(*draft_id)
                .ok_or_else(|| draft_not_found(*draft_id))?;
            Ok(FixtureEditorSuccess::Preview(Box::new(preview(
                draft,
                mode.as_deref(),
            )?)))
        }
        FixtureEditorCommand::SaveDraft {
            draft_id,
            file_name,
            overwrite,
            note,
        } => {
            let draft = draft_mut(drafts, *draft_id)?;
            let path = save(
                draft,
                library,
                SaveRequest {
                    file_name: file_name.as_deref(),
                    overwrite: *overwrite,
                    note: note.as_deref(),
                },
            )?;
            tracing::info!(draft_id, path = %path.display(), "fixture_draft_saved");
            Ok(changed(broadcaster, draft_view(draft)))
        }
        FixtureEditorCommand::DiscardDraft { draft_id } => {
            if !drafts.close(*draft_id) {
                return Err(draft_not_found(*draft_id));
            }
            publish_draft_closed(broadcaster, *draft_id);
            Ok(FixtureEditorSuccess::Applied)
        }
    }
}

/// Broadcasts a changed draft and wraps its view as the command output.
fn changed(broadcaster: &ClientEventSink, view: FixtureDraftView) -> FixtureEditorSuccess {
    publish_draft(broadcaster, &view);
    FixtureEditorSuccess::Draft(Box::new(view))
}

/// Error for a draft that is not open.
fn draft_not_found(draft_id: DraftId) -> CommandError {
    editor_error("draft_not_found", format!("Draft {draft_id} is not open"))
}

/// Looks up an open draft for changing.
fn draft_mut(
    drafts: &mut FixtureDrafts,
    draft_id: DraftId,
) -> Result<&mut FixtureDraft, CommandError> {
    drafts
        .get_mut(draft_id)
        .ok_or_else(|| draft_not_found(draft_id))
}

/// Opens a draft from its source and returns its view.
///
/// A duplicate gets a new fixture type identity and a name ending in
/// `copy`, so saving it never replaces the original. An edited library
/// fixture saves back to its own file name.
fn open_draft(
    drafts: &mut FixtureDrafts,
    library: &FixtureLibraryManager,
    source: &DraftSource,
) -> Result<FixtureDraftView, CommandError> {
    let open_failed = |error: String| editor_error("open_failed", error);
    let draft = match source {
        DraftSource::Blank => {
            let state = templates::blank_state().map_err(open_failed)?;
            drafts.open(|id| FixtureDraft::new(id, source.clone(), state))
        }
        DraftSource::Template(template) => {
            let state = templates::template_state(*template).map_err(open_failed)?;
            drafts.open(|id| FixtureDraft::new(id, source.clone(), state))
        }
        DraftSource::Duplicate(entry) | DraftSource::Edit(entry) => {
            let mut opened = open_library_fixture(library, entry)?;
            let is_edit = matches!(source, DraftSource::Edit(_));
            if is_edit && opened.path.parent() != Some(library.library_path()) {
                return Err(editor_error(
                    "unsupported_source",
                    "Only fixtures in your fixture library can be edited; duplicate this one to edit a copy",
                ));
            }
            if !is_edit {
                make_copy(&mut opened.state.description.fixture_types[0]);
            }
            let file_name = is_edit
                .then(|| opened.path.file_name())
                .flatten()
                .map(|name| name.to_string_lossy().into_owned());
            drafts.open(|id| {
                let mut draft = FixtureDraft::new(id, source.clone(), opened.state);
                draft.file_name = file_name;
                draft.source_archive = Some(opened.archive);
                draft.source_path = Some(opened.path);
                draft.lost_content = opened.lost_content;
                draft
            })
        }
    };
    Ok(draft_view(draft))
}

/// Turns a fixture type into an independent copy with a new identity and name.
fn make_copy(fixture_type: &mut gdtf::fixture_type::FixtureType) {
    let name = fixture_type
        .name
        .as_ref()
        .map(ToString::to_string)
        .unwrap_or_default();
    fixture_type.name = Some(gdtf::values::Name::new_lossy(format!("{name} copy")));
    if !fixture_type.long_name.trim().is_empty() {
        fixture_type.long_name = format!("{} copy", fixture_type.long_name);
    }
    fixture_type.fixture_type_id = uuid::Uuid::new_v4();
}
