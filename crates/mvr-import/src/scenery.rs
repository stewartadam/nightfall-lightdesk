// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Deciding what an import does with the rig's trusses, supports and other scenery.
//!
//! Each piece becomes a custom scene object whose model is a `.robj` bundle in the show's
//! own folder, named after the object and the model's fingerprint. A re-import compares
//! that name, so a scene object only changes when the file moved it or changed its model.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use nightfall_fixtures::prelude::FixturePlacement;
use nightfall_object_library::manager::encode_showfile_object_path;
use uuid::Uuid;

use crate::plan::same_placement;
use crate::preview::{RigImportOptions, RigSceneryKind, SceneryImportStatus, SceneryPreview};
use crate::rig::{RigFile, RigScenery};

/// A scene object already in the show, as the planner compares it with the file.
#[derive(Debug, Clone)]
pub struct ShowSceneObject {
    /// Scene object ID.
    pub id: u32,
    /// Label.
    pub label: String,
    /// Position and rotation.
    pub placement: FixturePlacement,
    /// Model path token of a custom object, if it is one.
    pub model_path: Option<String>,
}

/// The show's scene objects as the planner sees them.
#[derive(Debug, Clone, Default)]
pub struct ShowScenery {
    /// Scene object IDs in use.
    pub ids: HashSet<u32>,
    /// Scene objects by UID.
    pub objects: HashMap<Uuid, ShowSceneObject>,
}

/// A scene object the import adds or changes.
#[derive(Debug, Clone, PartialEq)]
pub struct PlannedScenery {
    /// Index into the rig's scenery.
    pub index: usize,
    /// Scene object ID.
    pub id: u32,
    /// Label, when it is new or renamed.
    pub label: Option<String>,
    /// Whether the scene object is already in the show.
    pub existing: bool,
    /// File name of the model bundle in the show's scene object folder.
    pub bundle: String,
    /// Model path token naming the bundle.
    pub model_path: String,
}

/// What the import does with the scenery: the preview rows and the objects to store.
#[derive(Debug, Clone, Default)]
pub struct SceneryPlan {
    /// One row per truss, support or layer of scenery, in file order.
    pub previews: Vec<SceneryPreview>,
    /// Scene objects to add or change.
    pub objects: Vec<PlannedScenery>,
}

/// Plans the scene objects for the rig's scenery against the show's scene objects.
///
/// New objects are numbered after the highest scene object ID in use. An object already in
/// the show is renamed only when the file names it, and moved or given the new model only
/// when it differs; with updates turned off it is left alone.
pub fn plan_scenery(rig: &RigFile, show: &ShowScenery, options: &RigImportOptions) -> SceneryPlan {
    let mut plan = SceneryPlan::default();
    let mut next_id = show.ids.iter().max().copied().unwrap_or(0);
    let mut counts: HashMap<&str, u32> = HashMap::new();
    for (index, scenery) in rig.scenery.iter().enumerate() {
        let label = scenery_label(scenery, &mut counts);
        let existing = show.objects.get(&scenery.uid);
        let mut preview = SceneryPreview {
            uid: scenery.uid,
            label: existing.map_or_else(|| label.clone(), |object| object.label.clone()),
            kind: scenery.kind,
            layer: scenery.layer.clone(),
            scene_object_id: existing.map(|object| object.id),
            triangles: scenery.model.as_ref().map_or(0, |model| {
                u32::try_from(model.triangles).unwrap_or(u32::MAX)
            }),
            status: SceneryImportStatus::New,
            changes: Vec::new(),
            warnings: scenery.warnings.clone(),
        };
        let Some(model) = &scenery.model else {
            preview.status = SceneryImportStatus::NoModel;
            plan.previews.push(preview);
            continue;
        };
        if !options.scenery {
            preview.status = SceneryImportStatus::Skipped;
            plan.previews.push(preview);
            continue;
        }
        let bundle = bundle_name(scenery.uid, &model.revision);
        let model_path = encode_showfile_object_path(Path::new(&bundle));
        match existing {
            Some(object) => {
                let rename = (!scenery.name.trim().is_empty() && label != object.label)
                    .then(|| label.clone());
                if let Some(label) = &rename {
                    preview.changes.push(format!("renamed to {label:?}"));
                }
                if !same_placement(&object.placement, &scenery.placement) {
                    preview.changes.push("moved".to_string());
                }
                if object.model_path.as_deref() != Some(model_path.as_str()) {
                    preview.changes.push("new model".to_string());
                }
                preview.status = if preview.changes.is_empty() {
                    SceneryImportStatus::Unchanged
                } else if options.update_existing {
                    plan.objects.push(PlannedScenery {
                        index,
                        id: object.id,
                        label: rename,
                        existing: true,
                        bundle,
                        model_path,
                    });
                    SceneryImportStatus::Update
                } else {
                    SceneryImportStatus::AlreadyInShow
                };
            }
            None => {
                next_id = next_id.saturating_add(1);
                preview.scene_object_id = Some(next_id);
                plan.objects.push(PlannedScenery {
                    index,
                    id: next_id,
                    label: Some(label),
                    existing: false,
                    bundle,
                    model_path,
                });
            }
        }
        plan.previews.push(preview);
    }
    plan
}

impl ShowScenery {
    /// Records what a planned import stores, so a later import in the same frame is planned
    /// against the show as it will be.
    pub fn apply(&mut self, rig: &RigFile, plan: &SceneryPlan) {
        for planned in &plan.objects {
            let scenery = &rig.scenery[planned.index];
            self.ids.insert(planned.id);
            let object = self
                .objects
                .entry(scenery.uid)
                .or_insert_with(|| ShowSceneObject {
                    id: planned.id,
                    label: String::new(),
                    placement: scenery.placement.clone(),
                    model_path: None,
                });
            if let Some(label) = &planned.label {
                object.label = label.clone();
            }
            object.placement = scenery.placement.clone();
            object.model_path = Some(planned.model_path.clone());
        }
    }
}

/// Names a scenery object: its name in the file, or what it is followed by a number when
/// the file leaves it unnamed ("Truss 3").
fn scenery_label<'a>(scenery: &'a RigScenery, counts: &mut HashMap<&'a str, u32>) -> String {
    let name = scenery.name.trim();
    if !name.is_empty() {
        return name.to_string();
    }
    let kind = match scenery.kind {
        RigSceneryKind::Truss => "Truss",
        RigSceneryKind::Support => "Support",
        RigSceneryKind::Layer => "Scenery",
    };
    let count = counts.entry(kind).or_default();
    *count += 1;
    format!("{kind} {count}")
}

/// Names a model bundle after the object and its model's fingerprint, so a changed model
/// gets a new file and an unchanged one keeps its name.
pub fn bundle_name(uid: Uuid, revision: &str) -> String {
    format!("mvr-{}-{revision}.robj", uid.simple())
}
