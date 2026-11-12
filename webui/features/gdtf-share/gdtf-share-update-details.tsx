// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ArrowSquareOutIcon } from "@squidlab/phosphor-solid/arrow-square-out";
import { Show } from "solid-js";
import { Button } from "../../components/ui/visual-language/button";
import type { GdtfShareUpdate } from "../../types";
import { gdtfSharePageUrl } from "./fixtures";
import { formatDate } from "./format";

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
 * revision, when GDTF Share last changed it, and a link to its page there. The caller
 * decides the single action it offers, such as updating or showing the library copy.
 */
export function GdtfShareUpdateDetails(props: GdtfShareUpdateDetailsProps) {
  return (
    <div class="space-y-2 text-sm" data-testid="gdtf-share-update">
      <h3 class="font-medium">Update on GDTF Share</h3>
      <p>
        {props.update.latest.revision || "A new revision"} is available
        <span class="text-neutral-400">
          {" "}
          · {formatDate(props.update.latest.last_modified)} · this file is{" "}
          {props.update.installed?.revision || "an older revision"}
        </span>
      </p>
      <div class="flex items-center gap-3">
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
        <a
          class="inline-flex items-center gap-1 text-blue-300 underline"
          href={gdtfSharePageUrl(props.update.latest)}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="gdtf-share-update-link"
        >
          View on GDTF Share
          <ArrowSquareOutIcon class="size-3.5" aria-hidden />
        </a>
      </div>
    </div>
  );
}
