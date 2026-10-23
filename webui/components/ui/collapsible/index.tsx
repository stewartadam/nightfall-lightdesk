// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CaretRightIcon } from "@squidlab/phosphor-solid/caret-right";
import { createSignal, createUniqueId, type JSX, Show } from "solid-js";
import "./collapsible.css";

/** Whether `hidden="until-found"` keeps collapsed content searchable with find-in-page. */
const SUPPORTS_UNTIL_FOUND =
  typeof document !== "undefined" && "onbeforematch" in document.body;

export interface CollapsibleProps {
  /** Header label. It is the toggle button's content and accessible name. */
  title: JSX.Element;
  /** Section content, shown while open. */
  children: JSX.Element;
  /**
   * Trailing header content beside the toggle, such as counts, status badges or menu buttons.
   * Clicking it never toggles the section.
   */
  actions?: JSX.Element;
  /** Controlled open state. Pair with `onOpenChange`; omit it to let the section own its state. */
  open?: boolean;
  /** Initial open state while uncontrolled. Defaults to `false`. */
  defaultOpen?: boolean;
  /** Called with the requested open state whenever the user toggles the section. */
  onOpenChange?: (open: boolean) => void;
  /**
   * `bordered` (the default) frames the section with a border and a shaded header row.
   * `plain` renders a borderless text toggle for inline disclosures in forms and dialogs.
   */
  variant?: "bordered" | "plain";
  /** Mounts the content only while open, for expensive or live-updating content. */
  lazy?: boolean;
  /**
   * Keeps closed content mounted, visible and inert, for containers that animate their own
   * height and clip the content while collapsing.
   */
  forceMount?: boolean;
  /** Classes for the root element. Text size set here also sizes the header. */
  class?: string;
  /** Classes for the header row that holds the toggle and actions. */
  headerClass?: string;
  /** Classes for the toggle button. */
  triggerClass?: string;
  /** Classes for the content region, such as its padding. */
  contentClass?: string;
  /** Receives the root element, for observers and measurements. */
  ref?: (element: HTMLDivElement) => void;
}

/**
 * Renders a disclosure section: a header toggle with a rotating chevron, optional trailing header
 * actions that do not toggle, and a content region that leaves the focus order and accessibility
 * tree while collapsed. Follows the WAI-ARIA disclosure pattern rather than `<details>` so header
 * actions can sit beside the toggle instead of inside it. Collapsed, non-lazy content stays
 * searchable with find-in-page and opens the section when a match is revealed.
 */
export function Collapsible(props: CollapsibleProps) {
  const contentId = createUniqueId();
  const [localOpen, setLocalOpen] = createSignal(props.defaultOpen ?? false);
  /** Returns the controlled state when supplied, otherwise the section's own state. */
  const isOpen = () => props.open ?? localOpen();
  /** Requests a new open state, updating local state only while uncontrolled. */
  const setOpen = (next: boolean) => {
    if (next === isOpen()) return;
    if (props.open === undefined) setLocalOpen(next);
    props.onOpenChange?.(next);
  };
  /** Returns whether closed content is kept visible (and inert) for a clipping container. */
  const keepsClosedContent = () => !isOpen() && props.forceMount === true;
  /** Returns the `hidden` value for the content region while it is collapsed. */
  const hiddenValue = (): JSX.HTMLAttributes<HTMLDivElement>["hidden"] => {
    if (isOpen() || props.forceMount) return undefined;
    return SUPPORTS_UNTIL_FOUND && !props.lazy ? "until-found" : true;
  };

  return (
    <div
      ref={props.ref}
      class={`nf-collapsible ${props.class ?? ""}`}
      data-variant={props.variant ?? "bordered"}
      data-open={isOpen() ? "true" : "false"}
    >
      <div class={`nf-collapsible-header ${props.headerClass ?? ""}`}>
        <button
          type="button"
          class={`nf-collapsible-trigger ${props.triggerClass ?? ""}`}
          aria-expanded={isOpen()}
          aria-controls={contentId}
          onClick={() => setOpen(!isOpen())}
        >
          <CaretRightIcon class="nf-collapsible-chevron" aria-hidden="true" />
          <span class="nf-collapsible-title">{props.title}</span>
        </button>
        <Show when={props.actions}>
          <div class="nf-collapsible-actions">{props.actions}</div>
        </Show>
      </div>
      <div
        ref={(element) =>
          element.addEventListener("beforematch", () => setOpen(true))
        }
        id={contentId}
        class={`nf-collapsible-content ${props.contentClass ?? ""}`}
        hidden={hiddenValue()}
        inert={keepsClosedContent()}
      >
        <Show when={!props.lazy || isOpen() || props.forceMount}>
          {props.children}
        </Show>
      </div>
    </div>
  );
}
