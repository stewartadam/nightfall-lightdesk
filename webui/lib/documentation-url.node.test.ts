// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { documentationUrl } from "./documentation-url";

const template = "https://nightfall.live/docs/{version}/";

/** Pre-release and build versions open their stable version's guide. */
test("documentation links target the stable version guide", () => {
  assert.equal(
    documentationUrl(template, "0.1.0-alpha.4"),
    "https://nightfall.live/docs/0.1.0/",
  );
  assert.equal(
    documentationUrl(template, "1.2.3+build.7"),
    "https://nightfall.live/docs/1.2.3/",
  );
  assert.equal(
    documentationUrl(template, "2.0.0"),
    "https://nightfall.live/docs/2.0.0/",
  );
});

/** A version string that is not semver still opens a guide rather than a broken address. */
test("documentation links fall back to the latest guide", () => {
  assert.equal(
    documentationUrl(template, "dev"),
    "https://nightfall.live/docs/latest/",
  );
});

/** The shipped project link keeps the version placeholder the app fills in. */
test("the configured documentation link is versioned", () => {
  const links = JSON.parse(
    readFileSync(
      join(
        process.env.NIGHTFALL_REPO_ROOT ?? process.cwd(),
        "config/project-links.json",
      ),
      "utf8",
    ),
  ) as { documentation: string };
  assert.equal(links.documentation, template);
});
