// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Table for the CRC-32 checksum zip entries carry. */
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

/** Computes the CRC-32 of `bytes`, as zip archives record it. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Packs one uncompressed file into a zip archive, which is all a GDTF file needs. */
function storedZip(name: string, content: Uint8Array): Buffer {
  const fileName = Buffer.from(name, "utf8");
  const crc = crc32(content);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(fileName.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  const centralOffset = local.length + fileName.length + content.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + fileName.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, fileName, content, central, fileName, end]);
}

/** What the generated GDTF fixture is called and which fixture type it is. */
export interface TestGdtfFixture {
  manufacturer: string;
  model: string;
  fixtureTypeId: string;
}

/**
 * Builds a minimal GDTF archive for `fixture`: a cube body with one wash beam and a single
 * one-channel dimmer mode named "Standard", enough for the library to list and preview it.
 */
export function testGdtfArchive(fixture: TestGdtfFixture): Buffer {
  const identity = `Name="${fixture.model}" ShortName="${fixture.model}" LongName="${fixture.model}" Manufacturer="${fixture.manufacturer}"`;
  const identityMatrix = "{1,0,0,0}{0,1,0,0}{0,0,1,0}{0,0,0,1}";
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GDTF DataVersion="1.2">
<FixtureType ${identity} Description="End-to-end test fixture" FixtureTypeID="${fixture.fixtureTypeId}" RefFT="" Thumbnail="">
<AttributeDefinitions>
<FeatureGroups>
<FeatureGroup Name="Dimmer" Pretty="Dimmer"><Feature Name="Dimmer"/></FeatureGroup>
</FeatureGroups>
<Attributes>
<Attribute Name="Dimmer" Pretty="Dim" Feature="Dimmer.Dimmer" PhysicalUnit="LuminousIntensity"/>
</Attributes>
</AttributeDefinitions>
<Wheels/>
<PhysicalDescriptions><Emitters/><DMXProfiles/></PhysicalDescriptions>
<Models>
<Model Name="Body" Length="0.3" Width="0.3" Height="0.3" PrimitiveType="Cube"/>
</Models>
<Geometries>
<Geometry Name="Body" Model="Body" Position="${identityMatrix}">
<Beam Name="Beam" Position="${identityMatrix}" LampType="LED" BeamType="Wash" BeamAngle="25" FieldAngle="30" LuminousFlux="1000" ColorTemperature="6000" BeamRadius="0.05"/>
</Geometry>
</Geometries>
<DMXModes>
<DMXMode Name="Standard" Geometry="Body">
<DMXChannels>
<DMXChannel DMXBreak="1" Offset="1" Highlight="None" Geometry="Beam">
<LogicalChannel Attribute="Dimmer" Snap="No" Master="None">
<ChannelFunction Name="Dimmer" Attribute="Dimmer" DMXFrom="0/1" Default="0/1" PhysicalFrom="0" PhysicalTo="1"/>
</LogicalChannel>
</DMXChannel>
</DMXChannels>
<Relations/>
<FTMacros/>
</DMXMode>
</DMXModes>
</FixtureType>
</GDTF>
`;
  return storedZip("description.xml", Buffer.from(xml, "utf8"));
}
