// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal, For } from "solid-js";
import { Collapsible } from "../components/ui/collapsible";
import { Button } from "../components/ui/visual-language/button";
import "./widget-demos.css";

const SAMPLE_CUES = ["Preset wash", "Blackout", "Chase A", "Chase B"];

/** Shows bordered and plain disclosure sections, header actions, and controlled open state. */
export function CollapsibleDemo() {
  const [refreshes, setRefreshes] = createSignal(0);
  const [stageOpen, setStageOpen] = createSignal(true);
  const [houseOpen, setHouseOpen] = createSignal(false);
  /** Opens or closes both controlled sections together, like a panel's expand-all action. */
  const setAll = (open: boolean) => {
    setStageOpen(open);
    setHouseOpen(open);
  };
  return (
    <section class="properties lab-panel" aria-label="Collapsible examples">
      <div class="eyebrow">COLLAPSIBLE SECTIONS</div>
      <h2>Disclosure with header actions.</h2>
      <p class="field-help">
        Click a header or press Enter or Space on it to toggle. Counts and
        buttons beside the header never toggle the section.
      </p>
      <div class="widget-collapsible-stack">
        <Collapsible
          defaultOpen
          title={<span class="font-medium">Sequence 1: Opening</span>}
          actions={
            <>
              <span>{SAMPLE_CUES.length} cues</span>
              <Button
                size="compact"
                variant="subtle"
                onClick={() => setRefreshes(refreshes() + 1)}
              >
                Refresh
              </Button>
            </>
          }
          contentClass="p-3"
        >
          <ul class="text-sm">
            <For each={SAMPLE_CUES}>{(cue) => <li>{cue}</li>}</For>
          </ul>
        </Collapsible>
        <p class="field-help" role="status">
          Refreshed {refreshes()} {refreshes() === 1 ? "time" : "times"}
        </p>
        <Collapsible
          lazy
          title="Ungrouped cues"
          actions={<span>0 cues</span>}
          contentClass="p-3 text-sm"
        >
          Lazy content mounts only while the section is open.
        </Collapsible>
      </div>
      <div class="eyebrow">CONTROLLED</div>
      <div class="widget-alert-actions">
        <Button size="compact" onClick={() => setAll(true)}>
          Expand all
        </Button>
        <Button size="compact" onClick={() => setAll(false)}>
          Collapse all
        </Button>
      </div>
      <div class="widget-collapsible-stack">
        <Collapsible
          title="Stage fixtures"
          open={stageOpen()}
          onOpenChange={setStageOpen}
          contentClass="p-3 text-sm"
        >
          12 spots and 8 washes patched to universe 1.
        </Collapsible>
        <Collapsible
          title="House fixtures"
          open={houseOpen()}
          onOpenChange={setHouseOpen}
          contentClass="p-3 text-sm"
        >
          6 house-light dimmers patched to universe 2.
        </Collapsible>
      </div>
      <div class="eyebrow">PLAIN</div>
      <div class="widget-collapsible-stack">
        <Collapsible
          variant="plain"
          class="text-xs"
          title="Advanced expression"
        >
          <p class="field-help">
            Plain sections suit optional details inside forms and dialogs.
          </p>
        </Collapsible>
      </div>
    </section>
  );
}
