// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createMemo } from "solid-js";
import { normalizeFixtureUid } from "../../../lib/binding-utils";
import { timelines } from "../../../state/appStores";
import { buildArgumentTargetChoices } from "../../action-mapping";

/** Offers timeline transport targets using persistent identities. */
export function createTimelineActionBindingChoices() {
  const $timelines = useStore(timelines);
  /** Updates target labels and deletion state without changing saved references. */
  return createMemo(() => [
    buildArgumentTargetChoices(
      "timeline.toggle-playback",
      "timeline_uid",
      Object.values($timelines())
        .sort((a, b) => a.identifiers.id - b.identifiers.id)
        .map((timeline) => ({
          label: `${timeline.identifiers.id}: ${timeline.identifiers.label}`,
          value: normalizeFixtureUid(timeline.identifiers.uid),
        })),
      (value) =>
        typeof value === "string" ? normalizeFixtureUid(value) : value,
    ),
  ]);
}
