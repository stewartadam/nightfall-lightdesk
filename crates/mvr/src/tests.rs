// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Tests against hand-written scenes covering each MVR case the reader handles.

use std::io::{Cursor, Write};

use uuid::Uuid;
use zip::write::SimpleFileOptions;

use crate::prelude::*;

/// Builds an in-memory MVR archive from `(name, contents)` pairs.
fn archive_bytes(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, contents) in files {
        writer
            .start_file(*name, SimpleFileOptions::default())
            .expect("start file");
        writer.write_all(contents).expect("write file");
    }
    writer.finish().expect("finish archive").into_inner()
}

/// Opens an archive holding only `xml` as its scene description.
fn open_scene(xml: &str) -> MvrArchive<Cursor<Vec<u8>>> {
    let bytes = archive_bytes(&[("GeneralSceneDescription.xml", xml.as_bytes())]);
    MvrArchive::open(Cursor::new(bytes)).expect("open archive")
}

/// Wraps layer XML in a version 1.6 scene description.
fn scene_xml(layers: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<GeneralSceneDescription verMajor="1" verMinor="6" provider="Test" providerVersion="1.0">
  <Scene>
    <AUXData>
      <Position uuid="77BCDE16-95A6-4725-9D04-16A0BD67CD1A" name="LX 1"/>
      <Class uuid="B8B05B28-C855-44FE-9AD7-313B1EF30E9C" name="Lighting"/>
      <Symdef uuid="12FCDD5E-4194-56A0-96DE-1C3C4EDF1CD3" name="Truss 3m">
        <ChildList><Geometry3D fileName="truss.glb"/></ChildList>
      </Symdef>
    </AUXData>
    <Layers>{layers}</Layers>
  </Scene>
</GeneralSceneDescription>"#
    )
}

/// Asserts that two points agree to within a micrometre.
fn assert_point_eq(actual: [f64; 3], expected: [f64; 3]) {
    for axis in 0..3 {
        assert!(
            (actual[axis] - expected[axis]).abs() < 1e-6,
            "expected {expected:?}, got {actual:?}"
        );
    }
}

/// Every fixture field the importer relies on is read, including the spaced-hex UUID
/// form, both address notations, extra DMX breaks, protocols and unmodelled features.
#[test]
fn reads_fixture_fields() {
    let archive = open_scene(&scene_xml(
        r#"<Layer uuid="83A405B6-8378-482D-9F72-AAD2EE51AABE" name="Rig">
          <ChildList>
            <Fixture uuid="8BF13DD7-CBF4-415B-99E4-625FE4D2DAF6" name="Robin MMX WashBeam">
              <Matrix>{1,0,0}{0,1,0}{0,0,1}{6020.5,2838.25,4978}</Matrix>
              <GDTFSpec>Robe@Robin MMX WashBeam</GDTFSpec>
              <GDTFMode>Mode 1</GDTFMode>
              <Focus>4A B1 94 62 A6 E3 4C 3B B2 5A D8 09 9F 78 17 0C</Focus>
              <Position>77 BC DE 16 95 A6 47 25 9D 04 16 A0 BD 67 CD 1A</Position>
              <Classing>B8B05B28-C855-44FE-9AD7-313B1EF30E9C</Classing>
              <Addresses>
                <Address break="0">45</Address>
                <Address break="1">2.17</Address>
                <Network geometry="ethernet_1" ipv4="192.168.11.5" subnetmask="255.255.0.0"/>
              </Addresses>
              <Protocols><Protocol geometry="NetworkInOut_1" type="sACN"/></Protocols>
              <CustomCommands><CustomCommand>Body_Pan,f 50</CustomCommand></CustomCommands>
              <FixtureID>101</FixtureID>
              <FixtureIDNumeric>0</FixtureIDNumeric>
              <UnitNumber>3</UnitNumber>
              <DMXInvertPan>true</DMXInvertPan>
              <Color>0.312712,0.329008,100.000000</Color>
              <FutureNode>ignored</FutureNode>
            </Fixture>
          </ChildList>
        </Layer>"#,
    ));

    assert_eq!(archive.description().provider_name(), Some("Test"));
    let scene = archive.scene();
    let placed = scene.placed_fixtures();
    assert_eq!(placed.len(), 1);
    let fixture = placed[0].fixture().expect("fixture");

    assert_eq!(
        fixture.uuid,
        Uuid::parse_str("8BF13DD7-CBF4-415B-99E4-625FE4D2DAF6").unwrap()
    );
    assert_eq!(
        fixture.gdtf_spec.as_deref(),
        Some("Robe@Robin MMX WashBeam")
    );
    assert_eq!(fixture.gdtf_mode.as_deref(), Some("Mode 1"));
    assert_eq!(
        fixture.focus,
        Some(Uuid::parse_str("4AB19462-A6E3-4C3B-B25A-D8099F78170C").unwrap())
    );
    let position = fixture.position.and_then(|uuid| scene.position(uuid));
    assert_eq!(position.map(|p| p.name.as_str()), Some("LX 1"));
    let class = fixture.class.and_then(|uuid| scene.class(uuid));
    assert_eq!(class.map(|c| c.name.as_str()), Some("Lighting"));
    assert_eq!(fixture.numeric_id(), Some(101));
    assert_eq!(fixture.unit_number, Some(3));
    assert_eq!(fixture.dmx_invert_pan, Some(true));
    assert_eq!(fixture.dmx_invert_tilt, None);
    assert!(fixture.color.is_some());
    assert_eq!(fixture.unmodelled_features(), vec!["CustomCommands"]);
    assert_eq!(
        fixture.addresses(),
        vec![
            Ok(FixtureAddress {
                dmx_break: 0,
                address: Some(DmxAddress {
                    universe: 1,
                    channel: 45
                }),
            }),
            Ok(FixtureAddress {
                dmx_break: 1,
                address: Some(DmxAddress {
                    universe: 2,
                    channel: 17
                }),
            }),
        ]
    );
    assert_eq!(
        fixture.address_list.networks[0].ipv4.as_deref(),
        Some("192.168.11.5")
    );
    assert_eq!(
        fixture.protocols.protocols[0].protocol_type.as_deref(),
        Some("sACN")
    );
    assert_point_eq(placed[0].world.origin, [6020.5, 2838.25, 4978.0]);
}

/// Empty nodes, as Vectorworks writes them for unnumbered and unpatched fixtures, read
/// as missing values rather than failing.
#[test]
fn treats_empty_values_as_missing() {
    let archive = open_scene(&scene_xml(
        r#"<Layer uuid="83A405B6-8378-482D-9F72-AAD2EE51AABE" name="Rig">
          <GDTFSpec></GDTFSpec>
          <ChildList>
            <Fixture uuid="CC20FF5C-AB12-11ED-937A-48F17FC77B85" name="LED PAR">
              <GDTFSpec>LED PAR.gdtf</GDTFSpec>
              <GDTFMode>Default</GDTFMode>
              <Focus></Focus>
              <Classing>00000000-0000-0000-0000-000000000000</Classing>
              <Addresses><Address break="0">0</Address><Address break="1"></Address></Addresses>
              <FixtureID></FixtureID>
              <UnitNumber>0</UnitNumber>
              <CustomId/>
              <Mappings/>
            </Fixture>
          </ChildList>
        </Layer>"#,
    ));

    let placed = archive.scene().placed_fixtures();
    let fixture = placed[0].fixture().expect("fixture");
    assert_eq!(fixture.focus, None);
    assert_eq!(fixture.class, None, "the nil UUID means no class");
    assert_eq!(fixture.fixture_id, None);
    assert_eq!(fixture.numeric_id(), None);
    assert_eq!(fixture.custom_id, None);
    assert_eq!(
        fixture.addresses(),
        vec![
            Ok(FixtureAddress {
                dmx_break: 0,
                address: None
            }),
            Ok(FixtureAddress {
                dmx_break: 1,
                address: None
            }),
        ]
    );
    assert_eq!(fixture.unmodelled_features(), vec!["Mappings"]);
    assert_point_eq(placed[0].world.origin, [0.0, 0.0, 0.0]);
}

/// World transforms compose the layer elevation, a rotated group and a truss, so a
/// fixture's world position and axes come out where the designer drew them.
#[test]
fn composes_world_transforms_through_the_tree() {
    let archive = open_scene(&scene_xml(
        r#"<Layer uuid="83A405B6-8378-482D-9F72-AAD2EE51AABE" name="Rig">
          <Matrix>{1,0,0}{0,1,0}{0,0,1}{0,0,1000}</Matrix>
          <ChildList>
            <GroupObject uuid="2E149740-6A41-BC43-BD59-8968781B11B9" name="Stage left">
              <Matrix>{0,1,0}{-1,0,0}{0,0,1}{5000,0,0}</Matrix>
              <ChildList>
                <Truss uuid="435954EE-E2FA-0A4E-A86D-87C71143CD8F" name="Truss">
                  <Matrix>{1,0,0}{0,1,0}{0,0,1}{0,0,6000}</Matrix>
                  <Geometries>
                    <Symbol uuid="FC4D2D64-5CE6-7A4E-AE4E-BEA3304D7E05" symdef="12FCDD5E-4194-56A0-96DE-1C3C4EDF1CD3"/>
                  </Geometries>
                  <ChildList>
                    <Fixture uuid="8BF13DD7-CBF4-415B-99E4-625FE4D2DAF6" name="Spot">
                      <Matrix>{1,0,0}{0,-1,0}{0,0,-1}{2000,0,0}</Matrix>
                    </Fixture>
                  </ChildList>
                </Truss>
              </ChildList>
            </GroupObject>
          </ChildList>
        </Layer>"#,
    ));

    let scene = archive.scene();
    let placed = scene.placed_fixtures();
    assert_eq!(placed.len(), 1);
    let fixture = &placed[0];
    // The group turns local X onto world Y, so 2 m along the truss is 2 m along world Y.
    assert_point_eq(fixture.world.origin, [5000.0, 2000.0, 7000.0]);
    // Hung upside down: local Z points at the floor.
    assert_point_eq(fixture.world.axes[2], [0.0, 0.0, -1.0]);
    assert_point_eq(fixture.world.axes[0], [0.0, 1.0, 0.0]);
    assert_eq!(fixture.ancestors.len(), 2);
    assert_eq!(fixture.layer.name, "Rig");
    assert!(fixture.parent_fixture().is_none());

    let truss = scene
        .placed_objects()
        .into_iter()
        .find(|placed| matches!(placed.node, SceneNode::Truss(_)))
        .expect("truss");
    let SceneNode::Truss(truss_object) = truss.node else {
        unreachable!()
    };
    let GeometryNode::Symbol(symbol) = &truss_object.geometries.nodes[0] else {
        panic!("expected a symbol");
    };
    let symdef = scene.symdef(symbol.symdef).expect("symdef");
    let GeometryNode::Geometry3D(model) = &symdef.geometries.nodes[0] else {
        panic!("expected a model file");
    };
    assert_eq!(model.file_name, "truss.glb");
}

/// A fixture attached to another fixture is reported with its parent, and node types
/// this reader does not know are skipped with everything inside them.
#[test]
fn reports_attached_fixtures_and_skips_unknown_nodes() {
    let archive = open_scene(&scene_xml(
        r#"<Layer uuid="83A405B6-8378-482D-9F72-AAD2EE51AABE" name="Rig">
          <ChildList>
            <Hologram uuid="00000000-0000-0000-0000-000000000009">
              <ChildList>
                <Fixture uuid="7E113A12-3E6D-4350-802E-37EDD41873CF" name="Hidden"/>
              </ChildList>
            </Hologram>
            <Fixture uuid="8BF13DD7-CBF4-415B-99E4-625FE4D2DAF6" name="Wash">
              <ChildList>
                <Fixture uuid="8BF13DD7-CBF4-415B-99E4-625FE4D2DAF5" name="Top hat">
                  <ChildPosition>Base.Yoke.Head</ChildPosition>
                </Fixture>
              </ChildList>
            </Fixture>
          </ChildList>
        </Layer>"#,
    ));

    let placed = archive.scene().placed_fixtures();
    let names: Vec<_> = placed
        .iter()
        .map(|placed| placed.fixture().unwrap().name.as_str())
        .collect();
    assert_eq!(names, ["Wash", "Top hat"]);
    let attachment = &placed[1];
    assert_eq!(
        attachment.parent_fixture().map(|f| f.name.as_str()),
        Some("Wash")
    );
    assert_eq!(
        attachment.fixture().unwrap().child_position.as_deref(),
        Some("Base.Yoke.Head")
    );
}

/// The provider comes from `UserData` for files older than MVR 1.6, as Vectorworks
/// writes them.
#[test]
fn reads_provider_from_user_data() {
    let archive = open_scene(
        r#"<GeneralSceneDescription verMajor="1" verMinor="5">
          <UserData><Data provider="Vectorworks" ver="0.1"/></UserData>
          <Scene><Layers/></Scene>
        </GeneralSceneDescription>"#,
    );
    assert_eq!(archive.description().provider_name(), Some("Vectorworks"));
    assert_eq!(archive.description().ver_minor, 5);
    assert!(archive.scene().placed_objects().is_empty());
}

/// Files from a future major version are rejected instead of half-read.
#[test]
fn rejects_unsupported_major_version() {
    let bytes = archive_bytes(&[(
        "GeneralSceneDescription.xml",
        br#"<GeneralSceneDescription verMajor="2" verMinor="0"><Scene/></GeneralSceneDescription>"#,
    )]);
    let error = MvrArchive::open(Cursor::new(bytes)).err().expect("error");
    assert!(matches!(
        error,
        MvrError::UnsupportedVersion { major: 2, minor: 0 }
    ));
}

/// A zip without a scene description is not an MVR file.
#[test]
fn rejects_archive_without_scene_description() {
    let bytes = archive_bytes(&[("fixture.gdtf", b"not a scene")]);
    let error = MvrArchive::open(Cursor::new(bytes)).err().expect("error");
    assert!(matches!(error, MvrError::MissingSceneDescription));
}

/// A malformed value fails the whole file with a message naming the bad text.
#[test]
fn rejects_malformed_values() {
    let bytes = archive_bytes(&[(
        "GeneralSceneDescription.xml",
        scene_xml(
            r#"<Layer uuid="83A405B6-8378-482D-9F72-AAD2EE51AABE" name="Rig">
              <ChildList>
                <Fixture uuid="8BF13DD7-CBF4-415B-99E4-625FE4D2DAF6" name="Spot">
                  <Matrix>{1,0,0}{0,1,0}{0,0,1}</Matrix>
                </Fixture>
              </ChildList>
            </Layer>"#,
        )
        .as_bytes(),
    )]);
    let error = MvrArchive::open(Cursor::new(bytes)).err().expect("error");
    assert!(error.to_string().contains("invalid matrix"), "{error}");
}

/// GDTF files are found with or without the `.gdtf` extension and regardless of case,
/// and files in folders or clashing by case are reported.
#[test]
fn finds_resources_and_reports_archive_problems() {
    let xml = scene_xml("");
    let bytes = archive_bytes(&[
        ("GeneralSceneDescription.xml", xml.as_bytes()),
        ("Custom@Pendant 44deg.gdtf", b"gdtf"),
        ("Model.GLB", b"glb"),
        ("model.glb", b"second"),
        ("textures/wood.png", b"png"),
    ]);
    let mut archive = MvrArchive::open(Cursor::new(bytes)).expect("open");

    assert_eq!(
        archive.find_gdtf("Custom@Pendant 44deg"),
        Some("Custom@Pendant 44deg.gdtf")
    );
    assert_eq!(
        archive.find_gdtf("custom@pendant 44deg.GDTF"),
        Some("Custom@Pendant 44deg.gdtf")
    );
    assert_eq!(archive.find_gdtf("Missing"), None);
    assert_eq!(archive.read_file("model.glb").expect("read"), b"second");
    assert_eq!(archive.read_file("MODEL.glb").expect("read"), b"glb");
    assert!(matches!(
        archive.read_file("absent.3ds"),
        Err(MvrError::FileNotFound(_))
    ));
    assert_eq!(
        archive.warnings(),
        [
            ArchiveWarning::CaseInsensitiveDuplicate {
                kept: "Model.GLB".to_string(),
                duplicate: "model.glb".to_string(),
            },
            ArchiveWarning::FileInFolder("textures/wood.png".to_string()),
        ]
    );
}

/// A file that expands past the per-file limit is refused, and so is an archive with
/// too many files.
#[test]
fn enforces_archive_limits() {
    let xml = scene_xml("");
    let large = vec![0u8; 4096];
    let bytes = archive_bytes(&[
        ("GeneralSceneDescription.xml", xml.as_bytes()),
        ("big.glb", &large),
    ]);
    let limits = ArchiveLimits {
        max_file_size: 2048,
        ..ArchiveLimits::default()
    };
    let mut archive = MvrArchive::open_with_limits(Cursor::new(bytes.clone()), limits)
        .expect("scene fits the limit");
    assert!(matches!(
        archive.read_file("big.glb"),
        Err(MvrError::FileTooLarge { .. })
    ));

    let limits = ArchiveLimits {
        max_files: 1,
        ..ArchiveLimits::default()
    };
    assert!(matches!(
        MvrArchive::open_with_limits(Cursor::new(bytes.clone()), limits),
        Err(MvrError::TooManyFiles { count: 2, limit: 1 })
    ));

    let limits = ArchiveLimits {
        max_total_size: 1024,
        ..ArchiveLimits::default()
    };
    assert!(matches!(
        MvrArchive::open_with_limits(Cursor::new(bytes), limits),
        Err(MvrError::ArchiveTooLarge { .. })
    ));
}

/// Absolute and dotted addresses split into universe and channel, 0 means unpatched,
/// and out-of-range text is rejected.
#[test]
fn parses_dmx_addresses() {
    let address = |universe, channel| Ok(Some(DmxAddress { universe, channel }));
    assert_eq!(DmxAddress::parse("1"), address(1, 1));
    assert_eq!(DmxAddress::parse("512"), address(1, 512));
    assert_eq!(DmxAddress::parse("513"), address(2, 1));
    assert_eq!(DmxAddress::parse(" 1025 "), address(3, 1));
    assert_eq!(DmxAddress::parse("4.200"), address(4, 200));
    assert_eq!(DmxAddress::parse("0"), Ok(None));
    assert_eq!(DmxAddress::parse("1.513"), Err("1.513".to_string()));
    assert_eq!(DmxAddress::parse("0.5"), Err("0.5".to_string()));
    assert_eq!(DmxAddress::parse("A1"), Err("A1".to_string()));
    assert_eq!(DmxAddress::parse(" "), Ok(None));
    assert_eq!(
        DmxAddress {
            universe: 2,
            channel: 1
        }
        .absolute(),
        513
    );
}

/// Matrix text parses with stray whitespace and scientific notation, round-trips through
/// `Display`, and rejects the wrong number of values.
#[test]
fn parses_matrices() {
    let matrix =
        Transform::parse(" {8.5e-08, -1.5e-07, 1}{0,1,0} {-1,0,0}{-6670.87,-890.86,6000} ")
            .expect("valid matrix");
    assert_point_eq(matrix.axes[0], [8.5e-08, -1.5e-07, 1.0]);
    assert_point_eq(matrix.origin, [-6670.87, -890.86, 6000.0]);
    assert_eq!(Transform::parse(&matrix.to_string()), Some(matrix));
    assert_eq!(Transform::parse("{1,0,0}{0,1,0}{0,0,1}"), None);
    assert_eq!(Transform::parse("{1,0}{0,1,0}{0,0,1}{0,0,0}"), None);
    assert_eq!(Transform::parse("{1,0,0,0}{0,1,0}{0,0,1}{0,0,0}"), None);
    assert_eq!(
        Transform::parse("{1,0,0}{0,1,0}{0,0,1}{0,0,0}{0,0,0}"),
        None
    );
    let scaled = Transform::parse("{2,0,0}{0,3,0}{0,0,1}{0,0,0}").unwrap();
    assert_point_eq(scaled.scale(), [2.0, 3.0, 1.0]);
}

/// Controllable non-fixture objects, such as a projector or a motor, keep their DMX
/// addresses and IDs.
#[test]
fn reads_device_fields_on_other_objects() {
    let archive = open_scene(&scene_xml(
        r#"<Layer uuid="83A405B6-8378-482D-9F72-AAD2EE51AABE" name="Video">
          <ChildList>
            <Projector uuid="8BF13DD7-CBF4-415B-99E4-625FE4D2DAF6" name="Projector">
              <GDTFSpec>Acme@Beamer.gdtf</GDTFSpec>
              <GDTFMode>Standard</GDTFMode>
              <Addresses><Address break="0">3.100</Address></Addresses>
              <FixtureIDNumeric>501</FixtureIDNumeric>
              <Geometries/>
            </Projector>
          </ChildList>
        </Layer>"#,
    ));
    let placed = archive.scene().placed_objects();
    let SceneNode::Projector(projector) = placed[0].node else {
        panic!("expected a projector");
    };
    assert_eq!(projector.numeric_id(), Some(501));
    assert_eq!(projector.gdtf_mode.as_deref(), Some("Standard"));
    assert_eq!(
        projector.addresses(),
        vec![Ok(FixtureAddress {
            dmx_break: 0,
            address: Some(DmxAddress {
                universe: 3,
                channel: 100
            }),
        })]
    );
}

/// A scene nested deeper than the reader allows is refused before it can exhaust the
/// stack.
#[test]
fn rejects_excessive_nesting() {
    let depth = crate::scene::MAX_NESTING_DEPTH;
    let group = r#"<GroupObject uuid="2E149740-6A41-BC43-BD59-8968781B11B9"><ChildList>"#;
    let layer = format!(
        r#"<Layer uuid="83A405B6-8378-482D-9F72-AAD2EE51AABE" name="Deep"><ChildList>{}{}</ChildList></Layer>"#,
        group.repeat(depth),
        "</ChildList></GroupObject>".repeat(depth),
    );
    let bytes = archive_bytes(&[("GeneralSceneDescription.xml", scene_xml(&layer).as_bytes())]);
    let error = MvrArchive::open(Cursor::new(bytes)).err().expect("error");
    assert!(matches!(error, MvrError::TooDeeplyNested { .. }), "{error}");
}
