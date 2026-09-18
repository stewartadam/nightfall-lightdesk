// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createEffect, createMemo, createSignal } from "solid-js";
import { engineRuntime } from "../../../lib/engine-runtime";
import { useConditionalShallowStore } from "../../../lib/use-shallow-store";
import { useWorkspaceActivity } from "../../../lib/workspace-activity";
import { dmxUniverseData } from "../../../state/appStores";
import { $ioSettings } from "../../../state/settings";
import { DmxIoMode, InputUniverseVisibilityMode } from "../../../types";

const TRANSPORT_SORT_ORDER = ["Console", "sACN", "Art-Net", "USB", "Disabled"];

/** Owns DMX I/O mode, transport selection, and visible-universe projection. */
export function createDmxUniverseSelectionController() {
  const dmxData = useConditionalShallowStore(
    dmxUniverseData,
    useWorkspaceActivity(),
  );
  const settings = useStore($ioSettings);
  const [ioMode, setIoMode] = createSignal<DmxIoMode>(DmxIoMode.Output);
  const [selectedOutputTransport, setSelectedOutputTransport] =
    createSignal("Console");
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

  /** Sorts known transports by operator-facing priority, then alphabetically. */
  const sortTransports = (a: string, b: string) => {
    const aIndex = TRANSPORT_SORT_ORDER.indexOf(a);
    const bIndex = TRANSPORT_SORT_ORDER.indexOf(b);
    if (aIndex === -1 && bIndex === -1) return a.localeCompare(b);
    if (aIndex === -1) return 1;
    if (bIndex === -1) return -1;
    return aIndex - bIndex;
  };

  /** Returns transports available for the active I/O mode. */
  const availableTransports = createMemo(() => {
    const transports = new Set<string>();
    if (ioMode() === DmxIoMode.Output) {
      for (const universe of outputUniverses()) {
        for (const transport of universe.transports) transports.add(transport);
      }
      return ["Console", ...Array.from(transports).sort(sortTransports)];
    }
    for (const universe of inputUniverses()) {
      if (universe.transport) transports.add(universe.transport);
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

  /** Filters universes to the active I/O mode and transport. */
  const filteredUniverses = createMemo(() => {
    const transport = selectedTransport();
    if (ioMode() === DmxIoMode.Output) {
      if (!transport || transport === "Console") return outputUniverses();
      return outputUniverses().filter((universe) =>
        universe.transports.includes(transport),
      );
    }
    if (!transport) return [];
    return inputUniverses().filter(
      (universe) => universe.transport === transport,
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
