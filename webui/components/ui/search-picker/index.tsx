// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { MagnifyingGlassIcon } from "@squidlab/phosphor-solid/magnifying-glass";
import { type JSX, splitProps } from "solid-js";
import { DialogSurface } from "../dialog";
import { Input, InputGroup } from "../form-controls";
import "./search-picker.css";

/** Frames a searchable action list while its caller owns positioning, filtering, and dismissal. */
export function SearchPickerSurface(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <DialogSurface class={`nf-search-picker ${local.class ?? ""}`} {...rest} />
  );
}

/** Composes a shared search field with a leading icon and optional filter tokens, trailing actions, or hints. */
export function SearchPickerInput(
  props: JSX.InputHTMLAttributes<HTMLInputElement> & {
    leading?: JSX.Element;
    trailing?: JSX.Element;
  },
) {
  const [local, rest] = splitProps(props, ["leading", "trailing"]);
  return (
    <InputGroup class="nf-search-picker-field">
      <MagnifyingGlassIcon class="size-5 shrink-0 self-center" aria-hidden />
      {local.leading}
      <Input {...rest} />
      {local.trailing}
    </InputGroup>
  );
}

/** Presents a rich result row with shared active, disabled, hover, and keyboard-focus states. */
export function SearchPickerOption(
  props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
    selected?: boolean;
    density?: "comfortable" | "compact";
  },
) {
  const [local, rest] = splitProps(props, [
    "class",
    "selected",
    "type",
    "density",
  ]);
  return (
    <button
      type={local.type ?? "button"}
      class={`nf-search-picker-option ${local.class ?? ""}`}
      data-active={local.selected || undefined}
      data-density={local.density}
      {...rest}
    />
  );
}
