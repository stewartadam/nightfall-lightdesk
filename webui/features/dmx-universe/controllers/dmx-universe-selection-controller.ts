// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createEffect, createMemo, createSignal } from "solid-js";
import { CONSOLE_TRANSPORT } from "../../../lib/dmx-universe-data";
import { engineRuntime } from "../../../lib/engine-runtime";
import { useConditionalShallowStore } from "../../../lib/use-shallow-store";
import { useWorkspaceActivity } from "../../../lib/workspace-activity";
import { dmxUniverseData } from "../../../state/appStores";
import { $ioSettings } from "../../../state/settings";
import { DmxIoMode, InputUniverseVisibilityMode } from "../../../types";
import { outputSpaceSelection } from "../model/output-binding-follow";

const TRANSPORT_SORT_ORDER = [
  CONSOLE_TRANSPORT,
  "sACN",
  "Art-Net",
  "USB",
  "Disabled",
];

/** Owns DMX I/O mode, transport selection, and visible-universe projection. */
export function createDmxUniverseSelectionController() {
  const dmxData = useConditionalShallowStore(
    dmxUniverseData,
    useWorkspaceActivity(),
  );
  const settings = useStore($ioSettings);
  const [ioMode, setIoMode] = createSignal<DmxIoMode>(DmxIoMode.Output);
  const [selectedOutputTransport, setSelectedOutputTransport] =
    createSignal(CONSOLE_TRANSPORT);
  const [selectedInputTransport, setSelectedInputTransport] = createSignal("");
  const [selectedUniverse, setSelectedUniverse] = createSignal<number | null>(
    null,
  );

  /** Returns the configured policy for showing received input universes. */
  const inputUniverseVisibilityMode = createMemo(
    () =>
      settings().input_universe_visibility_mode ??
      InputUniverseVisibilityMode.ExternalOnly,
  );

  /** Persists the input-universe visibility policy. */
  const setInputUniverseVisibilityMode = (
    value: InputUniverseVisibilityMode,
  ) => {
    engineRuntime.sendCommand({
      module: "SettingsCommand",
      command: { type: "SetInputUniverseVisibilityMode", data: value },
    });
  };

  /** Projects output universes from the live DMX snapshot. */
  const outputUniverses = createMemo(() =>
    dmxData().filter((universe) => universe.io_mode === DmxIoMode.Output),
  );

  /** Projects input universes from the live DMX snapshot. */
  const inputUniverses = createMemo(() =>
    dmxData().filter((universe) => universe.io_mode === DmxIoMode.Input),
  );

  /**
   * Returns the sort rank of a transport label by its family, so concrete labels such as
   * "sACN → 10.0.0.4" sort with their family; unknown families return -1.
   */
  const transportRank = (label: string) =>
    TRANSPORT_SORT_ORDER.findIndex(
      (family) => label === family || label.startsWith(`${family} `),
    );

  /** Sorts transports by operator-facing family priority, then alphabetically. */
  const sortTransports = (a: string, b: string) => {
    const aIndex = transportRank(a);
    const bIndex = transportRank(b);
    if (aIndex === bIndex) return a.localeCompare(b);
    if (aIndex === -1) return 1;
    if (bIndex === -1) return -1;
    return aIndex - bIndex;
  };

  /**
   * Returns numbering spaces available for the active I/O mode. Output mode lists
   * "Console" (console numbering) and each transport family (wire numbering) that has
   * data, falling back to "Console" alone when nothing is being output.
   */
  const availableTransports = createMemo(() => {
    const transports = new Set<string>();
    const universes =
      ioMode() === DmxIoMode.Output ? outputUniverses() : inputUniverses();
    for (const universe of universes) {
      if (universe.transport) transports.add(universe.transport);
    }
    if (ioMode() === DmxIoMode.Output && transports.size === 0) {
      return [CONSOLE_TRANSPORT];
    }
    return Array.from(transports).sort(sortTransports);
  });

  /** Returns the transport selected for the active I/O mode. */
  const selectedTransport = createMemo(() =>
    ioMode() === DmxIoMode.Output
      ? selectedOutputTransport()
      : selectedInputTransport(),
  );

  /** Updates the mode-specific transport selection. */
  const setSelectedTransport = (transport: string) => {
    if (ioMode() === DmxIoMode.Output) setSelectedOutputTransport(transport);
    else setSelectedInputTransport(transport);
  };

  /** Keeps mode-specific transport selection valid as data changes. */
  createEffect(() => {
    const transports = availableTransports();
    if (ioMode() === DmxIoMode.Output) {
      if (!transports.includes(selectedOutputTransport()))
        setSelectedOutputTransport(transports[0] ?? "");
      return;
    }
    if (transports.length === 0) {
      setSelectedInputTransport("");
    } else if (!transports.includes(selectedInputTransport())) {
      setSelectedInputTransport(transports[0]);
    }
  });

  /** Filters universes to the active I/O mode and numbering space. */
  const filteredUniverses = createMemo(() => {
    const transport = selectedTransport();
    if (!transport) return [];
    const universes =
      ioMode() === DmxIoMode.Output ? outputUniverses() : inputUniverses();
    return universes.filter((universe) => universe.transport === transport);
  });

  /**
   * Resolves the selected output numbering space: console space, or the concrete output
   * transport reported by the selected label's universes. `null` outside output mode.
   */
  const selectedOutputSpace = createMemo(() => {
    if (ioMode() !== DmxIoMode.Output) return null;
    return outputSpaceSelection(
      selectedOutputTransport(),
      filteredUniverses()[0]?.output_transport,
    );
  });

  /** Returns sorted identifiers for the filtered universe set. */
  const universeIds = createMemo(() =>
    filteredUniverses()
      .map((universe) => universe.universe_id)
      .sort((a, b) => a - b),
  );

  /** Indexes filtered universes for tab and jump lookups. */
  const universeById = createMemo(
    () =>
      new Map(
        filteredUniverses().map((universe) => [universe.universe_id, universe]),
      ),
  );

  /** Returns the selected filtered universe, when available. */
  const currentUniverse = createMemo(() => {
    const id = selectedUniverse();
    return id === null ? undefined : universeById().get(id);
  });

  /** Selects the first universe whenever filtering invalidates the current tab. */
  createEffect(() => {
    const ids = universeIds();
    if (ids.length === 0) {
      if (selectedUniverse() !== null) setSelectedUniverse(null);
      return;
    }
    const current = selectedUniverse();
    if (current === null || !ids.includes(current)) setSelectedUniverse(ids[0]);
  });

  return {
    settings,
    ioMode,
    setIoMode,
    inputUniverseVisibilityMode,
    setInputUniverseVisibilityMode,
    availableTransports,
    selectedTransport,
    setSelectedTransport,
    selectedOutputSpace,
    universeIds,
    universeById,
    currentUniverse,
    selectedUniverse,
    setSelectedUniverse,
  };
}

export type DmxUniverseSelectionController = ReturnType<
  typeof createDmxUniverseSelectionController
>;
