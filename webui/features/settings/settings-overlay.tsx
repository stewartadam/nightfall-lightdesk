// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { CloudArrowDownIcon } from "@squidlab/phosphor-solid/cloud-arrow-down";
import {
  createEffect,
  createSignal,
  createUniqueId,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { useAppShell } from "../../components/providers/app-shell";
import { Dialog, DialogBody } from "../../components/ui/dialog";
import { Input, NativeSelect } from "../../components/ui/form-controls";
import { SegmentedTabs } from "../../components/ui/segmented-tabs";
import { ToggleSwitch } from "../../components/ui/toggle-switch";
import { Button } from "../../components/ui/visual-language/button";
import { durationToMs, msToDuration } from "../../lib/duration";
import { engineRuntime } from "../../lib/engine-runtime";
import { setStoreAction } from "../../lib/nanostore-action";
import {
  bindingValidationSettings,
  runtimeCapabilities,
} from "../../state/appStores";
import {
  $availableAudioDevices,
  $availableNetworkInterfaces,
  $ioSettings,
  $networkInterfaceStatus,
  $settings,
} from "../../state/settings";
import type {
  BindingValidationMode,
  InputSignalLossPolicy,
  NetworkInterfaceInfo,
  NetworkInterfaceStatus,
} from "../../types";
import {
  CurrentNetworkInterfaceMode,
  InputUniverseVisibilityMode,
  SelectionFlattenPolicy,
  SequenceReorderRenumberPolicy,
  TimeDisplayPreference,
  TimelinePlacementPreference,
} from "../../types";
import { createBeatModelDownload } from "../beat-detection";
import { KeybindingsSettings } from "../keybindings";
import {
  type QualityPreset,
  setVisualizerQuality,
  type VisualizerCameraRotationMode,
  visualizerCameraRotationMode,
  visualizerDarkness,
  visualizerHighlightSelection,
  visualizerQuality,
  visualizerShowOrbitTargetIndicator,
} from "../visualizer";
import { AppearanceSettings } from "./appearance-settings";
import { PrivacySettings } from "./privacy-settings";
import {
  $requestedSettingsTab,
  type SettingsTab,
} from "./settings-tab-request";

const DEFAULT_INPUT_SIGNAL_LOSS_TIMEOUT_MS = 2000;
const DEFAULT_SHOWFILE_BACKUP_RETENTION = 20;
/** Largest value a Rust `u32` command field accepts. */
const U32_MAX = 4_294_967_295;
const QUALITY_OPTIONS: { value: QualityPreset; label: string }[] = [
  { value: "low", label: "Low (faster)" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High (slower)" },
];
const ROTATION_MODE_OPTIONS: {
  value: VisualizerCameraRotationMode;
  label: string;
}[] = [
  { value: "camera-locked", label: "Camera-locked (orbit current target)" },
  { value: "center-locked", label: "Center-locked (orbit world origin)" },
];

const SETTINGS_TABS: { key: SettingsTab; label: string }[] = [
  { key: "general", label: "General" },
  { key: "appearance", label: "Appearance" },
  { key: "editors", label: "Editors" },
  { key: "network", label: "Network" },
  { key: "visualizer", label: "Visualizer" },
  { key: "keyboard", label: "Keyboard" },
  { key: "privacy", label: "Privacy" },
];

/** Returns the human-readable interface name, falling back to the system name. */
const interfaceDisplayName = (iface: NetworkInterfaceInfo): string =>
  iface.friendly_name?.trim() || iface.name;

/** Formats a network interface for settings controls and status text. */
const formatNetworkInterface = (iface?: NetworkInterfaceInfo): string => {
  if (!iface) return "Unavailable";

  const displayName = interfaceDisplayName(iface);
  const details = [
    ...(displayName === iface.name ? [] : [iface.name]),
    ...iface.addresses,
  ];

  return `${displayName}${details.length > 0 ? ` (${details.join(", ")})` : ""}`;
};

const systemDefaultLabel = (status: NetworkInterfaceStatus): string => {
  if (!status.default_interface) {
    return "System Default";
  }

  return `System Default (${formatNetworkInterface(status.default_interface)})`;
};

const configuredInterfaceDescription = (
  status: NetworkInterfaceStatus,
  selectedInterface?: string,
): string => {
  if (status.current_interface) {
    if (
      status.current_interface_mode ===
      CurrentNetworkInterfaceMode.SystemDefault
    ) {
      return `Configured interface: System default (${formatNetworkInterface(status.current_interface)})`;
    }
    return `Configured interface: ${formatNetworkInterface(status.current_interface)}`;
  }

  if (status.selected_interface_missing && selectedInterface) {
    return `Configured interface unavailable: ${selectedInterface}`;
  }

  return "Configured interface unavailable";
};

/** Presents application, editor, transport, and local appearance preferences. */
export function SettingsOverlay() {
  const { isSettingsOpen, closeSettings } = useAppShell();
  const settings = useStore($settings);
  const ioSettings = useStore($ioSettings);
  const patchValidationSettings = useStore(bindingValidationSettings);
  const networkInterfaces = useStore($availableNetworkInterfaces);
  const networkInterfaceStatus = useStore($networkInterfaceStatus);
  const audioDevices = useStore($availableAudioDevices);
  const capabilities = useStore(runtimeCapabilities);
  const modelDownload = createBeatModelDownload();
  const highlightSelection = useStore(visualizerHighlightSelection);
  const rotationMode = useStore(visualizerCameraRotationMode);
  const showOrbitTargetIndicator = useStore(visualizerShowOrbitTargetIndicator);
  const quality = useStore(visualizerQuality);
  const darkness = useStore(visualizerDarkness);
  const [activeTab, setActiveTab] = createSignal<SettingsTab>("general");
  const requestedTab = useStore($requestedSettingsTab);
  const tabId = createUniqueId();
  /** Switches to a tab another surface asked for, then forgets the request. */
  createEffect(() => {
    const tab = requestedTab();
    if (!tab || !isSettingsOpen()) return;
    setActiveTab(tab);
    $requestedSettingsTab.set(null);
  });
  /** Refreshes backend-provided device choices whenever settings becomes visible. */
  createEffect(() => {
    if (!isSettingsOpen()) return;
    engineRuntime.sendCommand({
      module: "SettingsCommand",
      command: { type: "GetAvailableNetworkInterfaces" },
    });
    engineRuntime.sendCommand({
      module: "SettingsCommand",
      command: { type: "GetAvailableAudioDevices" },
    });
  });

  let dmxOutputRateInput: HTMLInputElement | undefined;
  // Rewrites the rate field from every IO settings snapshot, even an unchanged one, so a value the
  // backend clamped back to the rate it already had still replaces what the user typed.
  onCleanup(
    $ioSettings.listen((settings) => {
      if (dmxOutputRateInput) {
        dmxOutputRateInput.value = String(settings.dmx_output_rate_hz);
      }
    }),
  );

  /** Refresh cached model information on entry and stop polling when settings closes. */
  createEffect(() => {
    if (isSettingsOpen() && capabilities()?.runtime_mode !== "EmbeddedDemo") {
      void modelDownload.refresh();
    } else {
      modelDownload.close();
    }
  });

  const setProgrammerAutoSelect = (value: boolean) => {
    engineRuntime.sendCommand({
      module: "SettingsCommand",
      command: { type: "SetProgrammerAutoSelect", data: value },
    });
  };

  /** Chooses whether clients receive only changed parameter values or every value each frame. */
  const setParameterKeyframesOnly = (value: boolean) => {
    engineRuntime.sendCommand({
      module: "SettingsCommand",
      command: { type: "SetParameterKeyframesOnly", data: value },
    });
  };

  const setNetworkInterface = (value: string | null) => {
    engineRuntime.sendCommand({
      module: "SettingsCommand",
      command: { type: "SetNetworkInterface", data: value },
    });
  };

  const setAudioDevice = (value: string | null) => {
    engineRuntime.sendCommand({
      module: "SettingsCommand",
      command: { type: "SetAudioDevice", data: value },
    });
  };

  const setInputSignalLossPolicy = (value: InputSignalLossPolicy) => {
    engineRuntime.sendCommand({
      module: "SettingsCommand",
      command: { type: "SetInputSignalLossPolicy", data: value },
    });
  };

  const setInputUniverseVisibilityMode = (
    value: InputUniverseVisibilityMode,
  ) => {
    engineRuntime.sendCommand({
      module: "SettingsCommand",
      command: { type: "SetInputUniverseVisibilityMode", data: value },
    });
  };

  const setSequenceReorderRenumberPolicy = (
    value: SequenceReorderRenumberPolicy,
  ) => {
    engineRuntime.sendCommand({
      module: "SettingsCommand",
      command: { type: "SetSequenceReorderRenumberPolicy", data: value },
    });
  };

  const setSelectionFlattenPolicy = (value: SelectionFlattenPolicy) => {
    engineRuntime.sendCommand({
      module: "SettingsCommand",
      command: { type: "SetSelectionFlattenPolicy", data: value },
    });
  };

  const setTimeDisplayPreference = (value: TimeDisplayPreference) => {
    engineRuntime.sendCommand({
      module: "SettingsCommand",
      command: { type: "SetTimeDisplayPreference", data: value },
    });
  };

  const setTimelinePlacementPreference = (
    value: TimelinePlacementPreference,
  ) => {
    engineRuntime.sendCommand({
      module: "SettingsCommand",
      command: { type: "SetTimelinePlacementPreference", data: value },
    });
  };

  /** Sends the configured showfile backup retention count to the backend. */
  const setShowfileBackupRetention = (value: number) => {
    const retention = Number.isFinite(value)
      ? Math.max(0, Math.trunc(value))
      : DEFAULT_SHOWFILE_BACKUP_RETENTION;
    engineRuntime.sendCommand({
      module: "SettingsCommand",
      command: { type: "SetShowfileBackupRetention", data: retention },
    });
  };

  const setBindingValidationMode = (value: BindingValidationMode) => {
    engineRuntime.sendCommand({
      module: "SettingsCommand",
      command: { type: "SetBindingValidationMode", data: value },
    });
  };

  const inputSignalLossPolicy = (): InputSignalLossPolicy =>
    ioSettings().input_signal_loss_policy ?? { type: "Hold" };

  const sequenceReorderRenumberPolicy = (): SequenceReorderRenumberPolicy =>
    settings().sequence_reorder_renumber_policy ??
    SequenceReorderRenumberPolicy.Preserve;

  const inputUniverseVisibilityMode = (): InputUniverseVisibilityMode =>
    ioSettings().input_universe_visibility_mode ??
    InputUniverseVisibilityMode.ExternalOnly;

  const selectionFlattenPolicy = (): SelectionFlattenPolicy =>
    settings().selection_flatten_policy ?? SelectionFlattenPolicy.Silent;

  const timeDisplayPreference = (): TimeDisplayPreference =>
    settings().time_display_preference ?? TimeDisplayPreference.Auto;

  const timelinePlacementPreference = (): TimelinePlacementPreference =>
    settings().timeline_placement_preference ??
    TimelinePlacementPreference.Playhead;

  /** Returns the current showfile backup retention count for the settings input. */
  const showfileBackupRetention = (): number =>
    settings().showfile_backup_retention ?? DEFAULT_SHOWFILE_BACKUP_RETENTION;

  const inputSignalLossTimeoutMs = (): number => {
    const timeout = ioSettings().input_signal_loss_timeout;
    return timeout
      ? durationToMs(timeout)
      : DEFAULT_INPUT_SIGNAL_LOSS_TIMEOUT_MS;
  };

  const setInputSignalLossPolicyType = (
    value: "Hold" | "ClearAfterTimeout",
  ) => {
    if (value === "Hold") {
      setInputSignalLossPolicy({ type: "Hold" });
      return;
    }
    setInputSignalLossPolicy({ type: "ClearAfterTimeout", data: {} });
  };

  /** Sends the requested network DMX output rate; the backend clamps it to its supported range. */
  const setDmxOutputRate = (value: number) => {
    if (!Number.isFinite(value)) {
      if (dmxOutputRateInput) {
        dmxOutputRateInput.value = String(ioSettings().dmx_output_rate_hz);
      }
      return;
    }
    engineRuntime.sendCommand({
      module: "SettingsCommand",
      command: {
        type: "SetDmxOutputRate",
        data: Math.min(Math.max(Math.trunc(value), 0), U32_MAX),
      },
    });
  };

  const setInputSignalLossTimeout = (value: number) => {
    engineRuntime.sendCommand({
      module: "SettingsCommand",
      command: {
        type: "SetInputSignalLossTimeout",
        data: msToDuration(value),
      },
    });
  };

  return (
    <>
      <Dialog
        kind="info"
        isOpen={isSettingsOpen()}
        title="Settings"
        label="Settings"
        closeLabel="Close settings"
        onDismiss={closeSettings}
        class="max-w-[560px]"
        style={{ "max-height": "80vh" }}
      >
        <div class="px-4 pt-3">
          <SegmentedTabs
            id={tabId}
            label="Settings categories"
            contentId={`${tabId}-content`}
            options={SETTINGS_TABS}
            value={activeTab()}
            onChange={setActiveTab}
          />
        </div>

        <DialogBody
          class="space-y-6"
          id={`${tabId}-content`}
          role="tabpanel"
          aria-labelledby={`${tabId}-${activeTab()}`}
        >
          <Show when={activeTab() === "appearance"}>
            <AppearanceSettings />
          </Show>
          <Show when={activeTab() === "privacy"}>
            <PrivacySettings />
          </Show>
          <Show when={activeTab() === "keyboard"}>
            <KeybindingsSettings />
          </Show>
          <Show when={activeTab() === "general"}>
            <section>
              <h3 class="text-sm font-medium text-gray-300 mb-3">Programmer</h3>
              <div class="space-y-3">
                <ToggleSwitch
                  label="Auto-select on attribute set"
                  ariaLabel="Auto-select on attribute set"
                  class="w-full justify-between"
                  checked={settings().programmer_auto_select}
                  onChange={setProgrammerAutoSelect}
                />
                <label class="block">
                  <span class="text-sm text-gray-400">
                    Selection flatten behavior
                  </span>
                  <NativeSelect
                    value={selectionFlattenPolicy()}
                    onChange={(e) =>
                      setSelectionFlattenPolicy(
                        e.currentTarget.value as SelectionFlattenPolicy,
                      )
                    }
                    class="mt-1"
                  >
                    <option value="Silent">Silent</option>
                    <option value="Prompt">Prompt before flattening</option>
                  </NativeSelect>
                </label>
              </div>
            </section>
            <section>
              <h3 class="text-sm font-medium text-gray-300 mb-3">Audio</h3>
              <label class="block">
                <span class="text-sm text-gray-400">Output Device</span>
                <NativeSelect
                  value={settings().audio_device ?? ""}
                  onChange={(e) =>
                    setAudioDevice(e.currentTarget.value || null)
                  }
                  class="mt-1"
                >
                  <option value="">System Default</option>
                  <For each={Object.entries(audioDevices())} fallback={null}>
                    {([id, name]) => <option value={id}>{name}</option>}
                  </For>
                </NativeSelect>
              </label>
            </section>
            <section>
              <h3 class="text-sm font-medium text-gray-300 mb-3">Showfile</h3>
              <label class="block">
                <span class="text-sm text-gray-400">Backups to keep</span>
                <Input
                  type="number"
                  min="0"
                  step="1"
                  value={showfileBackupRetention()}
                  onChange={(e) =>
                    setShowfileBackupRetention(e.currentTarget.valueAsNumber)
                  }
                  class="mt-1"
                />
              </label>
            </section>
            <section>
              <h3 class="text-sm font-medium text-gray-300 mb-3">Patch</h3>
              <label class="block">
                <span class="text-sm text-gray-400">
                  Overlap validation mode
                </span>
                <NativeSelect
                  value={patchValidationSettings().mode}
                  onChange={(e) =>
                    setBindingValidationMode(
                      e.currentTarget.value as BindingValidationMode,
                    )
                  }
                  class="mt-1"
                >
                  <option value="Strict">Strict Mode</option>
                  <option value="Permissive">Permissive Mode</option>
                </NativeSelect>
              </label>
            </section>
          </Show>

          <Show when={activeTab() === "editors"}>
            <section>
              <h3 class="text-sm font-medium text-gray-300 mb-3">
                Cue / Sequence Authoring
              </h3>
              <div class="space-y-3">
                <label class="block">
                  <span class="text-sm text-gray-400">
                    Reorder cue renumber behavior
                  </span>
                  <NativeSelect
                    value={sequenceReorderRenumberPolicy()}
                    onChange={(e) =>
                      setSequenceReorderRenumberPolicy(
                        e.currentTarget.value as SequenceReorderRenumberPolicy,
                      )
                    }
                    class="mt-1"
                  >
                    <option value="Preserve">Preserve cue IDs</option>
                    <option value="AutoRenumber">
                      Auto-renumber after reorder
                    </option>
                    <option value="Prompt">Prompt each time</option>
                  </NativeSelect>
                </label>
                <label class="block">
                  <span class="text-sm text-gray-400">
                    Timing display units
                  </span>
                  <NativeSelect
                    value={timeDisplayPreference()}
                    onChange={(e) =>
                      setTimeDisplayPreference(
                        e.currentTarget.value as TimeDisplayPreference,
                      )
                    }
                    class="mt-1"
                  >
                    <option value="Auto">Auto</option>
                    <option value="Seconds">Seconds</option>
                    <option value="Milliseconds">Milliseconds</option>
                    <option value="Bpm">BPM</option>
                    <option value="Hertz">Hz</option>
                  </NativeSelect>
                </label>
              </div>
            </section>

            <section>
              <h3 class="text-sm font-medium text-gray-300 mb-3">Timeline</h3>
              <Show when={capabilities()?.runtime_mode !== "EmbeddedDemo"}>
                <div class="mb-4 space-y-2">
                  <Show
                    when={modelDownload.status()?.phase === "ready"}
                    fallback={
                      <>
                        <p class="text-sm text-gray-400" role="status">
                          {!modelDownload.status() ||
                          ["unchecked", "checking"].includes(
                            modelDownload.status()!.phase,
                          )
                            ? "Checking beat detection model…"
                            : modelDownload.status()?.phase === "deleting"
                              ? "Deleting beat detection model…"
                              : "The optional Beat This model will enable offline and automatic beatgrid detection."}
                        </p>
                        <Button
                          disabled={
                            modelDownload.busy() ||
                            !modelDownload.status() ||
                            ["unchecked", "checking", "deleting"].includes(
                              modelDownload.status()!.phase,
                            )
                          }
                          onClick={() => modelDownload.request()}
                        >
                          <CloudArrowDownIcon class="size-4" aria-hidden />
                          Download
                        </Button>
                      </>
                    }
                  >
                    <p class="text-sm text-gray-400" role="status">
                      <span class="text-[var(--accent)]">Beat This</span> ·{" "}
                      {(
                        (modelDownload.status()?.total_bytes ?? 0) / 1000000
                      ).toFixed(1)}{" "}
                      MB · Installed and available offline
                    </p>
                    <Button
                      disabled={modelDownload.busy()}
                      onClick={() => void modelDownload.remove()}
                    >
                      Delete model
                    </Button>
                  </Show>
                  <Show when={modelDownload.error()}>
                    <p role="alert" class="text-sm text-red-400">
                      {modelDownload.error()}
                    </p>
                  </Show>
                </div>
              </Show>
              <label class="block">
                <span class="text-sm text-gray-400">
                  Insert and paste position
                </span>
                <NativeSelect
                  value={timelinePlacementPreference()}
                  onChange={(e) =>
                    setTimelinePlacementPreference(
                      e.currentTarget.value as TimelinePlacementPreference,
                    )
                  }
                  class="mt-1"
                >
                  <option value="Playhead">Playhead</option>
                  <option value="Cursor">Cursor</option>
                </NativeSelect>
              </label>
            </section>
          </Show>

          <Show when={activeTab() === "network"}>
            <section>
              <h3 class="text-sm font-medium text-gray-300 mb-3">Network</h3>
              <label class="block">
                <span class="text-sm text-gray-400">Interface</span>
                <NativeSelect
                  value={ioSettings().network_interface ?? ""}
                  onChange={(e) =>
                    setNetworkInterface(e.currentTarget.value || null)
                  }
                  class="mt-1"
                >
                  <option value="">
                    {systemDefaultLabel(networkInterfaceStatus())}
                  </option>
                  <For each={networkInterfaces()}>
                    {(iface) => (
                      <option value={iface.name}>
                        {iface.name} ({iface.addresses.join(", ")})
                      </option>
                    )}
                  </For>
                </NativeSelect>
              </label>
              <div class="mt-3 rounded-md border border-gray-700 bg-gray-900/60 px-3 py-2 text-sm text-gray-300 space-y-1">
                <p>
                  {configuredInterfaceDescription(
                    networkInterfaceStatus(),
                    ioSettings().network_interface,
                  )}
                </p>
                <p class="text-gray-400">
                  System default interface:{" "}
                  {formatNetworkInterface(
                    networkInterfaceStatus().default_interface,
                  )}
                </p>
              </div>
            </section>
            <section>
              <h3 class="text-sm font-medium text-gray-300 mb-3">Output</h3>
              <label class="block">
                <span class="text-sm text-gray-400">DMX output rate (Hz)</span>
                <Input
                  ref={dmxOutputRateInput}
                  type="number"
                  min="1"
                  max="60"
                  step="1"
                  value={ioSettings().dmx_output_rate_hz}
                  onChange={(e) =>
                    setDmxOutputRate(e.currentTarget.valueAsNumber)
                  }
                  class="mt-1"
                />
              </label>
              <p class="mt-1 text-xs text-gray-500">
                Art-Net and sACN packets sent per universe each second. Wired
                DMX512 refreshes at most 44 times per second.
              </p>
            </section>
            <section>
              <h3 class="text-sm font-medium text-gray-300 mb-3">Input</h3>
              <label class="block mb-3">
                <span class="text-sm text-gray-400">Input visibility</span>
                <NativeSelect
                  value={inputUniverseVisibilityMode()}
                  onChange={(e) =>
                    setInputUniverseVisibilityMode(
                      e.currentTarget.value as InputUniverseVisibilityMode,
                    )
                  }
                  class="mt-1"
                >
                  <option value="ExternalOnly">External only</option>
                  <option value="AllDetected">All detected</option>
                </NativeSelect>
              </label>
              <label class="block">
                <span class="text-sm text-gray-400">
                  Input signal loss policy
                </span>
                <NativeSelect
                  value={inputSignalLossPolicy().type}
                  onChange={(e) =>
                    setInputSignalLossPolicyType(
                      e.currentTarget.value as "Hold" | "ClearAfterTimeout",
                    )
                  }
                  class="mt-1"
                >
                  <option value="Hold">Hold last values</option>
                  <option value="ClearAfterTimeout">Clear after timeout</option>
                </NativeSelect>
              </label>
              <div class="mt-3">
                <label class="block">
                  <span class="text-sm text-gray-400">
                    Input stale timeout (ms)
                  </span>
                  <Input
                    type="number"
                    min="0"
                    step="100"
                    value={inputSignalLossTimeoutMs()}
                    onChange={(e) =>
                      setInputSignalLossTimeout(e.currentTarget.valueAsNumber)
                    }
                    class="mt-1"
                  />
                </label>
              </div>
            </section>
            <section>
              <h3 class="text-sm font-medium text-gray-300 mb-3">UI updates</h3>
              <ToggleSwitch
                label="Send only changed parameters (recommended)"
                ariaLabel="Send only changed parameters (recommended)"
                class="w-full justify-between"
                checked={!settings().parameter_keyframes_only}
                onChange={(enabled) => setParameterKeyframesOnly(!enabled)}
              />
              <p class="mt-1 text-xs text-gray-500">
                Sending every parameter in full each frame may be more reliable,
                but uses more network bandwidth and processing power.
              </p>
            </section>
          </Show>

          <Show when={activeTab() === "visualizer"}>
            <section>
              <h3 class="text-sm font-medium text-gray-300 mb-3">Visualizer</h3>
              <div class="space-y-3">
                <ToggleSwitch
                  label="Highlight selection"
                  ariaLabel="Highlight selection"
                  class="w-full justify-between"
                  checked={highlightSelection()}
                  onChange={(enabled) =>
                    setStoreAction(
                      visualizerHighlightSelection,
                      "Set Visualizer Highlight Selection",
                      enabled,
                    )
                  }
                />
                <ToggleSwitch
                  label="Show current orbit target"
                  ariaLabel="Show current orbit target"
                  class="w-full justify-between"
                  checked={showOrbitTargetIndicator()}
                  onChange={(enabled) =>
                    setStoreAction(
                      visualizerShowOrbitTargetIndicator,
                      "Set Visualizer Orbit Target Indicator",
                      enabled,
                    )
                  }
                />
                <label class="block">
                  <span class="text-sm text-gray-400">Quality preset</span>
                  <input
                    type="range"
                    min="0"
                    max="2"
                    step="1"
                    aria-label="Quality preset"
                    aria-valuetext={
                      QUALITY_OPTIONS.find(
                        (option) => option.value === quality(),
                      )?.label
                    }
                    value={QUALITY_OPTIONS.findIndex(
                      (option) => option.value === quality(),
                    )}
                    onInput={(e) =>
                      setVisualizerQuality(
                        QUALITY_OPTIONS[e.currentTarget.valueAsNumber].value,
                      )
                    }
                    class="mt-2 w-full"
                  />
                  <span
                    class="flex justify-between text-xs text-gray-400"
                    aria-hidden="true"
                  >
                    <For each={QUALITY_OPTIONS}>
                      {(option) => (
                        <span
                          class={
                            quality() === option.value
                              ? "text-gray-100 font-medium"
                              : ""
                          }
                        >
                          {option.label}
                        </span>
                      )}
                    </For>
                  </span>
                  <p class="mt-1 text-xs text-gray-500" aria-live="polite">
                    {quality() === "low"
                      ? "Simple geometry beams without surface lighting, for maximum performance."
                      : quality() === "medium"
                        ? "Smoothly shaded beams and surface lighting, without fog or glow."
                        : "Atmospheric beams, fog, glow, and optical effects."}
                  </p>
                </label>
                <label class="block">
                  <span class="text-sm text-gray-400">
                    Darkness ({darkness()}%)
                  </span>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    value={darkness()}
                    class="mt-2 w-full"
                    aria-label="Darkness"
                    onInput={(e) =>
                      setStoreAction(
                        visualizerDarkness,
                        "Set Visualizer Darkness",
                        Number(e.currentTarget.value),
                      )
                    }
                  />
                  <p class="mt-1 text-xs text-gray-500">
                    Lower for a visible rig; higher for a dark stage. Fixture
                    brightness is unchanged.
                  </p>
                </label>
                <label class="block">
                  <span class="text-sm text-gray-400">Rotation mode</span>
                  <NativeSelect
                    value={rotationMode()}
                    onInput={(e) =>
                      setStoreAction(
                        visualizerCameraRotationMode,
                        "Set Visualizer Camera Rotation Mode",
                        e.currentTarget.value as VisualizerCameraRotationMode,
                      )
                    }
                    class="mt-1"
                  >
                    <For each={ROTATION_MODE_OPTIONS}>
                      {(option) => (
                        <option value={option.value}>{option.label}</option>
                      )}
                    </For>
                  </NativeSelect>
                </label>
              </div>
            </section>
            <section>
              <p class="text-xs text-gray-500">
                Tool mode, grid, emitter debug, and snap-point toggles are
                available in the visualizer toolbar.
              </p>
            </section>
          </Show>
        </DialogBody>
      </Dialog>
      {modelDownload.dialog()}
    </>
  );
}
