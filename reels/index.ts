// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { gdtfShareReel } from "./gdtf-share/edit";
import type { ReelDefinition } from "./kit/shared/edit";

/** Every reel the renderer can cut, one per folder beside `kit/`. */
export const REELS: ReelDefinition[] = [gdtfShareReel];
