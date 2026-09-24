// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { NativeSelect } from "../../../components/ui/form-controls";
import { Table, TableScroll } from "../../../components/ui/table";
/**
 * Properties panel for Fixture Library
 * Shows detailed information about selected fixture
 */

import { useStore } from "@nanostores/solid";
import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  Show,
} from "solid-js";
import { fixtureWireLayout, parameterDmxBreak } from "../../../lib/dmx";
import { profileMatchesRevision } from "../../../lib/fixture-profile-match";
import { fetchFixtureProfile } from "../../../lib/fixture-service";
import { fixtureProfile } from "../../../state/appStores";
import type * as types from "../../../types";
import LibraryFixturePreview from "./library-fixture-preview";

interface FixtureLibraryPropertiesProps {
  selectedFixture: Accessor<types.AvailableFixtureInfo | null>;
}

type ParameterDisplayRow = {
  parameter: types.ParameterMetadata;
  attributeLabel: string;
  channelLabel: string;
  offsetLabel: string;
  order: number;
  width: number;
};

type ElementDisplayGroup = {
  element: types.FixtureElement;
  elementIndex: number;
  parameters: ParameterDisplayRow[];
};

/**
 * Returns a concise display name for a generated fixture attribute union.
 */
function attributeLabel(attribute: types.Attribute): string {
  if (attribute.type === "Custom") {
    return attribute.data.label;
  }
  return attribute.type;
}

/**
 * Formats a parameter value union for compact metadata display.
 */
function parameterValueLabel(value: types.ParameterValue): string {
  switch (value.type) {
    case "Absolute":
      return `${value.data.value}`;
    case "AbsolutePercent":
      return `${value.data.value * 100}%`;
    case "Relative":
      return `${value.data.offset >= 0 ? "+" : ""}${value.data.offset}`;
    case "RelativePercent":
      return `${value.data.offset >= 0 ? "+" : ""}${value.data.offset * 100}%`;
  }
}

/**
 * Formats 1-based footprint channels, collapsing contiguous bytes into a range.
 */
function channelListLabel(channels: number[]): string {
  const contiguous = channels.every(
    (channel, index) => index === 0 || channel === channels[index - 1] + 1,
  );
  if (channels.length === 1) return `${channels[0]}`;
  return contiguous
    ? `${channels[0]}-${channels[channels.length - 1]}`
    : channels.join(", ");
}

/**
 * Builds display rows with the DMX channels each parameter occupies in the fixture footprint.
 *
 * Every DMX break is laid out separately since each has its own start
 * address; channels on breaks after the first are prefixed with their break.
 */
function buildElementParameterGroups(
  fixture: types.Fixture | null,
): ElementDisplayGroup[] {
  if (!fixture) return [];

  const breaks = new Set<number>();
  for (const element of fixture.elements) {
    for (const parameter of element.parameters) {
      const dmxBreak = parameterDmxBreak(parameter);
      if (dmxBreak !== null) breaks.add(dmxBreak);
    }
  }
  const slotsByParameter = new Map<
    string,
    { dmxBreak: number; slots: number[] }
  >();
  for (const dmxBreak of breaks) {
    for (const placed of fixtureWireLayout(fixture, { dmxBreak }).parameters) {
      slotsByParameter.set(`${placed.elementIndex}:${placed.parameterIndex}`, {
        dmxBreak,
        slots: placed.slots,
      });
    }
  }
  let order = 1;

  return fixture.elements.map((element, elementIndex) => {
    const parameters = element.parameters.map((parameter, parameterIndex) => {
      const placement = slotsByParameter.get(
        `${elementIndex}:${parameterIndex}`,
      );
      const channels = (placement?.slots ?? []).map((slot) => slot + 1);
      const width = channels.length;
      const startChannel = channels[0] ?? null;
      const breakPrefix =
        placement && placement.dmxBreak !== 1
          ? `Break ${placement.dmxBreak}: `
          : "";

      return {
        parameter,
        attributeLabel: attributeLabel(parameter.attribute),
        channelLabel:
          startChannel === null
            ? "Virtual"
            : `${breakPrefix}${channelListLabel(channels)}`,
        offsetLabel: startChannel === null ? "n/a" : `${startChannel - 1}`,
        order: order++,
        width,
      };
    });

    return {
      element,
      elementIndex: elementIndex + 1,
      parameters,
    };
  });
}

/**
 * Counts the hardware DMX channels spanned by a fixture mode, including unused gaps.
 */
function totalDmxChannels(fixture: types.Fixture | null): number {
  return fixture ? fixtureWireLayout(fixture).footprint : 0;
}

/**
 * Returns whether a profile response belongs to the selected fixture and mode.
 */
function profileMatchesSelection(
  profile: types.GetFixtureProfileResponse | null,
  fixture: types.AvailableFixtureInfo | null,
  mode: string | undefined,
): boolean {
  if (!profileMatchesRevision(profile, fixture)) return false;
  if (!mode) return true;
  if (profile.fixture) {
    return profile.fixture.mode === mode;
  }
  return profile.requested_mode === mode;
}

/**
 * Renders mode-specific fixture library metadata and parameter configuration.
 */
export default function FixtureLibraryProperties(
  props: FixtureLibraryPropertiesProps,
) {
  const $fixtureProfile = useStore(fixtureProfile);
  /** Provides the currently selected fixture library row. */
  const selectedFixture = createMemo(() => props.selectedFixture());
  /** Tracks fixture identity changes that should reset mode-local state. */
  const selectedFixtureKey = createMemo(() => {
    const fixture = selectedFixture();
    return fixture
      ? `${fixture.make}\0${fixture.model}\0${fixture.asset_etag}`
      : null;
  });
  const [selectedMode, setSelectedMode] = createSignal<string | undefined>(
    selectedFixture()?.modes[0],
  );

  /** Keeps the selected mode valid when the selected fixture changes. */
  createEffect(
    on(selectedFixtureKey, () => {
      setSelectedMode(selectedFixture()?.modes[0]);
    }),
  );

  /** Requests parsed profile data for the selected mode shown in this panel. */
  createEffect(
    on(
      () => [selectedFixture(), selectedMode()] as const,
      ([fixture, mode]) => {
        if (!fixture) return;
        fetchFixtureProfile(
          fixture.make,
          fixture.model,
          mode,
          fixture.asset_etag,
        );
      },
    ),
  );

  /** Provides the profile response matching the selected fixture and mode. */
  const selectedProfile = createMemo(() => {
    const profile = $fixtureProfile();
    return profileMatchesSelection(profile, selectedFixture(), selectedMode())
      ? profile
      : null;
  });

  /** Provides the parsed mode fixture returned by the fixture library. */
  const modeFixture = createMemo(() => selectedProfile()?.fixture ?? null);

  /** Provides element and parameter rows with computed DMX channel order. */
  const elementGroups = createMemo(() =>
    buildElementParameterGroups(modeFixture()),
  );

  /** Provides the mode's hardware DMX footprint from visible parameter rows. */
  const channelCount = createMemo(() => totalDmxChannels(modeFixture()));

  return (
    <div class="flex h-full flex-col space-y-4 overflow-auto p-4">
      <Show
        when={selectedFixture()}
        fallback={
          <div class="text-neutral-500 text-sm">No fixture selected</div>
        }
      >
        {(fixture) => (
          <>
            <div>
              <LibraryFixturePreview
                make={fixture().make}
                model={fixture().model}
                mode={selectedMode()}
                assetEtag={fixture().asset_etag}
              />
            </div>

            <div class="border-t border-neutral-700" />

            <div>
              <h3 class="mb-2 font-medium text-sm">Fixture Details</h3>
              <div class="space-y-2 text-sm">
                <div>
                  <span class="text-neutral-400">Make:</span> {fixture().make}
                </div>
                <div>
                  <span class="text-neutral-400">Model:</span> {fixture().model}
                </div>
                <div>
                  <span class="text-neutral-400">Source Format:</span>{" "}
                  {fixture().source_format}
                </div>
                <div>
                  <label
                    class="mb-1 block text-neutral-400"
                    for="fixture-library-mode-select"
                  >
                    Mode
                  </label>
                  <NativeSelect
                    density="compact"
                    id="fixture-library-mode-select"
                    class="w-full"
                    value={selectedMode() ?? ""}
                    onChange={(event) => {
                      setSelectedMode(event.currentTarget.value || undefined);
                    }}
                  >
                    <For each={fixture().modes}>
                      {(mode) => (
                        <option value={mode} selected={selectedMode() === mode}>
                          {mode}
                        </option>
                      )}
                    </For>
                  </NativeSelect>
                </div>
              </div>
            </div>

            <div class="border-t border-neutral-700" />

            <div class="space-y-3">
              <div class="flex items-start justify-between gap-3">
                <div>
                  <h3 class="font-medium text-sm">Mode Parameters</h3>
                  <div
                    class="text-neutral-500 text-xs"
                    data-testid="fixture-library-selected-mode"
                  >
                    {selectedMode() ?? "Default mode"}
                  </div>
                </div>
                <Show when={modeFixture()}>
                  <div class="shrink-0 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-right text-xs">
                    <div class="text-neutral-400">DMX footprint</div>
                    <div class="font-medium text-neutral-100">
                      {channelCount()} ch
                    </div>
                  </div>
                </Show>
              </div>

              <Show
                when={selectedProfile()}
                fallback={
                  <div class="rounded border border-neutral-800 bg-neutral-900 p-3 text-neutral-500 text-xs">
                    Loading mode parameter configuration...
                  </div>
                }
              >
                {(profile) => (
                  <Show
                    when={profile().fixture}
                    fallback={
                      <div class="rounded border border-neutral-800 bg-neutral-900 p-3 text-neutral-500 text-xs">
                        This mode has no parsed parameter configuration.
                      </div>
                    }
                  >
                    {(profileFixture) => (
                      <Show
                        when={elementGroups().length > 0}
                        fallback={
                          <div class="rounded border border-neutral-800 bg-neutral-900 p-3 text-neutral-500 text-xs">
                            This mode has no parameter metadata.
                          </div>
                        }
                      >
                        <div class="space-y-3">
                          <div class="grid grid-cols-2 gap-2 text-xs">
                            <div class="rounded border border-neutral-800 bg-neutral-900 p-2">
                              <div class="text-neutral-500">Elements</div>
                              <div class="font-medium text-neutral-100">
                                {profileFixture().elements.length}
                              </div>
                            </div>
                            <div class="rounded border border-neutral-800 bg-neutral-900 p-2">
                              <div class="text-neutral-500">Parameters</div>
                              <div class="font-medium text-neutral-100">
                                {elementGroups().reduce(
                                  (total, group) =>
                                    total + group.parameters.length,
                                  0,
                                )}
                              </div>
                            </div>
                          </div>

                          <For each={elementGroups()}>
                            {(group) => (
                              <section class="overflow-hidden rounded border border-neutral-800 bg-neutral-900">
                                <div class="border-neutral-800 border-b px-3 py-2">
                                  <div class="flex items-baseline justify-between gap-2">
                                    <h4 class="font-medium text-neutral-100 text-xs">
                                      {group.element.label || "Element"} #
                                      {group.elementIndex}
                                    </h4>
                                    <span class="text-neutral-500 text-[11px]">
                                      {group.parameters.length} parameter
                                      {group.parameters.length === 1 ? "" : "s"}
                                    </span>
                                  </div>
                                </div>
                                <TableScroll aria-label="Fixture parameters scroll area">
                                  <Table
                                    aria-label="Fixture parameters"
                                    class="min-w-full text-left"
                                  >
                                    <thead>
                                      <tr>
                                        <th scope="col">#</th>
                                        <th scope="col">Attribute</th>
                                        <th scope="col">Ch</th>
                                        <th scope="col">Offset</th>
                                        <th scope="col">Width</th>
                                        <th scope="col">Range</th>
                                        <th scope="col">Details</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      <For each={group.parameters}>
                                        {(row) => (
                                          <tr class="align-top">
                                            <td class="whitespace-nowrap">
                                              {row.order}
                                            </td>
                                            <td class="whitespace-nowrap">
                                              {row.attributeLabel}
                                            </td>
                                            <td class="whitespace-nowrap">
                                              {row.channelLabel}
                                            </td>
                                            <td class="whitespace-nowrap">
                                              {row.offsetLabel}
                                            </td>
                                            <td class="whitespace-nowrap">
                                              {row.width === 0
                                                ? "0"
                                                : `${row.width} (${row.parameter.resolution})`}
                                            </td>
                                            <td class="whitespace-nowrap">
                                              {row.parameter.min}-
                                              {row.parameter.max}
                                            </td>
                                            <td class="min-w-[12rem]">
                                              <div class="flex flex-wrap gap-1">
                                                <span class="rounded bg-neutral-800 px-1.5 py-0.5">
                                                  {row.parameter.merge_type}
                                                </span>
                                                <Show
                                                  when={
                                                    row.parameter.value_polarity
                                                  }
                                                >
                                                  {(polarity) => (
                                                    <span class="rounded bg-neutral-800 px-1.5 py-0.5">
                                                      {polarity()}
                                                    </span>
                                                  )}
                                                </Show>
                                                <span class="rounded bg-neutral-800 px-1.5 py-0.5">
                                                  Offset{" "}
                                                  {parameterValueLabel(
                                                    row.parameter.offset,
                                                  )}
                                                </span>
                                                <Show
                                                  when={
                                                    row.parameter.is_inverted
                                                  }
                                                >
                                                  <span class="rounded bg-amber-950 px-1.5 py-0.5 text-amber-200">
                                                    Inverted
                                                  </span>
                                                </Show>
                                                <Show
                                                  when={row.parameter.is_snap}
                                                >
                                                  <span class="rounded bg-neutral-800 px-1.5 py-0.5">
                                                    Snap
                                                  </span>
                                                </Show>
                                                <Show
                                                  when={
                                                    row.parameter
                                                      .use_grandmaster
                                                  }
                                                >
                                                  <span class="rounded bg-neutral-800 px-1.5 py-0.5">
                                                    Grandmaster
                                                  </span>
                                                </Show>
                                              </div>
                                              <Show
                                                when={
                                                  (row.parameter.functions
                                                    ?.length ?? 0) > 1 ||
                                                  (row.parameter.functions?.[0]
                                                    ?.sets?.length ?? 0) > 0
                                                }
                                              >
                                                <ul
                                                  class="mt-1 space-y-0.5 text-neutral-400"
                                                  aria-label="DMX functions"
                                                >
                                                  <For
                                                    each={
                                                      row.parameter.functions
                                                    }
                                                  >
                                                    {(fn) => (
                                                      <li>
                                                        <span class="text-neutral-200">
                                                          {fn.dmx_from}-
                                                          {fn.dmx_to}
                                                        </span>{" "}
                                                        {fn.name}
                                                        <Show
                                                          when={
                                                            (fn.sets?.length ??
                                                              0) > 0
                                                          }
                                                        >
                                                          {": "}
                                                          {fn.sets
                                                            ?.map(
                                                              (set) =>
                                                                `${set.name} ${set.dmx_from}-${set.dmx_to}`,
                                                            )
                                                            .join(", ")}
                                                        </Show>
                                                      </li>
                                                    )}
                                                  </For>
                                                </ul>
                                              </Show>
                                            </td>
                                          </tr>
                                        )}
                                      </For>
                                    </tbody>
                                  </Table>
                                </TableScroll>
                              </section>
                            )}
                          </For>
                        </div>
                      </Show>
                    )}
                  </Show>
                )}
              </Show>
            </div>
          </>
        )}
      </Show>
    </div>
  );
}
