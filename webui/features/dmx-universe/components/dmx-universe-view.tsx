// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createUniqueId, For, Index, Show } from "solid-js";
import { Input, NativeSelect } from "../../../components/ui/form-controls";
import PanelToolbar from "../../../components/ui/panel-toolbar";
import { SegmentedTabs } from "../../../components/ui/segmented-tabs";
import { ToggleSwitch } from "../../../components/ui/toggle-switch";
import Tooltip from "../../../components/ui/tooltip";
import { getInputFreshness } from "../../../lib/dmx-universe-data";
import type * as types from "../../../types";
import { DmxIoMode, InputUniverseVisibilityMode } from "../../../types";
import type { ChannelInfo } from "../model/dmx-universe-model";

export type FixtureJumpHighlight = {
  universeId: number;
  address: number;
};

export type DmxUniverseViewProps = {
  ioMode: DmxIoMode;
  inputUniverseVisibilityMode: InputUniverseVisibilityMode;
  availableTransports: string[];
  selectedTransport: string;
  universeIds: number[];
  selectedUniverse: number | null;
  currentUniverse: types.OutboundDmxUniverse | undefined;
  fixtures: Record<string, types.Fixture>;
  fixtureJumpActive: boolean;
  fixtureJumpText: string;
  fixtureJumpHighlight: FixtureJumpHighlight | undefined;
  universeForId: (id: number) => types.OutboundDmxUniverse | undefined;
  channelInfo: (address: number) => ChannelInfo | undefined;
  channelIsSelected: (address: number) => boolean;
  channelValueColor: (address: number, value: number) => string;
  onIoModeChange: (mode: DmxIoMode) => void;
  onInputUniverseVisibilityModeChange: (
    mode: InputUniverseVisibilityMode,
  ) => void;
  onSelectedTransportChange: (transport: string) => void;
  onSelectedUniverseChange: (universeId: number) => void;
  onFixtureJumpInputRef: (element: HTMLInputElement) => void;
  onFixtureJumpTextChange: (value: string) => void;
  onFixtureJumpFinish: (restore: boolean) => void;
  onScrollRef: (element: HTMLDivElement) => void;
  onChannelClick: (event: MouseEvent, address: number) => void;
  onChannelContextMenu: (event: MouseEvent, address: number) => void;
};

/** Renders the fixture-jump editor over the DMX universe view. */
function FixtureJumpInput(props: DmxUniverseViewProps) {
  /** Commits or cancels the fixture jump from keyboard input. */
  const handleKeyDown = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      props.onFixtureJumpFinish(true);
    } else if (event.key === "Enter") {
      event.preventDefault();
      props.onFixtureJumpFinish(false);
    }
  };

  return (
    <Show when={props.fixtureJumpActive}>
      <div class="absolute right-2 top-2 z-50 w-40">
        <Input
          density="compact"
          ref={props.onFixtureJumpInputRef}
          type="text"
          aria-label="Fixture ID jump"
          placeholder="Fixture / attribute"
          value={props.fixtureJumpText}
          onInput={(event) =>
            props.onFixtureJumpTextChange(event.currentTarget.value)
          }
          onKeyDown={handleKeyDown}
          onBlur={() => props.onFixtureJumpFinish(false)}
        />
      </div>
    </Show>
  );
}

/** Renders input/output and transport controls for the DMX panel. */
function DmxUniverseToolbar(
  props: DmxUniverseViewProps & { contentId: string },
) {
  return (
    <PanelToolbar
      left={
        <SegmentedTabs
          id={`${props.contentId}-direction`}
          density="compact"
          label="DMX direction"
          contentId={props.contentId}
          options={[
            { key: DmxIoMode.Output, label: "Output" },
            { key: DmxIoMode.Input, label: "Input" },
          ]}
          value={props.ioMode}
          onChange={props.onIoModeChange}
        />
      }
      right={
        <>
          <Show when={props.ioMode === DmxIoMode.Input}>
            <ToggleSwitch
              label="External"
              ariaLabel="External only"
              checked={
                props.inputUniverseVisibilityMode ===
                InputUniverseVisibilityMode.ExternalOnly
              }
              onChange={(externalOnly) =>
                props.onInputUniverseVisibilityModeChange(
                  externalOnly
                    ? InputUniverseVisibilityMode.ExternalOnly
                    : InputUniverseVisibilityMode.AllDetected,
                )
              }
            />
          </Show>
          <label class="flex items-center gap-2 text-xs text-neutral-400">
            <span>Transport</span>
            <NativeSelect
              density="compact"
              value={props.selectedTransport}
              disabled={props.availableTransports.length === 0}
              onChange={(event) =>
                props.onSelectedTransportChange(event.currentTarget.value)
              }
            >
              <Show
                when={props.availableTransports.length > 0}
                fallback={<option value="">No transports</option>}
              >
                <For each={props.availableTransports}>
                  {(transport) => (
                    <option value={transport}>{transport}</option>
                  )}
                </For>
              </Show>
            </NativeSelect>
          </label>
        </>
      }
    />
  );
}

/** Renders universe selection tabs and input freshness indicators. */
function DmxUniverseTabs(props: DmxUniverseViewProps & { contentId: string }) {
  /** Resolves an input indicator without requiring data for every listed universe. */
  const freshness = (id: number) => {
    const universe = props.universeForId(id);
    return universe ? getInputFreshness(universe).dot : "unknown";
  };
  return (
    <div class="shrink-0 min-w-0 border-b border-neutral-700 p-2">
      <SegmentedTabs
        id={`${props.contentId}-universe`}
        label="DMX universes"
        contentId={props.contentId}
        options={props.universeIds.map((id) => ({
          key: String(id),
          label: (
            <>
              <Show when={props.ioMode === DmxIoMode.Input}>
                <span
                  aria-hidden="true"
                  class="inline-flex h-2 w-2 shrink-0 rounded-full"
                  classList={{
                    "bg-emerald-400": freshness(id) === "live",
                    "bg-amber-400": freshness(id) === "stale",
                    "bg-gray-500": freshness(id) === "unknown",
                  }}
                />
              </Show>
              <span>Univ. {id}</span>
            </>
          ),
        }))}
        value={String(props.selectedUniverse)}
        onChange={(id) => props.onSelectedUniverseChange(Number(id))}
      />
    </div>
  );
}

/** Renders freshness metadata above an input universe channel grid. */
function InputUniverseFreshness(props: {
  universe: types.OutboundDmxUniverse;
}) {
  /** Projects input freshness for the visible universe. */
  const freshness = () => getInputFreshness(props.universe);

  return (
    <Show when={props.universe.is_stale !== undefined}>
      <Show when={freshness().badgeLabel}>
        <span
          class="rounded px-1.5 py-0.5 font-semibold"
          classList={{
            "bg-emerald-900 text-emerald-300": freshness().dot === "live",
            "bg-amber-900 text-amber-300": freshness().dot === "stale",
          }}
        >
          {freshness().badgeLabel}
        </span>
        <Show
          when={freshness().dot === "live" && props.universe.is_self === true}
        >
          <span class="rounded bg-blue-900 px-1.5 py-0.5 font-semibold text-blue-300">
            Self
          </span>
        </Show>
        <span class="text-gray-500">age {freshness().ageLabel}</span>
      </Show>
    </Show>
  );
}

/** Renders the address/value cell grid for one DMX universe. */
function DmxChannelGrid(
  props: DmxUniverseViewProps & {
    universe: types.OutboundDmxUniverse;
  },
) {
  return (
    <div class="grid grid-cols-[repeat(auto-fill,minmax(44px,1fr))] gap-1">
      <Index each={props.universe.channels}>
        {(value, index) => {
          const address = index + 1;
          /** Returns output patch metadata for this channel. */
          const channelInfo = () =>
            props.ioMode === DmxIoMode.Output
              ? props.channelInfo(address)
              : undefined;
          /** Returns the fixture identifier shown above the DMX value. */
          const fixtureIdentifier = () => {
            const info = channelInfo();
            if (!info) return "";
            const fixture = props.fixtures[info.fixtureUid];
            return fixture && fixture.elements.length > 1
              ? `#${info.fixtureId}.${info.elementIndex}`
              : `#${info.fixtureId}`;
          };
          /** Returns descriptive hover content for this channel. */
          const tooltip = () => {
            const info = channelInfo();
            if (!info) return `Ch ${address}: ${value()}`;
            return `Ch ${address}: ${value()}\n${fixtureIdentifier()} ${info.fixtureLabel}\n${info.elementLabel} → ${info.attribute}`;
          };
          /** Returns whether fixture jump navigation highlights this cell. */
          const isJumpMatch = () =>
            props.fixtureJumpHighlight?.universeId === props.selectedUniverse &&
            props.fixtureJumpHighlight?.address === address;

          return (
            <Tooltip content={tooltip} position="bottom">
              <button
                type="button"
                data-dmx-channel-address={address}
                data-dmx-jump-match={isJumpMatch() ? "true" : undefined}
                class="h-12 w-full bg-gray-800 rounded text-center flex flex-col justify-between p-0.5 text-xs border appearance-none"
                classList={{
                  "border-red-500":
                    props.ioMode === DmxIoMode.Output &&
                    props.channelIsSelected(address),
                  "border-gray-700":
                    props.ioMode !== DmxIoMode.Output ||
                    !props.channelIsSelected(address),
                  "ring-2 ring-blue-400": isJumpMatch(),
                }}
                onClick={(event) => props.onChannelClick(event, address)}
                onContextMenu={(event) =>
                  props.onChannelContextMenu(event, address)
                }
              >
                <div class="text-[8px] text-gray-500 truncate leading-tight h-3 overflow-hidden">
                  {fixtureIdentifier()}
                </div>
                <div
                  class="font-mono text-sm leading-none"
                  data-dmx-channel-value={address}
                  style={{
                    color: props.channelValueColor(address, value()),
                  }}
                >
                  {value()}
                </div>
                <div class="text-[8px] text-gray-600 leading-tight h-3">
                  {address}
                </div>
              </button>
            </Tooltip>
          );
        }}
      </Index>
    </div>
  );
}

/** Presents the complete props-driven DMX universe toolbar and channel grid. */
export function DmxUniverseView(props: DmxUniverseViewProps) {
  const contentId = createUniqueId();
  return (
    <div class="relative h-full flex flex-col bg-gray-900 text-white">
      <FixtureJumpInput {...props} />
      <DmxUniverseToolbar {...props} contentId={contentId} />
      <div
        id={contentId}
        role="tabpanel"
        aria-labelledby={`${contentId}-direction-${props.ioMode}`}
        class="flex flex-col flex-1 min-h-0"
      >
        <DmxUniverseTabs {...props} contentId={`${contentId}-channels`} />
        <div
          id={`${contentId}-channels`}
          role="tabpanel"
          aria-labelledby={
            props.selectedUniverse === null
              ? undefined
              : `${contentId}-channels-universe-${props.selectedUniverse}`
          }
          class="flex flex-col flex-1 min-h-0"
        >
          <Show
            when={props.currentUniverse}
            fallback={<div class="p-4 text-gray-500">No universe data</div>}
          >
            {(universe) => (
              <div ref={props.onScrollRef} class="flex-1 overflow-auto p-2">
                <Show when={props.ioMode === DmxIoMode.Input}>
                  <div class="mb-2 text-xs text-gray-400 flex items-center gap-2">
                    <InputUniverseFreshness universe={universe()} />
                  </div>
                </Show>
                <DmxChannelGrid {...props} universe={universe()} />
              </div>
            )}
          </Show>
        </div>
      </div>
    </div>
  );
}
