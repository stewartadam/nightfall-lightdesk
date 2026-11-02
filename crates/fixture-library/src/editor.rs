// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Fixture editor: drafts of GDTF fixture types that clients build and save
//! into the user fixture library.
//!
//! A draft holds one parsed GDTF description and, when it was opened from a
//! library file, that file's archive bytes so models, wheel images and
//! thumbnails survive a save. Every edit applies to a copy of the description
//! and is kept only when it succeeds, so a rejected edit never leaves a draft
//! half changed. Drafts live on the server and are shared by every client;
//! each change is broadcast as the draft's full view.

mod catalog;
pub mod commands;
mod draft;
mod edit;
mod handler;
mod problems;
mod save;
mod templates;
pub mod view;

use bevy_app::prelude::*;
use bevy_ecs::prelude::*;
pub use commands::{
    BodyShape, DraftEdit, DraftFunctionFields, DraftId, DraftPreviewResponse, DraftSetFields,
    DraftSlotFields, DraftSource, DraftTemplate, FixtureEditorCommand, FixtureEditorCommandResult,
    FixtureEditorSuccess,
};
pub use draft::FixtureDrafts;
use nightfall_engine::prelude::*;
pub use view::FixtureDraftView;

/// Registers fixture-editor commands, the draft store and the systems that apply them.
///
/// Requires the resources [`crate::FixtureLibraryPlugin`] provides.
pub fn register_fixture_editor(app: &mut App) {
    register_ingress_command::<FixtureEditorCommand>(app);
    app.add_message::<FixtureEditorCommandResult>();
    register_command_deserializer::<FixtureEditorCommand>(
        app,
        commands::deserialize_fixture_editor_command,
    );
    app.init_resource::<FixtureDrafts>();
    app.add_systems(
        Update,
        (
            handler::handle_fixture_editor_commands,
            commands::finish_fixture_editor_commands,
        )
            .chain()
            .in_set(EventHandling),
    );
}

#[cfg(test)]
mod tests;
