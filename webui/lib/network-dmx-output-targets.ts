// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import * as types from "../types";
import {
  reservedNetworkDmxTargetKeywords,
  reservedUsbDmxTargetKeywords,
} from "./wasm-bridge";

let reservedNetworkDmxTargetIds = new Set<string>();
let reservedUsbDmxTargetIds = new Set<string>();
let reservedTargetKeywordsRefresh: Promise<void> | null = null;
let reservedTargetKeywordsLoaded = false;

/** Returns the built-in Network DMX output target definitions. */
export function defaultNetworkDmxOutputs(): types.NetworkDmxOutputTargets {
  return {
    targets: [
      {
        id: "sacn",
        protocol: types.NetworkDmxProtocol.Sacn,
        delivery: { type: "SacnMulticast" },
      },
      {
        id: "artnet",
        protocol: types.NetworkDmxProtocol.ArtNet,
        delivery: { type: "ArtNetBroadcast" },
      },
    ],
  };
}

/** Returns showfile Network DMX outputs with defaults when settings are missing. */
export function networkDmxOutputsFromSettings(
  settings: types.IoRuntimeSettings,
): types.NetworkDmxOutputTargets {
  return normalizeNetworkDmxOutputs(
    settings.network_dmx_outputs ?? defaultNetworkDmxOutputs(),
  );
}

/** Returns the built-in USB DMX output target definitions. */
export function defaultUsbDmxOutputs(): types.UsbDmxOutputTargets {
  return {
    targets: [{ id: "udmx", device: "default", device_label: undefined }],
  };
}

/** Returns showfile USB DMX outputs with defaults when settings are missing. */
export function usbDmxOutputsFromSettings(
  settings: types.IoRuntimeSettings,
): types.UsbDmxOutputTargets {
  return normalizeUsbDmxOutputs(
    settings.usb_dmx_outputs ?? defaultUsbDmxOutputs(),
  );
}

/**
 * Refreshes reserved target keyword caches from the Rust WASM bridge.
 */
export async function refreshReservedOutputTargetKeywords(): Promise<boolean> {
  reservedTargetKeywordsRefresh ??= (async () => {
    const [networkKeywords, usbKeywords] = await Promise.all([
      reservedNetworkDmxTargetKeywords(),
      reservedUsbDmxTargetKeywords(),
    ]);

    reservedTargetKeywordsLoaded =
      networkKeywords !== null && usbKeywords !== null;

    if (networkKeywords !== null) {
      reservedNetworkDmxTargetIds = new Set(networkKeywords);
    }

    if (usbKeywords !== null) {
      reservedUsbDmxTargetIds = new Set(usbKeywords);
    }
  })();
  await reservedTargetKeywordsRefresh;

  if (!reservedTargetKeywordsLoaded) {
    reservedTargetKeywordsRefresh = null;
  }

  return reservedTargetKeywordsLoaded;
}

/** Returns whether reserved target keyword caches have loaded from WASM. */
export function reservedOutputTargetKeywordsReady(): boolean {
  return reservedTargetKeywordsLoaded;
}

/** Returns whether a target ID is reserved by a backend-owned output target namespace. */
export function isReservedOutputTargetKeyword(id: string): boolean {
  return reservedNetworkDmxTargetIds.has(id) || reservedUsbDmxTargetIds.has(id);
}

/** Returns whether a Network DMX output target ID can be used in patch commands. */
export function isValidNetworkDmxTargetId(id: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(id) && !reservedNetworkDmxTargetIds.has(id);
}

/** Returns whether a USB output target ID can be used in patch commands. */
export function isValidUsbDmxTargetId(id: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(id) && !reservedUsbDmxTargetIds.has(id);
}

/** Converts serialized IPv4 address forms into dotted-quad text. */
export function ipv4AddressToString(value: unknown): string {
  if (typeof value === "string") return value;

  if (ArrayBuffer.isView(value)) {
    const bytes = Array.from(value as Uint8Array);
    return bytes.length === 4 ? bytes.join(".") : "";
  }

  if (Array.isArray(value)) {
    return value.length === 4 && value.every((part) => Number.isInteger(part))
      ? value.join(".")
      : "";
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.octets)) return ipv4AddressToString(record.octets);
    if ("data" in record) return ipv4AddressToString(record.data);
    const indexed = ["0", "1", "2", "3"].map((key) => record[key]);
    if (indexed.every((part) => Number.isInteger(part))) {
      return indexed.join(".");
    }
  }

  return "";
}

/** Returns delivery settings with IPv4 values normalized for JSON commands. */
function normalizeNetworkDmxDelivery(
  delivery: types.NetworkDmxDelivery,
): types.NetworkDmxDelivery {
  if (delivery.type !== "Unicast") return delivery;
  return {
    type: "Unicast",
    data: { ip: ipv4AddressToString(delivery.data.ip) },
  };
}

/** Returns Network DMX targets normalized for UI rendering and command payloads. */
export function normalizeNetworkDmxOutputs(
  outputs: types.NetworkDmxOutputTargets,
): types.NetworkDmxOutputTargets {
  const targets = defaultNetworkDmxOutputs().targets;
  const seenIds = new Set(targets.map((target) => target.id));

  for (const target of outputs.targets) {
    const existing = targets.find(
      (candidate) =>
        candidate.id === target.id &&
        (target.id === "sacn" || target.id === "artnet"),
    );
    if (!existing) continue;
    const delivery = normalizeNetworkDmxDelivery(target.delivery);
    if (outputTransportForNetworkDmxTarget({ ...existing, delivery })) {
      existing.delivery = delivery;
    }
  }

  const seenTransports = new Set(
    targets
      .map(outputTransportForNetworkDmxTarget)
      .filter(
        (transport): transport is types.OutputTransport => transport !== null,
      )
      .map(outputTransportKey),
  );

  for (const target of outputs.targets) {
    if (
      !isValidNetworkDmxTargetId(target.id) ||
      target.id === "sacn" ||
      target.id === "artnet" ||
      seenIds.has(target.id)
    ) {
      continue;
    }
    const normalized = {
      ...target,
      delivery: normalizeNetworkDmxDelivery(target.delivery),
    };
    const transport = outputTransportForNetworkDmxTarget(normalized);
    if (!transport) continue;
    const transportKey = outputTransportKey(transport);
    if (seenTransports.has(transportKey)) continue;
    seenIds.add(normalized.id);
    seenTransports.add(transportKey);
    targets.push(normalized);
  }

  return { targets };
}

/** Returns USB DMX targets normalized for UI rendering and command payloads. */
export function normalizeUsbDmxOutputs(
  outputs: types.UsbDmxOutputTargets,
): types.UsbDmxOutputTargets {
  const targets = defaultUsbDmxOutputs().targets;
  const seenIds = new Set(targets.map((target) => target.id));
  const seenDevices = new Set(targets.map((target) => target.device));

  for (const target of outputs.targets) {
    const device = target.device.trim();
    if (target.id === "udmx" && device !== "") {
      targets[0] = {
        id: "udmx",
        device,
        device_label: target.device_label?.trim() || undefined,
      };
      seenDevices.clear();
      seenDevices.add(device);
    }
  }

  for (const target of outputs.targets) {
    const device = target.device.trim();
    if (
      !isValidUsbDmxTargetId(target.id) ||
      target.id === "udmx" ||
      device === "" ||
      seenIds.has(target.id) ||
      seenDevices.has(device)
    ) {
      continue;
    }
    const normalized = {
      id: target.id,
      device,
      device_label: target.device_label?.trim() || undefined,
    };
    seenIds.add(normalized.id);
    seenDevices.add(normalized.device);
    targets.push(normalized);
  }

  return { targets };
}

/** Returns whether a string is an IPv4 address. */
export function isValidIpv4Address(value: unknown): boolean {
  const parts = ipv4AddressToString(value).split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => {
      if (!/^\d+$/.test(part)) return false;
      const value = Number(part);
      return value >= 0 && value <= 255;
    })
  );
}

/** Returns the default delivery for a protocol. */
export function defaultDeliveryForProtocol(
  protocol: types.NetworkDmxProtocol,
): types.NetworkDmxDelivery {
  if (protocol === types.NetworkDmxProtocol.ArtNet) {
    return { type: "ArtNetBroadcast" };
  }
  return { type: "SacnMulticast" };
}

/** Returns the concrete output transport for a target definition. */
export function outputTransportForNetworkDmxTarget(
  target: types.NetworkDmxOutputTarget,
): types.OutputTransport | null {
  if (
    target.protocol === types.NetworkDmxProtocol.Sacn &&
    target.delivery.type === "SacnMulticast"
  ) {
    return { type: "Sacn", data: { mode: { type: "Multicast" } } };
  }
  if (
    target.protocol === types.NetworkDmxProtocol.Sacn &&
    target.delivery.type === "Unicast"
  ) {
    return {
      type: "Sacn",
      data: {
        mode: { type: "Unicast", data: { ip: target.delivery.data.ip } },
      },
    };
  }
  if (
    target.protocol === types.NetworkDmxProtocol.ArtNet &&
    target.delivery.type === "ArtNetBroadcast"
  ) {
    return { type: "ArtNet", data: { mode: { type: "Broadcast" } } };
  }
  if (
    target.protocol === types.NetworkDmxProtocol.ArtNet &&
    target.delivery.type === "Unicast"
  ) {
    return {
      type: "ArtNet",
      data: {
        mode: { type: "Unicast", data: { ip: target.delivery.data.ip } },
      },
    };
  }
  return null;
}

/** Returns a stable key for comparing concrete output transports. */
export function outputTransportKey(transport: types.OutputTransport): string {
  switch (transport.type) {
    case "Sacn":
      if (transport.data.mode.type === "Unicast") {
        return `Sacn:Unicast:${transport.data.mode.data.ip}`;
      }
      return "Sacn:Multicast";
    case "ArtNet":
      if (transport.data.mode.type === "Unicast") {
        return `ArtNet:Unicast:${transport.data.mode.data.ip}`;
      }
      return "ArtNet:Broadcast";
    case "Udmx":
      return `Udmx:${transport.data.device}`;
    case "Disabled":
      return "Disabled";
  }
}

/** Resolves a named output target to a concrete output transport. */
function outputTransportForNetworkDmxTargetId(
  targetId: string,
  outputs: types.NetworkDmxOutputTargets,
): types.OutputTransport | null {
  const normalized = normalizeNetworkDmxOutputs(outputs);
  const target = normalized.targets.find(
    (candidate) => candidate.id === targetId,
  );
  return target ? outputTransportForNetworkDmxTarget(target) : null;
}

/** Resolves a named USB output target to a concrete output transport. */
function outputTransportForUsbDmxTargetId(
  targetId: string,
  outputs: types.UsbDmxOutputTargets,
): types.OutputTransport | null {
  const normalized = normalizeUsbDmxOutputs(outputs);
  const target = normalized.targets.find(
    (candidate) => candidate.id === targetId,
  );
  return target ? { type: "Udmx", data: { device: target.device } } : null;
}

/** Resolves a named output target to a concrete transport across output types. */
export function outputTransportForOutputTargetId(
  targetId: string,
  networkOutputs: types.NetworkDmxOutputTargets,
  usbOutputs: types.UsbDmxOutputTargets = defaultUsbDmxOutputs(),
): types.OutputTransport | null {
  return (
    outputTransportForNetworkDmxTargetId(targetId, networkOutputs) ??
    outputTransportForUsbDmxTargetId(targetId, usbOutputs)
  );
}
