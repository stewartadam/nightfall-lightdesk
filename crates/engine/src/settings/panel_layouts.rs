// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! The showfile's shared named panel layouts and the commands that edit them.
//!
//! Each command changes one layout or the switcher order, so devices editing different layouts
//! at the same time never overwrite each other's changes.

use std::borrow::Cow;

use bevy_app::App;
use bevy_ecs::prelude::Resource;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{SettingsAppExt, SettingsSection};
use crate::prelude::{CommandError, EnginePayload, IngressCommand};
use crate::protocol::engine_command::EngineIngressMeta;

/// Serialized Dockview panel metadata stored alongside a named panel layout.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub struct StoredPanelLayoutPanel {
    /// Stable panel id inside the serialized Dockview layout.
    pub id: String,
    /// User-visible panel title captured when the layout was stored.
    pub title: String,
    /// Panel parameters needed by Dockview to restore component state.
    #[typeshare(serialized_as = "unknown")]
    pub params: Value,
}

/// Panel arrangement a device saves into one named layout from its working copy.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub struct PanelLayoutArrangement {
    /// Named layout receiving the arrangement.
    pub id: String,
    /// Layout storage format version.
    pub version: u32,
    /// Opaque Dockview layout payload.
    #[typeshare(serialized_as = "unknown")]
    pub layout: Value,
    /// Panel metadata captured with the arrangement.
    pub panels: Vec<StoredPanelLayoutPanel>,
}

/// New user-visible name for one named layout.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub struct PanelLayoutRename {
    /// Named layout to rename.
    pub id: String,
    /// New user-visible name; surrounding whitespace is trimmed.
    pub name: String,
}

/// Whether one named layout appears in the layout switcher.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub struct PanelLayoutVisibility {
    /// Named layout to show or hide.
    pub id: String,
    /// Whether the layout is listed in the switcher.
    pub shown_in_switcher: bool,
}

/// Serialized Dockview panel layout that is named and saved with the showfile.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[typeshare::typeshare]
#[serde(rename_all = "camelCase")]
pub struct StoredPanelLayout {
    /// Whether this layout is shown in the switcher; list order defines its position.
    #[serde(default = "default_layout_shown_in_switcher")]
    pub shown_in_switcher: bool,
    /// Stable layout id used by the UI command palette and layout manager.
    pub id: String,
    /// User-visible layout name.
    pub name: String,
    /// Layout storage format version.
    pub version: u32,
    /// Opaque Dockview layout payload.
    #[typeshare(serialized_as = "unknown")]
    pub layout: Value,
    /// Panel metadata captured when the layout was stored.
    pub panels: Vec<StoredPanelLayoutPanel>,
    /// Layout creation timestamp in milliseconds since Unix epoch.
    pub created_at: f64,
    /// Last layout update timestamp in milliseconds since Unix epoch.
    pub updated_at: f64,
    /// Whether this layout lives only for the current session and is left out of saved showfiles,
    /// such as the layout the welcome guide runs lessons in.
    #[serde(default)]
    pub transient: bool,
}

/// Keeps saved layouts discoverable when the showfile predates explicit switcher visibility.
fn default_layout_shown_in_switcher() -> bool {
    true
}

/// The showfile's named panel layouts, in switcher order.
#[derive(Resource, Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[typeshare::typeshare]
#[serde(default)]
pub struct PanelLayouts {
    /// Named layouts; shown layouts appear in the switcher in this order.
    pub layouts: Vec<StoredPanelLayout>,
    /// Named layout a device opens when it has no arrangement of its own for this showfile.
    pub default_layout_id: Option<String>,
}

impl PanelLayouts {
    /// Section the layouts are saved and sent under; saves leave out transient layouts.
    pub const SECTION: SettingsSection<Self> =
        SettingsSection::new("panelLayouts").saved_as(Self::for_showfile);

    /// Returns the layouts as a showfile stores them: without transient layouts, and without a
    /// default layout that is one, so the show reopens in a layout it keeps.
    pub fn for_showfile(&self) -> Cow<'_, Self> {
        let transient: Vec<&str> = self
            .layouts
            .iter()
            .filter(|layout| layout.transient)
            .map(|layout| layout.id.as_str())
            .collect();
        if transient.is_empty() {
            return Cow::Borrowed(self);
        }
        let mut saved = self.clone();
        saved.layouts.retain(|layout| !layout.transient);
        if saved
            .default_layout_id
            .as_deref()
            .is_some_and(|id| transient.contains(&id))
        {
            saved.default_layout_id = None;
        }
        Cow::Owned(saved)
    }
}

/// Commands that edit [`PanelLayouts`].
#[derive(Debug, Clone, Serialize, Deserialize, EnginePayload)]
#[typeshare::typeshare]
#[serde(tag = "type", content = "data")]
#[serde(deny_unknown_fields)]
pub enum PanelLayoutCommand {
    /// Add a named layout to the showfile; its id must not already exist.
    Create(StoredPanelLayout),
    /// Replace the saved arrangement of one named layout.
    SaveArrangement(PanelLayoutArrangement),
    /// Rename one named layout.
    Rename(PanelLayoutRename),
    /// Show or hide one named layout in the layout switcher.
    SetVisibility(PanelLayoutVisibility),
    /// Remove one named layout, clearing the default layout if it pointed there.
    Delete(String),
    /// Reorder the layouts shown in the switcher; hidden layouts keep their positions.
    Reorder(Vec<String>),
    /// Set the named layout devices open when they have no arrangement for this showfile.
    SetDefault(Option<String>),
}

impl IngressCommand for PanelLayoutCommand {}

/// Returns wall-clock milliseconds since the Unix epoch for layout timestamps.
fn now_ms() -> f64 {
    web_time::SystemTime::now()
        .duration_since(web_time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as f64)
        .unwrap_or(0.0)
}

/// Applies one layout edit, rejecting edits that name a missing layout or leave one unnamed.
fn apply(command: &PanelLayoutCommand, layouts: &mut PanelLayouts) -> Result<(), CommandError> {
    match command {
        PanelLayoutCommand::Create(layout) => create(layouts, layout),
        PanelLayoutCommand::SaveArrangement(arrangement) => {
            save_arrangement(layouts, arrangement, now_ms())
        }
        PanelLayoutCommand::Rename(name) => rename(layouts, name, now_ms()),
        PanelLayoutCommand::SetVisibility(visibility) => set_visibility(layouts, visibility),
        PanelLayoutCommand::Delete(id) => delete(layouts, id),
        PanelLayoutCommand::Reorder(ids) => reorder(layouts, ids),
        PanelLayoutCommand::SetDefault(id) => set_default(layouts, id.as_deref()),
    }
}

/// The `type` tag of every [`PanelLayoutCommand`] variant.
const LAYOUT_COMMAND_TYPES: [&str; 7] = [
    "Create",
    "SaveArrangement",
    "Rename",
    "SetVisibility",
    "Delete",
    "Reorder",
    "SetDefault",
];

/// Registers the layouts section and its command.
///
/// Layout edits stay allowed on a read-only engine: they only arrange panels, the web UI makes
/// them on its own whenever a show opens without layouts or panels move, and a backup's operator
/// still arranges panels to watch the show. The next copy from the primary replaces them.
pub(super) fn build(app: &mut App) {
    app.register_settings_section(PanelLayouts::SECTION);
    app.add_settings_command(apply);
    for command_type in LAYOUT_COMMAND_TYPES {
        crate::client_ingress::allow_command_while_read_only(
            app,
            PanelLayoutCommand::COMMAND_MODULE,
            command_type,
        );
    }
}

/// Adds a new named layout at the end of the list.
fn create(layouts: &mut PanelLayouts, layout: &StoredPanelLayout) -> Result<(), CommandError> {
    if layout.name.trim().is_empty() {
        return Err(empty_name());
    }
    if layouts
        .layouts
        .iter()
        .any(|existing| existing.id == layout.id)
    {
        return Err(CommandError::new(
            "panel_layout.duplicate_id",
            format!("A layout with id {} already exists", layout.id),
        ));
    }
    let mut layout = layout.clone();
    layout.name = layout.name.trim().to_string();
    layouts.layouts.push(layout);
    Ok(())
}

/// Replaces the saved arrangement of one layout, keeping its name and visibility.
fn save_arrangement(
    layouts: &mut PanelLayouts,
    arrangement: &PanelLayoutArrangement,
    now_ms: f64,
) -> Result<(), CommandError> {
    let layout = find_mut(layouts, &arrangement.id)?;
    layout.version = arrangement.version;
    layout.layout = arrangement.layout.clone();
    layout.panels = arrangement.panels.clone();
    layout.updated_at = now_ms;
    Ok(())
}

/// Renames one layout.
fn rename(
    layouts: &mut PanelLayouts,
    rename: &PanelLayoutRename,
    now_ms: f64,
) -> Result<(), CommandError> {
    let name = rename.name.trim();
    if name.is_empty() {
        return Err(empty_name());
    }
    let layout = find_mut(layouts, &rename.id)?;
    layout.name = name.to_string();
    layout.updated_at = now_ms;
    Ok(())
}

/// Shows or hides one layout in the switcher.
///
/// Hiding the default layout also clears the default, so devices opening the show do not
/// bring a layout back into everyone's switcher after someone hid it.
fn set_visibility(
    layouts: &mut PanelLayouts,
    visibility: &PanelLayoutVisibility,
) -> Result<(), CommandError> {
    find_mut(layouts, &visibility.id)?.shown_in_switcher = visibility.shown_in_switcher;
    if !visibility.shown_in_switcher
        && layouts.default_layout_id.as_deref() == Some(visibility.id.as_str())
    {
        layouts.default_layout_id = None;
    }
    Ok(())
}

/// Removes one layout and clears the default layout when it pointed at it.
fn delete(layouts: &mut PanelLayouts, id: &str) -> Result<(), CommandError> {
    find_mut(layouts, id)?;
    layouts.layouts.retain(|layout| layout.id != id);
    if layouts.default_layout_id.as_deref() == Some(id) {
        layouts.default_layout_id = None;
    }
    Ok(())
}

/// Puts the shown layouts in the given order, leaving hidden layouts at their positions.
///
/// The ids must name exactly the layouts currently shown, so a reorder computed from a stale
/// list is rejected instead of silently dropping or duplicating layouts.
fn reorder(layouts: &mut PanelLayouts, ids: &[String]) -> Result<(), CommandError> {
    let shown: Vec<&str> = layouts
        .layouts
        .iter()
        .filter(|layout| layout.shown_in_switcher)
        .map(|layout| layout.id.as_str())
        .collect();
    let mut requested: Vec<&str> = ids.iter().map(String::as_str).collect();
    let mut current = shown.clone();
    requested.sort_unstable();
    current.sort_unstable();
    if requested != current {
        return Err(CommandError::new(
            "panel_layout.stale_order",
            "The layout list changed while reordering; try again",
        ));
    }
    let mut ordered = ids.iter().map(|id| {
        layouts
            .layouts
            .iter()
            .find(|layout| &layout.id == id)
            .cloned()
            .expect("validated ids name shown layouts")
    });
    let reordered = layouts
        .layouts
        .iter()
        .map(|layout| {
            if layout.shown_in_switcher {
                ordered.next().expect("one ordered layout per shown slot")
            } else {
                layout.clone()
            }
        })
        .collect();
    layouts.layouts = reordered;
    Ok(())
}

/// Sets or clears the layout devices open when they have no arrangement for this showfile.
///
/// A hidden layout chosen as the default is shown again, since every device may open it.
fn set_default(layouts: &mut PanelLayouts, id: Option<&str>) -> Result<(), CommandError> {
    if let Some(id) = id {
        find_mut(layouts, id)?.shown_in_switcher = true;
    }
    layouts.default_layout_id = id.map(str::to_string);
    Ok(())
}

/// Returns the layout with the given id, or a not-found error naming it.
fn find_mut<'a>(
    layouts: &'a mut PanelLayouts,
    id: &str,
) -> Result<&'a mut StoredPanelLayout, CommandError> {
    layouts
        .layouts
        .iter_mut()
        .find(|layout| layout.id == id)
        .ok_or_else(|| {
            CommandError::new(
                "panel_layout.not_found",
                format!("No layout with id {id} exists"),
            )
        })
}

/// Error for a create or rename that would leave a layout without a name.
fn empty_name() -> CommandError {
    CommandError::new("panel_layout.empty_name", "Layout names cannot be empty")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// Builds a layout with distinct id, name and visibility for list-editing tests.
    fn layout(id: &str, shown: bool) -> StoredPanelLayout {
        StoredPanelLayout {
            shown_in_switcher: shown,
            id: id.to_string(),
            name: format!("Layout {id}"),
            version: 2,
            layout: json!({}),
            panels: Vec::new(),
            created_at: 1.0,
            updated_at: 1.0,
            transient: false,
        }
    }

    /// Builds a layout list holding the given layouts in order.
    fn settings_with(layouts: Vec<StoredPanelLayout>) -> PanelLayouts {
        PanelLayouts {
            layouts,
            default_layout_id: None,
        }
    }

    /// Returns layout ids in list order.
    fn ids(settings: &PanelLayouts) -> Vec<&str> {
        settings
            .layouts
            .iter()
            .map(|layout| layout.id.as_str())
            .collect()
    }

    /// Two devices editing different layouts both keep their changes.
    #[test]
    fn edits_to_different_layouts_do_not_overwrite_each_other() {
        let mut settings = settings_with(vec![layout("a", true), layout("b", true)]);
        rename(
            &mut settings,
            &PanelLayoutRename {
                id: "a".into(),
                name: " Front of house ".into(),
            },
            5.0,
        )
        .unwrap();
        save_arrangement(
            &mut settings,
            &PanelLayoutArrangement {
                id: "b".into(),
                version: 3,
                layout: json!({ "grid": 1 }),
                panels: Vec::new(),
            },
            6.0,
        )
        .unwrap();

        assert_eq!(settings.layouts[0].name, "Front of house");
        assert_eq!(settings.layouts[0].updated_at, 5.0);
        assert_eq!(settings.layouts[1].layout, json!({ "grid": 1 }));
        assert_eq!(settings.layouts[1].name, "Layout b");
        assert_eq!(settings.layouts[1].updated_at, 6.0);
    }

    /// Creating a layout with an id that already exists is rejected.
    #[test]
    fn create_rejects_duplicate_ids_and_empty_names() {
        let mut settings = settings_with(vec![layout("a", true)]);
        assert_eq!(
            create(&mut settings, &layout("a", true)).unwrap_err().code,
            "panel_layout.duplicate_id"
        );
        let mut unnamed = layout("b", true);
        unnamed.name = "  ".into();
        assert_eq!(
            create(&mut settings, &unnamed).unwrap_err().code,
            "panel_layout.empty_name"
        );
        create(&mut settings, &layout("c", false)).unwrap();
        assert_eq!(ids(&settings), ["a", "c"]);
    }

    /// Reordering moves only shown layouts and rejects an order built from a stale list.
    #[test]
    fn reorder_keeps_hidden_layouts_in_place() {
        let mut settings = settings_with(vec![
            layout("a", true),
            layout("hidden", false),
            layout("b", true),
            layout("c", true),
        ]);
        reorder(&mut settings, &["c".into(), "a".into(), "b".into()]).unwrap();
        assert_eq!(ids(&settings), ["c", "hidden", "a", "b"]);

        let stale = reorder(&mut settings, &["a".into(), "b".into()]).unwrap_err();
        assert_eq!(stale.code, "panel_layout.stale_order");
        assert_eq!(ids(&settings), ["c", "hidden", "a", "b"]);
    }

    /// Deleting the default layout clears the default, and defaults must name a layout.
    #[test]
    fn default_layout_follows_deletion() {
        let mut settings = settings_with(vec![layout("a", true), layout("b", true)]);
        assert_eq!(
            set_default(&mut settings, Some("missing"))
                .unwrap_err()
                .code,
            "panel_layout.not_found"
        );
        set_default(&mut settings, Some("a")).unwrap();
        delete(&mut settings, "b").unwrap();
        assert_eq!(settings.default_layout_id.as_deref(), Some("a"));
        delete(&mut settings, "a").unwrap();
        assert_eq!(settings.default_layout_id, None);
        assert!(settings.layouts.is_empty());
    }

    /// Visibility changes touch only the named layout.
    #[test]
    fn visibility_changes_one_layout() {
        let mut settings = settings_with(vec![layout("a", true), layout("b", true)]);
        set_visibility(
            &mut settings,
            &PanelLayoutVisibility {
                id: "b".into(),
                shown_in_switcher: false,
            },
        )
        .unwrap();
        assert!(settings.layouts[0].shown_in_switcher);
        assert!(!settings.layouts[1].shown_in_switcher);
    }

    /// The default layout is always shown: hiding it clears the default, and choosing a hidden
    /// layout as the default shows it again.
    #[test]
    fn default_layout_stays_shown() {
        let mut settings = settings_with(vec![layout("a", true), layout("b", false)]);
        set_default(&mut settings, Some("a")).unwrap();
        set_visibility(
            &mut settings,
            &PanelLayoutVisibility {
                id: "a".into(),
                shown_in_switcher: false,
            },
        )
        .unwrap();
        assert_eq!(settings.default_layout_id, None);

        set_default(&mut settings, Some("b")).unwrap();
        assert_eq!(settings.default_layout_id.as_deref(), Some("b"));
        assert!(settings.layouts[1].shown_in_switcher);
    }

    /// The web UI clears the default layout by omitting the payload, which must read as no layout.
    #[test]
    fn clearing_the_default_layout_needs_no_payload() {
        let command: PanelLayoutCommand =
            serde_json::from_value(json!({ "type": "SetDefault" })).unwrap();
        assert!(matches!(command, PanelLayoutCommand::SetDefault(None)));
    }

    /// Saved layouts without visibility metadata remain accessible, while explicit hiding
    /// survives a round trip.
    #[test]
    fn saved_layout_visibility_defaults_to_shown() {
        let value = json!({
            "id": "saved", "name": "Saved layout", "version": 2,
            "layout": { "panels": {}, "grid": {} }, "panels": [],
            "createdAt": 1, "updatedAt": 1
        });
        let mut layout: StoredPanelLayout = serde_json::from_value(value).unwrap();
        assert!(layout.shown_in_switcher);
        layout.shown_in_switcher = false;
        let restored: StoredPanelLayout =
            serde_json::from_value(serde_json::to_value(layout).unwrap()).unwrap();
        assert!(!restored.shown_in_switcher);
    }

    /// Commands build the layout list, order and default, and a refused edit changes nothing.
    #[test]
    fn commands_edit_layouts_and_refusals_change_nothing() {
        let mut settings = PanelLayouts::default();
        for command in [
            PanelLayoutCommand::Create(layout("second", true)),
            PanelLayoutCommand::Create(layout("hidden", true)),
            PanelLayoutCommand::Create(layout("first", true)),
            PanelLayoutCommand::SetVisibility(PanelLayoutVisibility {
                id: "hidden".into(),
                shown_in_switcher: false,
            }),
            PanelLayoutCommand::Reorder(vec!["first".into(), "second".into()]),
            PanelLayoutCommand::SetDefault(Some("first".into())),
        ] {
            apply(&command, &mut settings).unwrap();
        }
        assert_eq!(ids(&settings), ["first", "hidden", "second"]);
        assert_eq!(settings.default_layout_id.as_deref(), Some("first"));

        let before = settings.clone();
        let rename = PanelLayoutCommand::Rename(PanelLayoutRename {
            id: "missing".into(),
            name: "Renamed".into(),
        });
        assert!(apply(&rename, &mut settings).is_err());
        assert!(
            apply(
                &PanelLayoutCommand::Create(layout("first", false)),
                &mut settings
            )
            .is_err()
        );
        assert_eq!(settings, before);
    }

    /// Saves leave out transient layouts and a default that points at one.
    #[test]
    fn saved_form_drops_transient_layouts() {
        let mut lesson = layout("lesson", true);
        lesson.transient = true;
        let mut settings = settings_with(vec![layout("a", true), lesson]);
        settings.default_layout_id = Some("lesson".into());

        let saved = settings.for_showfile();
        assert_eq!(ids(&saved), ["a"]);
        assert_eq!(saved.default_layout_id, None);

        settings.layouts.pop();
        settings.default_layout_id = Some("a".into());
        assert!(matches!(settings.for_showfile(), Cow::Borrowed(_)));
    }

    /// Every layout command variant is listed as allowed on a read-only engine; the exhaustive
    /// match stops a new variant from compiling until it is listed here too.
    #[test]
    fn every_layout_command_stays_allowed_while_read_only() {
        let commands = [
            PanelLayoutCommand::Create(layout("a", true)),
            PanelLayoutCommand::SaveArrangement(PanelLayoutArrangement {
                id: "a".into(),
                version: 2,
                layout: json!({}),
                panels: Vec::new(),
            }),
            PanelLayoutCommand::Rename(PanelLayoutRename {
                id: "a".into(),
                name: "A".into(),
            }),
            PanelLayoutCommand::SetVisibility(PanelLayoutVisibility {
                id: "a".into(),
                shown_in_switcher: false,
            }),
            PanelLayoutCommand::Delete("a".into()),
            PanelLayoutCommand::Reorder(vec!["a".into()]),
            PanelLayoutCommand::SetDefault(None),
        ];
        for command in &commands {
            match command {
                PanelLayoutCommand::Create(_)
                | PanelLayoutCommand::SaveArrangement(_)
                | PanelLayoutCommand::Rename(_)
                | PanelLayoutCommand::SetVisibility(_)
                | PanelLayoutCommand::Delete(_)
                | PanelLayoutCommand::Reorder(_)
                | PanelLayoutCommand::SetDefault(_) => {}
            }
            let value = serde_json::to_value(command).expect("layout command serializes");
            let command_type = value["type"]
                .as_str()
                .expect("layout command has a type tag");
            assert!(
                LAYOUT_COMMAND_TYPES.contains(&command_type),
                "{command_type}"
            );
        }
        assert_eq!(commands.len(), LAYOUT_COMMAND_TYPES.len());
    }
}
