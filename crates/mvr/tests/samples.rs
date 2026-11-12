// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Reads real MVR exports from Capture and Vectorworks.
//!
//! The files embed third-party GDTF files and venue models, so they are not committed.
//! `pnpm run mvr:samples` downloads them at a pinned commit, checks their hashes and
//! runs these tests with `NIGHTFALL_MVR_SAMPLES_DIR` pointing at them.

use std::collections::HashSet;
use std::fs::File;
use std::path::PathBuf;

use nightfall_mvr::prelude::*;

/// Opens a sample from the directory `pnpm run mvr:samples` downloads into.
fn open_sample(name: &str) -> MvrArchive<File> {
    let dir = std::env::var_os("NIGHTFALL_MVR_SAMPLES_DIR")
        .map(PathBuf::from)
        .expect(
            "NIGHTFALL_MVR_SAMPLES_DIR must point at the MVR samples; run `pnpm run mvr:samples`",
        );
    let file = File::open(dir.join(name)).expect("sample file is present");
    MvrArchive::open(file).expect("sample opens")
}

/// Checks that every fixture's GDTF file and every model file named by the scene is in
/// the archive and readable, and that every symbol instance has a definition.
fn assert_resources_resolve(archive: &mut MvrArchive<File>) {
    let scene = archive.scene();
    let gdtf_specs: HashSet<String> = scene
        .placed_fixtures()
        .iter()
        .filter_map(|placed| placed.fixture()?.gdtf_spec.clone())
        .collect();
    let mut model_files = HashSet::new();
    let mut add_geometry = |geometries: &Geometries| {
        for node in &geometries.nodes {
            match node {
                GeometryNode::Geometry3D(model) => {
                    model_files.insert(model.file_name.clone());
                }
                GeometryNode::Symbol(symbol) => {
                    assert!(
                        scene.symdef(symbol.symdef).is_some(),
                        "symbol {} has no definition",
                        symbol.uuid
                    );
                }
                GeometryNode::Other => {}
            }
        }
    };
    for symdef in scene.symdefs() {
        add_geometry(&symdef.geometries);
    }
    for placed in scene.placed_objects() {
        match placed.node {
            SceneNode::SceneObject(object)
            | SceneNode::FocusPoint(object)
            | SceneNode::Truss(object)
            | SceneNode::Support(object)
            | SceneNode::VideoScreen(object)
            | SceneNode::Projector(object) => add_geometry(&object.geometries),
            _ => {}
        }
    }

    for spec in &gdtf_specs {
        let name = archive
            .find_gdtf(spec)
            .unwrap_or_else(|| panic!("GDTF {spec} is in the archive"))
            .to_string();
        let gdtf = archive.read_file(&name).expect("GDTF reads");
        assert!(gdtf.starts_with(b"PK"), "{name} is a zip archive");
    }
    for file in &model_files {
        assert!(
            archive.find_file(file).is_some(),
            "model {file} is in the archive"
        );
    }
}

/// The Capture demo show reads in full: 76 fixtures of five GDTF types with fixture IDs
/// and addresses from universe 2, trusses, groups and the venue model.
#[test]
#[ignore = "requires NIGHTFALL_MVR_SAMPLES_DIR"]
fn reads_capture_demo_show() {
    let mut archive = open_sample("capture_demo_show.mvr");
    assert_eq!(
        (
            archive.description().ver_major,
            archive.description().ver_minor
        ),
        (1, 4)
    );
    assert!(archive.warnings().is_empty(), "{:?}", archive.warnings());

    let scene = archive.scene();
    assert_eq!(scene.layers.layers.len(), 11);
    let placed = scene.placed_objects();
    let count = |matches: fn(&SceneNode) -> bool| {
        placed.iter().filter(|placed| matches(placed.node)).count()
    };
    assert_eq!(count(|node| matches!(node, SceneNode::Truss(_))), 13);
    assert_eq!(count(|node| matches!(node, SceneNode::GroupObject(_))), 63);
    assert_eq!(
        count(|node| matches!(node, SceneNode::SceneObject(_))),
        2078
    );

    let fixtures = scene.placed_fixtures();
    assert_eq!(fixtures.len(), 76);
    let gdtf_types: HashSet<_> = fixtures
        .iter()
        .filter_map(|placed| placed.fixture()?.gdtf_spec.as_deref())
        .collect();
    assert_eq!(gdtf_types.len(), 5);

    let ids: HashSet<_> = fixtures
        .iter()
        .map(|placed| placed.fixture().unwrap().numeric_id().expect("numbered"))
        .collect();
    assert_eq!(ids.len(), 76, "fixture IDs are unique");

    let first = fixtures[0].fixture().unwrap();
    assert_eq!(first.numeric_id(), Some(11));
    assert_eq!(
        first.addresses(),
        vec![Ok(FixtureAddress {
            dmx_break: 0,
            address: Some(DmxAddress {
                universe: 2,
                channel: 1
            }),
        })]
    );
    for placed in &fixtures {
        let fixture = placed.fixture().unwrap();
        assert!(fixture.gdtf_mode.is_some(), "{} has a mode", fixture.name);
        for address in fixture.addresses() {
            let address = address.expect("address parses");
            assert!(address.address.is_some(), "{} is patched", fixture.name);
        }
        assert!(
            placed.world.origin.iter().all(|value| value.is_finite()),
            "{} has a finite position",
            fixture.name
        );
    }

    assert_resources_resolve(&mut archive);
}

/// The Vectorworks theatre plan reads: unpatched, unnumbered fixtures aimed at focus
/// points, a GDTF named without its extension, and scene objects with GLB models.
#[test]
#[ignore = "requires NIGHTFALL_MVR_SAMPLES_DIR"]
fn reads_vectorworks_scene_objects() {
    let mut archive = open_sample("scene_objects.mvr");
    assert_eq!(archive.description().provider_name(), Some("Vectorworks"));
    assert!(archive.warnings().is_empty(), "{:?}", archive.warnings());

    let scene = archive.scene();
    assert_eq!(scene.classes().count(), 5);
    let placed = scene.placed_objects();
    let focus_points: HashSet<_> = placed
        .iter()
        .filter_map(|placed| match placed.node {
            SceneNode::FocusPoint(point) => Some(point.uuid),
            _ => None,
        })
        .collect();
    assert_eq!(focus_points.len(), 72);
    let scene_objects = placed
        .iter()
        .filter(|placed| matches!(placed.node, SceneNode::SceneObject(_)))
        .count();
    assert_eq!(scene_objects, 28);

    let fixtures = scene.placed_fixtures();
    assert_eq!(fixtures.len(), 72);
    for placed in &fixtures {
        let fixture = placed.fixture().unwrap();
        assert_eq!(fixture.numeric_id(), None);
        assert_eq!(
            fixture.addresses(),
            vec![Ok(FixtureAddress {
                dmx_break: 0,
                address: None
            })]
        );
        let focus = fixture.focus.expect("aimed at a focus point");
        assert!(focus_points.contains(&focus));
        assert!(fixture.class.and_then(|uuid| scene.class(uuid)).is_some());
    }
    let spec = fixtures[0].fixture().unwrap().gdtf_spec.clone().unwrap();
    assert_eq!(spec, "Custom@Light Instr Light Source Pendant 44deg");
    assert_eq!(
        archive.find_gdtf(&spec),
        Some("Custom@Light Instr Light Source Pendant 44deg.gdtf")
    );

    assert_resources_resolve(&mut archive);
}

/// The single Vectorworks LED PAR has four DMX breaks, none patched.
#[test]
#[ignore = "requires NIGHTFALL_MVR_SAMPLES_DIR"]
fn reads_vectorworks_basic_fixture() {
    let mut archive = open_sample("basic_fixture.mvr");
    let fixtures = archive.scene().placed_fixtures();
    assert_eq!(fixtures.len(), 1);
    let fixture = fixtures[0].fixture().unwrap();
    let breaks: Vec<_> = fixture
        .addresses()
        .into_iter()
        .map(|address| address.expect("address parses"))
        .collect();
    assert_eq!(
        breaks
            .iter()
            .map(|address| (address.dmx_break, address.address))
            .collect::<Vec<_>>(),
        [(0, None), (1, None), (2, None), (3, None)]
    );
    assert_eq!(
        fixture.unmodelled_features(),
        ["CustomCommands", "Mappings"]
    );
    assert_eq!(fixtures[0].world.origin, [5000.0, 5000.0, 5000.0]);

    assert_resources_resolve(&mut archive);
}
