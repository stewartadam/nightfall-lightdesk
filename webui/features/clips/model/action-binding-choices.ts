// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { normalizeFixtureUid } from "../../../lib/binding-utils";
import type { ClipMap } from "../../../state/appStores";
import type {
  ActionBindingChoices,
  ActionBindingOption,
} from "../../action-mapping";

/** Builds clip-owned argument choices and resolves saved UID bindings without numeric-ID fallback. */
export function buildClipActionBindingChoices(
  clips: ClipMap,
): ActionBindingChoices[] {
  return (
    [
      ["clip.start", "StartClip"],
      ["clip.stop", "StopClip"],
      ["clip.go", "AdvanceSequence"],
    ] as const
  ).map(([actionId, legacyTimelineType]) => {
    const options: ActionBindingOption[] = Object.values(clips)
      .sort(([left], [right]) => left.identifiers.id - right.identifiers.id)
      .map(([clip]) => {
        const uid = normalizeFixtureUid(clip.identifiers.uid);
        return {
          label: `${clip.identifiers.id}: ${clip.identifiers.label}`,
          action: {
            id: actionId,
            arguments: { target: { type: "Uid", data: uid } },
          },
          timelinePresentation: { type: legacyTimelineType, data: uid },
        };
      });
    const byUid = new Map(
      options.map((option) => [option.timelinePresentation!.data, option]),
    );
    return {
      actionId,
      legacyTimelineType,
      options,
      /** Resolves only the persistent target captured in this domain's saved argument format. */
      resolve(reference) {
        if (reference.id !== actionId) return undefined;
        const args = reference.arguments;
        if (!args || typeof args !== "object" || !("target" in args))
          return undefined;
        const target = args.target;
        if (
          !target ||
          typeof target !== "object" ||
          !("type" in target) ||
          target.type !== "Uid" ||
          !("data" in target) ||
          typeof target.data !== "string"
        )
          return undefined;
        return byUid.get(normalizeFixtureUid(target.data));
      },
    };
  });
}
