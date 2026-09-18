// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import { createMemo, createSignal, For, Show } from "solid-js";
import AttributeSlider, {
  type AttributeMode,
} from "../../../components/widgets/attribute-slider";
import ColorPicker, {
  type HsvColor,
} from "../../../components/widgets/color-picker";
import { sortedAttributes } from "../../../lib/attribute-ordering";
import { parseHexColor } from "../../../lib/color-utils";
import { engineRuntime } from "../../../lib/engine-runtime";
import { getFixtureAttributeNames } from "../../../lib/fixture-attributes";
import { normalizeAttributeName } from "../../../lib/utils";
import { fixtures, programmerSelection } from "../../../state/appStores";
import type * as types from "../../../types";
import { ParameterValuePolarity } from "../../../types";

const humanizeAttributeName = (attr: string): string => {
  if (attr.includes(" ")) return attr;
  return attr.replace(/([a-z])([A-Z])/g, "$1 $2");
};

const formatAttributeForCommand = (attr: string): string => {
  if (!/[^A-Za-z0-9_]/.test(attr)) return attr;
  const escaped = attr.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
};

export default function ProgrammerProperties() {
  const $fixtures = useStore(fixtures);
  const $selection = useStore(programmerSelection);
  const [attributeValues, setAttributeValues] = createSignal<
    Record<string, number>
  >({});
  const [attributeModes, setAttributeModes] = createSignal<
    Record<string, AttributeMode>
  >({});
  const [pickerColor, setPickerColor] = createSignal<HsvColor>({
    h: 0,
    s: 1,
    v: 1,
  });
  const selectedAttributes = createMemo(() => {
    const fixtureMap = $fixtures();
    const selection = $selection();
    const attributes = new Set<string>();
    for (const uid of selection) {
      const fixture = fixtureMap[uid];
      if (!fixture) continue;
      for (const attr of getFixtureAttributeNames(fixture)) {
        attributes.add(normalizeAttributeName(attr));
      }
    }
    return attributes;
  });

  const hasColorAttributes = createMemo(() => {
    const attrs = selectedAttributes();
    return attrs.has("Red") || attrs.has("Green") || attrs.has("Blue");
  });

  const sliderAttributes = createMemo(() => {
    const attrs = selectedAttributes();
    const filtered = [...attrs].filter(
      (attr) => !["Red", "Green", "Blue"].includes(attr),
    );
    return sortedAttributes(filtered);
  });

  const getMode = (attr: string): AttributeMode =>
    attributeModes()[attr] ?? "absolute";

  const setMode = (attr: string, mode: AttributeMode) =>
    setAttributeModes((prev) => ({ ...prev, [attr]: mode }));

  const getValue = (attr: string) => attributeValues()[attr] ?? 0;

  const setValue = (attr: string, value: number) =>
    setAttributeValues((prev) => ({ ...prev, [attr]: value }));

  /** Returns whether the selected fixtures expose the attribute as a signed value. */
  const isSignedAttribute = (attr: string) => {
    const fixtureMap = $fixtures();
    for (const uid of $selection()) {
      const fixture = fixtureMap[uid];
      for (const element of fixture?.elements ?? []) {
        for (const parameter of element.parameters ?? []) {
          const parameterAttribute = parameter.attribute as types.Attribute;
          const attributeName =
            parameterAttribute.type === "Custom" && parameterAttribute.data
              ? parameterAttribute.data.label
              : parameterAttribute.type;
          if (
            normalizeAttributeName(attributeName) === attr &&
            parameter.value_polarity === ParameterValuePolarity.Signed
          ) {
            return true;
          }
        }
      }
    }
    return false;
  };

  const sendAttributeValue = (attr: string, value: number) => {
    const mode = getMode(attr);
    const operator = mode === "relative" ? "~" : "@";
    const cmd: types.DeskCommand = {
      type: "Eval",
      data: `${formatAttributeForCommand(attr)}${operator}${value}`,
    };
    engineRuntime.sendCommand({ module: "DeskCommand", command: cmd });
  };

  /** Returns the percentage range supported by one attribute editing mode. */
  const getRange = (attr: string, mode: AttributeMode) =>
    mode === "relative" || isSignedAttribute(attr)
      ? { min: -100, max: 100 }
      : { min: 0, max: 100 };

  return (
    <div class="space-y-4 p-4">
      <Show
        when={$selection().length > 0}
        fallback={
          <div class="text-sm text-neutral-400">
            Select fixtures to edit attributes.
          </div>
        }
      >
        <Show when={hasColorAttributes()}>
          <div class="space-y-2">
            <h3 class="text-xs uppercase tracking-wider text-neutral-400">
              Color
            </h3>
            <ColorPicker
              value={pickerColor()}
              onChange={(color) => {
                setPickerColor(color);
                const rgb = parseHexColor(color.hex);
                const cmd: types.DeskCommand = {
                  type: "Eval",
                  data: `red@${(rgb.r / 255) * 100} green@${(rgb.g / 255) * 100} blue@${(rgb.b / 255) * 100}`,
                };
                engineRuntime.sendCommand({
                  module: "DeskCommand",
                  command: cmd,
                });
              }}
            />
          </div>
        </Show>

        <Show
          when={sliderAttributes().length > 0}
          fallback={
            <div class="text-sm text-neutral-400">
              No editable attributes in selection.
            </div>
          }
        >
          <div class="space-y-3">
            <h3 class="text-xs uppercase tracking-wider text-neutral-400">
              Attributes
            </h3>
            <For each={sliderAttributes()}>
              {(attr) => {
                const mode = () => getMode(attr);

                const min = () => getRange(attr, mode()).min;

                const max = () => getRange(attr, mode()).max;

                const value = () => getValue(attr);

                return (
                  <AttributeSlider
                    label={humanizeAttributeName(attr)}
                    mode={mode()}
                    value={value()}
                    min={min()}
                    max={max()}
                    onModeChange={(nextMode) => {
                      setMode(attr, nextMode);
                      const nextRange = getRange(attr, nextMode);
                      setValue(
                        attr,
                        Math.max(
                          nextRange.min,
                          Math.min(nextRange.max, value()),
                        ),
                      );
                    }}
                    onValueChange={(nextValue) => setValue(attr, nextValue)}
                    onCommit={(nextValue) =>
                      sendAttributeValue(attr, nextValue)
                    }
                  />
                );
              }}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  );
}
