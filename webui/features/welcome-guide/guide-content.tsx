// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CopyIcon } from "@squidlab/phosphor-solid/copy";
import { For, Match, Show, Switch } from "solid-js";
import { OPEN_COMMAND_PALETTE_SHORTCUT } from "../../components/providers/command-registry";
import { ShortcutKeys } from "../../components/ui/shortcut-keys";
import { Button } from "../../components/ui/visual-language/button";
import {
  type PanelComponentName,
  panelDefinitionByName,
} from "../../lib/panel-definitions";
import type { GuideContent } from "./lessons";

/** Expands shortcut placeholders in any text block using the actual platform binding. */
function GuideText(props: { text: string }) {
  return (
    <For each={props.text.split("{command-palette-shortcut}")}>
      {(text, index) => (
        <>
          <Show when={index() > 0}>
            <span class="nf-guide-inline-shortcut">
              <ShortcutKeys shortcut={OPEN_COMMAND_PALETTE_SHORTCUT} />
            </span>
          </Show>
          {text}
        </>
      )}
    </For>
  );
}

/** Renders one authored block without imposing an order on surrounding lesson content. */
export function GuideContentItem(props: {
  item: GuideContent;
  panelVisible: (name: PanelComponentName) => boolean;
  timelineVisible: () => boolean;
  canOpenPanels: boolean;
  canOpenTimeline: boolean;
  openPanel: (name: PanelComponentName) => void;
  openTimeline: () => void;
  copyCommand: (command: string) => void;
}) {
  return (
    <Switch>
      <Match when={props.item.type === "text" && props.item}>
        {(item) => (
          <p>
            <GuideText text={item().text} />
          </p>
        )}
      </Match>
      <Match when={props.item.type === "prerequisite" && props.item}>
        {(item) => (
          <Show
            when={
              (item().sampleTimeline && !props.timelineVisible()) ||
              item().panels?.some((name) => !props.panelVisible(name))
            }
          >
            <div class="nf-guide-shortcuts">
              <Show when={item().sampleTimeline && !props.timelineVisible()}>
                <Button
                  size="compact"
                  onClick={props.openTimeline}
                  disabled={!props.canOpenTimeline}
                >
                  Open Timeline 1: Lo-Fi
                </Button>
              </Show>
              <For
                each={item().panels?.filter(
                  (name) => !props.panelVisible(name),
                )}
              >
                {(name) => (
                  <Button
                    size="compact"
                    onClick={() => props.openPanel(name)}
                    disabled={!props.canOpenPanels}
                  >
                    Open {panelDefinitionByName(name).title}
                  </Button>
                )}
              </For>
            </div>
          </Show>
        )}
      </Match>
      <Match when={props.item.type === "action" && props.item}>
        {(item) => (
          <div class="nf-guide-action">
            <Show when={item().title}>
              {(title) => (
                <strong>
                  <GuideText text={title()} />
                </strong>
              )}
            </Show>
            <p>
              <GuideText text={item().body} />
            </p>
            <Show when={item().command}>
              {(command) => (
                <div class="nf-guide-command">
                  <code>{command()}</code>
                  <Button
                    size="icon"
                    variant="subtle"
                    aria-label="Copy command"
                    title="Copy command"
                    onClick={() => props.copyCommand(command())}
                  >
                    <CopyIcon class="size-4" aria-hidden />
                  </Button>
                </div>
              )}
            </Show>
          </div>
        )}
      </Match>
      <Match when={props.item.type === "details" && props.item}>
        {(item) => (
          <details>
            <summary>{item().title}</summary>
            <p>
              <GuideText text={item().text} />
            </p>
          </details>
        )}
      </Match>
    </Switch>
  );
}
