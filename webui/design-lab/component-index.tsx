// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ArrowRightIcon } from "@squidlab/phosphor-solid/arrow-right";
import { createMemo, For } from "solid-js";
import { Button } from "../components/ui/visual-language/button";
import "./component-index.css";

/** General interface patterns; specialized catalog entries belong to Custom widgets. */
const coreDemoIds = new Set([
  "animations",
  "buttons",
  "command-palette",
  "menus",
  "docking",
  "input-forms",
  "popups",
  "selects",
  "shortcuts",
  "sliders",
  "switches",
  "toasts",
  "toolbars",
  "tooltips",
]);

/** Separates general UI patterns from specialized widgets while preserving each demo's navigation data. */
export function ComponentIndex<T extends { id: string; title: string }>(props: {
  demos: readonly T[];
  activeDemo: string | undefined;
  onOpen: (demo: T) => void;
}) {
  /** Sorts each category by its visible title without changing the shared demo registry. */
  const sections = createMemo(() =>
    [
      { title: "Core UI", core: true },
      { title: "Custom widgets", core: false },
    ].map((section) => ({
      title: section.title,
      demos: props.demos
        .filter((demo) => coreDemoIds.has(demo.id) === section.core)
        .sort((left, right) => left.title.localeCompare(right.title)),
    })),
  );

  return (
    <nav class="component-index control-group" aria-label="Component index">
      <h2>
        Components <span>{props.demos.length}</span>
      </h2>
      <For each={sections()}>
        {(section) => (
          <section class="component-index-section" aria-label={section.title}>
            <h3>
              {section.title} <span>{section.demos.length}</span>
            </h3>
            <For each={section.demos}>
              {(demo, index) => (
                <Button
                  aria-current={
                    props.activeDemo === demo.id ||
                    (demo.id === "groups" && props.activeDemo === "flows")
                      ? "page"
                      : undefined
                  }
                  onClick={() => props.onOpen(demo)}
                >
                  <span>{String(index() + 1).padStart(2, "0")}</span>
                  {demo.title}
                  <ArrowRightIcon size={13} />
                </Button>
              )}
            </For>
          </section>
        )}
      </For>
    </nav>
  );
}
