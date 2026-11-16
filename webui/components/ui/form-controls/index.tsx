// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
  createUniqueId,
  type JSX,
  onCleanup,
  onMount,
  Show,
  splitProps,
} from "solid-js";
import "../selectable-surface.css";
import "./form-controls.css";

interface ControlDensity {
  /** Uses a shorter control for inline property editors; otherwise follows the surrounding density. */
  density?: "comfortable" | "compact";
}

/** Groups a native field and its suffix under a single themed border and focus ring. */
export function InputGroup(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <div
      class={`nf-input-group nf-field-group ${local.class ?? ""}`}
      {...rest}
    />
  );
}

/** Presents a non-editable unit alongside its field without changing the field's value. */
export function InputSuffix(props: JSX.HTMLAttributes<HTMLSpanElement>) {
  const [local, rest] = splitProps(props, ["class"]);
  return <span class={`nf-input-suffix ${local.class ?? ""}`} {...rest} />;
}

/** Renders a native text or numeric field, preserving refs, validation attributes and input events. */
export function Input(
  props: JSX.InputHTMLAttributes<HTMLInputElement> &
    ControlDensity & {
      /** Mutes an editable value supplied by a parent default until it is overridden. */
      inherited?: boolean;
    },
) {
  const [local, rest] = splitProps(props, [
    "class",
    "type",
    "density",
    "inherited",
  ]);
  return (
    <input
      class={`nf-form-control ${local.class ?? ""}`}
      type={local.type ?? "text"}
      data-inherited={local.inherited ? "true" : undefined}
      data-density={local.density}
      {...rest}
    />
  );
}

/** Provides a resizable multiline field with the same states and density as single-line inputs. */
export function Textarea(
  props: JSX.TextareaHTMLAttributes<HTMLTextAreaElement> & ControlDensity,
) {
  const [local, rest] = splitProps(props, ["class", "density"]);
  return (
    <textarea
      class={`nf-form-control nf-textarea ${local.class ?? ""}`}
      data-density={local.density}
      {...rest}
    />
  );
}

/** Styles a native select while retaining browser option menus and native keyboard selection. */
export function NativeSelect(
  props: JSX.SelectHTMLAttributes<HTMLSelectElement> & ControlDensity,
) {
  const [local, rest] = splitProps(props, ["class", "density", "ref"]);
  let select: HTMLSelectElement | undefined;
  /**
   * Restores the controlled value when changing the options silently changed the selection.
   * Browsers select the first option when the chosen one is removed and do not restore it when a
   * replacement with the same value appears, so a list that swaps an option (such as a device
   * going unavailable) would otherwise show a choice the caller never made. A choice the user
   * just made is left alone while its update is in flight.
   */
  onMount(() => {
    const element = select;
    if (!element) return;
    let shown = element.value;
    const remember = () => {
      shown = element.value;
    };
    element.addEventListener("change", remember);
    const observer = new MutationObserver(() => {
      if (element.value !== shown && props.value !== undefined) {
        element.value = String(props.value);
      }
      shown = element.value;
    });
    observer.observe(element, { childList: true });
    onCleanup(() => {
      observer.disconnect();
      element.removeEventListener("change", remember);
    });
  });
  return (
    <select
      ref={(element) => {
        select = element;
        (local.ref as ((element: HTMLSelectElement) => void) | undefined)?.(
          element,
        );
      }}
      class={`nf-form-control ${local.class ?? ""}`}
      data-density={local.density}
      {...rest}
    />
  );
}

/** Renders an accent-aware native checkbox with shared sizing and keyboard focus. */
export function Checkbox(
  props: Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "type">,
) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <input type="checkbox" class={`nf-choice ${local.class ?? ""}`} {...rest} />
  );
}

/** Renders a native radio control whose grouping and selected value remain caller-owned. */
export function Radio(
  props: Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "type">,
) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <input type="radio" class={`nf-choice ${local.class ?? ""}`} {...rest} />
  );
}

/**
 * Presents one choice of a radio group as a selectable card with a title and an optional
 * description. The whole card toggles the radio, the radio's accessible name is the title alone
 * and the description is announced ahead of any caller-supplied `aria-describedby` hint.
 * Grouping and change handling remain caller-owned, as with `Radio`. `checked` is required so
 * the card's selected surface always matches the radio.
 */
export function RadioCard(
  props: Omit<
    JSX.InputHTMLAttributes<HTMLInputElement>,
    "type" | "title" | "checked"
  > & {
    /** Short name of the choice, used as the radio's accessible name. */
    title: JSX.Element;
    /** Longer explanation shown beneath the title and announced as the radio's description. */
    description?: JSX.Element;
    /** Whether this choice is the group's current value. */
    checked: boolean;
  },
) {
  const [local, rest] = splitProps(props, [
    "class",
    "title",
    "description",
    "checked",
    "aria-describedby",
  ]);
  const titleId = createUniqueId();
  const descriptionId = createUniqueId();
  /** Lists the card's own description first, followed by any hint the caller links. */
  const describedBy = () =>
    [local.description ? descriptionId : undefined, local["aria-describedby"]]
      .filter(Boolean)
      .join(" ") || undefined;
  return (
    <label
      class={`nf-radio-card ${local.class ?? ""}`}
      data-selectable-surface
      data-selected={local.checked ? "true" : undefined}
    >
      <Radio
        {...rest}
        checked={local.checked}
        aria-labelledby={titleId}
        aria-describedby={describedBy()}
      />
      <span class="nf-radio-card-text">
        <span id={titleId} class="nf-radio-card-title">
          {local.title}
        </span>
        <Show when={local.description}>
          <span id={descriptionId} class="nf-radio-card-description">
            {local.description}
          </span>
        </Show>
      </span>
    </label>
  );
}
