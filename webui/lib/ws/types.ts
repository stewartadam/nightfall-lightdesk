// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type * as types from "../../types";
import type * as flowTypes from "../../types/index";

/** Desk command echo message emitted using the websocket envelope shape. */
export type DeskCommandWsMessage = {
  type: "DeskCommand";
  data: types.DeskCommand;
};

/** Step FX definitions are emitted by the backend but are not yet typeshared. */
export type StepFxDefinitionsWsMessage = {
  type: "StepFxDefinitions";
  data: types.StepFx[];
};

/** Timeline-authored side effect consumed by the browser media host. */
export type TimelineAudioDirectiveWsMessage = {
  type: "TimelineAudioDirective";
  data: types.TimelineAudioDirective;
};

/** Commands that can share the websocket message queue type at call sites. */
export type AnyCommand =
  | types.BlueprintCommand
  | types.CueCommand
  | types.DeskCommand
  | types.EngineCommand
  | types.ClipCommand
  | flowTypes.FlowCommand
  | types.FixtureCommand
  | types.FxCommand
  | types.FxModuleCommand
  | types.GroupCommand
  | types.ProgrammerCommand
  | types.SceneObjectCommand
  | types.SettingsCommand
  | types.ControlCommand
  | types.StepFxCommand
  | types.TimecodeCommand
  | types.TimelineCommand
  | types.UndoCommand;

/** Union of websocket payloads handled on the main thread. */
export type AnyWsMessage =
  | types.CueWsMessage
  | types.FixtureWsMessage
  | types.FixtureLibraryWsMessage
  | types.ObjectLibraryWsMessage
  | flowTypes.FlowWsMessage
  | types.DeskWsMessage
  | types.TimelineWsMessage
  | TimelineAudioDirectiveWsMessage
  | types.ProgrammerWsMessage
  | StepFxDefinitionsWsMessage
  | types.FxWsMessage
  | types.FxModuleWsMessage
  | types.TimecodeWsMessage
  | types.TimelineWsMessage
  | types.MidiWsMessage
  | types.OscWsMessage
  | types.EngineClientMessage
  | DeskCommandWsMessage
  | types.SceneObjectWsMessage
  | AnyCommand;
