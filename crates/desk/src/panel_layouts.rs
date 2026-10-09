// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Edits to the showfile's shared named panel layouts.
//!
//! Each command changes one layout or the switcher order, so devices editing different layouts
//! at the same time never overwrite each other's changes.

use nightfall_engine::prelude::CommandError;

use crate::settings::{
    DeskSettings, PanelLayoutArrangement, PanelLayoutRename, PanelLayoutVisibility,
    StoredPanelLayout,
};

/// Adds a new named layout at the end of the list.
pub(crate) fn create(
    settings: &mut DeskSettings,
    layout: &StoredPanelLayout,
) -> Result<(), CommandError> {
    if layout.name.trim().is_empty() {
        return Err(empty_name());
    }
    if settings
        .panel_layouts
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
    settings.panel_layouts.push(layout);
    Ok(())
}

/// Replaces the saved arrangement of one layout, keeping its name and visibility.
pub(crate) fn save_arrangement(
    settings: &mut DeskSettings,
    arrangement: &PanelLayoutArrangement,
    now_ms: f64,
) -> Result<(), CommandError> {
    let layout = find_mut(settings, &arrangement.id)?;
    layout.version = arrangement.version;
    layout.layout = arrangement.layout.clone();
    layout.panels = arrangement.panels.clone();
    layout.updated_at = now_ms;
    Ok(())
}

/// Renames one layout.
pub(crate) fn rename(
    settings: &mut DeskSettings,
    rename: &PanelLayoutRename,
    now_ms: f64,
) -> Result<(), CommandError> {
    let name = rename.name.trim();
    if name.is_empty() {
        return Err(empty_name());
    }
    let layout = find_mut(settings, &rename.id)?;
    layout.name = name.to_string();
    layout.updated_at = now_ms;
    Ok(())
}

/// Shows or hides one layout in the switcher.
///
/// Hiding the default layout also clears the default, so devices opening the show do not
/// bring a layout back into everyone's switcher after someone hid it.
pub(crate) fn set_visibility(
    settings: &mut DeskSettings,
    visibility: &PanelLayoutVisibility,
) -> Result<(), CommandError> {
    find_mut(settings, &visibility.id)?.shown_in_switcher = visibility.shown_in_switcher;
    if !visibility.shown_in_switcher
        && settings.default_panel_layout_id.as_deref() == Some(visibility.id.as_str())
    {
        settings.default_panel_layout_id = None;
    }
    Ok(())
}

/// Removes one layout and clears the default layout when it pointed at it.
pub(crate) fn delete(settings: &mut DeskSettings, id: &str) -> Result<(), CommandError> {
    find_mut(settings, id)?;
    settings.panel_layouts.retain(|layout| layout.id != id);
    if settings.default_panel_layout_id.as_deref() == Some(id) {
        settings.default_panel_layout_id = None;
    }
    Ok(())
}

/// Puts the shown layouts in the given order, leaving hidden layouts at their positions.
///
/// The ids must name exactly the layouts currently shown, so a reorder computed from a stale
/// list is rejected instead of silently dropping or duplicating layouts.
pub(crate) fn reorder(settings: &mut DeskSettings, ids: &[String]) -> Result<(), CommandError> {
    let shown: Vec<&str> = settings
        .panel_layouts
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
        settings
            .panel_layouts
            .iter()
            .find(|layout| &layout.id == id)
            .cloned()
            .expect("validated ids name shown layouts")
    });
    let layouts = settings
        .panel_layouts
        .iter()
        .map(|layout| {
            if layout.shown_in_switcher {
                ordered.next().expect("one ordered layout per shown slot")
            } else {
                layout.clone()
            }
        })
        .collect();
    settings.panel_layouts = layouts;
    Ok(())
}

/// Sets or clears the layout devices open when they have no arrangement for this showfile.
///
/// A hidden layout chosen as the default is shown again, since every device may open it.
pub(crate) fn set_default(
    settings: &mut DeskSettings,
    id: Option<&str>,
) -> Result<(), CommandError> {
    if let Some(id) = id {
        find_mut(settings, id)?.shown_in_switcher = true;
    }
    settings.default_panel_layout_id = id.map(str::to_string);
    Ok(())
}

/// Returns the layout with the given id, or a not-found error naming it.
fn find_mut<'a>(
    settings: &'a mut DeskSettings,
    id: &str,
) -> Result<&'a mut StoredPanelLayout, CommandError> {
    settings
        .panel_layouts
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
        }
    }

    /// Builds settings holding the given layouts in order.
    fn settings_with(layouts: Vec<StoredPanelLayout>) -> DeskSettings {
        DeskSettings {
            panel_layouts: layouts,
            ..DeskSettings::default()
        }
    }

    /// Returns layout ids in list order.
    fn ids(settings: &DeskSettings) -> Vec<&str> {
        settings
            .panel_layouts
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

        assert_eq!(settings.panel_layouts[0].name, "Front of house");
        assert_eq!(settings.panel_layouts[0].updated_at, 5.0);
        assert_eq!(settings.panel_layouts[1].layout, json!({ "grid": 1 }));
        assert_eq!(settings.panel_layouts[1].name, "Layout b");
        assert_eq!(settings.panel_layouts[1].updated_at, 6.0);
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
        assert_eq!(settings.default_panel_layout_id.as_deref(), Some("a"));
        delete(&mut settings, "a").unwrap();
        assert_eq!(settings.default_panel_layout_id, None);
        assert!(settings.panel_layouts.is_empty());
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
        assert!(settings.panel_layouts[0].shown_in_switcher);
        assert!(!settings.panel_layouts[1].shown_in_switcher);
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
        assert_eq!(settings.default_panel_layout_id, None);

        set_default(&mut settings, Some("b")).unwrap();
        assert_eq!(settings.default_panel_layout_id.as_deref(), Some("b"));
        assert!(settings.panel_layouts[1].shown_in_switcher);
    }
}
