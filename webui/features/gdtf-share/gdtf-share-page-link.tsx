// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ArrowSquareOutIcon } from "@squidlab/phosphor-solid/arrow-square-out";
import type { GdtfShareFixture } from "../../types";
import { gdtfSharePageUrl } from "./fixtures";

export interface GdtfSharePageLinkProps {
  /** The GDTF Share revision to open. */
  fixture: Pick<GdtfShareFixture, "manufacturer" | "fixture" | "rid">;
  /** Test id of the link. */
  "data-testid"?: string;
}

/**
 * An external-link icon that opens one revision's GDTF Share page in a new tab, placed
 * right after the text naming that revision.
 */
export function GdtfSharePageLink(props: GdtfSharePageLinkProps) {
  return (
    <a
      class="inline-flex translate-y-0.5 text-blue-300 hover:text-blue-200"
      href={gdtfSharePageUrl(props.fixture)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="View on GDTF Share"
      title="View on GDTF Share"
      data-testid={props["data-testid"]}
    >
      <ArrowSquareOutIcon class="size-3.5" aria-hidden />
    </a>
  );
}
