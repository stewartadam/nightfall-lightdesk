// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Fills the user guide address template with the guide folder for an app version. Pre-releases
 * and builds share their stable version's guide, so `0.1.0-alpha.4` opens the `0.1.0` guide.
 * A version that is not semver leaves the template's `{version}` as `latest`.
 */
export function documentationUrl(template: string, version: string): string {
  const guide = /^v?(\d+\.\d+\.\d+)(?:[-+].*)?$/.exec(version)?.[1] ?? "latest";
  return template.split("{version}").join(guide);
}
