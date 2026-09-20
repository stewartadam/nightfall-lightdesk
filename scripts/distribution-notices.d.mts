// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/** Distribution metadata and original legal texts served by About. */
export interface NoticesDocument {
  schemaVersion: number;
  distribution: string;
  entries: {
    name: string;
    version: string;
    license: string;
    source: string;
    text: string;
  }[];
}
export const noticesJson: string;
export const noticesText: string;
/** Read installed production dependencies for the explicitly labelled development preview. */
export function developmentNotices(): NoticesDocument;
/** Render the same inventory as a standalone offline notice file. */
export function renderNotices(document: NoticesDocument): string;
/** Collect and package the actual web and optional desktop dependency inventories. */
export function packageNotices(
  outDir: string,
  target?: string,
  embeddedDemo?: boolean,
): void;
