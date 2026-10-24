// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildProfile,
  importColors,
  midiValue,
  parseQxi,
} from "./import-qlcplus-led-colors.mjs";

/** Excerpt of QLC+'s original Launchpad input profile, with its doubled color values. */
const LAUNCHPAD_QXI = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE InputProfile>
<InputProfile xmlns="http://www.qlcplus.org/InputProfile">
 <Creator>
  <Name>Q Light Controller Plus</Name>
  <Version>4.13.1</Version>
  <Author>Maikel Boerebach+Jan Fries</Author>
 </Creator>
 <Manufacturer>Novation</Manufacturer>
 <Model>Launchpad</Model>
 <Type>MIDI</Type>
 <Channel Number="104">
  <Name>Up Button</Name>
  <Type>Button</Type>
 </Channel>
 <ColorTable>
  <Color Value="22" Label="Flash Red Full" RGB="#FF0000"/>
  <Color Value="24" Label="Off" RGB="#000000"/>
  <Color Value="30" Label="Red Full" RGB="#ff0000"/>
  <Color Value="120" Label="Green Full" RGB="#00ff00"/>
  <Color Value="126" Label="Amber &amp; Co" RGB="#ffaa00"/>
 </ColorTable>
</InputProfile>
`;

/** Verifies QLC+'s 0-255 values map onto MIDI data bytes, including 255 to 127. */
test("midiValue halves QLC+ values", () => {
  assert.equal(midiValue(24), 12);
  assert.equal(midiValue(120), 60);
  assert.equal(midiValue(255), 127);
  assert.throws(() => midiValue(256));
});

/**
 * Verifies a color table becomes halved values with lowercase swatches, decoded labels and
 * blink flags read from the label.
 */
test("parseQxi reads the color table", () => {
  const parsed = parseQxi(LAUNCHPAD_QXI);

  assert.equal(parsed.manufacturer, "Novation");
  assert.equal(parsed.model, "Launchpad");
  assert.equal(parsed.authors, "Maikel Boerebach+Jan Fries");
  assert.deepEqual(parsed.colors, [
    { name: "Flash Red Full", value: 11, swatch: "#ff0000", blink: true },
    { name: "Off", value: 12, swatch: "#000000", blink: false },
    { name: "Red Full", value: 15, swatch: "#ff0000", blink: false },
    { name: "Green Full", value: 60, swatch: "#00ff00", blink: false },
    { name: "Amber & Co", value: 63, swatch: "#ffaa00", blink: false },
  ]);
});

/**
 * Verifies a repeated value is dropped and a repeated label with a new value keeps its
 * color under a name carrying the value, since profiles list each once.
 */
test("parseQxi drops repeated values and renames repeated labels", () => {
  const parsed = parseQxi(`<Author>A</Author><Model>M</Model><ColorTable>
  <Color Value="2" Label="Green" RGB="#00ff00"/>
  <Color Value="3" Label="Lime" RGB="#40ff00"/>
  <Color Value="255" Label="Green" RGB="#00ff00"/>
  <Color Value="200" Label="Green (127)" RGB="#00ff00"/>
  <Color Value="202" Label="Red > Amber" RGB="#ff5500"/>
</ColorTable>`);

  assert.deepEqual(
    parsed.colors.map(({ name, value }) => [name, value]),
    [
      ["Green", 1],
      ["Green (127)", 127],
      ["Green (127) (100)", 100],
      ["Red > Amber", 101],
    ],
  );
  assert.deepEqual(
    parsed.skipped.map(({ name, duplicateOf }) => [name, duplicateOf]),
    [["Lime", "Green"]],
  );
  assert.deepEqual(parsed.renamed, [
    { from: "Green", to: "Green (127)" },
    { from: "Green (127)", to: "Green (127) (100)" },
  ]);
});

/**
 * Verifies profiles that would match every port, credit nobody or list no colors, and
 * entries with a blank value, are rejected instead of written.
 */
test("parseQxi rejects incomplete profiles", () => {
  const entry = '<Color Value="2" Label="Green" RGB="#00ff00"/>';
  assert.throws(() => parseQxi("<InputProfile/>"), /no ColorTable/);
  assert.throws(
    () =>
      parseQxi("<Author>A</Author><Model>M</Model><ColorTable></ColorTable>"),
    /is empty/,
  );
  assert.throws(
    () => parseQxi(`<Author>A</Author><ColorTable>${entry}</ColorTable>`),
    /no Model/,
  );
  assert.throws(
    () => parseQxi(`<Model>M</Model><ColorTable>${entry}</ColorTable>`),
    /no Author/,
  );
  assert.throws(
    () =>
      parseQxi(
        '<Author>A</Author><Model>M</Model><ColorTable><Color Value="" Label="Red" RGB="#f00"/></ColorTable>',
      ),
    /incomplete/,
  );
});

/**
 * Verifies a new profile credits QLC+, starts with feedback off and placeholder port
 * matching, and picks off, on and held defaults from the imported colors.
 */
test("buildProfile seeds a new profile", () => {
  const profile = buildProfile(
    parseQxi(LAUNCHPAD_QXI),
    "Novation-Launchpad.qxi",
  );

  assert.equal(profile.id, "novation.launchpad");
  assert.equal(profile.name, "Novation Launchpad");
  assert.deepEqual(profile.source, {
    project: "QLC+",
    file: "Novation-Launchpad.qxi",
    authors: "Maikel Boerebach+Jan Fries",
    license: "Apache-2.0",
  });
  assert.deepEqual(profile.ports, { match: ["launchpad"], exclude: [] });
  assert.equal(profile.feedback, false);
  assert.deepEqual(profile.colors[1], {
    name: "Off",
    value: 12,
    swatch: "#000000",
  });
  assert.deepEqual(profile.defaults, {
    off: "Off",
    on: "Red Full",
    held: "Flash Red Full",
  });
});

/**
 * Verifies updating a hand-written profile keeps its other fields, its names, swatches and
 * ramps for values QLC+ also lists, and its colors QLC+ lacks.
 */
test("buildProfile merges into an existing profile", () => {
  const existing = {
    id: "novation.launchpad",
    name: "Novation Launchpad",
    ports: { match: ["launchpad"], exclude: ["mk2"] },
    feedback: true,
    init: [[176, 0, 0]],
    release: [],
    colors: [
      { name: "Green", value: 60, swatch: "#2cff3c", ramp: [28, 44, 60] },
      { name: "Orange", value: 47, swatch: "#ff6a1a" },
    ],
    defaults: { off: "Off", on: "Green", held: "Green" },
  };
  const profile = buildProfile(
    parseQxi(LAUNCHPAD_QXI),
    "Novation-Launchpad.qxi",
    existing,
  );

  assert.deepEqual(profile.ports, existing.ports);
  assert.deepEqual(profile.init, existing.init);
  assert.equal(profile.feedback, true);
  assert.deepEqual(
    profile.colors.map(({ name, value }) => [name, value]),
    [
      ["Flash Red Full", 11],
      ["Off", 12],
      ["Red Full", 15],
      ["Green", 60],
      ["Amber & Co", 63],
      ["Orange", 47],
    ],
  );
  assert.deepEqual(profile.colors[3], existing.colors[0]);
  assert.equal(profile.source.project, "QLC+");
});

/**
 * Verifies an imported label that a hand-written color already uses at another value gets
 * its value appended, and that a hand-written profile repeating a value is refused.
 */
test("buildProfile keeps merged color names distinct", () => {
  const existing = {
    colors: [{ name: "Off", value: 0, swatch: "#000000" }],
    defaults: { off: "Off", on: "Off", held: "Off" },
  };
  const profile = buildProfile(parseQxi(LAUNCHPAD_QXI), "x.qxi", existing);

  assert.deepEqual(profile.colors.map(({ name }) => name).slice(0, 2), [
    "Flash Red Full",
    "Off (12)",
  ]);
  assert.throws(
    () =>
      buildProfile(parseQxi(LAUNCHPAD_QXI), "x.qxi", {
        colors: [
          { name: "A", value: 1, swatch: "#000000" },
          { name: "B", value: 1, swatch: "#000000" },
        ],
      }),
    /two colors use the value 1/,
  );
});

/**
 * Verifies the file entry point writes the converted profile as indented JSON with one
 * color per line, and updates rather than recreates it on a second run.
 */
test("importColors writes the profile file", () => {
  const directory = mkdtempSync(join(tmpdir(), "qlcplus-import-"));
  try {
    const input = join(directory, "Novation-Launchpad.qxi");
    const output = join(directory, "profile.json");
    writeFileSync(input, LAUNCHPAD_QXI);

    const result = importColors(input, output);

    assert.equal(result.created, true);
    const text = readFileSync(output, "utf8");
    assert.deepEqual(JSON.parse(text), result.profile);
    assert.match(
      text,
      /\n {4}\{"name":"Off","value":12,"swatch":"#000000"\},\n/,
    );
    assert.equal(importColors(input, output).created, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
