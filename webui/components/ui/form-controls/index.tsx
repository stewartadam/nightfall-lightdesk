// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type JSX, splitProps } from "solid-js";
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
  const [local, rest] = splitProps(props, ["class", "density"]);
  return (
    <select
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
