// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Shared fixtures for fixture-library unit tests.

use std::io::Write;
use std::path::Path;

/// Manufacturer of the archive written by [`write_test_gdtf`].
pub(crate) const TEST_GDTF_MAKE: &str = "Test Maker";
/// Model of the archive written by [`write_test_gdtf`].
pub(crate) const TEST_GDTF_MODEL: &str = "Test Wash";
/// Only DMX mode of the archive written by [`write_test_gdtf`].
pub(crate) const TEST_GDTF_MODE: &str = "Default";

/// Writes a minimal GDTF archive with one geometry and one dimmer channel to `path`.
pub(crate) fn write_test_gdtf(path: &Path) {
    let mut zip = zip::ZipWriter::new(std::fs::File::create(path).expect("GDTF file"));
    zip.start_file("description.xml", zip::write::SimpleFileOptions::default())
        .expect("GDTF description entry");
    zip.write_all(
        br#"<?xml version="1.0" encoding="UTF-8"?>
<GDTF DataVersion="1.2"><FixtureType Name="TestWash" ShortName="Wash" LongName="Test Wash" Manufacturer="Test Maker" Description="Test" FixtureTypeID="00000000-0000-0000-0000-000000000002">
<AttributeDefinitions><FeatureGroups><FeatureGroup Name="Dimmer" Pretty="Dimmer"><Feature Name="Dimmer"/></FeatureGroup></FeatureGroups><Attributes><Attribute Name="Dimmer" Pretty="Dim" Feature="Dimmer.Dimmer" PhysicalUnit="LuminousIntensity"/></Attributes></AttributeDefinitions>
<Geometries><Geometry Name="Base" Position="{1,0,0,0}{0,1,0,0}{0,0,1,0}{0,0,0,1}"/></Geometries>
<DMXModes><DMXMode Name="Default" Description="Test" Geometry="Base"><DMXChannels>
<DMXChannel DMXBreak="1" Offset="1" InitialFunction="Base_Dimmer.Dimmer.Dimmer" Highlight="255/1" Geometry="Base"><LogicalChannel Attribute="Dimmer"><ChannelFunction Name="Dimmer" Attribute="Dimmer" DMXFrom="0/1" Default="0/1" PhysicalFrom="0" PhysicalTo="1"/></LogicalChannel></DMXChannel>
</DMXChannels></DMXMode></DMXModes>
</FixtureType></GDTF>"#,
    )
    .expect("GDTF description content");
    zip.finish().expect("GDTF archive");
    crate::GdtfMetadata::from_file(path).expect("test GDTF should parse");
}
