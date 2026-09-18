// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Types for the timeline components

export const ScrollMode = {
  FREE: "free",
  CENTER_LOCK: "center",
  FOLLOW: "follow",
} as const;

export type ScrollMode = (typeof ScrollMode)[keyof typeof ScrollMode];
