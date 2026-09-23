// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { GuideContent, GuidePrerequisite } from "./lessons";

/** Reveals ordered content through the first unmet prerequisite, including its opening controls. */
export function visibleGuideContent(
  content: GuideContent[],
  ready: (item: GuidePrerequisite) => boolean,
): GuideContent[] {
  const blocked = content.findIndex(
    (item) => item.type === "prerequisite" && !ready(item),
  );
  return blocked < 0 ? content : content.slice(0, blocked + 1);
}
