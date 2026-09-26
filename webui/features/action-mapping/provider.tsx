// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useStore } from "@nanostores/solid";
import {
  type Accessor,
  createContext,
  createEffect,
  createSignal,
  onCleanup,
  type ParentProps,
  Show,
  useContext,
} from "solid-js";
import { useCommand } from "../../components/providers/command-registry";
import { PersistentToast } from "../../components/ui/persistent-toast";
import { Button } from "../../components/ui/visual-language/button";
import { CommandClient } from "../../lib/command-client";
import { decodeCorrelationId } from "../../lib/console-scrollback";
import {
  connectionStatus,
  EngineRuntimeStatus,
  engineRuntime,
} from "../../lib/engine-runtime";
import { actionCatalog, controllerLearning } from "../../state/appStores";
import { pushToast } from "../../state/notifications";
import {
  ActionInputKind,
  type ActionReference,
  ActionSurface,
  type ControllerLearningCommand,
  type MidiMapping,
  type OscMapping,
} from "../../types";
import "./mapping.css";

interface MappingTarget {
  action: ActionReference;
  label: string;
}

interface MappingContext {
  armed: Accessor<boolean>;
  compatible: (action: ActionReference) => boolean;
  select: (target: MappingTarget) => void;
}

const Context = createContext<MappingContext>();

/** Owns learning interaction while backend bindings remain independent of mounted controls. */
export function ActionMappingProvider(props: ParentProps) {
  const catalog = useStore(actionCatalog);
  const learning = useStore(controllerLearning);
  const [session, setSession] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const [surface, setSurface] = createSignal(ActionSurface.Midi);
  const [conflict, setConflict] = createSignal<MidiMapping | OscMapping>();
  const [target, setTarget] = createSignal<MappingTarget>();
  const client = new CommandClient(engineRuntime);
  let observedSession: string | undefined;

  /** Releases interception when the observed backend session ends or the connection disappears. */
  createEffect(() => {
    const id = session();
    if (!id) {
      observedSession = undefined;
      return;
    }
    if (learning()?.session_id === id) observedSession = id;
    const disconnected = connectionStatus() !== EngineRuntimeStatus.Connected;
    if (
      !disconnected &&
      (observedSession !== id || learning()?.session_id === id)
    )
      return;
    setSession(undefined);
    setConflict(undefined);
    setTarget(undefined);
    setMessage(
      disconnected
        ? "Controller learning ended because the connection closed."
        : "Controller learning ended.",
    );
  });

  /** Submits a learning transition and surfaces its terminal backend failure. */
  async function command(command: ControllerLearningCommand) {
    const result = await client.submitCommand(
      "ControllerLearningCommand",
      command,
    );
    if (result.outcome.type === "Failed")
      throw new Error(result.outcome.data.message);
  }

  /** Starts fresh capture only after the backend has acknowledged learning mode. */
  async function begin(selectedSurface: ActionSurface) {
    if (busy() || session()) return;
    setBusy(true);
    const id = crypto.randomUUID().replace(/-/g, "");
    try {
      await command({
        type: "Begin",
        data: { session_id: id, surface: selectedSurface },
      });
      setSurface(selectedSurface);
      setSession(id);
      setConflict(undefined);
      setTarget(undefined);
      setMessage(
        `Touch ${selectedSurface === ActionSurface.Midi ? "a MIDI" : "an OSC"} control, then select a highlighted action.`,
      );
    } catch (error) {
      pushToast("error", String(error));
    } finally {
      setBusy(false);
    }
  }

  /** Ends suppression and leaves already-saved mappings intact. */
  async function cancel() {
    const id = session();
    if (!id) return;
    try {
      await command({ type: "Cancel", data: { session_id: id } });
      setSession(undefined);
      setConflict(undefined);
      setTarget(undefined);
    } catch (error) {
      setMessage(String(error));
    }
  }

  /** Saves an immutable target with the backend's captured source and explicit replacement. */
  async function save(
    selected: MappingTarget,
    replace?: MidiMapping | OscMapping,
  ) {
    const id = session();
    if (!id || busy()) return;
    setBusy(true);
    try {
      const result =
        surface() === ActionSurface.Midi
          ? await client.submitCommand("MidiCommand", {
              type: "BindLearned",
              data: {
                session_id: id,
                action: selected.action,
                replace: replace as MidiMapping | undefined,
              },
            })
          : await client.submitCommand("OscCommand", {
              type: "BindLearned",
              data: {
                session_id: id,
                action: selected.action,
                replace: replace as OscMapping | undefined,
              },
            });
      if (result.outcome.type === "Failed") {
        const error = result.outcome.data;
        if (
          error.code === "midi.mapping_conflict" ||
          error.code === "osc.mapping_conflict"
        ) {
          const existing = error.details as MidiMapping | OscMapping;
          const normalized = {
            ...existing,
            id: decodeCorrelationId(existing.id) ?? existing.id,
          };
          setConflict(normalized);
        }
        throw new Error(error.message);
      }
      setSession(undefined);
      setConflict(undefined);
      setTarget(undefined);
      pushToast("success", `Mapped to ${selected.label}.`);
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  /** Renews only this provider's session; closing the app lets backend suppression expire. */
  createEffect(() => {
    const id = session();
    if (!id) return;
    const timer = window.setInterval(() => {
      void command({ type: "Heartbeat", data: { session_id: id } }).catch(
        (error) => {
          if (session() !== id) return;
          setMessage(String(error));
          setSession(undefined);
          pushToast("error", String(error));
        },
      );
    }, 4000);
    onCleanup(() => window.clearInterval(timer));
  });

  /** Requests immediate cancellation on unmount, with backend expiry as the disconnect fallback. */
  onCleanup(() => {
    void cancel();
  });

  const context: MappingContext = {
    armed: () => Boolean(session()),
    compatible: (action) =>
      learning()?.session_id === session() &&
      Boolean(learning()?.captured) &&
      catalog().some(
        (descriptor) =>
          descriptor.id === action.id &&
          descriptor.allowed_surfaces.includes(surface()) &&
          (learning()?.captured?.gesture !== "Pulse" ||
            descriptor.input_kind === ActionInputKind.Trigger),
      ),
    select: (value) => {
      if (!context.compatible(value.action)) return;
      const immutable = structuredClone(value);
      setTarget(immutable);
      setConflict(undefined);
      void save(immutable);
    },
  };

  useCommand({
    id: "controller.learn-midi",
    name: "Map MIDI controller",
    description: "Touch a MIDI control, then select an action to map",
    category: "Controller mapping",
    execute: () => void begin(ActionSurface.Midi),
  });
  useCommand({
    id: "controller.learn-osc",
    name: "Map OSC controller",
    description: "Touch an OSC control, then select an action to map",
    category: "Controller mapping",
    execute: () => void begin(ActionSurface.Osc),
  });
  useCommand({
    id: "controller.cancel-learning",
    name: "Cancel controller mapping",
    description: "Exit controller learning mode",
    category: "Controller mapping",
    execute: () => void cancel(),
  });

  return (
    <Context.Provider value={context}>
      {props.children}
      <Show when={session()}>
        <PersistentToast label="Controller mapping">
          <p class="font-semibold mb-2">
            {surface() === ActionSurface.Midi ? "MIDI" : "OSC"} learning active
          </p>
          <p role="status" class="mb-3">
            {learning()?.session_id === session()
              ? learning()?.captured?.label
              : ""}{" "}
            {learning()?.session_id === session()
              ? learning()?.input_diagnostic
              : ""}{" "}
            {message()}
          </p>
          <Button
            size="compact"
            disabled={busy()}
            onClick={() => void cancel()}
          >
            Cancel mapping
          </Button>
          <Show when={conflict()}>
            {(existing) => (
              <Button
                size="compact"
                disabled={busy()}
                onClick={() => {
                  const selected = target();
                  if (selected) void save(selected, existing());
                }}
              >
                Replace existing mapping
              </Button>
            )}
          </Show>
        </PersistentToast>
      </Show>
    </Context.Provider>
  );
}

/** Lets controls accept mapping selection while their normal operation is unavailable. */
export function useActionMappingArmed(): Accessor<boolean> {
  const mapping = useContext(Context);
  return () => mapping?.armed() ?? false;
}

/** Attaches mapping selection to the real control, consuming pointer/keyboard activation while armed. */
export function createActionMappingTarget(target: Accessor<MappingTarget>) {
  const mapping = useContext(Context);
  const [element, setElement] = createSignal<HTMLElement>();

  /** Registers listeners only for this mounted element and refreshes its visual compatibility. */
  createEffect(() => {
    const node = element();
    if (!node || !mapping) return;
    node.dataset.mappingState = mapping.armed()
      ? mapping.compatible(target().action)
        ? "compatible"
        : "waiting"
      : "inactive";
  });

  /** Prevents normal control behavior and selects only on click or keyboard activation. */
  const intercept = (event: Event) => {
    if (!mapping?.armed()) return;
    if (
      event instanceof KeyboardEvent &&
      ![
        "Enter",
        " ",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
      ].includes(event.key)
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (
      event.type === "click" ||
      (event instanceof KeyboardEvent && ["Enter", " "].includes(event.key))
    )
      mapping.select(target());
  };

  /** Moves interception with the mounted element and releases listeners when it changes. */
  createEffect(() => {
    const node = element();
    if (!node || !mapping) return;
    const events = [
      "pointerdown",
      "click",
      "keydown",
      "wheel",
      "input",
      "change",
    ];
    for (const type of events) node.addEventListener(type, intercept, true);
    onCleanup(() => {
      for (const type of events)
        node.removeEventListener(type, intercept, true);
      delete node.dataset.mappingState;
    });
  });

  /** Binds to a native element through the shared component's forwarded ref. */
  return (node: HTMLElement) => {
    setElement(node);
  };
}
