// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Resolve a logical JSON path to its stored gzip representation when present. */
export function resolveShowfileSnapshotPath(jsonPath: string): string;

/** Read JSON interchange text from either a plain or gzip snapshot. */
export function readShowfileJsonSync(jsonPath: string): string;
