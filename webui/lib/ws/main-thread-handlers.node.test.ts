// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { AnyWsMessage } from "./types";

/** Every websocket message type the main thread consumes from the backend. */
const HANDLED_MESSAGE_TYPES: AnyWsMessage["type"][] = [
  "ActionCatalog",
  "ActionInvocationFailed",
  "ActiveInstances",
  "AppState",
  "AttributeMetadata",
  "AudioInputDevices",
  "AvailableAudioDevices",
  "AvailableNetworkInterfaces",
  "AvailableUsbDmxDevices",
  "BeatgridDetectionFailed",
  "BeatgridDetectionReady",
  "BeatgridDetectionStarted",
  "RouteValidationSettings",
  "Routes",
  "BlueprintDefinitions",
  "BlueprintDependencies",
  "BoardDefinitions",
  "BoardStates",
  "ClientActionInvocation",
  "ClipCommand",
  "ClipDefinitions",
  "ColorPathDefaults",
  "ColorPathDefinitions",
  "CommandNotice",
  "CommandResult",
  "ControllerMappingMode",
  "Controls",
  "CueCommand",
  "CueDefinitionRemoved",
  "CueDefinitionUpdated",
  "CueDefinitions",
  "CueDurationProfileRemoved",
  "CueDurationProfileUpdated",
  "CueDurationProfiles",
  "DeskCommand",
  "DmxUniverseChannels",
  "DmxUniverseList",
  "ExternalControlState",
  "FixtureCommand",
  "FixtureDefinitions",
  "FixtureGeometries",
  "FlowAck",
  "FlowCommand",
  "FlowDefinitions",
  "FlowDelta",
  "FlowNodeTemplates",
  "FlowPortValueDelta",
  "FlowSnapshot",
  "FlowTriggerDelta",
  "FxDefinitions",
  "FxModuleDefinitions",
  "GetFixtureProfileResponse",
  "GetObjectProfileResponse",
  "GroupDefinitions",
  "InputContributionTrace",
  "IoSettings",
  "LayerStack",
  "ListAvailableFixturesResponse",
  "ListAvailableFxModulesResponse",
  "ListAvailableObjectsResponse",
  "MasterDefinitions",
  "Metrics",
  "MidiControlTouched",
  "MidiDeviceList",
  "MidiDeviceProfiles",
  "MidiLastEvent",
  "MidiMappingDiagnostics",
  "MidiMappings",
  "NetworkInterfaceStatus",
  "ObjectLibraryCommand",
  "OscControlTouched",
  "OscExternalEval",
  "OscLastEvent",
  "OscListenerStatus",
  "OscMappingDiagnostics",
  "OscMappings",
  "OscSources",
  "ParameterState",
  "ProgrammerSelection",
  "ProgrammerSpatialSelection",
  "ProgrammerState",
  "ReferenceHealth",
  "ReferenceList",
  "ReferenceListUpdate",
  "ResyncComplete",
  "RuntimeCapabilities",
  "SceneObjectCommand",
  "SceneObjectDefinitions",
  "SequenceDefinitionRemoved",
  "SequenceDefinitionUpdated",
  "SequenceDefinitions",
  "SequenceLookaheadStates",
  "ServerVersion",
  "Settings",
  "StepFxDefinitions",
  "TelemetryState",
  "TempoState",
  "TimecodeDefinitions",
  "TimelineAudioDirective",
  "TimelineCommand",
  "TimelineDefinitions",
  "TimelineLookaheadActionStatuses",
  "TimelineRecordingPreviews",
  "TimelineRecordingStates",
  "UiNotification",
  "UndoState",
  "WorldReplaced",
];

/**
 * Builds the production registry with inert runtime session callbacks. The
 * browser demo audio host, reached through the timeline handlers, constructs
 * an `Audio` element on import, so a minimal stand-in is installed first.
 */
async function createRegistry() {
  globalThis.Audio ??= class extends EventTarget {} as unknown as typeof Audio;
  const { createMainThreadMessageHandlerRegistry } = await import(
    "./main-thread-handlers"
  );
  return createMainThreadMessageHandlerRegistry({
    session: {
      resyncGeneration: () => 0,
      markResyncComplete: () => {},
      setBackendAppState: () => {},
      requestBackendSessionState: () => {},
      sendDmxUniverseWatch: () => {},
      sendReferenceListWatch: () => {},
    },
  });
}

/** Verifies every consumed backend message type reaches a domain handler instead of the unknown-type fallback. */
test("main-thread registry handles every consumed websocket message type", async () => {
  const registry = await createRegistry();
  const missing = HANDLED_MESSAGE_TYPES.filter((type) => !registry.has(type));

  assert.deepEqual(missing, []);
});
