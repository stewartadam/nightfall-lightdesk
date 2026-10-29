// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CaretRightIcon } from "@squidlab/phosphor-solid/caret-right";
import {
  batch,
  createEffect,
  For,
  type JSX,
  on,
  onCleanup,
  Show,
  untrack,
} from "solid-js";
import { playContentEntrance } from "./content-entrance";
import { DialogBackButton, useDialogPage } from "./dialog";
import { ScrollArea } from "./scroll-area";
import { SegmentedTabs } from "./segmented-tabs";
import { Button } from "./visual-language/button";
import "./sidebar-tabs.css";

/** Attributes the content panel takes from the layout currently presenting it. */
export interface SidebarTabsPanel {
  id: string;
  role: "tabpanel" | "region";
  "aria-labelledby"?: string;
  "aria-label"?: string;
}

interface SidebarTabsProps<T extends string> {
  id: string;
  /** Accessible name for the category list. */
  label: string;
  options: readonly { key: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  /**
   * Presents the categories as a list of their own that drills into one category at a time,
   * for screens too narrow for a sidebar beside the content.
   */
  stacked: boolean;
  /** Whether the stacked layout shows the selected category's page instead of the list. */
  pageOpen: boolean;
  onPageOpenChange: (open: boolean) => void;
  /** Hides the categories and shows the content alone, such as while search results span all of them. */
  hideNavigation?: boolean;
  /** Accessible name for the button returning from a page to the list. */
  backLabel?: string;
  /**
   * Renders the content panel once; spread or apply the accessor's attributes so the panel stays
   * labelled by whichever control currently presents it.
   */
  children: (panel: () => SidebarTabsPanel) => JSX.Element;
}

/**
 * Switches between categories of content. On wide screens the categories are a vertical tab list
 * beside the content. When stacked, they are a full-width list: choosing one slides its page in,
 * and a back button at the top left (in the enclosing dialog's header, when there is one) slides
 * back to the list.
 */
export function SidebarTabs<T extends string>(props: SidebarTabsProps<T>) {
  const contentId = `${props.id}-content`;
  const dialogPage = useDialogPage();
  const items: Partial<Record<string, HTMLButtonElement>> = {};
  let list: HTMLElement | undefined;
  let ownBack: HTMLButtonElement | undefined;

  /** Label of the selected category, used as the open page's title. */
  const selectedLabel = () =>
    props.options.find((option) => option.key === props.value)?.label ?? "";
  /** Whether the stacked layout is showing the category list. */
  const showingList = () =>
    props.stacked && !props.pageOpen && !props.hideNavigation;
  /** Whether the stacked layout is showing one category's page with a way back. */
  const showingPage = () =>
    props.stacked && props.pageOpen && !props.hideNavigation;
  /** Accessible name for the back button, defaulting to one built from the list's name. */
  const backLabel = () => props.backLabel ?? `Back to ${props.label}`;

  /**
   * Labels the panel by its tab beside a sidebar, or by the category name on a stacked page. With
   * the navigation hidden it is a plain region for the caller to label.
   */
  const panel = (): SidebarTabsPanel =>
    props.hideNavigation
      ? { id: contentId, role: "region" }
      : props.stacked
        ? { id: contentId, role: "region", "aria-label": selectedLabel() }
        : {
            id: contentId,
            role: "tabpanel",
            "aria-labelledby": `${props.id}-${props.value}`,
          };

  /** Slides into a category's page and moves focus to the back button. */
  function openPage(key: T) {
    batch(() => {
      props.onChange(key);
      props.onPageOpenChange(true);
    });
    requestAnimationFrame(() => {
      const document = list?.ownerDocument ?? window.document;
      const content = document.getElementById(contentId);
      if (content) playContentEntrance(content, { direction: "right" });
      if (dialogPage) dialogPage.focusBack();
      else ownBack?.focus();
    });
  }

  /** Slides back to the category list and returns focus to the category that was open. */
  function closePage() {
    const key = props.value;
    props.onPageOpenChange(false);
    requestAnimationFrame(() => {
      if (list) playContentEntrance(list, { direction: "left" });
      items[key]?.focus();
    });
  }

  /**
   * Keeps the category in view when a sidebar layout narrows into the stacked one: the selected
   * tab's content was showing, so the stacked layout opens its page rather than the list.
   */
  createEffect(
    on(
      () => props.stacked,
      (stacked, wasStacked) => {
        if (stacked && wasStacked === false) props.onPageOpenChange(true);
      },
    ),
  );

  /** Shows the open page's title and back button in the dialog header while the page is showing. */
  createEffect(() => {
    if (!dialogPage || !showingPage()) return;
    dialogPage.setPage({
      title: selectedLabel(),
      backLabel: backLabel(),
      onBack: closePage,
    });
    onCleanup(() => dialogPage.setPage(undefined));
  });

  // Created once so switching layouts moves the panel instead of rebuilding its contents.
  const content = untrack(() => props.children(panel));

  return (
    <Show
      when={props.stacked}
      fallback={
        <div class="nf-sidebar-tabs">
          <Show when={!props.hideNavigation}>
            <div class="nf-sidebar-tabs-sidebar">
              <SegmentedTabs
                id={props.id}
                label={props.label}
                orientation="vertical"
                contentId={contentId}
                options={props.options}
                value={props.value}
                onChange={props.onChange}
              />
            </div>
          </Show>
          {content}
        </div>
      }
    >
      <Show
        when={showingList()}
        fallback={
          <div class="nf-sidebar-tabs">
            <div class="nf-sidebar-tabs-page">
              <Show when={!dialogPage && showingPage()}>
                <div class="nf-sidebar-tabs-page-header">
                  <DialogBackButton
                    ref={(element) => {
                      ownBack = element;
                    }}
                    aria-label={backLabel()}
                    onClick={closePage}
                  />
                  <h3>{selectedLabel()}</h3>
                </div>
              </Show>
              {content}
            </div>
          </div>
        }
      >
        <ScrollArea
          class="nf-sidebar-tabs-list-area"
          viewportProps={{
            ref: (element) => {
              list = element;
            },
          }}
        >
          <nav class="nf-sidebar-tabs-list" aria-label={props.label}>
            <For each={props.options}>
              {(option) => (
                <Button
                  ref={(element) => {
                    items[option.key] = element;
                  }}
                  variant="subtle"
                  class="nf-sidebar-tabs-item"
                  onClick={() => openPage(option.key)}
                >
                  <span>{option.label}</span>
                  <CaretRightIcon class="size-4" aria-hidden />
                </Button>
              )}
            </For>
          </nav>
        </ScrollArea>
      </Show>
    </Show>
  );
}
