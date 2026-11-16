// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createEffect, type JSX, splitProps, untrack } from "solid-js";
import { formatNumberDraft, readNumberField } from "../../lib/number-draft";
import { Input } from "../ui/form-controls";

type NumberFieldProps = Omit<
  JSX.InputHTMLAttributes<HTMLInputElement>,
  "type" | "value" | "onInput" | "ref"
> & {
  /** The stored draft: the number typed, null when blank, NaN for unfinished text. */
  value: number | null;
  /** Receives the field's number on every keystroke, out-of-range values included. */
  onValueChange: (value: number | null) => void;
  density?: "comfortable" | "compact";
};

/**
 * A numeric field whose stored value is exactly what was typed (see `lib/number-draft`), so
 * forms can show an error for an out-of-range entry instead of keeping an earlier valid one.
 * It writes the stored value back to the field only when it differs from what the field
 * already reads, so clearing the field or typing unfinished text like "1e" is never erased.
 */
export function NumberField(props: NumberFieldProps) {
  const [local, rest] = splitProps(props, ["value", "onValueChange"]);
  let input: HTMLInputElement | undefined;

  /** Shows a value set from outside (a default, Next available, a reset) in the field. */
  createEffect(() => {
    const value = local.value;
    if (input && !Object.is(readNumberField(input), value)) {
      input.value = formatNumberDraft(value);
    }
  });

  return (
    <Input
      {...rest}
      ref={input}
      type="number"
      value={untrack(() => formatNumberDraft(local.value))}
      onInput={(event) =>
        local.onValueChange(readNumberField(event.currentTarget))
      }
    />
  );
}
