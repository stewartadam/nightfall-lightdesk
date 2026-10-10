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

/** Decoded output and asserted values of one fixture element, keyed by attribute. */
export interface ElementParameterState {
  /** Absolute parameter values asserted by objects in the layer stack. */
  absolute: Record<string, types.ParameterValue>;
  /** Relative parameter values asserted by objects in the layer stack. */
  relative: Record<string, types.ParameterValue>;
  /** Final computed output values after compositing and fixture processing. */
  output: Record<string, number>;
}

/** Decoded parameter state of one fixture, one entry per fixture element. */
export interface FixtureParameterState {
  fixture_uid: string;
  parameters: ElementParameterState[];
}

/**
 * Parameter state as the main thread receives it, after the worker and
 * `ParameterStateDecoder` resolved the backend's slot-indexed values frame.
 */
export type ParameterStateWsMessage = {
  type: "ParameterState";
  data: FixtureParameterState[];
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
  | Exclude<types.FixtureWsMessage, { type: "ParameterState" }>
  | ParameterStateWsMessage
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
  | types.ActionsWsMessage
  | types.EngineClientMessage
  | DeskCommandWsMessage
  | types.SceneObjectWsMessage
  | AnyCommand;
