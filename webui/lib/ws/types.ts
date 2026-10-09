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

/** Values of one fixture in a layer, one record per fixture element keyed by attribute. */
export interface LayerFixtureValues<T> {
  fixture_uid: string;
  parameters: Record<string, T>[];
}

/** Asserted parameter values of one fixture in a layer. */
export type LayerElementParameterValues =
  LayerFixtureValues<types.ParameterValue>;
/** Computed absolute output values of one fixture in a layer. */
export type LayerElementComputedState = LayerFixtureValues<number>;
/** Transition-active flags of one fixture's computed values in a layer. */
export type LayerElementTransitionState = LayerFixtureValues<boolean>;

/**
 * One layer of the layer stack as the main thread receives it, after `ParameterStateDecoder`
 * resolved the backend's slot-indexed values against the parameter layout.
 */
export type LayerState = Omit<
  types.OutboundLayerState,
  | "asserted_absolute"
  | "asserted_relative"
  | "lookahead_asserted"
  | "computed_slots"
  | "computed_values"
  | "transitioning_slots"
> & {
  /** Asserted absolute parameter values for this layer, grouped by fixture element. */
  asserted_absolute_values: LayerElementParameterValues[];
  /** Asserted relative parameter values for this layer, grouped by fixture element. */
  asserted_relative_values: LayerElementParameterValues[];
  /** Backend-owned lookahead assertions, grouped by fixture element. */
  lookahead_asserted_values: LayerElementParameterValues[];
  /** Computed absolute parameter values for this layer, grouped by fixture element. */
  computed_values: LayerElementComputedState[];
  /** Transition-active flags for computed parameter values in this layer. */
  computed_transitioning: LayerElementTransitionState[];
};

/** Layer stack as the main thread receives it, lowest priority layer first. */
export type LayerStackWsMessage = {
  type: "LayerStack";
  data: LayerState[];
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
  | Exclude<types.DeskWsMessage, { type: "LayerStack" }>
  | LayerStackWsMessage
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
