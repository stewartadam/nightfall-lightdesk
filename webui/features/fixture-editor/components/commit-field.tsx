// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createEffect, createSignal, type JSX, on, splitProps } from "solid-js";
import { Input } from "../../../components/ui/form-controls";

type CommitFieldProps = Omit<
  JSX.InputHTMLAttributes<HTMLInputElement>,
  "value" | "onInput" | "onChange" | "onBlur" | "onKeyDown"
> & {
  /** Value held by the draft; the field shows it until the user types. */
  value: string;
  /**
   * Receives a changed value when the field loses focus or Enter is pressed.
   * Each commit is one draft edit, and so one undo step. Returning or
   * resolving `false` puts the draft's value back, for input that was refused.
   */
  onCommit: (value: string) => CommitOutcome;
};

/** Whether a commit was accepted; `false` reverts the field. */
export type CommitOutcome = boolean | undefined | Promise<boolean | undefined>;

/**
 * A draft field that sends its value once editing finishes rather than on
 * every keystroke. Escape restores the draft's value, and a change made in
 * another window replaces the shown value unless the user is mid-edit.
 */
export function CommitField(props: CommitFieldProps) {
  const [local, rest] = splitProps(props, ["value", "onCommit"]);
  const [text, setText] = createSignal(local.value);
  let editing = false;

  /** Shows the draft's value whenever it changes, unless the user is typing. */
  createEffect(
    on(
      () => local.value,
      (value) => {
        if (!editing) setText(value);
      },
    ),
  );

  /** Value sent by a commit that has not been answered yet, so a blur right after Enter does not send it twice. */
  let pending: string | null = null;

  /** Sends the typed value when it differs from the draft's, reverting it if it is refused. */
  const commit = () => {
    editing = false;
    const value = text();
    if (value === local.value || value === pending) return;
    pending = value;
    void Promise.resolve(local.onCommit(value)).then((accepted) => {
      pending = null;
      if (accepted === false && !editing) setText(local.value);
    });
  };

  return (
    <Input
      density="compact"
      {...rest}
      value={text()}
      onInput={(event) => {
        editing = true;
        setText(event.currentTarget.value);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape" && editing) {
          event.preventDefault();
          editing = false;
          setText(local.value);
        }
      }}
    />
  );
}

type CommitNumberFieldProps = Omit<CommitFieldProps, "value" | "onCommit"> & {
  value: number;
  /** Receives a changed, valid number; other input is reverted. */
  onCommit: (value: number) => CommitOutcome;
  /** Accepts only whole numbers, as DMX values are. */
  integer?: boolean;
};

/** A numeric draft field: invalid or out-of-range text reverts instead of being sent. */
export function CommitNumberField(props: CommitNumberFieldProps) {
  const [local, rest] = splitProps(props, ["value", "onCommit", "integer"]);
  return (
    <CommitField
      inputMode={local.integer ? "numeric" : "decimal"}
      {...rest}
      value={String(local.value)}
      onCommit={(text) => {
        const value = Number(text.trim());
        const min = rest.min === undefined ? -Infinity : Number(rest.min);
        const max = rest.max === undefined ? Infinity : Number(rest.max);
        const valid =
          text.trim() !== "" &&
          Number.isFinite(value) &&
          (!local.integer || Number.isInteger(value)) &&
          value >= min &&
          value <= max;
        if (!valid) return false;
        return value === local.value ? undefined : local.onCommit(value);
      }}
    />
  );
}

/**
 * Puts a native select or swatch back to the draft's value when its edit is
 * refused. A refused edit brings no new view, so nothing else rewrites what
 * the control shows.
 */
export function revertIfRefused(
  element: HTMLInputElement | HTMLSelectElement,
  accepted: Promise<boolean>,
  value: () => string | number | undefined,
): void {
  void accepted.then((ok) => {
    if (!ok) element.value = String(value() ?? "");
  });
}
