// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { macosIconSvg } from "./generate-app-icons.mjs";

/** The logo is nested unchanged inside the 824px body, so its artwork cannot drift. */
test("nests the logo on Apple's icon grid", () => {
  const logo =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="64">\n  <rect width="32" height="32" fill="#000"/>\n</svg>\n';
  const icon = macosIconSvg(logo);
  assert.match(icon, /^<svg [^>]*viewBox="0 0 1024 1024">/);
  assert.match(
    icon,
    /<svg x="100" y="100" width="824" height="824" xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 32 32">/,
  );
  assert.ok(icon.includes('<rect width="32" height="32" fill="#000"/>'));
  assert.doesNotMatch(icon, /width="64"/);
});

/** Text before the root element, such as an XML declaration, is dropped. */
test("drops content before the logo's root element", () => {
  const icon = macosIconSvg(
    '<?xml version="1.0"?>\n<svg viewBox="0 0 32 32"></svg>',
  );
  assert.doesNotMatch(icon, /<\?xml/);
});

/** A file without an SVG root is rejected rather than producing an empty icon. */
test("rejects input without a root svg element", () => {
  assert.throws(() => macosIconSvg("<g/>"), /no root <svg>/);
});
