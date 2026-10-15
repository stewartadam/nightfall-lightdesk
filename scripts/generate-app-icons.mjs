// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const logoPath = fileURLToPath(
  new URL("../webui/public/logo.svg", import.meta.url),
);
const iconsDirectory = fileURLToPath(
  new URL("../desktop/app-tauri/icons/", import.meta.url),
);

/** Apple's app icon template: an 824px body centred in a 1024px canvas. */
const macosCanvas = 1024;
const macosBody = 824;

/**
 * Place the full-bleed logo on Apple's macOS icon grid.
 *
 * The logo's root `<svg>` becomes a nested viewport sized to the icon body, so the
 * artwork is never copied and any logo change flows into the macOS icon. A drop
 * shadow matching Apple's template is applied to the whole body.
 */
export function macosIconSvg(logoSvg) {
  const root = logoSvg.match(/<svg\b[^>]*>/);
  if (!root) throw new Error("logo.svg has no root <svg> element");
  const offset = (macosCanvas - macosBody) / 2;
  const nestedRoot = root[0]
    .replace(/\s(?:x|y|width|height)="[^"]*"/g, "")
    .replace(
      /^<svg\b/,
      `<svg x="${offset}" y="${offset}" width="${macosBody}" height="${macosBody}"`,
    );
  const nestedLogo = logoSvg
    .slice(root.index)
    .replace(root[0], nestedRoot)
    .trim();
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${macosCanvas} ${macosCanvas}">
  <defs>
    <filter id="macos-icon-shadow" x="-10%" y="-10%" width="120%" height="125%">
      <feDropShadow dx="0" dy="10" stdDeviation="10" flood-color="#000" flood-opacity="0.3"/>
    </filter>
  </defs>
  <g filter="url(#macos-icon-shadow)">
${nestedLogo}
  </g>
</svg>
`;
}

/** Run the Tauri CLI's icon generator for one source image and output directory. */
function tauriIcon(source, output) {
  execFileSync("pnpm", ["exec", "tauri", "icon", source, "-o", output], {
    stdio: "inherit",
  });
}

/**
 * Regenerate every desktop and mobile app icon from `webui/public/logo.svg`.
 *
 * Windows, Linux, iOS and Android icons use the full-bleed logo. macOS draws icons
 * exactly as supplied, so `icon.icns` is rendered from the logo placed on Apple's
 * grid; otherwise it appears larger than other apps in the Dock and app switcher.
 */
export function generateAppIcons(output = iconsDirectory) {
  tauriIcon(logoPath, output);
  const scratch = mkdtempSync(join(tmpdir(), "nightfall-macos-icon-"));
  try {
    const macosSource = join(scratch, "macos.svg");
    writeFileSync(macosSource, macosIconSvg(readFileSync(logoPath, "utf8")));
    tauriIcon(macosSource, join(scratch, "icons"));
    copyFileSync(
      join(scratch, "icons", "icon.icns"),
      join(output, "icon.icns"),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  generateAppIcons();
}
