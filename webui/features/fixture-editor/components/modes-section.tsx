// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ArrowDownIcon } from "@squidlab/phosphor-solid/arrow-down";
import { ArrowUpIcon } from "@squidlab/phosphor-solid/arrow-up";
import { CopyIcon } from "@squidlab/phosphor-solid/copy";
import { PlusIcon } from "@squidlab/phosphor-solid/plus";
import { TrashIcon } from "@squidlab/phosphor-solid/trash";
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  Index,
  on,
  Show,
} from "solid-js";
import { Badge } from "../../../components/ui/badge";
import { EmptyState } from "../../../components/ui/empty-state";
import { NativeSelect } from "../../../components/ui/form-controls";
import { SegmentedTabs } from "../../../components/ui/segmented-tabs";
import { Table } from "../../../components/ui/table";
import { Button } from "../../../components/ui/visual-language/button";
import {
  addressLabel,
  channelAttributes,
  nextName,
  problemsAt,
  RESOLUTIONS,
  resolutionLabel,
} from "../model/draft-editing";
import AttributeField from "./attribute-field";
import ChannelDetail from "./channel-detail";
import { CommitField, revertIfRefused } from "./commit-field";
import { useDraftEditing } from "./draft-context";

/** Adds a channel to the end of a mode: an attribute and a resolution. */
function AddChannelForm(props: { mode: number }) {
  const editing = useDraftEditing();
  const [attribute, setAttribute] = createSignal("");
  const [resolution, setResolution] = createSignal(1);

  /** Adds the channel and clears the attribute for the next one. */
  const add = async () => {
    const name = attribute().trim();
    if (!name) return;
    const added = await editing.edit({
      type: "AddChannel",
      data: { mode: props.mode, attribute: name, resolution: resolution() },
    });
    if (added) setAttribute("");
  };

  return (
    <form
      class="flex flex-wrap items-end gap-2"
      data-testid="add-channel-form"
      onSubmit={(event) => {
        event.preventDefault();
        void add();
      }}
    >
      <label class="flex min-w-48 flex-1 flex-col gap-1 text-sm">
        <span class="text-neutral-300">Attribute</span>
        <AttributeField
          value={attribute()}
          onInput={setAttribute}
          placeholder="e.g. Dimmer or ColorAdd_R"
        />
      </label>
      <label class="flex flex-col gap-1 text-sm">
        <span class="text-neutral-300">Resolution</span>
        <NativeSelect
          density="compact"
          value={resolution()}
          onInput={(event) => setResolution(Number(event.currentTarget.value))}
        >
          <For each={RESOLUTIONS}>
            {(bytes) => <option value={bytes}>{resolutionLabel(bytes)}</option>}
          </For>
        </NativeSelect>
      </label>
      <Button type="submit" size="compact" disabled={!attribute().trim()}>
        <PlusIcon class="size-4" aria-hidden />
        Add channel
      </Button>
    </form>
  );
}

/** The channel table of one mode, with the selected channel's details beneath it. */
function ModeChannels(props: { mode: number }) {
  const editing = useDraftEditing();
  const [selected, setSelected] = createSignal<number | null>(null);
  /** The mode on screen, from the draft's latest view. */
  const mode = () => editing.draft().modes[props.mode];
  /** Channels of the mode, empty while the mode is being removed. */
  const channels = () => mode()?.channels ?? [];

  /** Counts the modes, so removing one (which can shift another into this position) clears the selection. */
  const modeCount = createMemo(() => editing.draft().modes.length);

  /** Clears the selection when another mode is shown, since its index belonged to the old one. */
  createEffect(
    on([() => props.mode, modeCount], () => setSelected(null), {
      defer: true,
    }),
  );

  /** Clears a selection that a removal or a change elsewhere left pointing past the end. */
  createEffect(() => {
    const index = selected();
    if (index !== null && index >= channels().length) setSelected(null);
  });

  /** Moves a channel and keeps it selected at its new place. */
  const move = async (from: number, to: number) => {
    const moved = await editing.edit({
      type: "MoveChannel",
      data: { mode: props.mode, from, to },
    });
    if (!moved) return;
    if (selected() === from) setSelected(to);
    else if (selected() === to) setSelected(from);
  };

  /** Removes a channel and keeps the selection on the same channel, or clears it when that one went. */
  const remove = async (index: number) => {
    const removed = await editing.edit({
      type: "RemoveChannel",
      data: { mode: props.mode, channel: index },
    });
    const current = selected();
    if (!removed || current === null) return;
    if (current === index) setSelected(null);
    else if (current > index) setSelected(current - 1);
  };

  return (
    <div class="flex flex-col gap-3">
      <Show
        when={channels().length > 0}
        fallback={
          <EmptyState
            variant="dashed"
            class="p-6"
            title="No channels yet"
            description="Add the fixture's channels in the order its manual lists them."
          />
        }
      >
        <Table aria-label="Channels" data-testid="mode-channels">
          <thead>
            <tr>
              <th scope="col">Address</th>
              <th scope="col">Channel</th>
              <th scope="col">Attribute</th>
              <th scope="col">Resolution</th>
              <th scope="col">
                <span class="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <Index each={channels()}>
              {(channel, index) => (
                <tr
                  data-selected={selected() === index || undefined}
                  data-testid="channel-row"
                  onClick={(event) => {
                    if (
                      !(event.target as Element).closest(
                        "button, select, input",
                      )
                    )
                      setSelected(index);
                  }}
                >
                  <td class="font-mono tabular-nums">
                    {addressLabel(channel().offset)}
                  </td>
                  <td>
                    <span class="flex items-center gap-2">
                      <button
                        type="button"
                        class="text-left hover:underline"
                        aria-pressed={selected() === index}
                        onClick={() =>
                          setSelected(selected() === index ? null : index)
                        }
                      >
                        {channel().name}
                      </button>
                      <Show
                        when={
                          problemsAt(
                            editing.draft().problems,
                            props.mode,
                            index,
                          ).length > 0
                        }
                      >
                        <Badge tone="warning" size="xs">
                          Problem
                        </Badge>
                      </Show>
                    </span>
                  </td>
                  <td>{channelAttributes(channel())}</td>
                  <td>
                    <NativeSelect
                      density="compact"
                      aria-label={`Resolution of ${channel().name}`}
                      value={channel().resolution}
                      onInput={(event) =>
                        revertIfRefused(
                          event.currentTarget,
                          editing.edit({
                            type: "SetChannelResolution",
                            data: {
                              mode: props.mode,
                              channel: index,
                              resolution: Number(event.currentTarget.value),
                            },
                          }),
                          () => channel().resolution,
                        )
                      }
                    >
                      <For each={RESOLUTIONS}>
                        {(bytes) => (
                          <option value={bytes}>
                            {resolutionLabel(bytes)}
                          </option>
                        )}
                      </For>
                    </NativeSelect>
                  </td>
                  <td>
                    <span class="flex justify-end gap-1">
                      <Button
                        size="icon-compact"
                        variant="subtle"
                        aria-label={`Move ${channel().name} up`}
                        tooltip="Move up"
                        disabled={index === 0}
                        onClick={() => void move(index, index - 1)}
                      >
                        <ArrowUpIcon class="size-4" aria-hidden />
                      </Button>
                      <Button
                        size="icon-compact"
                        variant="subtle"
                        aria-label={`Move ${channel().name} down`}
                        tooltip="Move down"
                        disabled={index === channels().length - 1}
                        onClick={() => void move(index, index + 1)}
                      >
                        <ArrowDownIcon class="size-4" aria-hidden />
                      </Button>
                      <Button
                        size="icon-compact"
                        variant="subtle"
                        aria-label={`Remove ${channel().name}`}
                        tooltip="Remove channel"
                        onClick={() => void remove(index)}
                      >
                        <TrashIcon class="size-4" aria-hidden />
                      </Button>
                    </span>
                  </td>
                </tr>
              )}
            </Index>
          </tbody>
        </Table>
      </Show>
      <AddChannelForm mode={props.mode} />
      <Show when={selected() !== null && channels()[selected() ?? -1]}>
        {(channel) => (
          <ChannelDetail
            mode={props.mode}
            channelIndex={selected() ?? 0}
            channel={channel()}
          />
        )}
      </Show>
    </div>
  );
}

/**
 * Edits the fixture's DMX modes: a list to pick, add, copy and remove modes,
 * and the chosen mode's name and channels.
 */
export default function ModesSection() {
  const editing = useDraftEditing();
  const tabsId = createUniqueId();
  const contentId = `${tabsId}-content`;
  const [selected, setSelected] = createSignal(0);
  /** The draft's modes, from its latest view. */
  const modes = () => editing.draft().modes;
  /** The chosen mode, clamped to the modes that still exist. */
  const current = createMemo(() =>
    Math.min(selected(), Math.max(0, modes().length - 1)),
  );

  /** Adds a mode, empty or copying the chosen one, and shows it. */
  const addMode = async (copy: boolean) => {
    const names = modes().map((mode) => mode.name);
    const name = copy
      ? nextName(`${modes()[current()]?.name ?? "Mode"} copy`, names)
      : nextName("Mode", names);
    const added = await editing.edit({
      type: "AddMode",
      data: { name, copy_of: copy ? current() : undefined },
    });
    if (added) setSelected(editing.draft().modes.length - 1);
  };

  return (
    <section class="flex flex-col gap-4" data-testid="fixture-modes-section">
      <div class="flex flex-wrap items-center gap-2">
        <div class="min-w-0">
          <SegmentedTabs
            density="compact"
            id={tabsId}
            label="Modes"
            contentId={contentId}
            options={modes().map((mode, index) => ({
              key: String(index),
              label: (
                <>
                  {mode.name}
                  <span class="ml-1 text-xs opacity-70">
                    {mode.footprint} ch
                  </span>
                </>
              ),
            }))}
            value={String(current())}
            onChange={(key) => setSelected(Number(key))}
          />
        </div>
        <Button
          size="compact"
          variant="subtle"
          onClick={() => void addMode(false)}
        >
          <PlusIcon class="size-4" aria-hidden />
          Add mode
        </Button>
        <Show when={modes().length > 0}>
          <Button
            size="compact"
            variant="subtle"
            onClick={() => void addMode(true)}
          >
            <CopyIcon class="size-4" aria-hidden />
            Copy mode
          </Button>
        </Show>
      </div>
      <Show
        when={modes()[current()]}
        fallback={
          <EmptyState
            variant="dashed"
            class="p-6"
            title="No modes"
            description="A fixture needs at least one DMX mode."
          />
        }
      >
        {(mode) => (
          <div
            id={contentId}
            role="tabpanel"
            aria-labelledby={`${tabsId}-${current()}`}
            class="flex flex-col gap-4"
          >
            <div class="flex flex-wrap items-end gap-2">
              <label class="flex min-w-48 flex-col gap-1 text-sm">
                <span class="text-neutral-300">Mode name</span>
                <CommitField
                  value={mode().name}
                  onCommit={(name) =>
                    editing.edit({
                      type: "RenameMode",
                      data: { mode: current(), name },
                    })
                  }
                />
              </label>
              <span class="pb-1.5 text-sm text-neutral-400">
                {mode().footprint} DMX{" "}
                {mode().footprint === 1 ? "address" : "addresses"}
              </span>
              <Button
                size="compact"
                variant="subtle"
                class="ml-auto"
                disabled={modes().length === 1}
                tooltip={
                  modes().length === 1
                    ? "A fixture needs at least one mode"
                    : undefined
                }
                onClick={() =>
                  void editing.edit({
                    type: "RemoveMode",
                    data: { mode: current() },
                  })
                }
              >
                <TrashIcon class="size-4" aria-hidden />
                Remove mode
              </Button>
            </div>
            <ModeChannels mode={current()} />
          </div>
        )}
      </Show>
    </section>
  );
}
