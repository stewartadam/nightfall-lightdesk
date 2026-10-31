// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Command-level tests of the fixture editor against a temporary library.

use std::io::{Cursor, Read};

use bevy_app::{App, Update};
use bevy_ecs::message::Messages;
use bevy_ecs::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_fixtures::prelude::FixtureDataProviderExt;
use tempfile::TempDir;

use super::commands::{
    DraftEdit, DraftFunctionFields, DraftSource, DraftTemplate, FixtureEditorCommand,
    FixtureEditorCommandResult, finish_fixture_editor_commands,
};
use super::handler::handle_fixture_editor_commands;
use super::view::{FixtureDraftView, ProblemSeverity};
use super::{DraftPreviewResponse, FixtureDrafts};
use crate::commands::FixtureLibraryEntry;
use crate::manager::FixtureLibraryManager;
use crate::testing::{ChannelSpec, GdtfBuilder, GeometrySpec, ModeSpec};

/// Test app running fixture-editor commands against a library in a temporary directory.
struct EditorApp {
    /// App holding the editor systems and command lifecycle.
    app: App,
    /// Receives everything broadcast to clients.
    broadcasts: async_channel::Receiver<OutboundFrame>,
    /// Library directory, removed when the test ends.
    dir: TempDir,
}

impl EditorApp {
    /// Builds an app whose library is `dir`, after `prepare` has written any files into it.
    fn with_library(prepare: impl FnOnce(&std::path::Path)) -> Self {
        let dir = TempDir::new().expect("temporary library directory");
        prepare(dir.path());
        let mut app = App::new();
        app.insert_resource(
            FixtureLibraryManager::with_path(dir.path().to_path_buf())
                .expect("library initializes"),
        );
        app.init_resource::<FixtureDataProviderExt>();
        app.init_resource::<CommandTracker>();
        app.init_resource::<FixtureDrafts>();
        app.add_message::<CommandEnvelope<FixtureEditorCommand>>();
        app.add_message::<FixtureEditorCommandResult>();
        app.add_message::<CommandResult>();
        app.add_message::<CommandReply>();
        app.add_message::<FinishedCommand>();
        app.add_message::<CommandNoticeReply>();
        let (sender, broadcasts) = async_channel::unbounded();
        app.insert_resource(ClientEventSink::new(sender));
        app.add_systems(
            Update,
            (
                handle_fixture_editor_commands,
                finish_fixture_editor_commands,
            )
                .chain(),
        );
        Self {
            app,
            broadcasts,
            dir,
        }
    }

    /// Builds an app with an empty library.
    fn new() -> Self {
        Self::with_library(|_| {})
    }

    /// Runs one command and returns its terminal outcome.
    fn run(&mut self, command: FixtureEditorCommand) -> CommandOutcome {
        let envelope = CommandEnvelope::new(command, CommandOrigin::WebUi, ReplyTarget::Detached);
        self.app
            .world_mut()
            .resource_mut::<CommandTracker>()
            .register(&envelope)
            .expect("command registers");
        self.app.world_mut().write_message(envelope);
        self.app.update();
        self.app
            .world_mut()
            .resource_mut::<Messages<CommandResult>>()
            .drain()
            .next()
            .expect("command produces a result")
            .outcome
    }

    /// Runs a command that must succeed and decodes its output.
    fn output<T: serde::de::DeserializeOwned>(&mut self, command: FixtureEditorCommand) -> T {
        match self.run(command) {
            CommandOutcome::Succeeded {
                output: Some(output),
            } => serde_json::from_value(output.value.clone()).expect("output decodes"),
            other => panic!("command did not succeed with output: {other:?}"),
        }
    }

    /// Runs a command that must fail and returns its error code.
    fn error_code(&mut self, command: FixtureEditorCommand) -> String {
        match self.run(command) {
            CommandOutcome::Failed(error) => error.code.to_string(),
            other => panic!("command did not fail: {other:?}"),
        }
    }

    /// Opens a draft and returns its view.
    fn open(&mut self, source: DraftSource) -> FixtureDraftView {
        self.output(FixtureEditorCommand::OpenDraft { source })
    }

    /// Applies an edit that must succeed and returns the updated view.
    fn edit(&mut self, draft_id: u32, edit: DraftEdit) -> FixtureDraftView {
        self.output(FixtureEditorCommand::EditDraft {
            draft_id,
            base_version: None,
            edit,
        })
    }

    /// Saves a draft with the given overwrite flag.
    fn save(&mut self, draft_id: u32, overwrite: bool) -> CommandOutcome {
        self.run(FixtureEditorCommand::SaveDraft {
            draft_id,
            file_name: None,
            overwrite,
            note: Some("Test save".to_string()),
        })
    }

    /// Names of the broadcast messages sent so far, in order.
    fn broadcast_types(&self) -> Vec<String> {
        std::iter::from_fn(|| self.broadcasts.try_recv().ok())
            .map(|frame| {
                let value: serde_json::Value =
                    minicbor_serde::from_slice(&frame.bytes[1..]).expect("broadcast decodes");
                value["type"].as_str().unwrap_or_default().to_string()
            })
            .collect()
    }
}

/// Fields of a function covering a channel from `dmx_from`.
fn function(name: &str, attribute: &str, dmx_from: u32) -> DraftFunctionFields {
    DraftFunctionFields {
        name: name.to_string(),
        attribute: attribute.to_string(),
        dmx_from,
        default: dmx_from,
        physical_from: 0.0,
        physical_to: 1.0,
        wheel: None,
    }
}

/// Reads `description.xml` from archive bytes.
fn description_of(bytes: &[u8]) -> String {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).expect("archive opens");
    let mut xml = String::new();
    archive
        .by_name("description.xml")
        .expect("description entry")
        .read_to_string(&mut xml)
        .expect("description reads");
    xml
}

/// Every template opens without errors, names its mode after its footprint and previews.
#[test]
fn templates_open_clean_and_preview() {
    let mut editor = EditorApp::new();
    for (template, footprint) in [
        (DraftTemplate::Dimmer, 1),
        (DraftTemplate::Rgb, 3),
        (DraftTemplate::Rgbw, 4),
        (DraftTemplate::Rgbawuv, 6),
        (DraftTemplate::DimmerRgbStrobe, 5),
        (DraftTemplate::MovingHead, 7),
    ] {
        let view = editor.open(DraftSource::Template(template));
        let errors: Vec<_> = view
            .problems
            .iter()
            .filter(|problem| problem.severity == ProblemSeverity::Error)
            .collect();
        assert!(errors.is_empty(), "{template:?} has errors: {errors:?}");
        assert_eq!(view.modes[0].footprint, footprint, "{template:?}");
        assert_eq!(view.modes[0].name, format!("{footprint}-channel"));
        assert!(!view.dirty, "{template:?} starts clean");

        let preview: DraftPreviewResponse = editor.output(FixtureEditorCommand::PreviewDraft {
            draft_id: view.draft_id,
            mode: None,
        });
        let fixture = preview.profile.fixture.expect("preview has a fixture");
        let parameters: usize = fixture
            .elements
            .iter()
            .map(|element| element.parameters.len())
            .sum();
        assert_eq!(parameters, view.modes[0].channels.len(), "{template:?}");
        assert!(preview.profile.geometry.is_some());
    }
}

/// The moving head template uses 16-bit pan and tilt on the yoke and head, and a color wheel.
#[test]
fn moving_head_template_layout() {
    let mut editor = EditorApp::new();
    let view = editor.open(DraftSource::Template(DraftTemplate::MovingHead));
    let channels = &view.modes[0].channels;
    assert_eq!(channels[0].geometry, "Yoke");
    assert_eq!(channels[0].offset, [1, 2]);
    assert_eq!(channels[1].geometry, "Head");
    assert_eq!(channels[1].offset, [3, 4]);
    assert_eq!(channels[2].geometry, "Beam");
    let color = &channels[4].logical_channels[0].functions[0];
    assert_eq!(color.wheel.as_deref(), Some("Color1"));
    assert_eq!(color.sets.len(), view.wheels[0].slots.len());
}

/// Channel edits move the addresses behind them and resolution changes rescale values.
#[test]
fn channel_edits_shift_addresses_and_rescale() {
    let mut editor = EditorApp::new();
    let id = editor
        .open(DraftSource::Template(DraftTemplate::Rgb))
        .draft_id;
    let view = editor.edit(
        id,
        DraftEdit::AddChannel {
            mode: 0,
            index: Some(0),
            attribute: "Dimmer".to_string(),
            resolution: 2,
        },
    );
    let offsets: Vec<_> = view.modes[0]
        .channels
        .iter()
        .map(|channel| channel.offset.clone())
        .collect();
    assert_eq!(offsets, [vec![1, 2], vec![3], vec![4], vec![5]]);
    assert!(view.attributes.contains(&"Dimmer".to_string()));

    let view = editor.edit(
        id,
        DraftEdit::MoveChannel {
            mode: 0,
            from: 0,
            to: 3,
        },
    );
    assert_eq!(view.modes[0].channels[3].offset, [4, 5]);

    editor.edit(
        id,
        DraftEdit::UpdateFunction {
            mode: 0,
            channel: 0,
            function: 0,
            fields: function("Red", "ColorAdd_R", 0),
        },
    );
    let view = editor.edit(
        id,
        DraftEdit::SetChannelHighlight {
            mode: 0,
            channel: 0,
            value: Some(255),
        },
    );
    assert_eq!(view.modes[0].channels[0].highlight, Some(255));
    let view = editor.edit(
        id,
        DraftEdit::SetChannelResolution {
            mode: 0,
            channel: 0,
            resolution: 2,
        },
    );
    assert_eq!(view.modes[0].channels[0].highlight, Some(65535));
    assert_eq!(view.modes[0].footprint, 6);

    let view = editor.edit(
        id,
        DraftEdit::RemoveChannel {
            mode: 0,
            channel: 0,
        },
    );
    assert_eq!(view.modes[0].footprint, 4);
}

/// A rejected edit fails with an editor error and leaves the draft unchanged.
#[test]
fn invalid_edit_changes_nothing() {
    let mut editor = EditorApp::new();
    let view = editor.open(DraftSource::Template(DraftTemplate::Rgb));
    let code = editor.error_code(FixtureEditorCommand::EditDraft {
        draft_id: view.draft_id,
        base_version: None,
        edit: DraftEdit::AddFunction {
            mode: 0,
            channel: 0,
            function: function("Bad", "ColorAdd_R", 300),
        },
    });
    assert_eq!(code, "fixture_editor.invalid_edit");
    let drafts: Vec<FixtureDraftView> = editor.output(FixtureEditorCommand::ListDrafts);
    assert_eq!(drafts, [view]);
}

/// Functions split a channel's range, named ranges stay inside their function and wheels follow renames.
#[test]
fn functions_sets_and_wheels() {
    let mut editor = EditorApp::new();
    let id = editor
        .open(DraftSource::Template(DraftTemplate::Dimmer))
        .draft_id;
    let view = editor.edit(
        id,
        DraftEdit::AddFunction {
            mode: 0,
            channel: 0,
            function: function("Strobe", "Shutter1Strobe", 200),
        },
    );
    let functions = &view.modes[0].channels[0].logical_channels[0].functions;
    assert_eq!(functions.len(), 2);
    assert_eq!(functions[1].dmx_from, 200);

    let code = editor.error_code(FixtureEditorCommand::EditDraft {
        draft_id: id,
        base_version: None,
        edit: DraftEdit::SetFunctionSets {
            mode: 0,
            channel: 0,
            function: 0,
            sets: vec![super::DraftSetFields {
                name: "Too high".to_string(),
                dmx_from: 210,
                wheel_slot: None,
            }],
        },
    });
    assert_eq!(code, "fixture_editor.invalid_edit");

    let id = editor
        .open(DraftSource::Template(DraftTemplate::MovingHead))
        .draft_id;
    let view = editor.edit(
        id,
        DraftEdit::RenameWheel {
            wheel: 0,
            name: "Colors".to_string(),
        },
    );
    assert_eq!(
        view.modes[0].channels[4].logical_channels[0].functions[0]
            .wheel
            .as_deref(),
        Some("Colors")
    );
    let code = editor.error_code(FixtureEditorCommand::EditDraft {
        draft_id: id,
        base_version: None,
        edit: DraftEdit::RemoveWheel { wheel: 0 },
    });
    assert_eq!(code, "fixture_editor.invalid_edit");
}

/// Undo and redo restore views and broadcast them; a discarded draft is announced closed.
#[test]
fn undo_redo_and_discard_broadcast() {
    let mut editor = EditorApp::new();
    let opened = editor.open(DraftSource::Template(DraftTemplate::Rgb));
    let id = opened.draft_id;
    let edited = editor.edit(
        id,
        DraftEdit::RenameMode {
            mode: 0,
            name: "Main".to_string(),
        },
    );
    assert!(edited.dirty && edited.can_undo);

    let undone: FixtureDraftView = editor.output(FixtureEditorCommand::UndoDraft { draft_id: id });
    assert_eq!(undone.modes, opened.modes);
    assert!(!undone.dirty && undone.can_redo);
    let redone: FixtureDraftView = editor.output(FixtureEditorCommand::RedoDraft { draft_id: id });
    assert_eq!(redone.modes, edited.modes);
    assert_eq!(
        editor.error_code(FixtureEditorCommand::RedoDraft { draft_id: id }),
        "fixture_editor.nothing_to_redo"
    );

    assert!(matches!(
        editor.run(FixtureEditorCommand::DiscardDraft { draft_id: id }),
        CommandOutcome::Succeeded { .. }
    ));
    assert_eq!(
        editor.error_code(FixtureEditorCommand::UndoDraft { draft_id: id }),
        "fixture_editor.draft_not_found"
    );
    assert_eq!(
        editor.broadcast_types(),
        [
            "FixtureDraftUpdated",
            "FixtureDraftUpdated",
            "FixtureDraftUpdated",
            "FixtureDraftUpdated",
            "FixtureDraftClosed"
        ]
    );
}

/// A draft with errors cannot be saved.
#[test]
fn save_is_blocked_by_errors() {
    let mut editor = EditorApp::new();
    let view = editor.open(DraftSource::Blank);
    assert!(
        view.problems
            .iter()
            .any(|problem| problem.severity == ProblemSeverity::Error)
    );
    assert!(matches!(
        editor.save(view.draft_id, false),
        CommandOutcome::Failed(CommandError { ref code, .. }) if code == "fixture_editor.has_errors"
    ));
}

/// Saving writes a GDTF file with a revision entry; another draft must confirm before replacing it.
#[test]
fn save_writes_library_file_and_confirms_overwrite() {
    let mut editor = EditorApp::new();
    let first = editor
        .open(DraftSource::Template(DraftTemplate::Rgbw))
        .draft_id;
    assert!(matches!(
        editor.save(first, false),
        CommandOutcome::Succeeded { .. }
    ));
    let path = editor.dir.path().join("Generic@RGBW.gdtf");
    let bytes = std::fs::read(&path).expect("saved file exists");
    let xml = description_of(&bytes);
    assert!(xml.contains("Test save"), "revision note is written: {xml}");
    gdtf::GdtfFile::new(Cursor::new(bytes)).expect("saved file parses");

    let drafts: Vec<FixtureDraftView> = editor.output(FixtureEditorCommand::ListDrafts);
    assert_eq!(drafts[0].file_name.as_deref(), Some("Generic@RGBW.gdtf"));
    assert!(!drafts[0].dirty);
    editor.edit(
        first,
        DraftEdit::RenameMode {
            mode: 0,
            name: "Main".to_string(),
        },
    );
    assert!(matches!(
        editor.save(first, false),
        CommandOutcome::Succeeded { .. }
    ));
    let xml = description_of(&std::fs::read(&path).unwrap());
    assert_eq!(
        xml.matches("Test save").count(),
        2,
        "both saves are recorded: {xml}"
    );

    let second = editor
        .open(DraftSource::Template(DraftTemplate::Rgbw))
        .draft_id;
    assert!(matches!(
        editor.save(second, false),
        CommandOutcome::Failed(CommandError { ref code, .. }) if code == "fixture_editor.file_exists"
    ));
    assert!(matches!(
        editor.save(second, true),
        CommandOutcome::Succeeded { .. }
    ));

    let mut library = editor
        .app
        .world_mut()
        .resource_mut::<FixtureLibraryManager>();
    library.scan().unwrap();
    let profile = library
        .find_fixture("Generic", "RGBW")
        .expect("saved fixture is listed");
    assert_eq!(profile.mode_names(), ["4-channel"]);
}

/// Editing a library file saves back to the same file and keeps its resources.
#[test]
fn edit_library_fixture_keeps_resources() {
    let mut editor = EditorApp::with_library(|dir| {
        GdtfBuilder::new("Acme", "Spot")
            .geometry(GeometrySpec::generic("Body"))
            .mode(ModeSpec::new("Basic", "Body").channel(ChannelSpec::new("Body", "Dimmer", &[1])))
            .file("wheels/gobo.png", b"png")
            .write_to(&dir.join("acme-spot.gdtf"));
    });
    let entry = FixtureLibraryEntry {
        make: "Acme".to_string(),
        model: "Spot".to_string(),
        asset_etag: None,
    };
    let view = editor.open(DraftSource::Edit(entry.clone()));
    assert_eq!(view.file_name.as_deref(), Some("acme-spot.gdtf"));
    assert_eq!(view.body, None);
    editor.edit(
        view.draft_id,
        DraftEdit::AddChannel {
            mode: 0,
            index: None,
            attribute: "Shutter1".to_string(),
            resolution: 1,
        },
    );
    assert!(matches!(
        editor.save(view.draft_id, false),
        CommandOutcome::Failed(CommandError { ref code, .. }) if code == "fixture_editor.file_exists"
    ));
    assert!(matches!(
        editor.save(view.draft_id, true),
        CommandOutcome::Succeeded { .. }
    ));

    let bytes = std::fs::read(editor.dir.path().join("acme-spot.gdtf")).unwrap();
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes.as_slice())).unwrap();
    assert!(archive.by_name("wheels/gobo.png").is_ok());
    assert!(description_of(&bytes).contains("Shutter1"));

    let copy = editor.open(DraftSource::Duplicate(entry));
    assert_eq!(copy.info.name, "Spot copy");
    assert_eq!(copy.file_name, None);
}

/// Missing fixtures and non-GDTF sources cannot be opened.
#[test]
fn open_rejects_missing_and_non_gdtf_sources() {
    let mut editor = EditorApp::new();
    let missing = FixtureLibraryEntry {
        make: "Missing".to_string(),
        model: "Fixture".to_string(),
        asset_etag: None,
    };
    assert_eq!(
        editor.error_code(FixtureEditorCommand::OpenDraft {
            source: DraftSource::Edit(missing)
        }),
        "fixture_editor.not_found"
    );
    let built_in = {
        let library = editor.app.world().resource::<FixtureLibraryManager>();
        let profile = library.list_fixtures()[0];
        FixtureLibraryEntry {
            make: profile.make.clone(),
            model: profile.model.clone(),
            asset_etag: None,
        }
    };
    assert_eq!(
        editor.error_code(FixtureEditorCommand::OpenDraft {
            source: DraftSource::Duplicate(built_in)
        }),
        "fixture_editor.unsupported_source"
    );
}

/// Channel edits on a library file move only the addresses behind the edited channel, keeping gaps.
#[test]
fn channel_edits_keep_address_gaps() {
    let mut editor = EditorApp::with_library(|dir| {
        GdtfBuilder::new("Acme", "Gap")
            .geometry(GeometrySpec::generic("Body"))
            .mode(
                ModeSpec::new("Basic", "Body")
                    .channel(ChannelSpec::new("Body", "Dimmer", &[1]))
                    .channel(ChannelSpec::new("Body", "Zoom", &[2]))
                    .channel(ChannelSpec::new("Body", "Focus1", &[5])),
            )
            .write_to(&dir.join("acme-gap.gdtf"));
    });
    let id = editor
        .open(DraftSource::Edit(FixtureLibraryEntry {
            make: "Acme".to_string(),
            model: "Gap".to_string(),
            asset_etag: None,
        }))
        .draft_id;
    /// Addresses of every channel of the first mode.
    fn offsets(view: &FixtureDraftView) -> Vec<Vec<u32>> {
        view.modes[0]
            .channels
            .iter()
            .map(|channel| channel.offset.clone())
            .collect()
    }

    let view = editor.edit(
        id,
        DraftEdit::SetChannelResolution {
            mode: 0,
            channel: 1,
            resolution: 2,
        },
    );
    assert_eq!(offsets(&view), [vec![1], vec![2, 3], vec![6]]);
    let view = editor.edit(
        id,
        DraftEdit::RemoveChannel {
            mode: 0,
            channel: 0,
        },
    );
    assert_eq!(offsets(&view), [vec![1, 2], vec![5]]);
    let view = editor.edit(
        id,
        DraftEdit::AddChannel {
            mode: 0,
            index: Some(1),
            attribute: "Shutter1".to_string(),
            resolution: 1,
        },
    );
    assert_eq!(offsets(&view), [vec![1, 2], vec![3], vec![6]]);
    let view = editor.edit(
        id,
        DraftEdit::MoveChannel {
            mode: 0,
            from: 1,
            to: 0,
        },
    );
    assert_eq!(offsets(&view), [vec![1], vec![2, 3], vec![6]]);
}

/// An edit made against an outdated version is rejected, and the current version is accepted.
#[test]
fn stale_edits_are_rejected() {
    let mut editor = EditorApp::new();
    let opened = editor.open(DraftSource::Template(DraftTemplate::Rgb));
    let edited = editor.edit(
        opened.draft_id,
        DraftEdit::RemoveChannel {
            mode: 0,
            channel: 0,
        },
    );
    assert_eq!(edited.version, opened.version + 1);
    assert_eq!(
        editor.error_code(FixtureEditorCommand::EditDraft {
            draft_id: opened.draft_id,
            base_version: Some(opened.version),
            edit: DraftEdit::RemoveChannel {
                mode: 0,
                channel: 0
            },
        }),
        "fixture_editor.stale_draft"
    );
    let view: FixtureDraftView = editor.output(FixtureEditorCommand::EditDraft {
        draft_id: opened.draft_id,
        base_version: Some(edited.version),
        edit: DraftEdit::RemoveChannel {
            mode: 0,
            channel: 0,
        },
    });
    assert_eq!(view.modes[0].channels.len(), 1);
}

/// Ranges cannot select wheel slots the function's wheel lacks, and shrinking a wheel flags the ranges left behind.
#[test]
fn wheel_slots_are_checked() {
    let mut editor = EditorApp::new();
    let id = editor
        .open(DraftSource::Template(DraftTemplate::MovingHead))
        .draft_id;
    assert_eq!(
        editor.error_code(FixtureEditorCommand::EditDraft {
            draft_id: id,
            base_version: None,
            edit: DraftEdit::SetFunctionSets {
                mode: 0,
                channel: 4,
                function: 0,
                sets: vec![super::DraftSetFields {
                    name: "Missing".to_string(),
                    dmx_from: 0,
                    wheel_slot: Some(9),
                }],
            },
        }),
        "fixture_editor.invalid_edit"
    );
    let view = editor.edit(
        id,
        DraftEdit::SetWheelSlots {
            wheel: 0,
            slots: vec![super::DraftSlotFields {
                name: "Open".to_string(),
                color: None,
            }],
        },
    );
    assert!(view.problems.iter().any(|problem| {
        problem.severity == ProblemSeverity::Error
            && problem.message.contains("missing wheel slots")
    }));
}
