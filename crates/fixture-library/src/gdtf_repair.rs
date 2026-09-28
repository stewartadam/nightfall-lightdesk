// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Tolerant opening of GDTF archives that `gdtf-rs` rejects.
//!
//! A small share of published archives fail strict parsing over details
//! that do not affect what Nightfall reads from them: NaN placeholders in
//! optional numeric attributes, missing `Pretty` or `Offset` attributes,
//! gamut points in the spec's `{x,y,Y}` list syntax, or laser geometries
//! whose attributes the parser cannot read. When strict parsing fails, the
//! archive's `description.xml` is rewritten to repair those faults and the
//! archive is parsed again from memory. Archives that parse as published are
//! never rewritten.

use std::fs::File;
use std::io::{Cursor, Read, Write};
use std::path::Path;

use quick_xml::events::{BytesEnd, BytesStart, Event};
use quick_xml::{Reader, Writer};

/// Name of the archive entry holding the fixture description.
const DESCRIPTION_ENTRY: &str = "description.xml";

/// Archive entries a repaired archive is rebuilt with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RepairedContents {
    /// Every entry, so models, wheel images and other resources stay readable.
    WithResources,
    /// Only the repaired description, for callers that never read resources.
    DescriptionOnly,
}

/// Opens a GDTF archive, repairing known authoring faults if strict parsing fails.
///
/// Returns the parsed file and a description of every repair applied (empty
/// when the archive parsed as published). When the repaired archive still
/// fails to parse, the original parser error is returned with the repaired one.
/// A repaired archive is rebuilt in memory with all of its resources.
pub fn open_gdtf(path: &Path) -> Result<(gdtf::GdtfFile, Vec<String>), String> {
    open_gdtf_with(path, RepairedContents::WithResources)
}

/// Opens a GDTF archive for its description only, repairing faults like [`open_gdtf`].
///
/// When repair is needed, the rebuilt in-memory archive holds only the
/// repaired description, so scanning large archives does not copy their
/// models and images into memory. Resources of the returned file are only
/// readable when the archive parsed without repair.
pub fn open_gdtf_description(path: &Path) -> Result<(gdtf::GdtfFile, Vec<String>), String> {
    open_gdtf_with(path, RepairedContents::DescriptionOnly)
}

/// Opens a GDTF archive, repairing its description into an archive holding `contents` if needed.
fn open_gdtf_with(
    path: &Path,
    contents: RepairedContents,
) -> Result<(gdtf::GdtfFile, Vec<String>), String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let original = match gdtf::GdtfFile::new(file) {
        Ok(parsed) => return Ok((parsed, Vec::new())),
        Err(error) => error.to_string(),
    };
    let Some((archive, repairs)) = repaired_archive(path, contents) else {
        return Err(format!("{original} (no applicable repairs)"));
    };
    match gdtf::GdtfFile::new(Cursor::new(archive)) {
        Ok(parsed) => {
            tracing::warn!(
                path = %path.display(),
                ?repairs,
                "Repaired GDTF authoring faults to import fixture"
            );
            Ok((parsed, repairs))
        }
        Err(repaired) => Err(format!("{original} (after repairs: {repaired})")),
    }
}

/// Rebuilds an archive with a repaired description, or `None` when nothing needed repair.
///
/// Other entries are raw-copied only for [`RepairedContents::WithResources`].
fn repaired_archive(path: &Path, contents: RepairedContents) -> Option<(Vec<u8>, Vec<String>)> {
    let mut source = zip::ZipArchive::new(File::open(path).ok()?).ok()?;
    let mut description = String::new();
    source
        .by_name(DESCRIPTION_ENTRY)
        .ok()?
        .read_to_string(&mut description)
        .ok()?;
    let (repaired, repairs) = repair_description(&description)?;
    if repairs.is_empty() {
        return None;
    }

    let mut output = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let copied_entries = match contents {
        RepairedContents::WithResources => source.len(),
        RepairedContents::DescriptionOnly => 0,
    };
    for index in 0..copied_entries {
        let entry = source.by_index_raw(index).ok()?;
        if entry.name() == DESCRIPTION_ENTRY {
            continue;
        }
        output.raw_copy_file(entry).ok()?;
    }
    output
        .start_file(
            DESCRIPTION_ENTRY,
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated),
        )
        .ok()?;
    output.write_all(repaired.as_bytes()).ok()?;
    Some((output.finish().ok()?.into_inner(), repairs))
}

/// Rewrites a description to repair known faults, listing each distinct repair.
///
/// Returns `None` when the document is not well-formed XML.
pub fn repair_description(xml: &str) -> Option<(String, Vec<String>)> {
    let mut reader = Reader::from_str(xml);
    let mut writer = Writer::new(Vec::new());
    let mut repairs: Vec<String> = Vec::new();
    // Output names of open elements, so renamed elements close correctly,
    // and whether each was a laser imported as a plain geometry.
    let mut open: Vec<(String, bool)> = Vec::new();
    // Depth inside a subtree being dropped (0 when not dropping).
    let mut dropping = 0usize;

    loop {
        let event = reader.read_event().ok()?;
        if dropping > 0 {
            match event {
                Event::Start(_) => dropping += 1,
                Event::End(_) => dropping -= 1,
                Event::Eof => return None,
                _ => {}
            }
            continue;
        }
        match event {
            Event::Start(start) => {
                if let Some(reason) = dropped_element(&start, &open) {
                    note(&mut repairs, reason);
                    dropping = 1;
                    continue;
                }
                let repaired = repair_element(&start, &mut repairs)?;
                open.push((
                    String::from_utf8_lossy(repaired.name().as_ref()).into_owned(),
                    start.name().as_ref() == b"Laser",
                ));
                writer.write_event(Event::Start(repaired)).ok()?;
            }
            Event::Empty(start) => {
                if let Some(reason) = dropped_element(&start, &open) {
                    note(&mut repairs, reason);
                    continue;
                }
                let repaired = repair_element(&start, &mut repairs)?;
                writer.write_event(Event::Empty(repaired)).ok()?;
            }
            Event::End(_) => {
                let (name, _) = open.pop()?;
                writer.write_event(Event::End(BytesEnd::new(name))).ok()?;
            }
            Event::Eof => break,
            other => writer.write_event(other).ok()?,
        }
    }
    Some((String::from_utf8(writer.into_inner()).ok()?, repairs))
}

/// Returns why an element is dropped with its subtree, or `None` to keep it.
///
/// Drops a laser's protocols, direct or wrapped (the laser is imported as a
/// plain geometry, which cannot hold them), and channel sets starting at a
/// negative DMX value, which only label ranges.
fn dropped_element(start: &BytesStart, open: &[(String, bool)]) -> Option<&'static str> {
    let in_laser = open.last().is_some_and(|(_, is_laser)| *is_laser);
    match start.name().as_ref() {
        b"Protocols" | b"Protocol" if in_laser => Some("dropped laser protocols"),
        b"ChannelSet"
            if start.attributes().flatten().any(|attribute| {
                attribute.key.as_ref() == b"DMXFrom" && attribute.value.starts_with(b"-")
            }) =>
        {
            Some("dropped channel set with negative DMXFrom")
        }
        _ => None,
    }
}

/// White (D65) substituted for NaN colors on elements that require a color.
const WHITE_CIE: &str = "0.312700,0.329000,100.000000";

/// Elements whose `Color` attribute is required, so a NaN color becomes white.
const COLOR_REQUIRED: [&str; 3] = ["Slot", "Emitter", "Filter"];

/// Output element name for laser geometries, which are imported as plain geometries.
const LASER_AS: &str = "Geometry";

/// Attributes a laser keeps once imported as a plain geometry.
const GEOMETRY_ATTRIBUTES: [&str; 3] = ["Name", "Model", "Position"];

/// Returns a copy of an element with its attribute faults repaired.
fn repair_element(start: &BytesStart, repairs: &mut Vec<String>) -> Option<BytesStart<'static>> {
    let name = String::from_utf8_lossy(start.name().as_ref()).into_owned();
    let is_laser = name == "Laser";
    let mut repaired = BytesStart::new(if is_laser {
        note(repairs, "imported laser geometry as a plain geometry");
        LASER_AS.to_string()
    } else {
        name.clone()
    });

    let mut element_name = None;
    let mut has_pretty = false;
    let mut has_offset = false;
    for attribute in start.attributes() {
        let attribute = attribute.ok()?;
        let key = String::from_utf8_lossy(attribute.key.as_ref()).into_owned();
        let value = attribute
            .normalized_value(quick_xml::XmlVersion::Implicit1_0)
            .ok()?
            .into_owned();
        if is_laser && !GEOMETRY_ATTRIBUTES.contains(&key.as_str()) {
            continue;
        }
        if is_nan(&value) {
            if key == "Color" && COLOR_REQUIRED.contains(&name.as_str()) {
                note(repairs, &format!("replaced NaN {name}@{key} with white"));
                repaired.push_attribute((key.as_str(), WHITE_CIE));
            } else {
                note(repairs, &format!("dropped NaN {name}@{key}"));
            }
            continue;
        }
        let value = if name == "Gamut" && key == "Points" && value.contains('{') {
            note(repairs, "rewrote gamut points list");
            gamut_points_list(&value)
        } else {
            value
        };
        match key.as_str() {
            "Name" => element_name = Some(value.clone()),
            "Pretty" => has_pretty = true,
            "Offset" => has_offset = true,
            _ => {}
        }
        repaired.push_attribute((key.as_str(), value.as_str()));
    }

    if name == "FeatureGroup" && !has_pretty {
        note(repairs, "filled missing FeatureGroup@Pretty");
        repaired.push_attribute(("Pretty", element_name.as_deref().unwrap_or("")));
    }
    if name == "DMXChannel" && !has_offset {
        note(repairs, "filled missing DMXChannel@Offset");
        repaired.push_attribute(("Offset", "None"));
    }
    Some(repaired)
}

/// Returns whether an attribute value holds a NaN placeholder the parser rejects.
///
/// Matches numeric parts that are exactly a NaN token such as `-nan(ind)`
/// but do not parse as a float (Rust already accepts `NaN`), so names like
/// `Nano` and parseable NaNs are left alone.
fn is_nan(value: &str) -> bool {
    value.split([',', '{', '}']).any(|part| {
        let part = part.trim();
        let token = part.trim_start_matches(['-', '+']).to_ascii_lowercase();
        let is_nan_token = token == "nan" || (token.starts_with("nan(") && token.ends_with(')'));
        is_nan_token && part.parse::<f64>().is_err()
    })
}

/// Converts GDTF's `{x,y,Y}{x,y,Y}` gamut syntax into a whitespace-separated point list.
///
/// Whitespace inside a point is removed, since the parser splits the list on it.
fn gamut_points_list(value: &str) -> String {
    value
        .split(['{', '}'])
        .map(|point| point.split_whitespace().collect::<String>())
        .map(|point| point.trim_matches(',').to_string())
        .filter(|point| !point.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Records a repair once.
fn note(repairs: &mut Vec<String>, repair: &str) {
    if !repairs.iter().any(|existing| existing == repair) {
        repairs.push(repair.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies well-formed descriptions need no repair.
    #[test]
    fn clean_description_is_unchanged() {
        let xml =
            r#"<GDTF><FeatureGroup Name="Dimmer" Pretty="Dim"/><DMXChannel Offset="1"/></GDTF>"#;
        let (repaired, repairs) = repair_description(xml).expect("well-formed");
        assert!(repairs.is_empty());
        assert!(repaired.contains(r#"Pretty="Dim""#));
    }

    /// Verifies NaN placeholders are dropped and missing required attributes are filled.
    #[test]
    fn repairs_nan_and_missing_attributes() {
        let xml = r#"<GDTF><Attribute Name="R" Color="-nan(ind),0.3,1"/><FeatureGroup Name="Color"/><DMXChannel DMXBreak="1"/></GDTF>"#;
        let (repaired, repairs) = repair_description(xml).expect("well-formed");
        assert!(!repaired.contains("nan"));
        assert!(repaired.contains(r#"<FeatureGroup Name="Color" Pretty="Color"/>"#));
        assert!(repaired.contains(r#"Offset="None""#));
        assert_eq!(repairs.len(), 3);
    }

    /// Verifies required NaN colors become white and negative channel sets are dropped.
    #[test]
    fn repairs_required_colors_and_negative_sets() {
        let xml = r#"<GDTF><Slot Name="Open" Color="-nan(ind),-nan(ind),0"/><ChannelFunction><ChannelSet Name="Bad" DMXFrom="-255/1"/><ChannelSet Name="Ok" DMXFrom="0/1"/></ChannelFunction></GDTF>"#;
        let (repaired, _) = repair_description(xml).expect("well-formed");
        assert!(repaired.contains(&format!(r#"Color="{WHITE_CIE}""#)));
        assert!(!repaired.contains("Bad"));
        assert!(repaired.contains(r#"Name="Ok""#));
    }

    /// Writes an archive whose description strict parsing rejects (a
    /// FeatureGroup without `Pretty`), plus `resources`, and returns its path.
    fn faulty_archive(dir: &Path, resources: &[(&str, &[u8])]) -> std::path::PathBuf {
        let description = crate::testing::GdtfBuilder::new("Test", "Faulty")
            .description_xml()
            .replace(
                r#"<FeatureGroup Name="Control" Pretty="Control">"#,
                r#"<FeatureGroup Name="Control">"#,
            );
        let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
        archive
            .start_file(DESCRIPTION_ENTRY, zip::write::SimpleFileOptions::default())
            .expect("start entry");
        archive
            .write_all(description.as_bytes())
            .expect("write description");
        for (name, content) in resources {
            archive
                .start_file(*name, zip::write::SimpleFileOptions::default())
                .expect("start resource");
            archive.write_all(content).expect("write resource");
        }
        let bytes = archive.finish().expect("finish archive").into_inner();
        assert!(gdtf::GdtfFile::new(Cursor::new(bytes.clone())).is_err());
        let path = dir.join("faulty.gdtf");
        std::fs::write(&path, &bytes).expect("write archive");
        path
    }

    /// Returns the entry names of an in-memory archive.
    fn entry_names(archive: Vec<u8>) -> Vec<String> {
        let archive = zip::ZipArchive::new(Cursor::new(archive)).expect("rebuilt archive");
        archive.file_names().map(str::to_string).collect()
    }

    /// Verifies an archive rejected by strict parsing opens after repair, from a rebuilt archive.
    #[test]
    fn opens_rejected_archive_after_repair() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = faulty_archive(dir.path(), &[]);
        let (_, repairs) = open_gdtf(&path).expect("repaired archive opens");
        assert_eq!(repairs, vec!["filled missing FeatureGroup@Pretty"]);
    }

    /// Verifies description-only repair skips resource entries, so scanning a
    /// large repairable archive does not copy its media into memory, while a
    /// full repair keeps them readable.
    #[test]
    fn description_only_repair_omits_resources() {
        let dir = tempfile::tempdir().expect("temp dir");
        let media = vec![0u8; 64 * 1024];
        let path = faulty_archive(dir.path(), &[("models/gltf/Body.glb", &media)]);

        let (description_only, _) =
            repaired_archive(&path, RepairedContents::DescriptionOnly).expect("repairable");
        assert_eq!(entry_names(description_only), vec![DESCRIPTION_ENTRY]);
        let (complete, _) =
            repaired_archive(&path, RepairedContents::WithResources).expect("repairable");
        let mut names = entry_names(complete);
        names.sort();
        assert_eq!(names, vec![DESCRIPTION_ENTRY, "models/gltf/Body.glb"]);

        let (_, repairs) = open_gdtf_description(&path).expect("description opens");
        assert_eq!(repairs, vec!["filled missing FeatureGroup@Pretty"]);
    }

    /// Verifies entity-escaped attribute values stay escaped when a
    /// description is rewritten, so the repaired XML remains well-formed.
    #[test]
    fn repair_preserves_escaped_attribute_values() {
        let xml = r#"<GDTF><FixtureType Name="Spot &quot;XL&quot; &amp; &lt;Pro&gt;"/><FeatureGroup Name="Dimmer"/></GDTF>"#;
        let (repaired, repairs) = repair_description(xml).expect("well-formed");
        assert_eq!(repairs, vec!["filled missing FeatureGroup@Pretty"]);
        assert!(
            repaired.contains(r#"Name="Spot &quot;XL&quot; &amp; &lt;Pro&gt;""#),
            "{repaired}"
        );
        let (reparsed, _) = repair_description(&repaired).expect("repaired XML is well-formed");
        assert_eq!(reparsed, repaired);
    }

    /// Verifies braced gamut points become a whitespace-separated list of triples.
    #[test]
    fn rewrites_braced_gamut_points() {
        assert_eq!(
            gamut_points_list("{0.64,0.33,1}{0.3,0.6,1},{0.15,0.06,1}"),
            "0.64,0.33,1 0.3,0.6,1 0.15,0.06,1"
        );
    }

    /// Verifies a laser becomes a plain geometry, keeping children but not protocols.
    #[test]
    fn imports_laser_as_geometry() {
        let xml = r#"<Geometries><Laser Name="L" Model="M" Position="{1,0,0,0}" OutputStrength="1"><Protocols><Protocol Name="ILDA"/></Protocols><Geometry Name="Child"/></Laser></Geometries>"#;
        let (repaired, _) = repair_description(xml).expect("well-formed");
        assert_eq!(
            repaired,
            r#"<Geometries><Geometry Name="L" Model="M" Position="{1,0,0,0}"><Geometry Name="Child"/></Geometry></Geometries>"#
        );

        let direct = r#"<Laser Name="L"><Protocol Name="ILDA"/><Geometry Name="Child"><Protocol Name="Kept"/></Geometry></Laser>"#;
        let (repaired, _) = repair_description(direct).expect("well-formed");
        assert_eq!(
            repaired,
            r#"<Geometry Name="L"><Geometry Name="Child"><Protocol Name="Kept"/></Geometry></Geometry>"#
        );
    }

    /// Verifies names resembling NaN and NaNs the parser accepts are left alone.
    #[test]
    fn nan_detection_ignores_names_and_parseable_nans() {
        assert!(is_nan("-nan(ind)"));
        assert!(is_nan("0.3,-nan(ind),1"));
        assert!(is_nan("{-nan(ind),0.3,1}"));
        assert!(!is_nan("Nano Head"));
        assert!(!is_nan("nano_gobo"));
        assert!(!is_nan("NaN"));
        let xml = r#"<Geometry Name="NanoHead" Model="nan_model"/>"#;
        let (repaired, repairs) = repair_description(xml).expect("well-formed");
        assert_eq!(repaired, xml);
        assert!(repairs.is_empty());
    }

    /// Verifies whitespace inside braced gamut points is removed so each point stays one token.
    #[test]
    fn gamut_points_drop_inner_whitespace() {
        assert_eq!(
            gamut_points_list("{0.64, 0.33, 1} {0.3, 0.6, 1}"),
            "0.64,0.33,1 0.3,0.6,1"
        );
    }
}
