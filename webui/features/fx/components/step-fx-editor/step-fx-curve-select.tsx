// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CaretDownIcon } from "@squidlab/phosphor-solid/caret-down";
import { createMemo, For } from "solid-js";
import {
  DropdownMenu,
  DropdownMenuItem,
} from "../../../../components/ui/dropdown-menu";
import type * as types from "../../../../types";
import {
  STEP_FX_CURVE_NAMES,
  type StepFxCurveName,
  stepFxCurveFromName,
  stepFxCurveIconPath,
  stepFxCurveName,
} from "../../model/step-fx-editor-model";
import { STEP_FX_FIELD_CLASS } from "./step-fx-editor-styles";

/** Renders an icon-capable selector for one authored transition curve. */
export function StepFxCurveSelect(props: {
  stepNumber: number;
  curve: types.CurveType;
  onChange: (curve: types.CurveType) => void;
}) {
  /** Resolves the persisted curve to the selector's supported visual preset. */
  const selectedName = createMemo(() => stepFxCurveName(props.curve));

  return (
    <DropdownMenu
      align="end"
      triggerLabel={`Step ${props.stepNumber} curve`}
      triggerClass="block w-full min-w-0"
      trigger={
        <span
          class={`${STEP_FX_FIELD_CLASS} flex w-full min-w-0 items-center gap-1 px-1.5 text-left text-xs`}
        >
          <StepFxCurveIcon
            name={selectedName()}
            class="size-4 shrink-0 text-neutral-400"
          />
          <span class="min-w-0 flex-1 truncate">{selectedName()}</span>
          <CaretDownIcon class="size-3 shrink-0 text-neutral-400" aria-hidden />
        </span>
      }
    >
      <div class="py-0.5" data-menu-kind="step-fx-curve">
        <For each={STEP_FX_CURVE_NAMES}>
          {(name) => (
            <DropdownMenuItem
              onClick={() => props.onChange(stepFxCurveFromName(name))}
            >
              <span
                class="flex min-w-0 flex-1 items-center gap-2"
                classList={{ "text-sky-300": selectedName() === name }}
                data-step-fx-curve-option={name}
              >
                <StepFxCurveIcon
                  name={name}
                  class="size-4 shrink-0 text-current"
                />
                <span>{name}</span>
              </span>
            </DropdownMenuItem>
          )}
        </For>
      </div>
    </DropdownMenu>
  );
}

/** Draws the normalized interpolation shape represented by one curve preset. */
function StepFxCurveIcon(props: { name: StepFxCurveName; class?: string }) {
  return (
    <svg
      class={props.class ?? "size-4"}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      data-step-fx-curve-icon={props.name}
    >
      <path
        d={stepFxCurveIconPath(props.name)}
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <circle cx="2" cy="14" r="1" fill="currentColor" />
      <circle cx="14" cy="2" r="1" fill="currentColor" />
    </svg>
  );
}
