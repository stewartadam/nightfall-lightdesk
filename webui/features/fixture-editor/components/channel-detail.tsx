// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { PlusIcon } from "@squidlab/phosphor-solid/plus";
import { TrashIcon } from "@squidlab/phosphor-solid/trash";
import { For, Index, type JSX, Show } from "solid-js";
import { Badge } from "../../../components/ui/badge";
import { NativeSelect } from "../../../components/ui/form-controls";
import { Button } from "../../../components/ui/visual-language/button";
import * as types from "../../../types";
import {
  channelFunctions,
  functionAt,
  functionFields,
  type IndexedFunction,
  maxDmxValue,
  nextName,
  nextRangeStart,
  problemsAt,
  resolutionLabel,
  setFields,
} from "../model/draft-editing";
import { AttributeCommitField } from "./attribute-field";
import {
  CommitField,
  CommitNumberField,
  revertIfRefused,
} from "./commit-field";
import { useDraftEditing } from "./draft-context";

/** Labels one value of a function or range. */
function Field(props: {
  label: string;
  class?: string;
  children: JSX.Element;
}) {
  return (
    <label class={`flex flex-col gap-1 text-xs ${props.class ?? ""}`}>
      <span class="text-neutral-400">{props.label}</span>
      {props.children}
    </label>
  );
}

interface ChannelDetailProps {
  mode: number;
  channelIndex: number;
  channel: types.DraftChannel;
}

/** Where a function sits, which every function edit names. */
interface FunctionTarget {
  mode: number;
  channel: number;
  function: number;
}

/**
 * Edits a function's named ranges, such as the slots of a color wheel or
 * the open and closed parts of a shutter. Ranges are sent as a whole list,
 * so each change is one undo step.
 */
function FunctionRanges(props: {
  target: FunctionTarget;
  entry: types.DraftFunction;
  /** Highest DMX value the function's range reaches. */
  end: number;
}) {
  const editing = useDraftEditing();
  /** Slots of the wheel the function uses, offered for each range. */
  const slots = () =>
    editing.draft().wheels.find((wheel) => wheel.name === props.entry.wheel)
      ?.slots ?? [];

  /**
   * Sends the function's ranges with a change to their list, built from the
   * function as it stands when sent so queued range edits do not undo each other.
   */
  const changeRanges = (change: (sets: types.DraftSetFields[]) => void) => {
    const target = props.target;
    return editing.edit((draft) => {
      const entry =
        functionAt(draft, target.mode, target.channel, target.function) ??
        props.entry;
      const sets = setFields(entry);
      change(sets);
      return { type: "SetFunctionSets", data: { ...target, sets } };
    });
  };

  /** Changes some values of one range, or removes it when `changes` is null. */
  const setRange = (
    index: number,
    changes: Partial<types.DraftSetFields> | null,
  ) =>
    changeRanges((sets) => {
      if (!sets[index]) return;
      if (changes) sets[index] = { ...sets[index], ...changes };
      else sets.splice(index, 1);
    });

  /** Adds a range halfway into the space after the last one. */
  const addRange = () =>
    void changeRanges((sets) => {
      const start = nextRangeStart(
        sets.map((set) => set.dmx_from),
        props.entry.dmx_from,
        props.end,
      );
      if (start === undefined) return;
      sets.push({
        name: nextName(
          "Range",
          sets.map((set) => set.name),
        ),
        dmx_from: start,
        wheel_slot: props.entry.wheel && slots().length > 0 ? 1 : undefined,
      });
    });

  return (
    <div class="flex flex-col gap-2" data-testid="function-ranges">
      <div class="flex items-center gap-2">
        <span class="text-xs font-semibold text-neutral-300">Named ranges</span>
        <Button
          size="compact"
          variant="subtle"
          class="ml-auto"
          disabled={
            nextRangeStart(
              props.entry.sets.map((set) => set.dmx_from),
              props.entry.dmx_from,
              props.end,
            ) === undefined
          }
          onClick={addRange}
        >
          <PlusIcon class="size-4" aria-hidden />
          Add range
        </Button>
      </div>
      <Show
        when={props.entry.sets.length > 0}
        fallback={
          <p class="text-xs text-neutral-500">
            No named ranges. Add them for values operators pick by name, such as
            wheel slots or strobe effects.
          </p>
        }
      >
        <Index each={props.entry.sets}>
          {(set, index) => (
            <div class="flex flex-wrap items-end gap-2" data-testid="range-row">
              <Field label="Range name" class="min-w-32 flex-1">
                <CommitField
                  value={set().name}
                  onCommit={(name) => setRange(index, { name })}
                />
              </Field>
              <Field label="From DMX" class="w-24">
                <CommitNumberField
                  integer
                  min={props.entry.dmx_from}
                  max={props.end}
                  value={set().dmx_from}
                  onCommit={(dmx_from) =>
                    setRange(index, {
                      dmx_from,
                    })
                  }
                />
              </Field>
              <Show when={props.entry.wheel}>
                <Field label="Wheel slot" class="w-36">
                  <NativeSelect
                    density="compact"
                    value={set().wheel_slot ?? ""}
                    onInput={(event) => {
                      const value = event.currentTarget.value;
                      revertIfRefused(
                        event.currentTarget,
                        setRange(index, {
                          wheel_slot: value ? Number(value) : undefined,
                        }),
                        () => set().wheel_slot,
                      );
                    }}
                  >
                    <option value="">None</option>
                    <For each={slots()}>
                      {(slot, slotIndex) => (
                        <option value={slotIndex() + 1}>
                          {slotIndex() + 1}. {slot.name}
                        </option>
                      )}
                    </For>
                  </NativeSelect>
                </Field>
              </Show>
              <Button
                size="icon-compact"
                variant="subtle"
                aria-label={`Remove range ${set().name}`}
                tooltip="Remove range"
                onClick={() => void setRange(index, null)}
              >
                <TrashIcon class="size-4" aria-hidden />
              </Button>
            </div>
          )}
        </Index>
      </Show>
    </div>
  );
}

/** Edits one function of a channel: its name, attribute, DMX range, physical values and wheel. */
function FunctionCard(props: {
  mode: number;
  channelIndex: number;
  item: IndexedFunction;
  /** Highest DMX value the function's range reaches, before the next function starts. */
  end: number;
  removable: boolean;
}) {
  const editing = useDraftEditing();
  /** The function's position, which every edit of it names. */
  const target = (): FunctionTarget => ({
    mode: props.mode,
    channel: props.channelIndex,
    function: props.item.index,
  });

  /** Sends the function's values with some of them changed. */
  const update = (changes: Partial<types.DraftFunctionFields>) => {
    const at = target();
    return editing.edit((draft) => {
      const entry =
        functionAt(draft, at.mode, at.channel, at.function) ??
        props.item.function;
      return {
        type: "UpdateFunction",
        data: { ...at, fields: { ...functionFields(entry), ...changes } },
      };
    });
  };

  return (
    <li
      class="flex flex-col gap-3 rounded-md border border-neutral-800 bg-neutral-800/50 p-3"
      data-testid="function-card"
    >
      <div class="flex flex-wrap items-end gap-2">
        <Field label="Function name" class="min-w-36 flex-1">
          <CommitField
            value={props.item.function.name}
            onCommit={(name) => update({ name })}
          />
        </Field>
        <Field label="Attribute" class="min-w-36 flex-1">
          <AttributeCommitField
            value={props.item.function.attribute}
            onCommit={(attribute) => update({ attribute })}
          />
        </Field>
        <Button
          size="icon-compact"
          variant="subtle"
          aria-label={`Remove function ${props.item.function.name}`}
          tooltip={
            props.removable
              ? "Remove function"
              : "A channel needs at least one function"
          }
          disabled={!props.removable}
          onClick={() =>
            void editing.edit({ type: "RemoveFunction", data: target() })
          }
        >
          <TrashIcon class="size-4" aria-hidden />
        </Button>
      </div>
      <div class="flex flex-wrap items-end gap-2">
        <Field label="From DMX" class="w-24">
          <CommitNumberField
            integer
            min={0}
            max={props.end}
            value={props.item.function.dmx_from}
            onCommit={(dmx_from) => update({ dmx_from })}
          />
        </Field>
        <span class="pb-1.5 text-xs text-neutral-500">to {props.end}</span>
        <Field label="Default DMX" class="w-24">
          <CommitNumberField
            integer
            min={0}
            max={maxDmxValue(
              editing.draft().modes[props.mode]?.channels[props.channelIndex]
                ?.resolution ?? 1,
            )}
            value={props.item.function.default}
            onCommit={(value) => update({ default: value })}
          />
        </Field>
        <Field label="Physical from" class="w-24">
          <CommitNumberField
            value={props.item.function.physical_from}
            onCommit={(physical_from) => update({ physical_from })}
          />
        </Field>
        <Field label="Physical to" class="w-24">
          <CommitNumberField
            value={props.item.function.physical_to}
            onCommit={(physical_to) => update({ physical_to })}
          />
        </Field>
        <Field label="Wheel" class="w-36">
          <NativeSelect
            density="compact"
            value={props.item.function.wheel ?? ""}
            onInput={(event) =>
              revertIfRefused(
                event.currentTarget,
                update({ wheel: event.currentTarget.value || undefined }),
                () => props.item.function.wheel,
              )
            }
          >
            <option value="">None</option>
            <For each={editing.draft().wheels}>
              {(wheel) => <option value={wheel.name}>{wheel.name}</option>}
            </For>
          </NativeSelect>
        </Field>
      </div>
      <FunctionRanges
        target={target()}
        entry={props.item.function}
        end={props.end}
      />
    </li>
  );
}

/**
 * Edits the selected channel: its highlight value, its functions and their
 * named ranges. DMX values are at the channel's resolution, so a 16-bit
 * channel takes values up to 65535.
 */
export default function ChannelDetail(props: ChannelDetailProps) {
  const editing = useDraftEditing();
  /** Functions in the order edits count them. */
  const functions = () => channelFunctions(props.channel);
  /** Highest value the channel outputs at its resolution. */
  const max = () => maxDmxValue(props.channel.resolution);
  /** Where the channel's next function would start, or none when the range is full. */
  const nextStart = () =>
    nextRangeStart(
      functions().map((item) => item.function.dmx_from),
      0,
      max(),
    );

  /** Returns the last DMX value a function covers: up to where the next one starts. */
  const functionEnd = (position: number) => {
    const next = functions()[position + 1];
    const start = functions()[position]?.function.dmx_from ?? 0;
    return next && next.function.dmx_from > start
      ? next.function.dmx_from - 1
      : max();
  };

  /** Adds a function in the free space after the last one, for the channel's first attribute. */
  const addFunction = () => {
    const start = nextStart();
    if (start === undefined) return;
    const last = functions()[functions().length - 1]?.function;
    void editing.edit({
      type: "AddFunction",
      data: {
        mode: props.mode,
        channel: props.channelIndex,
        function: {
          name: nextName(
            "Function",
            functions().map((item) => item.function.name),
          ),
          attribute:
            last?.attribute ??
            props.channel.logical_channels[0]?.attribute ??
            "Dimmer",
          dmx_from: start,
          default: start,
          physical_from: 0,
          physical_to: 1,
          wheel: undefined,
        },
      },
    });
  };

  return (
    <section
      class="flex flex-col gap-4 rounded-md border border-neutral-800 p-4"
      data-testid="channel-detail"
      aria-label={`Channel ${props.channel.name}`}
    >
      <div class="flex flex-wrap items-end gap-3">
        <div class="flex min-w-0 flex-1 flex-col">
          <h3 class="truncate text-sm font-semibold">{props.channel.name}</h3>
          <span class="text-xs text-neutral-400">
            {resolutionLabel(props.channel.resolution)}, values 0 to {max()}
            {" · "}
            {props.channel.geometry}
          </span>
        </div>
        <Field label="Highlight DMX" class="w-28">
          <CommitField
            inputMode="numeric"
            placeholder="None"
            value={
              props.channel.highlight === undefined
                ? ""
                : String(props.channel.highlight)
            }
            onCommit={(text) => {
              const trimmed = text.trim();
              const value = trimmed === "" ? undefined : Number(trimmed);
              if (
                value !== undefined &&
                (!Number.isInteger(value) || value < 0 || value > max())
              ) {
                return false;
              }
              return editing.edit({
                type: "SetChannelHighlight",
                data: {
                  mode: props.mode,
                  channel: props.channelIndex,
                  value,
                },
              });
            }}
          />
        </Field>
      </div>
      <Show
        when={
          problemsAt(editing.draft().problems, props.mode, props.channelIndex)
            .length > 0
        }
      >
        <ul class="flex flex-col gap-1">
          <For
            each={problemsAt(
              editing.draft().problems,
              props.mode,
              props.channelIndex,
            )}
          >
            {(problem) => (
              <li class="flex items-start gap-2 text-xs">
                <Badge
                  tone={
                    problem.severity === types.ProblemSeverity.Error
                      ? "danger"
                      : "warning"
                  }
                  uppercase
                  size="xs"
                >
                  {problem.severity}
                </Badge>
                <span>{problem.message}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <div class="flex items-center gap-2">
        <h4 class="text-xs font-semibold text-neutral-300">Functions</h4>
        <Button
          size="compact"
          variant="subtle"
          class="ml-auto"
          disabled={nextStart() === undefined}
          onClick={addFunction}
        >
          <PlusIcon class="size-4" aria-hidden />
          Add function
        </Button>
      </div>
      <ul class="flex flex-col gap-3">
        <Index each={functions()}>
          {(item, position) => (
            <FunctionCard
              mode={props.mode}
              channelIndex={props.channelIndex}
              item={item()}
              end={functionEnd(position)}
              removable={functions().length > 1}
            />
          )}
        </Index>
      </ul>
    </section>
  );
}
