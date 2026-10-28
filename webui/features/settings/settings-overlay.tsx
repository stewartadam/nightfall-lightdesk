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
  createMemo,
  createSignal,
  createUniqueId,
  For,
  type JSX,
  onCleanup,
  Show,
} from "solid-js";
import { useAppShell } from "../../components/providers/app-shell";
import { Dialog, DialogBody } from "../../components/ui/dialog";
import { Input, NativeSelect } from "../../components/ui/form-controls";
import { RangeSlider } from "../../components/ui/range-slider";
import { SearchField } from "../../components/ui/search-field";
import { SegmentedControl } from "../../components/ui/segmented-control";
import { SegmentedTabs } from "../../components/ui/segmented-tabs";
import { SettingsRow, SettingsSection } from "../../components/ui/settings-row";
import {
  SettingsSearchGroup,
  SettingsSearchItem,
  SettingsSearchRoot,
} from "../../components/ui/settings-search";
import { ToggleSwitch } from "../../components/ui/toggle-switch";
import { Button } from "../../components/ui/visual-language/button";
import { durationToMs, msToDuration } from "../../lib/duration";
import { commandClient } from "../../lib/engine-commands";
import { setStoreAction } from "../../lib/nanostore-action";
import {
  routeValidationSettings,
  runtimeCapabilities,
} from "../../state/appStores";
import {
  dismissedPrompts,
  resetDismissedPrompts,
} from "../../state/dismissed-prompts";
import {
  $availableAudioDevices,
  $availableNetworkInterfaces,
  $ioSettings,
  $networkInterfaceStatus,
  $settings,
} from "../../state/settings";
import {
  $requestedSettings,
  NETWORK_INTERFACE_SETTING,
  ROUTE_VALIDATION_SETTING,
  type SettingsTab,
} from "../../state/settings-request";
import { compactViewport } from "../../state/viewport";
import type {
  InputSignalLossPolicy,
  NetworkInterfaceInfo,
  NetworkInterfaceStatus,
  RouteValidationMode,
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
import { GdtfShareSettings } from "../gdtf-share";
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
  { value: "camera-locked", label: "Camera-locked" },
  { value: "center-locked", label: "Center-locked" },
];

const SETTINGS_TABS: { key: SettingsTab; label: string }[] = [
  { key: "general", label: "General" },
  { key: "appearance", label: "Appearance" },
  { key: "editors", label: "Editors" },
  { key: "network", label: "Network" },
  { key: "visualizer", label: "Visualizer" },
  { key: "keyboard", label: "Keyboard" },
  { key: "accounts", label: "Accounts" },
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

/** Describes how many prompts "Don't show this again" turned off on this device. */
const hiddenPromptsDescription = (count: number): string => {
  const intro =
    "Prompts turned off with “Don't show this again” on this device.";
  if (count === 0) return `${intro} None are hidden.`;
  return `${intro} ${count} ${count === 1 ? "is" : "are"} hidden.`;
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
  const patchValidationSettings = useStore(routeValidationSettings);
  const networkInterfaces = useStore($availableNetworkInterfaces);
  const networkInterfaceStatus = useStore($networkInterfaceStatus);
  /**
   * Names the chosen interface while it is disconnected, so the selector keeps showing it instead
   * of appearing to have switched to System default.
   */
  const missingNetworkInterface = createMemo(() => {
    const selected = ioSettings().network_interface;
    return selected &&
      !networkInterfaces().some((item) => item.name === selected)
      ? selected
      : undefined;
  });
  const audioDevices = useStore($availableAudioDevices);
  const capabilities = useStore(runtimeCapabilities);
  const modelDownload = createBeatModelDownload();
  const highlightSelection = useStore(visualizerHighlightSelection);
  const rotationMode = useStore(visualizerCameraRotationMode);
  const showOrbitTargetIndicator = useStore(visualizerShowOrbitTargetIndicator);
  const quality = useStore(visualizerQuality);
  const darkness = useStore(visualizerDarkness);
  const dismissed = useStore(dismissedPrompts);
  const [activeTab, setActiveTab] = createSignal<SettingsTab>("general");
  /** Tabs with something to show on this engine; Accounts holds only GDTF Share for now. */
  const visibleTabs = createMemo(() =>
    SETTINGS_TABS.filter(
      (tab) => tab.key !== "accounts" || capabilities()?.gdtf_share,
    ),
  );
  const [query, setQuery] = createSignal("");
  const [hasResults, setHasResults] = createSignal(true);
  /** Whether a search is running, which lists matches from every tab instead of one tab. */
  const searching = () => query().trim().length > 0;
  const requested = useStore($requestedSettings);
  const tabId = createUniqueId();
  /**
   * Switches to the tab another surface asked for, ending any search, and focuses the requested
   * setting's control once the tab has rendered. Then forgets the request.
   */
  createEffect(() => {
    const target = requested();
    if (!target || !isSettingsOpen()) return;
    setQuery("");
    setActiveTab(target.tab);
    $requestedSettings.set(null);
    const { setting } = target;
    if (!setting) return;
    // Waits past the dialog's own opening focus, which lands on the search field.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const control = document
          .getElementById(`${tabId}-content`)
          ?.querySelector<HTMLElement>(
            `[data-setting="${CSS.escape(setting)}"] :is(input, select, textarea, button)`,
          );
        control?.scrollIntoView({ block: "nearest" });
        control?.focus();
      }),
    );
  });
  /** Starts each visit to settings without the previous visit's search. */
  createEffect(() => {
    if (!isSettingsOpen()) setQuery("");
  });

  /**
   * Renders one tab's settings: alone while its tab is selected, or, during a search, under its
   * tab name alongside the other tabs' matches, in tab order.
   */
  const TabPane = (props: { tab: SettingsTab; children: JSX.Element }) => {
    const index = SETTINGS_TABS.findIndex((tab) => tab.key === props.tab);
    return (
      <Show when={searching() || activeTab() === props.tab}>
        <SettingsSearchGroup
          title={SETTINGS_TABS[index].label}
          showTitle={searching()}
          class="space-y-4"
          style={{ order: index }}
        >
          {props.children}
        </SettingsSearchGroup>
      </Show>
    );
  };
  /** Refreshes backend-provided device choices whenever settings becomes visible. */
  createEffect(() => {
    if (!isSettingsOpen()) return;
    commandClient.emit("SettingsCommand", {
      type: "GetAvailableNetworkInterfaces",
    });
    commandClient.emit("SettingsCommand", { type: "GetAvailableAudioDevices" });
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
    commandClient.emit("SettingsCommand", {
      type: "SetProgrammerAutoSelect",
      data: value,
    });
  };

  /** Chooses whether clients receive only changed parameter values or every value each frame. */
  const setParameterKeyframesOnly = (value: boolean) => {
    commandClient.emit("SettingsCommand", {
      type: "SetParameterKeyframesOnly",
      data: value,
    });
  };

  const setNetworkInterface = (value: string | null) => {
    commandClient.emit("SettingsCommand", {
      type: "SetNetworkInterface",
      data: value,
    });
  };

  const setAudioDevice = (value: string | null) => {
    commandClient.emit("SettingsCommand", {
      type: "SetAudioDevice",
      data: value,
    });
  };

  const setInputSignalLossPolicy = (value: InputSignalLossPolicy) => {
    commandClient.emit("SettingsCommand", {
      type: "SetInputSignalLossPolicy",
      data: value,
    });
  };

  const setInputUniverseVisibilityMode = (
    value: InputUniverseVisibilityMode,
  ) => {
    commandClient.emit("SettingsCommand", {
      type: "SetInputUniverseVisibilityMode",
      data: value,
    });
  };

  const setSequenceReorderRenumberPolicy = (
    value: SequenceReorderRenumberPolicy,
  ) => {
    commandClient.emit("SettingsCommand", {
      type: "SetSequenceReorderRenumberPolicy",
      data: value,
    });
  };

  const setSelectionFlattenPolicy = (value: SelectionFlattenPolicy) => {
    commandClient.emit("SettingsCommand", {
      type: "SetSelectionFlattenPolicy",
      data: value,
    });
  };

  const setTimeDisplayPreference = (value: TimeDisplayPreference) => {
    commandClient.emit("SettingsCommand", {
      type: "SetTimeDisplayPreference",
      data: value,
    });
  };

  const setTimelinePlacementPreference = (
    value: TimelinePlacementPreference,
  ) => {
    commandClient.emit("SettingsCommand", {
      type: "SetTimelinePlacementPreference",
      data: value,
    });
  };

  /** Sends the configured showfile backup retention count to the backend. */
  const setShowfileBackupRetention = (value: number) => {
    const retention = Number.isFinite(value)
      ? Math.max(0, Math.trunc(value))
      : DEFAULT_SHOWFILE_BACKUP_RETENTION;
    commandClient.emit("SettingsCommand", {
      type: "SetShowfileBackupRetention",
      data: retention,
    });
  };

  const setRouteValidationMode = (value: RouteValidationMode) => {
    commandClient.emit("SettingsCommand", {
      type: "SetRouteValidationMode",
      data: value,
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
    commandClient.emit("SettingsCommand", {
      type: "SetDmxOutputRate",
      data: Math.min(Math.max(Math.trunc(value), 0), U32_MAX),
    });
  };

  const setInputSignalLossTimeout = (value: number) => {
    commandClient.emit("SettingsCommand", {
      type: "SetInputSignalLossTimeout",
      data: msToDuration(value),
    });
  };

  return (
    <SettingsSearchRoot query={query()} onResults={setHasResults}>
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
        <div class="space-y-3 px-4 pt-3">
          <SearchField
            label="Search settings"
            // Ready for typing on open, except on phones, where focus would raise the keyboard.
            autofocus={!compactViewport.get()}
            value={query()}
            onInput={setQuery}
            data-testid="settings-search"
          />
          <Show when={!searching()}>
            <SegmentedTabs
              id={tabId}
              label="Settings categories"
              contentId={`${tabId}-content`}
              options={visibleTabs()}
              value={activeTab()}
              onChange={setActiveTab}
            />
          </Show>
        </div>

        <DialogBody
          class="flex flex-col gap-4"
          id={`${tabId}-content`}
          role={searching() ? "region" : "tabpanel"}
          aria-label={searching() ? "Search results" : undefined}
          aria-labelledby={searching() ? undefined : `${tabId}-${activeTab()}`}
        >
          <Show when={searching() && !hasResults()}>
            <p class="py-6 text-center text-sm text-gray-400" role="status">
              No settings match “{query().trim()}”.
            </p>
          </Show>
          <TabPane tab="appearance">
            <AppearanceSettings />
          </TabPane>
          <Show when={capabilities()?.gdtf_share}>
            <TabPane tab="accounts">
              <GdtfShareSettings />
            </TabPane>
          </Show>
          <TabPane tab="privacy">
            <PrivacySettings />
          </TabPane>
          <TabPane tab="keyboard">
            <SettingsSearchItem keywords="Keybindings keyboard shortcuts keys hotkeys MIDI OSC">
              <KeybindingsSettings />
            </SettingsSearchItem>
          </TabPane>
          <TabPane tab="general">
            <SettingsSection title="Programmer">
              <SettingsRow
                label="Auto-select on attribute set"
                description="Setting an attribute value also updates the programmer selection."
              >
                {(field) => (
                  <ToggleSwitch
                    id={field.id}
                    describedBy={field.describedBy}
                    ariaLabel="Auto-select on attribute set"
                    layout="switch-only"
                    checked={settings().programmer_auto_select}
                    onChange={setProgrammerAutoSelect}
                  />
                )}
              </SettingsRow>
              <SettingsRow
                label="Selection flatten behavior"
                description="Whether to ask before an action replaces a selection expression with the fixtures it currently matches."
              >
                {(field) => (
                  <NativeSelect
                    id={field.id}
                    aria-describedby={field.describedBy}
                    value={selectionFlattenPolicy()}
                    onChange={(e) =>
                      setSelectionFlattenPolicy(
                        e.currentTarget.value as SelectionFlattenPolicy,
                      )
                    }
                  >
                    <option value="Silent">Silent</option>
                    <option value="Prompt">Prompt before flattening</option>
                  </NativeSelect>
                )}
              </SettingsRow>
            </SettingsSection>
            <SettingsSection title="Audio">
              <SettingsRow
                label="Output Device"
                description="Where timeline audio plays."
              >
                {(field) => (
                  <NativeSelect
                    id={field.id}
                    aria-describedby={field.describedBy}
                    value={settings().audio_device ?? ""}
                    onChange={(e) =>
                      setAudioDevice(e.currentTarget.value || null)
                    }
                  >
                    <option value="">System Default</option>
                    <For each={Object.entries(audioDevices())} fallback={null}>
                      {([id, name]) => <option value={id}>{name}</option>}
                    </For>
                  </NativeSelect>
                )}
              </SettingsRow>
            </SettingsSection>
            <SettingsSection title="Showfile">
              <SettingsRow
                label="Backups to keep"
                description="Timestamped backups kept after each save. 0 keeps every backup."
              >
                {(field) => (
                  <Input
                    id={field.id}
                    aria-describedby={field.describedBy}
                    type="number"
                    min="0"
                    step="1"
                    value={showfileBackupRetention()}
                    onChange={(e) =>
                      setShowfileBackupRetention(e.currentTarget.valueAsNumber)
                    }
                  />
                )}
              </SettingsRow>
            </SettingsSection>
            <SettingsSection title="Patch">
              <SettingsRow
                setting={ROUTE_VALIDATION_SETTING}
                label="Overlap validation mode"
                description="Strict blocks overlapping patches. Permissive allows overlaps but still requires unique console addresses."
              >
                {(field) => (
                  <NativeSelect
                    id={field.id}
                    aria-describedby={field.describedBy}
                    value={patchValidationSettings().mode}
                    onChange={(e) =>
                      setRouteValidationMode(
                        e.currentTarget.value as RouteValidationMode,
                      )
                    }
                  >
                    <option value="Strict">Strict Mode</option>
                    <option value="Permissive">Permissive Mode</option>
                  </NativeSelect>
                )}
              </SettingsRow>
            </SettingsSection>
            <SettingsSection title="Notifications">
              <SettingsRow
                label="Hidden prompts"
                labelControl={false}
                keywords="don't show this again dismissed reset toasts"
                description={
                  <span role="status">
                    {hiddenPromptsDescription(dismissed().length)}
                  </span>
                }
              >
                {() => (
                  <Button
                    size="compact"
                    disabled={dismissed().length === 0}
                    onClick={resetDismissedPrompts}
                    data-testid="reset-dismissed-prompts"
                  >
                    Show again
                  </Button>
                )}
              </SettingsRow>
            </SettingsSection>
          </TabPane>

          <TabPane tab="editors">
            <SettingsSection title="Cue / Sequence Authoring">
              <SettingsRow
                label="Reorder cue renumber behavior"
                description="What happens to cue numbers after you reorder a sequence's cues."
              >
                {(field) => (
                  <NativeSelect
                    id={field.id}
                    aria-describedby={field.describedBy}
                    value={sequenceReorderRenumberPolicy()}
                    onChange={(e) =>
                      setSequenceReorderRenumberPolicy(
                        e.currentTarget.value as SequenceReorderRenumberPolicy,
                      )
                    }
                  >
                    <option value="Preserve">Preserve cue IDs</option>
                    <option value="AutoRenumber">
                      Auto-renumber after reorder
                    </option>
                    <option value="Prompt">Prompt each time</option>
                  </NativeSelect>
                )}
              </SettingsRow>
              <SettingsRow
                label="Timing display units"
                description="Unit for editable times such as fades and delays. Auto picks a compact unit for each value."
              >
                {(field) => (
                  <NativeSelect
                    id={field.id}
                    aria-describedby={field.describedBy}
                    value={timeDisplayPreference()}
                    onChange={(e) =>
                      setTimeDisplayPreference(
                        e.currentTarget.value as TimeDisplayPreference,
                      )
                    }
                  >
                    <option value="Auto">Auto</option>
                    <option value="Seconds">Seconds</option>
                    <option value="Milliseconds">Milliseconds</option>
                    <option value="Bpm">BPM</option>
                    <option value="Hertz">Hz</option>
                  </NativeSelect>
                )}
              </SettingsRow>
            </SettingsSection>

            <SettingsSection title="Timeline">
              <Show when={capabilities()?.runtime_mode !== "EmbeddedDemo"}>
                <SettingsRow
                  label="Beat detection model"
                  labelControl={false}
                  description={
                    <span role="status">
                      <Show
                        when={modelDownload.status()?.phase === "ready"}
                        fallback={
                          !modelDownload.status() ||
                          ["unchecked", "checking"].includes(
                            modelDownload.status()!.phase,
                          )
                            ? "Checking beat detection model…"
                            : modelDownload.status()?.phase === "deleting"
                              ? "Deleting beat detection model…"
                              : "The optional Beat This model will enable offline and automatic beatgrid detection."
                        }
                      >
                        <span class="text-[var(--accent)]">Beat This</span> ·{" "}
                        {(
                          (modelDownload.status()?.total_bytes ?? 0) / 1000000
                        ).toFixed(1)}{" "}
                        MB · Installed and available offline
                      </Show>
                    </span>
                  }
                  details={
                    modelDownload.error() ? (
                      <p role="alert" class="text-xs text-red-400">
                        {modelDownload.error()}
                      </p>
                    ) : undefined
                  }
                >
                  {() => (
                    <Show
                      when={modelDownload.status()?.phase === "ready"}
                      fallback={
                        <Button
                          size="compact"
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
                      }
                    >
                      <Button
                        size="compact"
                        disabled={modelDownload.busy()}
                        onClick={() => void modelDownload.remove()}
                      >
                        Delete model
                      </Button>
                    </Show>
                  )}
                </SettingsRow>
              </Show>
              <SettingsRow
                label="Insert and paste position"
                description="Where new and pasted timeline items land."
              >
                {(field) => (
                  <NativeSelect
                    id={field.id}
                    aria-describedby={field.describedBy}
                    value={timelinePlacementPreference()}
                    onChange={(e) =>
                      setTimelinePlacementPreference(
                        e.currentTarget.value as TimelinePlacementPreference,
                      )
                    }
                  >
                    <option value="Playhead">Playhead</option>
                    <option value="Cursor">Cursor</option>
                  </NativeSelect>
                )}
              </SettingsRow>
            </SettingsSection>
          </TabPane>

          <TabPane tab="network">
            <SettingsSection title="Network">
              <SettingsRow
                label="Interface"
                setting={NETWORK_INTERFACE_SETTING}
                description={
                  <>
                    <p>
                      {configuredInterfaceDescription(
                        networkInterfaceStatus(),
                        ioSettings().network_interface,
                      )}
                    </p>
                    <p>
                      System default interface:{" "}
                      {formatNetworkInterface(
                        networkInterfaceStatus().default_interface,
                      )}
                    </p>
                  </>
                }
              >
                {(field) => (
                  <NativeSelect
                    id={field.id}
                    aria-describedby={field.describedBy}
                    value={ioSettings().network_interface ?? ""}
                    onChange={(e) =>
                      setNetworkInterface(e.currentTarget.value || null)
                    }
                  >
                    <option value="">
                      {systemDefaultLabel(networkInterfaceStatus())}
                    </option>
                    <Show when={missingNetworkInterface()}>
                      {(name) => (
                        <option value={name()}>{name()} (unavailable)</option>
                      )}
                    </Show>
                    <For each={networkInterfaces()}>
                      {(iface) => (
                        <option value={iface.name}>
                          {iface.name} ({iface.addresses.join(", ")})
                        </option>
                      )}
                    </For>
                  </NativeSelect>
                )}
              </SettingsRow>
            </SettingsSection>
            <SettingsSection title="Output">
              <SettingsRow
                label="DMX output rate (Hz)"
                description="Art-Net and sACN packets sent per universe each second. Wired DMX512 refreshes at most 44 times per second."
              >
                {(field) => (
                  <Input
                    ref={dmxOutputRateInput}
                    id={field.id}
                    aria-describedby={field.describedBy}
                    type="number"
                    min="1"
                    max="60"
                    step="1"
                    value={ioSettings().dmx_output_rate_hz}
                    onChange={(e) =>
                      setDmxOutputRate(e.currentTarget.valueAsNumber)
                    }
                  />
                )}
              </SettingsRow>
            </SettingsSection>
            <SettingsSection title="Input">
              <SettingsRow
                label="Input visibility"
                description="All detected also lists local loopback frames, such as Nightfall's own output."
              >
                {(field) => (
                  <NativeSelect
                    id={field.id}
                    aria-describedby={field.describedBy}
                    value={inputUniverseVisibilityMode()}
                    onChange={(e) =>
                      setInputUniverseVisibilityMode(
                        e.currentTarget.value as InputUniverseVisibilityMode,
                      )
                    }
                  >
                    <option value="ExternalOnly">External only</option>
                    <option value="AllDetected">All detected</option>
                  </NativeSelect>
                )}
              </SettingsRow>
              <SettingsRow
                label="Input signal loss policy"
                description="What input channels do when their source stops sending."
              >
                {(field) => (
                  <NativeSelect
                    id={field.id}
                    aria-describedby={field.describedBy}
                    value={inputSignalLossPolicy().type}
                    onChange={(e) =>
                      setInputSignalLossPolicyType(
                        e.currentTarget.value as "Hold" | "ClearAfterTimeout",
                      )
                    }
                  >
                    <option value="Hold">Hold last values</option>
                    <option value="ClearAfterTimeout">
                      Clear after timeout
                    </option>
                  </NativeSelect>
                )}
              </SettingsRow>
              <SettingsRow
                label="Input stale timeout (ms)"
                description="How long an input can go quiet before it counts as lost."
              >
                {(field) => (
                  <Input
                    id={field.id}
                    aria-describedby={field.describedBy}
                    type="number"
                    min="0"
                    step="100"
                    value={inputSignalLossTimeoutMs()}
                    onChange={(e) =>
                      setInputSignalLossTimeout(e.currentTarget.valueAsNumber)
                    }
                  />
                )}
              </SettingsRow>
            </SettingsSection>
            <SettingsSection title="UI updates">
              <SettingsRow
                label="Send only changed parameters (recommended)"
                description="Sending every parameter in full each frame may be more reliable, but uses more network bandwidth and processing power."
              >
                {(field) => (
                  <ToggleSwitch
                    id={field.id}
                    describedBy={field.describedBy}
                    ariaLabel="Send only changed parameters (recommended)"
                    layout="switch-only"
                    checked={!settings().parameter_keyframes_only}
                    onChange={(enabled) => setParameterKeyframesOnly(!enabled)}
                  />
                )}
              </SettingsRow>
            </SettingsSection>
          </TabPane>

          <TabPane tab="visualizer">
            <SettingsSection
              title="Visualizer"
              footer="Tool mode, grid, emitter debug, and snap-point toggles are available in the visualizer toolbar."
            >
              <SettingsRow
                label="Highlight selection"
                description="Outlines selected fixtures in the 3D view."
              >
                {(field) => (
                  <ToggleSwitch
                    id={field.id}
                    describedBy={field.describedBy}
                    ariaLabel="Highlight selection"
                    layout="switch-only"
                    checked={highlightSelection()}
                    onChange={(enabled) =>
                      setStoreAction(
                        visualizerHighlightSelection,
                        "Set Visualizer Highlight Selection",
                        enabled,
                      )
                    }
                  />
                )}
              </SettingsRow>
              <SettingsRow
                label="Show current orbit target"
                description="Marks the point the camera orbits around."
              >
                {(field) => (
                  <ToggleSwitch
                    id={field.id}
                    describedBy={field.describedBy}
                    ariaLabel="Show current orbit target"
                    layout="switch-only"
                    checked={showOrbitTargetIndicator()}
                    onChange={(enabled) =>
                      setStoreAction(
                        visualizerShowOrbitTargetIndicator,
                        "Set Visualizer Orbit Target Indicator",
                        enabled,
                      )
                    }
                  />
                )}
              </SettingsRow>
              <SettingsRow
                label="Quality preset"
                labelControl={false}
                description={
                  <span aria-live="polite">
                    {quality() === "low"
                      ? "Simple geometry beams without surface lighting, for maximum performance."
                      : quality() === "medium"
                        ? "Smoothly shaded beams and surface lighting, without fog or glow."
                        : "Atmospheric beams, fog, glow, and optical effects."}
                  </span>
                }
              >
                {(field) => (
                  <SegmentedControl
                    id={field.id}
                    label="Quality preset"
                    aria-describedby={field.describedBy}
                    options={QUALITY_OPTIONS}
                    value={quality()}
                    onChange={setVisualizerQuality}
                  />
                )}
              </SettingsRow>
              <SettingsRow
                label={`Darkness (${darkness()}%)`}
                labelControl={false}
                description="Lower for a visible rig; higher for a dark stage. Fixture brightness is unchanged."
              >
                {(field) => (
                  <RangeSlider
                    value={darkness()}
                    ariaLabel="Darkness"
                    describedBy={field.describedBy}
                    showPips={false}
                    showInputs={false}
                    containerClass="w-56"
                    onChange={(value) =>
                      setStoreAction(
                        visualizerDarkness,
                        "Set Visualizer Darkness",
                        value,
                      )
                    }
                  />
                )}
              </SettingsRow>
              <SettingsRow
                label="Rotation mode"
                description="Camera-locked orbits the current target; Center-locked orbits the world origin."
              >
                {(field) => (
                  <NativeSelect
                    id={field.id}
                    aria-describedby={field.describedBy}
                    value={rotationMode()}
                    onInput={(e) =>
                      setStoreAction(
                        visualizerCameraRotationMode,
                        "Set Visualizer Camera Rotation Mode",
                        e.currentTarget.value as VisualizerCameraRotationMode,
                      )
                    }
                  >
                    <For each={ROTATION_MODE_OPTIONS}>
                      {(option) => (
                        <option value={option.value}>{option.label}</option>
                      )}
                    </For>
                  </NativeSelect>
                )}
              </SettingsRow>
            </SettingsSection>
          </TabPane>
        </DialogBody>
      </Dialog>
      {modelDownload.dialog()}
    </SettingsSearchRoot>
  );
}
