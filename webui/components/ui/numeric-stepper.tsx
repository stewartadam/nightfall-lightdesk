// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type JSX, Show, splitProps } from "solid-js";
import { Input, InputGroup } from "./form-controls";
import { Button } from "./visual-language/button";
import "./numeric-stepper.css";

interface NumericStepperProps
  extends Omit<
    JSX.InputHTMLAttributes<HTMLInputElement>,
    "value" | "onInput" | "type"
  > {
  type?: "text" | "number";
  value: string | number;
  onValueChange: (value: string) => void;
  decreaseLabel: string;
  increaseLabel: string;
  fallbackValue?: number;
  stepBy?: number;
  density?: "comfortable" | "compact";
  unit?: JSX.Element;
}

/** Edits numeric drafts with bounded button/arrow increments while preserving fractional values and native validation. */
export function NumericStepper(props: NumericStepperProps) {
  const [local, input] = splitProps(props, [
    "class",
    "type",
    "value",
    "onValueChange",
    "decreaseLabel",
    "increaseLabel",
    "fallbackValue",
    "stepBy",
    "density",
    "unit",
    "onKeyDown",
  ]);
  /** Resolves a numeric bound without treating missing attributes as zero. */
  const bound = (value: string | number | undefined, fallback: number) =>
    value === undefined || value === "" ? fallback : Number(value);
  /** Returns a finite draft or the caller's initial value when the field is blank. */
  const current = () =>
    String(local.value).trim() !== "" && Number.isFinite(Number(local.value))
      ? Number(local.value)
      : (local.fallbackValue ?? bound(input.min, 0));
  /** Applies a relative increment, retaining decimals instead of snapping to an integer step grid. */
  const adjust = (direction: -1 | 1) => {
    if (input.disabled || input.readOnly) return;
    const step =
      local.stepBy ?? (input.step === "any" ? 1 : bound(input.step, 1));
    const next = Math.min(
      bound(input.max, Infinity),
      Math.max(
        bound(input.min, -Infinity),
        Number((current() + direction * step).toFixed(12)),
      ),
    );
    local.onValueChange(String(next));
  };
  return (
    <InputGroup
      class={`nf-numeric-stepper ${local.class ?? ""}`}
      data-density={local.density}
      data-disabled={input.disabled ? "true" : undefined}
    >
      <Button
        variant="subtle"
        aria-label={local.decreaseLabel}
        disabled={
          input.disabled ||
          input.readOnly ||
          (String(local.value).trim() !== "" &&
            Number(local.value) <= bound(input.min, -Infinity))
        }
        onClick={() => adjust(-1)}
      >
        −
      </Button>
      <Input
        {...input}
        type={local.type ?? "number"}
        density={local.density}
        value={local.value}
        onInput={(event) => local.onValueChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          const handler = local.onKeyDown;
          if (typeof handler === "function") handler(event);
          else if (Array.isArray(handler)) handler[0](handler[1], event);
          if (event.defaultPrevented) return;
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            adjust(event.key === "ArrowUp" ? 1 : -1);
          }
        }}
      />
      <Show when={local.unit}>
        <span class="nf-stepper-unit">{local.unit}</span>
      </Show>
      <Button
        variant="subtle"
        aria-label={local.increaseLabel}
        disabled={
          input.disabled ||
          input.readOnly ||
          (String(local.value).trim() !== "" &&
            Number(local.value) >= bound(input.max, Infinity))
        }
        onClick={() => adjust(1)}
      >
        +
      </Button>
    </InputGroup>
  );
}
