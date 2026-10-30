// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Writing GDTF archives from a parsed description.
//!
//! A written archive keeps every resource of the archive it was read from
//! (models, wheel images, thumbnails) and replaces only `description.xml`
//! with the serialized description. The description model does not cover
//! every element of the format, so [`lost_content`] lists what a write would
//! drop from a given source description.

use std::collections::BTreeSet;
use std::fs::File;
use std::io::{Cursor, Read, Seek, Write};
use std::path::Path;

/// Name of the archive entry holding the fixture description.
pub(crate) const DESCRIPTION_ENTRY: &str = "description.xml";

/// Reads the raw `description.xml` of a GDTF archive.
pub fn read_description_xml(path: &Path) -> Result<String, String> {
    let mut archive = zip::ZipArchive::new(File::open(path).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    let mut description = String::new();
    archive
        .by_name(DESCRIPTION_ENTRY)
        .map_err(|error| error.to_string())?
        .read_to_string(&mut description)
        .map_err(|error| error.to_string())?;
    Ok(description)
}

/// Builds a GDTF archive holding `description` and every other entry of the archive at `source`.
pub fn write_gdtf(source: &Path, description: &gdtf::Description) -> Result<Vec<u8>, String> {
    let xml = description.to_string().map_err(|error| error.to_string())?;
    let mut archive = zip::ZipArchive::new(File::open(source).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    rebuild_archive(&mut archive, &xml, true)
}

/// Rebuilds an archive around a new description.
///
/// Entries other than the description are raw-copied without recompression
/// when `copy_resources` is set, and left out otherwise.
pub(crate) fn rebuild_archive<R: Read + Seek>(
    source: &mut zip::ZipArchive<R>,
    description: &str,
    copy_resources: bool,
) -> Result<Vec<u8>, String> {
    let mut output = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let copied_entries = if copy_resources { source.len() } else { 0 };
    for index in 0..copied_entries {
        let entry = source
            .by_index_raw(index)
            .map_err(|error| error.to_string())?;
        if entry.name_raw() == DESCRIPTION_ENTRY.as_bytes() {
            continue;
        }
        output
            .raw_copy_file(entry)
            .map_err(|error| error.to_string())?;
    }
    output
        .start_file(
            DESCRIPTION_ENTRY,
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated),
        )
        .map_err(|error| error.to_string())?;
    output
        .write_all(description.as_bytes())
        .map_err(|error| error.to_string())?;
    Ok(output
        .finish()
        .map_err(|error| error.to_string())?
        .into_inner())
}

/// Lists the elements and attributes of a description that the description model does not read.
///
/// These are dropped when the parsed description is written back out. Paths
/// leave out list positions, so `FixtureType.Wheels.Wheel.Slot.@Foo` stands
/// for that attribute on every slot of every wheel, and each path is listed
/// once. The deserializer is configured like the `gdtf` crate's
/// (`overlapped-lists`), so it accepts the same documents.
pub fn lost_content(xml: &str) -> Result<Vec<String>, String> {
    let mut deserializer = quick_xml::de::Deserializer::from_str(xml);
    let mut paths = BTreeSet::new();
    let _: gdtf::Description = serde_ignored::deserialize(&mut deserializer, |path| {
        paths.insert(without_positions(&path.to_string()));
    })
    .map_err(|error| error.to_string())?;
    Ok(paths.into_iter().collect())
}

/// Drops numeric list positions from a dotted `serde_ignored` path.
fn without_positions(path: &str) -> String {
    path.split('.')
        .filter(|segment| !segment.chars().all(|character| character.is_ascii_digit()))
        .collect::<Vec<_>>()
        .join(".")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal valid description; `{attrs}` and `{extra}` add fixture type attributes and children.
    const DESCRIPTION: &str = r#"<GDTF DataVersion="1.2"><FixtureType Name="Test" ShortName="T" LongName="Test" Manufacturer="Generic" Description="" FixtureTypeID="00000000-0000-0000-0000-000000000000" RefFT="" Thumbnail=""{attrs}><AttributeDefinitions/><Wheels/><PhysicalDescriptions/><Models/><Geometries/><DMXModes/>{extra}</FixtureType></GDTF>"#;

    /// Elements and attributes the model does not read are listed once each.
    #[test]
    fn lost_content_lists_unread_elements_and_attributes() {
        let xml = DESCRIPTION
            .replace("{attrs}", r#" Vendor="x""#)
            .replace("{extra}", "<Unknown/><Unknown/>");
        assert_eq!(
            lost_content(&xml).unwrap(),
            ["FixtureType.@Vendor", "FixtureType.Unknown"]
        );
    }

    /// Empty containers and empty attributes the model reads are not reported as lost.
    #[test]
    fn lost_content_is_empty_for_modelled_content() {
        let xml = DESCRIPTION.replace("{attrs}", "").replace("{extra}", "");
        assert!(lost_content(&xml).unwrap().is_empty());
    }

    /// A written archive keeps the source's resources and reads back the same description.
    #[test]
    fn write_gdtf_keeps_resources_and_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.gdtf");
        let description = DESCRIPTION.replace("{attrs}", "").replace("{extra}", "");
        {
            let mut zip = zip::ZipWriter::new(File::create(&source).unwrap());
            let options = zip::write::SimpleFileOptions::default();
            zip.start_file(DESCRIPTION_ENTRY, options).unwrap();
            zip.write_all(description.as_bytes()).unwrap();
            zip.start_file("wheels/gobo.png", options).unwrap();
            zip.write_all(b"png").unwrap();
            zip.finish().unwrap();
        }
        let parsed = gdtf::GdtfFile::new(File::open(&source).unwrap()).unwrap();

        let written = write_gdtf(&source, &parsed.description).unwrap();

        let mut archive = zip::ZipArchive::new(Cursor::new(written.clone())).unwrap();
        let mut gobo = Vec::new();
        archive
            .by_name("wheels/gobo.png")
            .unwrap()
            .read_to_end(&mut gobo)
            .unwrap();
        assert_eq!(gobo, b"png");
        let reread = gdtf::GdtfFile::new(Cursor::new(written)).unwrap();
        assert_eq!(reread.description, parsed.description);
    }
}
