// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Seeds a controller LED profile's colors from a QLC+ input profile.
 *
 * QLC+ (Apache-2.0) ships input profiles (`resources/inputprofiles/*.qxi`) whose
 * `ColorTable` names the LED values a controller understands. This script converts that
 * table into the `colors` of a profile in `crates/input_midi/profiles/`:
 *
 *   node scripts/import-qlcplus-led-colors.mjs <input.qxi> <profile.json>
 *   pnpm exec biome format --write <profile.json>
 *
 * An existing profile keeps everything except its colors; each color it already lists
 * keeps its name, swatch and ramp, and hand-added colors QLC+ lacks are kept. A missing
 * profile is created with placeholder port matching and feedback off; port names, init and
 * release messages, ramps and the dimmable flag are then written by hand, and the file is
 * added to `BUNDLED_PROFILES`. The output can also be an existing shared palette in
 * `profiles/palettes/` (only `id`, `source` and `colors`), which profiles name by id.
 * QLC+'s `MidiChannelTable` (blinking or brightness chosen by channel) is not imported; a
 * profile's hand-written `ledChannels` can send a range of notes on a fixed channel instead.
 *
 * Converted profiles name their QLC+ file and authors in `source`, and distributions carry
 * QLC+'s copyright and license through its entry in `config/notices/supplements.json`.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const XML_ENTITIES = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  quot: '"',
};

/**
 * Replaces the XML entities QLC+ writes in attribute and element text, including numeric
 * character references.
 */
function decodeXml(text) {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/giu, (entity, name) => {
    if (name.startsWith("#x") || name.startsWith("#X"))
      return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith("#"))
      return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return XML_ENTITIES[name] ?? entity;
  });
}

/** Returns the decoded attributes of one XML start tag as a plain object. */
function attributes(tag) {
  const result = {};
  for (const [, name, , value] of tag.matchAll(
    /([A-Za-z_][\w.-]*)\s*=\s*(["'])(.*?)\2/gsu,
  ))
    result[name] = decodeXml(value);
  return result;
}

/** Returns the trimmed, decoded text of the first `<name>` element, or undefined. */
function elementText(xml, name) {
  const match = xml.match(new RegExp(`<${name}>([^<]*)</${name}>`, "u"));
  return match ? decodeXml(match[1]).trim() : undefined;
}

/**
 * Converts a QLC+ color value to the MIDI data byte the controller receives.
 *
 * QLC+ scales feedback values to 0-255 and halves them on output, so 24 sends 12 and 255
 * sends 127.
 */
export function midiValue(qlcValue) {
  if (!Number.isInteger(qlcValue) || qlcValue < 0 || qlcValue > 255)
    throw new Error(`QLC+ color value ${qlcValue} is not between 0 and 255`);
  return qlcValue >> 1;
}

/**
 * Parses a QLC+ input profile into its manufacturer, model, authors and LED colors.
 *
 * Colors keep the table's order with values converted to MIDI data bytes. A profile lists
 * each value and name once, so a later entry repeating an earlier entry's value is dropped
 * and reported in `skipped`, and one repeating only its label gets the value appended to
 * its name and is reported in `renamed`. Missing model, author or colors are errors, since
 * the profile would match every port or fail validation.
 */
export function parseQxi(xml) {
  const table = xml.match(/<ColorTable>([\s\S]*?)<\/ColorTable>/u);
  if (!table) throw new Error("the QLC+ profile has no ColorTable");
  const colors = [];
  const skipped = [];
  const renamed = [];
  const taken = new Set();
  for (const [tag] of table[1].matchAll(
    /<Color\b(?:[^>"']|"[^"]*"|'[^']*')*>/gu,
  )) {
    const { Value, Label, RGB } = attributes(tag);
    if (!/^\d+$/u.test(Value?.trim() ?? "") || !Label?.trim() || !RGB?.trim())
      throw new Error(`incomplete ColorTable entry ${tag}`);
    const color = {
      name: Label.trim(),
      value: midiValue(Number(Value)),
      swatch: RGB.trim().toLowerCase(),
      blink: /\b(blink|flash|puls)/iu.test(Label),
    };
    const sameValue = colors.find((other) => other.value === color.value);
    if (sameValue) {
      skipped.push({ ...color, duplicateOf: sameValue.name });
      continue;
    }
    const name = uniqueName(color.name, color.value, taken);
    if (name !== color.name) renamed.push({ from: color.name, to: name });
    color.name = name;
    taken.add(name);
    colors.push(color);
  }
  if (colors.length === 0)
    throw new Error("the QLC+ profile's ColorTable is empty");
  const model = elementText(xml, "Model");
  const authors = elementText(xml, "Author");
  if (!model) throw new Error("the QLC+ profile names no Model");
  if (!authors) throw new Error("the QLC+ profile names no Author to credit");
  return {
    manufacturer: elementText(xml, "Manufacturer") ?? "",
    model,
    authors,
    colors,
    skipped,
    renamed,
  };
}

/**
 * Returns `name`, or when another color already uses it, the name with the color's value
 * appended (and a counter if even that is taken), so every color keeps a distinct name.
 */
function uniqueName(name, value, taken) {
  if (!taken.has(name)) return name;
  let candidate = `${name} (${value})`;
  for (let count = 2; taken.has(candidate); count += 1)
    candidate = `${name} (${value}, ${count})`;
  return candidate;
}

/**
 * Throws when two colors share a name or value, naming the first repeat, since the engine
 * rejects such a profile at startup.
 */
function assertDistinct(colors) {
  for (const key of ["name", "value"]) {
    const seen = new Set();
    for (const color of colors) {
      if (seen.has(color[key]))
        throw new Error(
          `two colors use the ${key} ${JSON.stringify(color[key])}`,
        );
      seen.add(color[key]);
    }
  }
}

/** Returns a lowercase identifier fragment such as `launchpad-mk2` for a display name. */
function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

/**
 * Picks placeholder default colors for a new profile: the color at value 0 (or named Off)
 * when idle, green (or the first other steady color) when on, and the first blinking
 * color (or the on color) while held.
 */
function placeholderDefaults(colors) {
  const off =
    colors.find((color) => color.value === 0) ??
    colors.find((color) => /^off$/iu.test(color.name)) ??
    colors[0];
  const steady = colors.filter((color) => color !== off && !color.blink);
  const on =
    steady.find((color) => /^green$/iu.test(color.name)) ?? steady[0] ?? off;
  const held = colors.find((color) => color.blink) ?? on;
  return { off: off.name, on: on.name, held: held.name };
}

/** Writes a color in the profile file's key order, leaving out a false `blink`. */
function profileColor({ name, value, swatch, blink, ramp }) {
  return {
    name,
    value,
    swatch,
    ...(blink ? { blink } : {}),
    ...(ramp?.length ? { ramp } : {}),
  };
}

/**
 * Builds the profile JSON for a parsed QLC+ profile.
 *
 * With an `existing` profile, every field but `colors` and `source` is kept, colors it
 * already lists by value keep their hand-written name, swatch and ramp, and colors QLC+
 * does not list stay after the imported ones; an imported name a hand-written color already
 * uses gets its value appended. Without one, a new profile gets placeholder port matching
 * on the model name and feedback off. Throws when the result repeats a name or value.
 */
export function buildProfile(parsed, file, existing) {
  const source = {
    project: "QLC+",
    file,
    authors: parsed.authors,
    license: "Apache-2.0",
  };
  if (existing) {
    const written = existing.colors ?? [];
    assertDistinct(written);
    const taken = new Set(written.map((color) => color.name));
    const imported = parsed.colors.map((color) => {
      const known = written.find((other) => other.value === color.value);
      if (known)
        return profileColor({
          ...color,
          ...known,
          blink: known.blink ?? false,
        });
      const name = uniqueName(color.name, color.value, taken);
      taken.add(name);
      return profileColor({ ...color, name });
    });
    const handOnly = written.filter(
      (color) => !parsed.colors.some((other) => other.value === color.value),
    );
    const colors = [...imported, ...handOnly];
    assertDistinct(colors);
    return { ...existing, colors, source };
  }
  const name = [parsed.manufacturer, parsed.model].filter(Boolean).join(" ");
  assertDistinct(parsed.colors);
  return {
    id: [slug(parsed.manufacturer), slug(parsed.model)]
      .filter(Boolean)
      .join("."),
    name,
    source,
    ports: { match: [parsed.model.toLowerCase()], exclude: [] },
    feedback: false,
    init: [],
    release: [],
    colors: parsed.colors.map(profileColor),
    defaults: placeholderDefaults(parsed.colors),
  };
}

/**
 * Serializes a profile with two-space indents and each color on one line, as the
 * hand-written profiles list them; Biome's JSON formatter keeps that layout.
 */
export function formatProfile(profile) {
  const colors = profile.colors.map((color) => JSON.stringify(color));
  const text = JSON.stringify(
    { ...profile, colors: colors.map((_, index) => `\u0000${index}`) },
    null,
    2,
  );
  return `${text.replace(/"\\u0000(\d+)"/gu, (_, index) => colors[Number(index)])}\n`;
}

/** Converts `inputPath` into the profile at `outputPath` and reports what changed. */
export function importColors(inputPath, outputPath) {
  const parsed = parseQxi(readFileSync(inputPath, "utf8"));
  const existing = existsSync(outputPath)
    ? JSON.parse(readFileSync(outputPath, "utf8"))
    : undefined;
  const profile = buildProfile(parsed, basename(inputPath), existing);
  writeFileSync(outputPath, formatProfile(profile));
  return {
    profile,
    created: !existing,
    skipped: parsed.skipped,
    renamed: parsed.renamed,
  };
}

/** Runs the command line entry point. */
function main(args) {
  if (args.length !== 2) {
    process.stderr.write(
      "usage: node scripts/import-qlcplus-led-colors.mjs <input.qxi> <profile.json>\n",
    );
    return 2;
  }
  const outputPath = resolve(args[1]);
  const { profile, created, skipped, renamed } = importColors(
    resolve(args[0]),
    outputPath,
  );
  process.stdout.write(
    `${created ? "Created" : "Updated"} ${outputPath} with ${profile.colors.length} colors.\n`,
  );
  for (const color of skipped)
    process.stdout.write(
      `Skipped "${color.name}" (value ${color.value}): repeats "${color.duplicateOf}".\n`,
    );
  for (const { from, to } of renamed)
    process.stdout.write(`Renamed a repeated "${from}" to "${to}".\n`);
  if (created)
    process.stdout.write(
      "Write ports, init, release, defaults and ramps by hand, then add the file to BUNDLED_PROFILES.\n",
    );
  return 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = main(process.argv.slice(2));
