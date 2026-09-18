// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type JSX, splitProps } from "solid-js";
import { ScrollArea } from "../../ui/scroll-area";
import {
  type CrudViewMode,
  createCrudViewEntrance,
} from "./crud-view-mode-toggle";

interface CrudScrollAreaProps extends JSX.HTMLAttributes<HTMLDivElement> {
  "aria-label": string;
  viewMode: CrudViewMode;
}

/** Fills panel space with a named scroll viewport while keeping card interactions on that viewport. */
export default function CrudScrollArea(props: CrudScrollAreaProps) {
  let element: HTMLDivElement | undefined;
  createCrudViewEntrance(
    () => props.viewMode,
    () => element,
  );
  const [local, viewport] = splitProps(props, [
    "children",
    "class",
    "viewMode",
    "ref",
  ]);
  return (
    <ScrollArea
      class="min-h-0 flex-1"
      viewportClass={local.class}
      viewportProps={{
        role: "region",
        tabIndex: 0,
        ...viewport,
        ref: (node) => {
          element = node;
          if (typeof local.ref === "function") local.ref(node);
        },
      }}
    >
      {local.children}
    </ScrollArea>
  );
}
