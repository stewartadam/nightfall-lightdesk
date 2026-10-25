// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ArrowFatLinesRightIcon } from "@squidlab/phosphor-solid/arrow-fat-lines-right";
import { For, Match, Show, Switch } from "solid-js";
import { OPEN_COMMAND_PALETTE_SHORTCUT } from "../../components/providers/command-registry";
import { KbdShortcut } from "../../components/ui/kbd";
import { Button } from "../../components/ui/visual-language/button";
import { documentationPageUrl } from "../../lib/feedback";
import {
  type PanelComponentName,
  panelDefinitionByName,
} from "../../lib/panel-definitions";
import {
  CLEAR_PROGRAMMER_SHORTCUT,
  typeIntoCommandLine,
} from "../command-line";
import { stopAllPlayback } from "./cleanup";
import type { GuideContent } from "./lessons";

// TODO: Replace shortcut placeholders with action references so shortcuts can be discovered and injected automatically.
const lessonShortcuts: Record<string, string> = {
  "{command-palette-shortcut}": OPEN_COMMAND_PALETTE_SHORTCUT,
  "{clear-shortcut}": CLEAR_PROGRAMMER_SHORTCUT,
};

/** Expands shortcut placeholders in any text block using the actual platform binding. */
function GuideText(props: { text: string }) {
  return (
    <For
      each={props.text.split(
        /(\{command-palette-shortcut\}|\{clear-shortcut\})/g,
      )}
    >
      {(text) => (
        <Show when={lessonShortcuts[text]} fallback={text}>
          {(shortcut) => (
            <span class="nf-guide-inline-shortcut">
              <KbdShortcut shortcut={shortcut()} size="compact" />
            </span>
          )}
        </Show>
      )}
    </For>
  );
}

/** Renders one authored block without imposing an order on surrounding lesson content. */
export function GuideContentItem(props: {
  item: GuideContent;
  panelVisible: (name: PanelComponentName) => boolean;
  /** Reports a panel already active in Dockview, so its button reveals it rather than opening it. */
  panelOpen: (name: PanelComponentName) => boolean;
  timelineVisible: () => boolean;
  canOpenPanels: boolean;
  canOpenTimeline: boolean;
  openPanel: (name: PanelComponentName) => void;
  openTimeline: () => void;
  playbackRunning: boolean;
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
                  Open Timeline 1: Lo-fi
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
                    {props.panelOpen(name) ? "Show" : "Open"}{" "}
                    {panelDefinitionByName(name).title}
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
                    aria-label="Type command"
                    title="Type into the command line"
                    onClick={() => typeIntoCommandLine(command())}
                  >
                    <ArrowFatLinesRightIcon class="size-4" aria-hidden />
                  </Button>
                </div>
              )}
            </Show>
          </div>
        )}
      </Match>
      <Match when={props.item.type === "stop-playback"}>
        <div class="nf-guide-shortcuts">
          <Button
            size="compact"
            disabled={!props.playbackRunning}
            onClick={stopAllPlayback}
          >
            Stop all playback
          </Button>
        </div>
      </Match>
      <Match when={props.item.type === "details" && props.item}>
        {(item) => (
          <details>
            <summary>{item().title}</summary>
            <p>
              <GuideText text={item().text} />
            </p>
            <Show when={item().guidePage}>
              {(page) => (
                <p>
                  <a
                    href={documentationPageUrl(page())}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="underline"
                  >
                    Read more in the user guide
                  </a>
                </p>
              )}
            </Show>
          </details>
        )}
      </Match>
    </Switch>
  );
}
