// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { createSignal, For } from "solid-js";
import { Input } from "../components/ui/form-controls";
import { ToggleSwitch } from "../components/ui/toggle-switch";
import { Button } from "../components/ui/visual-language/button";
import { pushToast, type ToastLevel } from "../state/appStores";

const examples: { level: ToastLevel; label: string; message: string }[] = [
  {
    level: "info",
    label: "Information",
    message: "Preview is ready. Choose a cue to continue.",
  },
  {
    level: "success",
    label: "Success",
    message: "Sample workspace saved successfully.",
  },
  {
    level: "warning",
    label: "Warning",
    message: "Some sample fixtures are unpatched.",
  },
  {
    level: "error",
    label: "Error",
    message: "Sample export failed. Try again.",
  },
];

/** Exercises the application's typed toast service with severity, duration, stacking, and custom text. */
export function ToastDemo() {
  const [message, setMessage] = createSignal("");
  const [persistent, setPersistent] = createSignal(false);
  const [actionNotice, setActionNotice] = createSignal(
    "Action examples use local sample state.",
  );
  return (
    <section class="properties lab-panel" aria-label="Toast examples">
      <div class="eyebrow">TOAST NOTIFICATIONS</div>
      <h2>Feedback without losing your place.</h2>
      <label class="demo-input-label">
        Custom message
        <Input
          density="comfortable"
          placeholder="Use the sample messages"
          value={message()}
          onInput={(event) => setMessage(event.currentTarget.value)}
        />
      </label>
      <ToggleSwitch
        label="Keep until dismissed"
        ariaLabel="Keep until dismissed"
        checked={persistent()}
        onChange={setPersistent}
      />
      <div class="property-section button-samples">
        <For each={examples}>
          {(example) => (
            <Button
              onClick={() =>
                pushToast(
                  example.level,
                  message().trim() || example.message,
                  persistent() ? -1 : 4000,
                )
              }
            >
              <span class="toast-demo-dot" data-level={example.level} />
              {example.label}
            </Button>
          )}
        </For>
      </div>
      <p class="field-help">
        Notifications stack at the top right. Hover pauses dismissal; the close
        button dismisses each one. Default duration is four seconds.
      </p>
      <div class="property-section">
        <div class="section-label">Notifications with actions</div>
        <div class="button-samples">
          <Button
            onClick={() =>
              pushToast(
                "info",
                "Notifications may include alerts, sounds and icon badges.",
                -1,
                [
                  {
                    label: "Don't allow",
                    onClick: () =>
                      setActionNotice("Sample notifications declined."),
                  },
                  {
                    label: "Allow",
                    onClick: () =>
                      setActionNotice("Sample notifications allowed."),
                  },
                ],
                { title: "App notifications", icon: BellIcon },
              )
            }
          >
            Show notification prompt
          </Button>
          <Button
            onClick={() => {
              setActionNotice("Sample cue removed.");
              pushToast("success", "Sample cue removed.", -1, [
                {
                  label: "Undo",
                  onClick: () => setActionNotice("Sample cue restored."),
                },
              ]);
            }}
          >
            Show undo toast
          </Button>
          <Button
            onClick={() =>
              pushToast("error", "Sample export failed.", -1, [
                {
                  label: "Retry",
                  onClick: () => setActionNotice("Sample export retried."),
                },
                {
                  label: "Details",
                  dismissOnClick: false,
                  onClick: () =>
                    setActionNotice("Sample details: destination unavailable."),
                },
              ])
            }
          >
            Show retry toast
          </Button>
        </div>
        <p class="field-help">
          Action examples stay visible until dismissed. Undo and Retry dismiss
          their toast; Details keeps it open.
        </p>
        <p class="field-help" role="status">
          {actionNotice()}
        </p>
      </div>
    </section>
  );
}

import { BellIcon } from "@squidlab/phosphor-solid/bell";
