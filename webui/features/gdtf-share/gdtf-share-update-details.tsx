// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Show } from "solid-js";
import { Button } from "../../components/ui/visual-language/button";
import type { GdtfShareUpdate } from "../../types";
import { formatDate } from "./format";
import { GdtfSharePageLink } from "./gdtf-share-page-link";

export interface GdtfShareUpdateDetailsProps {
  /** The newer revision found for the selected library file. */
  update: GdtfShareUpdate;
  /**
   * Label of the one action the section offers, such as "Update…", or none when there
   * is nothing to do.
   */
  actionLabel?: string;
  /** Runs the section's action. */
  onAction: () => void;
}

/**
 * Tells the user a newer GDTF Share revision of the selected library file exists: which
 * revision, with a link to its GDTF Share page, and when GDTF Share last changed it. The
 * caller decides the single action it offers, such as updating or showing the library copy.
 */
export function GdtfShareUpdateDetails(props: GdtfShareUpdateDetailsProps) {
  return (
    <div class="space-y-2 text-sm" data-testid="gdtf-share-update">
      <h3 class="font-medium">Update on GDTF Share</h3>
      <p>
        {props.update.latest.revision || "A new revision"} is available{" "}
        <GdtfSharePageLink
          fixture={props.update.latest}
          data-testid="gdtf-share-update-link"
        />
        <span class="text-neutral-400">
          {" "}
          · {formatDate(props.update.latest.last_modified)}
        </span>
      </p>
      <Show when={props.actionLabel}>
        {(label) => (
          <Button
            size="compact"
            variant="primary"
            onClick={() => props.onAction()}
            data-testid="gdtf-share-update-action"
          >
            {label()}
          </Button>
        )}
      </Show>
    </div>
  );
}
