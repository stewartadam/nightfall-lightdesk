// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { PlusIcon } from "@squidlab/phosphor-solid/plus";
import { TrashIcon } from "@squidlab/phosphor-solid/trash";
import { Index, Show } from "solid-js";
import { EmptyState } from "../../../components/ui/empty-state";
import { Button } from "../../../components/ui/visual-language/button";
import type * as types from "../../../types";
import {
  hexToSlotColor,
  nextName,
  slotFields,
  slotFieldsWithout,
  slotHex,
} from "../model/draft-editing";
import { CommitField, revertIfRefused } from "./commit-field";
import { useDraftEditing } from "./draft-context";

/** Color shown in a slot's swatch when it has no color of its own, such as a gobo. */
const FILTER_SWATCH = "#ffffff";

/** Edits one wheel: its name and its slots' names and colors. */
function WheelCard(props: { wheel: types.DraftWheel; index: number }) {
  const editing = useDraftEditing();
  /** Whether a function selects this wheel, which keeps it from being removed. */
  const inUse = () =>
    editing
      .draft()
      .modes.some((mode) =>
        mode.channels.some((channel) =>
          channel.logical_channels.some((logical) =>
            logical.functions.some((entry) => entry.wheel === props.wheel.name),
          ),
        ),
      );

  /** Sends the wheel's slots. */
  const setSlots = (
    build: (wheel: types.DraftWheel) => types.DraftSlotFields[],
  ) => {
    const index = props.index;
    return editing.edit((draft) => ({
      type: "SetWheelSlots",
      data: { wheel: index, slots: build(draft.wheels[index] ?? props.wheel) },
    }));
  };

  return (
    <li
      class="flex flex-col gap-3 rounded-md border border-neutral-800 p-4"
      data-testid="wheel-card"
    >
      <div class="flex flex-wrap items-end gap-2">
        <label class="flex min-w-48 flex-1 flex-col gap-1 text-sm">
          <span class="text-neutral-300">Wheel name</span>
          <CommitField
            value={props.wheel.name}
            onCommit={(name) =>
              editing.edit({
                type: "RenameWheel",
                data: { wheel: props.index, name },
              })
            }
          />
        </label>
        <Button
          size="compact"
          variant="subtle"
          disabled={inUse()}
          tooltip={
            inUse() ? "A function uses this wheel; unlink it first" : undefined
          }
          onClick={() =>
            void editing.edit({
              type: "RemoveWheel",
              data: { wheel: props.index },
            })
          }
        >
          <TrashIcon class="size-4" aria-hidden />
          Remove wheel
        </Button>
      </div>
      <ol class="flex flex-col gap-2">
        <Index each={props.wheel.slots}>
          {(slot, slotIndex) => (
            <li class="flex items-center gap-2" data-testid="wheel-slot">
              <span class="w-6 text-right font-mono text-xs text-neutral-500">
                {slotIndex + 1}
              </span>
              <input
                type="color"
                class="size-8 shrink-0 cursor-pointer rounded border border-neutral-700 bg-transparent"
                aria-label={`Color of ${slot().name}`}
                value={slotHex(slot().color) ?? FILTER_SWATCH}
                onChange={(event) => {
                  const color = hexToSlotColor(
                    event.currentTarget.value,
                    slot().color,
                  );
                  revertIfRefused(
                    event.currentTarget,
                    setSlots((wheel) =>
                      slotFields(wheel, { index: slotIndex, color }),
                    ),
                    () => slotHex(slot().color) ?? FILTER_SWATCH,
                  );
                }}
              />
              <CommitField
                class="min-w-0 flex-1"
                aria-label={`Name of slot ${slotIndex + 1}`}
                value={slot().name}
                onCommit={(name) =>
                  setSlots((wheel) =>
                    slotFields(wheel).map((fields, index) =>
                      index === slotIndex ? { ...fields, name } : fields,
                    ),
                  )
                }
              />
              <Show when={slot().media}>
                <span class="text-xs text-neutral-500">Image</span>
              </Show>
              <Button
                size="icon-compact"
                variant="subtle"
                aria-label={`Remove slot ${slot().name}`}
                tooltip="Remove slot"
                onClick={() =>
                  void setSlots((wheel) => slotFieldsWithout(wheel, slotIndex))
                }
              >
                <TrashIcon class="size-4" aria-hidden />
              </Button>
            </li>
          )}
        </Index>
      </ol>
      <Button
        size="compact"
        variant="subtle"
        class="self-start"
        onClick={() =>
          void setSlots((wheel) => [
            ...slotFields(wheel),
            {
              name: nextName(
                "Slot",
                wheel.slots.map((slot) => slot.name),
              ),
            },
          ])
        }
      >
        <PlusIcon class="size-4" aria-hidden />
        Add slot
      </Button>
    </li>
  );
}

/**
 * Edits the fixture's wheels, such as color and gobo wheels. A function
 * picks a wheel, and its named ranges pick the wheel's slots.
 */
export default function WheelsSection() {
  const editing = useDraftEditing();
  /** The draft's wheels, from its latest view. */
  const wheels = () => editing.draft().wheels;

  return (
    <section class="flex flex-col gap-4" data-testid="fixture-wheels-section">
      <Show
        when={wheels().length > 0}
        fallback={
          <EmptyState
            variant="dashed"
            class="p-6"
            title="No wheels"
            description="Add a wheel for a fixture with a color or gobo wheel."
          />
        }
      >
        <ul class="flex flex-col gap-3">
          <Index each={wheels()}>
            {(wheel, index) => <WheelCard wheel={wheel()} index={index} />}
          </Index>
        </ul>
      </Show>
      <Button
        size="compact"
        variant="subtle"
        class="self-start"
        onClick={() =>
          void editing.edit({
            type: "AddWheel",
            data: {
              name: nextName(
                "Wheel",
                wheels().map((wheel) => wheel.name),
              ),
            },
          })
        }
      >
        <PlusIcon class="size-4" aria-hidden />
        Add wheel
      </Button>
    </section>
  );
}
