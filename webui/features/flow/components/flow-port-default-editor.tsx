// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createEffect, createSignal, For, Show } from "solid-js";
import {
  Checkbox,
  Input,
  NativeSelect,
} from "../../../components/ui/form-controls";
import ColorPicker from "../../../components/widgets/color-picker";
import {
  formatSpatialSelection,
  parseSpatialSelection,
} from "../../../lib/wasm-bridge";
import { pushToast } from "../../../state/appStores";
import type * as flowTypes from "../../../types/index";
import { WaveformEditor } from "../../fx";
import {
  attributeLabelToHsv,
  DEFAULT_WAVEFORM,
  formatColorHex,
  parseHexColor,
  resolveAttributeValue,
  resolveBoolValue,
  resolveNumberValue,
  resolveSelectionValue,
  resolveStringValue,
  resolveWaveformValue,
  rgbToAttributeLabel,
} from "../model/utils";

interface FlowPortDefaultEditorProps {
  port: flowTypes.FlowPortDefinition;
  disabled: boolean;
  nodeKind?: string;
  onCommit: (value: flowTypes.FlowValue) => void;
}

/** Edits color attribute defaults with a swatch, text field, and inline picker. */
function AttributeColorPicker(props: {
  value: string;
  disabled: boolean;
  onCommit: (value: string) => void;
}) {
  let lastSentValue = props.value;

  /** Keeps color change deduplication aligned with externally supplied values. */
  createEffect(() => {
    lastSentValue = props.value;
  });

  /** Converts picker hex output to an attribute label and publishes real changes. */
  const handleChange = (hex: string) => {
    const parsed = parseHexColor(hex);
    if (!parsed) return;
    const nextLabel = rgbToAttributeLabel(parsed);
    if (nextLabel === lastSentValue) return;
    lastSentValue = nextLabel;
    props.onCommit(nextLabel);
  };

  return (
    <div
      class={`rounded-md border border-neutral-700 bg-neutral-950 p-2 ${props.disabled ? "pointer-events-none opacity-60" : ""}`}
    >
      <Show when={props.value} keyed>
        {(value) => (
          <ColorPicker
            value={attributeLabelToHsv(value)}
            onChange={(color) => handleChange(color.hex)}
            class="scale-90 origin-top-left"
          />
        )}
      </Show>
      <div class="mt-2 text-[10px] text-neutral-400">
        Attribute {props.value}
      </div>
    </div>
  );
}

/** Embeds the waveform editor for waveform-valued flow ports. */
function WaveformEditorInline(props: {
  value: flowTypes.FlowWaveform;
  onCommit: (value: flowTypes.FlowWaveform) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = createSignal(props.value);

  /** Refreshes the local waveform draft when the owning flow changes. */
  createEffect(() => {
    setDraft(props.value);
  });

  /** Publishes one merged waveform draft update. */
  const updateDraft = (next: flowTypes.FlowWaveform) => {
    setDraft(next);
    props.onCommit(next);
  };

  return (
    <div class={props.disabled ? "opacity-60 pointer-events-none" : ""}>
      <WaveformEditor
        waveform={draft()}
        onWaveformChange={(updates) => updateDraft({ ...draft(), ...updates })}
      />
    </div>
  );
}

/** Chooses and coordinates the inline editor for a flow port's default value. */
export function FlowPortDefaultEditor(props: FlowPortDefaultEditorProps) {
  const [draftText, setDraftText] = createSignal("");
  const [draftNumber, setDraftNumber] = createSignal(0);
  const [draftBool, setDraftBool] = createSignal(false);
  const [draftColor, setDraftColor] = createSignal("#ff0000");
  let selectionFormatRequestId = 0;

  /** Synchronizes editor draft state from the current port definition. */
  createEffect(() => {
    const requestId = ++selectionFormatRequestId;
    if (props.port.port_type === "number" || props.port.port_type === "int") {
      setDraftNumber(resolveNumberValue(props.port));
      return;
    }
    if (props.port.port_type === "bool") {
      setDraftBool(resolveBoolValue(props.port));
      return;
    }
    if (props.port.port_type === "string") {
      setDraftText(resolveStringValue(props.port));
      return;
    }
    if (props.port.port_type === "attribute") {
      setDraftText(resolveAttributeValue(props.port));
      return;
    }
    if (props.port.port_type === "selection") {
      const selection = resolveSelectionValue(props.port);
      if (!selection) {
        setDraftText("");
        return;
      }
      void formatSpatialSelection(selection)
        .then((formatted) => {
          if (requestId === selectionFormatRequestId) setDraftText(formatted);
        })
        .catch(() => {
          if (requestId === selectionFormatRequestId) setDraftText("");
        });
      return;
    }
    if (props.port.port_type === "color") {
      const value = props.port.default_value;
      const color = value?.type === "Color" ? value.data : null;
      setDraftColor(formatColorHex(color));
    }
  });

  /** Parses and publishes a spatial-selection draft when it is valid. */
  const commitSelection = async () => {
    const trimmed = draftText().trim();
    if (!trimmed) return;
    const parsed = await parseSpatialSelection(trimmed);
    if (!parsed) {
      pushToast("error", `Invalid selection: "${trimmed}"`);
      return;
    }
    props.onCommit({ type: "Selection", data: parsed });
  };

  if (props.port.port_type === "number" || props.port.port_type === "int") {
    if (
      props.port.port_type === "int" &&
      props.port.enum_options &&
      props.port.enum_options.length > 0
    ) {
      return (
        <NativeSelect
          density="compact"
          value={Math.round(draftNumber())}
          onChange={(event) => {
            const value = Number.parseInt(event.currentTarget.value, 10);
            setDraftNumber(value);
            props.onCommit({ type: "Int", data: value });
          }}
          class="w-full"
          disabled={props.disabled}
        >
          <For each={props.port.enum_options}>
            {(option) => <option value={option.value}>{option.label}</option>}
          </For>
        </NativeSelect>
      );
    }

    return (
      <Input
        density="compact"
        type="number"
        step={props.port.port_type === "int" ? "1" : "0.1"}
        value={draftNumber()}
        onInput={(event) =>
          setDraftNumber(Number.parseFloat(event.currentTarget.value) || 0)
        }
        onChange={() =>
          props.onCommit({
            type: props.port.port_type === "int" ? "Int" : "Number",
            data:
              props.port.port_type === "int"
                ? Math.round(draftNumber())
                : draftNumber(),
          })
        }
        class="w-full"
        disabled={props.disabled}
      />
    );
  }

  if (props.port.port_type === "bool") {
    return (
      <label class="flex items-center gap-2 text-sm text-neutral-200">
        <Checkbox
          checked={draftBool()}
          onChange={(event) => {
            const next = event.currentTarget.checked;
            setDraftBool(next);
            props.onCommit({ type: "Bool", data: next });
          }}
          disabled={props.disabled}
        />
        <span>{draftBool() ? "True" : "False"}</span>
      </label>
    );
  }

  if (props.port.port_type === "string") {
    return (
      <Input
        density="compact"
        type="text"
        value={draftText()}
        onInput={(event) => setDraftText(event.currentTarget.value)}
        onChange={() => props.onCommit({ type: "String", data: draftText() })}
        class="w-full"
        disabled={props.disabled}
      />
    );
  }

  if (props.port.port_type === "attribute") {
    if (props.nodeKind === "color_picker") {
      return (
        <AttributeColorPicker
          value={draftText()}
          disabled={props.disabled}
          onCommit={(value) =>
            props.onCommit({ type: "AttributeLabel", data: value })
          }
        />
      );
    }
    return (
      <Input
        density="compact"
        type="text"
        value={draftText()}
        onInput={(event) => setDraftText(event.currentTarget.value)}
        onChange={() => {
          const trimmed = draftText().trim();
          if (!trimmed) return;
          const entries = trimmed
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean);
          props.onCommit(
            entries.length > 1
              ? { type: "AttributeLabels", data: entries }
              : { type: "AttributeLabel", data: entries[0] ?? trimmed },
          );
        }}
        class="w-full"
        disabled={props.disabled}
      />
    );
  }

  if (props.port.port_type === "selection") {
    return (
      <Input
        density="compact"
        type="text"
        value={draftText()}
        onInput={(event) => setDraftText(event.currentTarget.value)}
        onChange={() => void commitSelection()}
        class="w-full"
        disabled={props.disabled}
      />
    );
  }

  if (props.port.port_type === "color") {
    /** Publishes a color draft when it parses, optionally surfacing invalid blur input. */
    const commitColorIfValid = (value: string, showError = false) => {
      const parsed = parseHexColor(value);
      if (!parsed) {
        if (showError)
          pushToast("error", "Invalid color. Use #RRGGBB or #RGB.");
        return;
      }
      props.onCommit({
        type: "Color",
        data: { r: parsed.r / 255, g: parsed.g / 255, b: parsed.b / 255, w: 0 },
      });
    };

    return (
      <Input
        density="compact"
        type="text"
        value={draftColor()}
        onInput={(event) => {
          const nextValue = event.currentTarget.value;
          setDraftColor(nextValue);
          commitColorIfValid(nextValue);
        }}
        onBlur={() => commitColorIfValid(draftColor(), true)}
        class="w-full"
        disabled={props.disabled}
      />
    );
  }

  if (props.port.port_type === "waveform") {
    return (
      <WaveformEditorInline
        value={resolveWaveformValue(props.port) ?? DEFAULT_WAVEFORM}
        onCommit={(value) => props.onCommit({ type: "Waveform", data: value })}
        disabled={props.disabled}
      />
    );
  }

  return (
    <div class="text-xs text-neutral-500">No editor for this port type.</div>
  );
}
