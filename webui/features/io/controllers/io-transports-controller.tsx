// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createEffect, createMemo, createSignal, For, onMount } from "solid-js";
import { Table, TableScroll } from "../../../components/ui/table";
import { ToggleSwitch } from "../../../components/ui/toggle-switch";
import { engineRuntime } from "../../../lib/engine-runtime";
import {
  sendNetworkDmxOutputs,
  sendNetworkInputEnabled,
  sendNetworkOutputEnabled,
  sendUsbDmxOutputs,
  sendUsbOutputEnabled,
} from "../../../lib/io-service";
import { networkOutputFailureForTarget } from "../../../lib/network-dmx-output-health";
import {
  isValidIpv4Address,
  isValidNetworkDmxTargetId,
  isValidUsbDmxTargetId,
  networkDmxOutputsFromSettings,
  refreshReservedOutputTargetKeywords,
  reservedOutputTargetKeywordsReady,
  usbDmxOutputsFromSettings,
} from "../../../lib/network-dmx-output-targets";
import { isEmbeddedDemoRuntime } from "../../../lib/runtime-config";
import { engineMetrics, runtimeCapabilities } from "../../../state/appStores";
import {
  $availableNetworkInterfaces,
  $availableUsbDmxDevices,
  $externalControlState,
  $ioSettings,
  $networkInterfaceStatus,
} from "../../../state/settings";
import * as types from "../../../types";
import { ExternalControlSettings } from "../components/external-control-settings";
import { NetworkInterfaceSummary } from "../components/network-interface-summary";
import { NetworkTargetAddRow } from "../components/network-target-add-row";
import { NetworkTargetRow } from "../components/network-target-row";
import { UsbDeviceSummary } from "../components/usb-device-summary";
import { UsbTargetAddRow } from "../components/usb-target-add-row";
import { UsbTargetRow } from "../components/usb-target-row";
import {
  deliveryFromMode,
  isBuiltInTarget,
  replaceTarget,
  targetOutputKey,
} from "../network/model";
import {
  DEFAULT_USB_DEVICE_ID,
  isBuiltInUsbTarget,
  replaceUsbTarget,
  usbDeviceOptionLabel,
  usbDeviceSelectorLabel,
  usbDeviceSerialConflictKeys,
  usbTargetDeviceLabel,
} from "../usb/model";

/** Coordinates I/O transport stores, edits, validation, and presentation. */
export function IoTransportsController() {
  const settings = useStore($ioSettings);
  const capabilities = useStore(runtimeCapabilities);
  const metrics = useStore(engineMetrics);
  const networkInterfaces = useStore($availableNetworkInterfaces);
  const externalControl = useStore($externalControlState);
  const networkInterfaceStatus = useStore($networkInterfaceStatus);
  const usbDevices = useStore($availableUsbDmxDevices);

  const [newId, setNewId] = createSignal("");
  const [newProtocol, setNewProtocol] = createSignal<types.NetworkDmxProtocol>(
    types.NetworkDmxProtocol.Sacn,
  );
  const [newDeliveryMode, setNewDeliveryMode] = createSignal("Unicast");
  const [newIp, setNewIp] = createSignal("127.0.0.1");
  const [newUsbId, setNewUsbId] = createSignal("");
  const [newUsbDevice, setNewUsbDevice] = createSignal("");
  const [reservedKeywordsReady, setReservedKeywordsReady] = createSignal(
    reservedOutputTargetKeywordsReady(),
  );

  onMount(() => {
    void refreshReservedOutputTargetKeywords().then(setReservedKeywordsReady);
  });

  /** Requests compatible USB adapter choices when the panel is mounted. */
  createEffect(() => {
    engineRuntime.sendCommand({
      module: "SettingsCommand",
      command: { type: "GetAvailableUsbDmxDevices" },
    });
  });

  const targets = createMemo(
    () => networkDmxOutputsFromSettings(settings()).targets,
  );
  /** Returns configured USB output target mappings from showfile settings. */
  const usbTargets = createMemo(
    () => usbDmxOutputsFromSettings(settings()).targets,
  );
  /** Returns discovered USB DMX devices keyed by stable selector id. */
  const usbDeviceById = createMemo(
    () => new Map(usbDevices().map((device) => [device.id, device])),
  );
  /** Returns serial identities that need USB port labels in selectors. */
  const usbSerialConflictKeys = createMemo(() =>
    usbDeviceSerialConflictKeys(usbDevices()),
  );
  /** Returns discovered USB DMX device ids that are not already mapped. */
  const availableNewUsbDeviceIds = createMemo(() => {
    const usedDevices = new Set(usbTargets().map((target) => target.device));
    const availableDeviceIds = usbDevices()
      .map((device) => device.id)
      .filter((deviceId) => !usedDevices.has(deviceId));
    return usedDevices.has(DEFAULT_USB_DEVICE_ID)
      ? availableDeviceIds
      : [DEFAULT_USB_DEVICE_ID, ...availableDeviceIds];
  });
  /** Projects unused USB device selectors for the add-row presentation. */
  const availableNewUsbDeviceOptions = createMemo(() =>
    availableNewUsbDeviceIds().map((deviceId) => ({
      id: deviceId,
      label:
        deviceId === DEFAULT_USB_DEVICE_ID
          ? usbDeviceSelectorLabel(deviceId, usbDeviceById())
          : usbDeviceOptionLabel(
              usbDeviceById().get(deviceId)!,
              usbSerialConflictKeys(),
            ),
    })),
  );
  /** Selects the first unused USB device as hardware enumeration changes. */
  createEffect(() => {
    const availableDeviceIds = availableNewUsbDeviceIds();
    const selectedDevice = newUsbDevice();
    if (selectedDevice !== "" && availableDeviceIds.includes(selectedDevice)) {
      return;
    }
    setNewUsbDevice(availableDeviceIds[0] ?? "");
  });
  const sendFailuresByTargetId = createMemo(() => {
    const failures = metrics()?.network_output_send_failures ?? [];
    const entries = targets()
      .map((target): [string, types.NetworkOutputSendFailure | undefined] => [
        target.id,
        networkOutputFailureForTarget(target, failures),
      ])
      .filter(
        (entry): entry is [string, types.NetworkOutputSendFailure] =>
          entry[1] !== undefined,
      );
    return new Map(entries);
  });
  /** Returns the interface name currently used for network output, if available. */
  const currentInterfaceName = createMemo(
    () => networkInterfaceStatus().current_interface?.name,
  );
  /** Returns the system default interface name, if available. */
  const defaultInterfaceName = createMemo(
    () => networkInterfaceStatus().default_interface?.name,
  );
  /** Disables network output when the active host cannot transmit DMX. */
  const networkOutputAvailable = createMemo(
    () => capabilities()?.network_dmx_output ?? !isEmbeddedDemoRuntime(),
  );
  /** Disables network input when the active host cannot receive DMX. */
  const networkInputAvailable = createMemo(
    () => capabilities()?.network_dmx_input ?? !isEmbeddedDemoRuntime(),
  );
  /** Disables USB output when the active host cannot access adapters. */
  const usbOutputAvailable = createMemo(
    () => capabilities()?.usb_dmx_output ?? !isEmbeddedDemoRuntime(),
  );
  /** Returns whether network output is currently allowed to transmit. */
  const networkOutputEnabled = createMemo(
    () =>
      networkOutputAvailable() && (settings().network_output_enabled ?? true),
  );
  /** Returns whether network input listeners are currently allowed to bind. */
  const networkInputEnabled = createMemo(
    () => networkInputAvailable() && (settings().network_input_enabled ?? true),
  );
  /** Returns whether USB output is currently allowed to transmit. */
  const usbOutputEnabled = createMemo(
    () => usbOutputAvailable() && (settings().usb_output_enabled ?? true),
  );

  /** Returns every configured output target ID across transport families. */
  const allTargetIds = createMemo(
    () => new Set([...targets(), ...usbTargets()].map((target) => target.id)),
  );

  /** Describes whether the pending add-row target can be created. */
  const newTargetStatus = createMemo(() => {
    const id = newId().trim();
    const protocol = newProtocol();
    const delivery = deliveryFromMode(protocol, newDeliveryMode(), newIp());
    const targetKey = targetOutputKey({
      id,
      protocol,
      delivery,
    });
    if (id === "") return { label: "Enter ID", kind: "idle" as const };
    if (!reservedKeywordsReady()) {
      return { label: "Loading", kind: "idle" as const };
    }
    if (!isValidNetworkDmxTargetId(id)) {
      return { label: "Invalid ID", kind: "invalid" as const };
    }
    if (allTargetIds().has(id)) {
      return { label: "Duplicate ID", kind: "invalid" as const };
    }
    if (newDeliveryMode() === "Unicast" && !isValidIpv4Address(newIp())) {
      return { label: "Invalid IP", kind: "invalid" as const };
    }
    if (targetKey === null) {
      return { label: "Invalid output", kind: "invalid" as const };
    }
    if (targets().some((target) => targetOutputKey(target) === targetKey)) {
      return { label: "Duplicate output", kind: "invalid" as const };
    }
    return { label: "Ready", kind: "valid" as const };
  });

  /** Returns whether the pending add-row target is valid enough to save. */
  const canAddTarget = createMemo(() => newTargetStatus().kind === "valid");
  /** Describes whether the pending USB mapping can be created. */
  const newUsbTargetStatus = createMemo(() => {
    const id = newUsbId().trim();
    const device = newUsbDevice().trim();
    if (id === "") return { label: "Enter ID", kind: "idle" as const };
    if (!reservedKeywordsReady()) {
      return { label: "Loading", kind: "idle" as const };
    }
    if (!isValidUsbDmxTargetId(id)) {
      return { label: "Invalid ID", kind: "invalid" as const };
    }
    if (allTargetIds().has(id)) {
      return { label: "Duplicate ID", kind: "invalid" as const };
    }
    if (device === "") {
      return {
        label: usbDevices().length === 0 ? "No devices" : "Select device",
        kind:
          usbDevices().length === 0 ? ("idle" as const) : ("invalid" as const),
      };
    }
    if (usbTargets().some((target) => target.device === device)) {
      return { label: "Duplicate device", kind: "invalid" as const };
    }
    return { label: "Ready", kind: "valid" as const };
  });
  /** Returns whether the pending USB mapping is valid enough to save. */
  const canAddUsbTarget = createMemo(
    () => newUsbTargetStatus().kind === "valid",
  );
  /** Returns whether the pending add-row target should be outlined as invalid. */
  const newRowInvalid = createMemo(() => newTargetStatus().kind === "invalid");
  /** Returns whether the pending USB row should be outlined as invalid. */
  const newUsbRowInvalid = createMemo(
    () => newUsbTargetStatus().kind === "invalid",
  );
  /** Returns the text color class for the add-row status cell. */
  const newTargetStatusClass = createMemo(() => {
    switch (newTargetStatus().kind) {
      case "valid":
        return "text-emerald-300";
      case "invalid":
        return "text-red-300";
      default:
        return "text-gray-500";
    }
  });
  /** Returns the text color class for the USB add-row status cell. */
  const newUsbTargetStatusClass = createMemo(() => {
    switch (newUsbTargetStatus().kind) {
      case "valid":
        return "text-emerald-300";
      case "invalid":
        return "text-red-300";
      default:
        return "text-gray-500";
    }
  });
  /** Returns table cell classes that draw the pending add-row validation border. */
  const newRowCellClass = (edge?: "first" | "last") => {
    const invalid = newRowInvalid();
    const border = invalid
      ? `border-y border-red-500/70 bg-red-500/5 ${
          edge === "first" ? "border-l" : ""
        } ${edge === "last" ? "border-r" : ""}`
      : "border-y border-transparent";
    return border;
  };
  /** Returns table cell classes that draw the pending USB row validation border. */
  const newUsbRowCellClass = (edge?: "first" | "last") => {
    const invalid = newUsbRowInvalid();
    const border = invalid
      ? `border-y border-red-500/70 bg-red-500/5 ${
          edge === "first" ? "border-l" : ""
        } ${edge === "last" ? "border-r" : ""}`
      : "border-y border-transparent";
    return border;
  };

  /** Persists a complete target list. */
  const saveTargets = (nextTargets: types.NetworkDmxOutputTarget[]) => {
    sendNetworkDmxOutputs(nextTargets);
  };

  /** Persists a complete USB target list. */
  const saveUsbTargets = (nextTargets: types.UsbDmxOutputTarget[]) => {
    sendUsbDmxOutputs(nextTargets);
  };

  /** Persists one edited target. */
  const saveTarget = (target: types.NetworkDmxOutputTarget) => {
    saveTargets(replaceTarget(targets(), target));
  };

  /** Persists one edited USB target. */
  const saveUsbTarget = (target: types.UsbDmxOutputTarget) => {
    const device = target.device.trim();
    if (device === "") return;
    if (
      usbTargets().some(
        (item) => item.id !== target.id && item.device === device,
      )
    ) {
      return;
    }
    saveUsbTargets(
      replaceUsbTarget(usbTargets(), {
        ...target,
        device,
        device_label: usbTargetDeviceLabel(
          device,
          usbDeviceById(),
          target.device_label,
        ),
      }),
    );
  };

  /** Persists whether network output is enabled. */
  const setNetworkOutputEnabled = (enabled: boolean) => {
    sendNetworkOutputEnabled(enabled);
  };

  /** Persists whether network input listeners are enabled. */
  const setNetworkInputEnabled = (enabled: boolean) => {
    sendNetworkInputEnabled(enabled);
  };

  /** Persists whether USB output is enabled. */
  const setUsbOutputEnabled = (enabled: boolean) => {
    sendUsbOutputEnabled(enabled);
  };

  /** Persists one edited target only when its output is distinct. */
  const saveTargetIfUnique = (target: types.NetworkDmxOutputTarget) => {
    const key = targetOutputKey(target);
    if (
      key &&
      targets().some(
        (item) => item.id !== target.id && targetOutputKey(item) === key,
      )
    ) {
      return;
    }
    saveTarget(target);
  };

  /** Adds a new custom target using the current form values. */
  const addTarget = () => {
    const id = newId().trim();
    if (!canAddTarget()) return;
    const protocol = newProtocol();
    const delivery = deliveryFromMode(protocol, newDeliveryMode(), newIp());
    saveTargets([
      ...targets(),
      {
        id,
        protocol,
        delivery,
      },
    ]);
    setNewId("");
    setNewProtocol(types.NetworkDmxProtocol.Sacn);
    setNewDeliveryMode("Unicast");
    setNewIp("127.0.0.1");
  };

  /** Adds a new custom USB target using the current form values. */
  const addUsbTarget = () => {
    const id = newUsbId().trim();
    const device = newUsbDevice().trim();
    if (!canAddUsbTarget()) return;
    saveUsbTargets([
      ...usbTargets(),
      {
        id,
        device,
        device_label: usbTargetDeviceLabel(device, usbDeviceById()),
      },
    ]);
    setNewUsbId("");
    setNewUsbDevice("");
  };

  /** Removes a custom target. */
  const removeTarget = (target: types.NetworkDmxOutputTarget) => {
    if (isBuiltInTarget(target)) return;
    saveTargets(targets().filter((item) => item.id !== target.id));
  };

  /** Removes a custom USB target. */
  const removeUsbTarget = (target: types.UsbDmxOutputTarget) => {
    if (isBuiltInUsbTarget(target)) return;
    saveUsbTargets(usbTargets().filter((item) => item.id !== target.id));
  };

  /** Returns whether a saved USB selector currently points at available hardware. */
  const usbTargetDeviceAvailable = (target: types.UsbDmxOutputTarget) => {
    const device = target.device.trim();
    return device === DEFAULT_USB_DEVICE_ID || usbDeviceById().has(device);
  };

  /** Returns the status text for a configured USB mapping row. */
  const usbTargetStatus = (target: types.UsbDmxOutputTarget) => {
    const device = target.device.trim();
    if (device === "") {
      return { label: "Missing device", kind: "invalid" as const };
    }
    if (device === DEFAULT_USB_DEVICE_ID) {
      return { label: "Auto", kind: "valid" as const };
    }
    if (usbDeviceById().has(device)) {
      return { label: "Configured", kind: "valid" as const };
    }
    return { label: "Missing", kind: "invalid" as const };
  };

  /** Returns select options for an existing USB target, preserving saved missing devices. */
  const usbDeviceOptions = (target: types.UsbDmxOutputTarget) => {
    const savedDevice = target.device.trim();
    const defaultUsedByOtherTarget = usbTargets().some(
      (item) =>
        item.id !== target.id && item.device.trim() === DEFAULT_USB_DEVICE_ID,
    );
    const defaultOption = {
      id: DEFAULT_USB_DEVICE_ID,
      label: usbDeviceSelectorLabel(
        DEFAULT_USB_DEVICE_ID,
        usbDeviceById(),
        target.device_label,
      ),
    };
    const options = usbDevices().map((device) => ({
      id: device.id,
      label: usbDeviceOptionLabel(device, usbSerialConflictKeys()),
    }));
    const selectableOptions =
      savedDevice === DEFAULT_USB_DEVICE_ID || !defaultUsedByOtherTarget
        ? [defaultOption, ...options]
        : options;

    if (
      savedDevice !== "" &&
      savedDevice !== DEFAULT_USB_DEVICE_ID &&
      !usbDeviceById().has(savedDevice)
    ) {
      return [
        {
          id: savedDevice,
          label: usbDeviceSelectorLabel(
            savedDevice,
            usbDeviceById(),
            target.device_label,
          ),
        },
        ...selectableOptions,
      ];
    }
    return selectableOptions;
  };

  return (
    <div
      class="h-full min-h-0 overflow-auto bg-gray-950 text-gray-100"
      data-component="IoTransportsPanel"
    >
      <div class="mx-auto max-w-6xl p-4">
        <section class="mb-6" aria-label="Network I/O transports">
          <div class="mb-2 flex flex-wrap items-center justify-between gap-3">
            <h3 class="text-xs font-semibold uppercase text-gray-400">
              Network
            </h3>
            <div class="flex flex-wrap items-center gap-4">
              <ToggleSwitch
                label="Network input"
                checked={networkInputEnabled()}
                disabled={!networkInputAvailable()}
                ariaLabel="Enable network input"
                onChange={setNetworkInputEnabled}
              />
              <ToggleSwitch
                label="Network output"
                checked={networkOutputEnabled()}
                disabled={!networkOutputAvailable()}
                ariaLabel="Enable network output"
                onChange={setNetworkOutputEnabled}
              />
            </div>
          </div>
          <TableScroll
            aria-label="Network transports scroll area"
            class="rounded border border-gray-800"
          >
            <Table
              aria-label="Network transports"
              class="min-w-[56rem] table-fixed"
            >
              <thead>
                <tr>
                  <th scope="col" class="w-40 whitespace-nowrap text-left">
                    ID
                  </th>
                  <th scope="col" class="w-36 whitespace-nowrap text-left">
                    Protocol
                  </th>
                  <th scope="col" class="w-40 whitespace-nowrap text-left">
                    Mode
                  </th>
                  <th scope="col" class="w-40 whitespace-nowrap text-left">
                    IP
                  </th>
                  <th scope="col" class="w-36 whitespace-nowrap text-left">
                    Status
                  </th>
                  <th scope="col" class="w-28 whitespace-nowrap text-right">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                <For each={targets()}>
                  {(target) => (
                    <NetworkTargetRow
                      target={target}
                      sendFailure={sendFailuresByTargetId().get(target.id)}
                      outputEnabled={networkOutputEnabled()}
                      onSave={saveTargetIfUnique}
                      onRemove={removeTarget}
                    />
                  )}
                </For>
                <NetworkTargetAddRow
                  id={newId()}
                  protocol={newProtocol()}
                  deliveryMode={newDeliveryMode()}
                  ip={newIp()}
                  invalid={newRowInvalid()}
                  canAdd={canAddTarget()}
                  status={newTargetStatus()}
                  statusClass={newTargetStatusClass()}
                  cellClass={newRowCellClass}
                  onIdChange={setNewId}
                  onProtocolChange={setNewProtocol}
                  onDeliveryModeChange={setNewDeliveryMode}
                  onIpChange={setNewIp}
                  onAdd={addTarget}
                />
              </tbody>
            </Table>
          </TableScroll>
        </section>

        <NetworkInterfaceSummary
          interfaces={networkInterfaces()}
          listeningAddresses={
            externalControl().available
              ? externalControl().listening_addresses
              : []
          }
          currentInterfaceName={currentInterfaceName()}
          defaultInterfaceName={defaultInterfaceName()}
        >
          <ExternalControlSettings />
        </NetworkInterfaceSummary>

        <section class="mb-6" aria-label="USB output transports">
          <div class="mb-2 flex flex-wrap items-center justify-between gap-3">
            <h3 class="text-xs font-semibold uppercase text-gray-400">USB</h3>
            <ToggleSwitch
              label="USB output"
              checked={usbOutputEnabled()}
              disabled={!usbOutputAvailable()}
              ariaLabel="Enable USB output"
              onChange={setUsbOutputEnabled}
            />
          </div>
          <TableScroll
            aria-label="USB transports scroll area"
            class="rounded border border-gray-800"
          >
            <Table
              aria-label="USB transports"
              class="min-w-[42rem] table-fixed"
            >
              <thead>
                <tr>
                  <th scope="col" class="w-40 whitespace-nowrap text-left">
                    ID
                  </th>
                  <th scope="col" class="w-64 whitespace-nowrap text-left">
                    USB Device
                  </th>
                  <th scope="col" class="w-36 whitespace-nowrap text-left">
                    Status
                  </th>
                  <th scope="col" class="w-28 whitespace-nowrap text-right">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                <For each={usbTargets()}>
                  {(target) => (
                    <UsbTargetRow
                      target={target}
                      outputEnabled={usbOutputEnabled()}
                      deviceAvailable={usbTargetDeviceAvailable(target)}
                      status={usbTargetStatus(target)}
                      deviceOptions={usbDeviceOptions(target)}
                      onSave={saveUsbTarget}
                      onRemove={removeUsbTarget}
                    />
                  )}
                </For>
                <UsbTargetAddRow
                  id={newUsbId()}
                  device={newUsbDevice()}
                  deviceOptions={availableNewUsbDeviceOptions()}
                  invalid={newUsbRowInvalid()}
                  canAdd={canAddUsbTarget()}
                  status={newUsbTargetStatus()}
                  statusClass={newUsbTargetStatusClass()}
                  cellClass={newUsbRowCellClass}
                  onIdChange={setNewUsbId}
                  onDeviceChange={setNewUsbDevice}
                  onAdd={addUsbTarget}
                />
              </tbody>
            </Table>
          </TableScroll>
        </section>

        <UsbDeviceSummary devices={usbDevices()} />
      </div>
    </div>
  );
}
