// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal, For } from "solid-js";
import { render } from "solid-js/web";
import { Dialog, DialogBody } from "../../components/ui/dialog";
import { Button } from "../../components/ui/visual-language/button";
import "../../index.css";

/**
 * Mounts two shared info dialogs, the second opened from a button in the first, so specs can
 * check how stacked dialogs share focus, Escape and Enter. The inner dialog holds a search field
 * and several buttons, and the outer one several buttons around the opener.
 */
function StackedDialogs() {
  const [outerOpen, setOuterOpen] = createSignal(true);
  const [innerOpen, setInnerOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  return (
    <>
      <Dialog
        kind="info"
        isOpen={outerOpen()}
        title="Outer dialog"
        closeLabel="Close outer dialog"
        onDismiss={() => setOuterOpen(false)}
      >
        <DialogBody class="space-y-3">
          <h3>Outer content</h3>
          <For each={["First", "Second"]}>
            {(name) => <Button type="button">{name} outer action</Button>}
          </For>
          <Button type="button" onClick={() => setInnerOpen(true)}>
            Open inner dialog
          </Button>
        </DialogBody>
      </Dialog>
      <Dialog
        kind="info"
        isOpen={outerOpen() && innerOpen()}
        title="Inner dialog"
        closeLabel="Close inner dialog"
        onDismiss={() => setInnerOpen(false)}
      >
        <DialogBody class="space-y-3">
          <input
            type="search"
            aria-label="Filter"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
          <For each={["First", "Second", "Third"]}>
            {(name) => <Button type="button">{name} inner action</Button>}
          </For>
        </DialogBody>
      </Dialog>
    </>
  );
}

render(() => <StackedDialogs />, document.getElementById("root")!);
