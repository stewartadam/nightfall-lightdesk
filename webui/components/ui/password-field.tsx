// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { EyeIcon } from "@squidlab/phosphor-solid/eye";
import { EyeSlashIcon } from "@squidlab/phosphor-solid/eye-slash";
import { createSignal, type JSX, splitProps } from "solid-js";
import { Input, InputGroup } from "./form-controls";
import { Button } from "./visual-language/button";

type PasswordFieldProps = Omit<
  JSX.InputHTMLAttributes<HTMLInputElement>,
  "type" | "class" | "style"
> & {
  /** Classes for the outer group, such as a width. */
  class?: string;
  /** Styles for the outer group, such as a width. */
  style?: JSX.CSSProperties;
};

/**
 * A password field with a toggle button that reveals or hides what was typed. The field
 * starts hidden, and the toggle keeps one name and reports its state as pressed. Every
 * other attribute, such as `id`, `value` or `autocomplete`, goes to the input itself.
 */
export function PasswordField(props: PasswordFieldProps) {
  const [local, rest] = splitProps(props, ["class", "style", "disabled"]);
  const [revealed, setRevealed] = createSignal(false);
  return (
    <InputGroup class={`items-center ${local.class ?? ""}`} style={local.style}>
      <Input
        {...rest}
        type={revealed() ? "text" : "password"}
        disabled={local.disabled}
      />
      <Button
        variant="subtle"
        size="icon"
        style={{ height: "auto" }}
        type="button"
        aria-label="Show password"
        aria-pressed={revealed()}
        disabled={local.disabled}
        onClick={() => setRevealed((shown) => !shown)}
      >
        {revealed() ? (
          <EyeSlashIcon class="size-4" aria-hidden />
        ) : (
          <EyeIcon class="size-4" aria-hidden />
        )}
      </Button>
    </InputGroup>
  );
}
