// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import blueprintsPanel from "../features/blueprints/panels/blueprints.definition";
import clipListPanel from "../features/clips/panels/clip-list.definition";
import colorPathPanel from "../features/color-paths/panels/color-path-panel.definition";
import commandLinePanel from "../features/command-line/panels/command-line.definition";
import cueEditorPanel from "../features/cues/panels/cue-editor.definition";
import cueListPanel from "../features/cues/panels/cue-list.definition";
import dmxUniversePanel from "../features/dmx-universe/panels/dmx-universe.definition";
import fixtureLibraryPanel from "../features/fixture-library/panels/fixture-library.definition";
import fixtureGridPanel from "../features/fixtures/panels/fixtures.definition";
import flowEditorPanel from "../features/flow/panels/flow-editor.definition";
import flowListPanel from "../features/flow/panels/flow-list.definition";
import fxEditorPanel from "../features/fx/panels/fx-editor.definition";
import fxListPanel from "../features/fx/panels/fx-list.definition";
import stepFxEditorPanel from "../features/fx/panels/step-fx-editor.definition";
import groupsPanel from "../features/groups/definition";
import undoStackPanel from "../features/history/definition";
import statusDisplayPanel from "../features/instance-status/panels/instance-status.definition";
import instrumentationPanel from "../features/instrumentation/panels/instrumentation.definition";
import midiInputPanel from "../features/io/midi/definition";
import oscInputPanel from "../features/io/osc/definition";
import ioTransportsPanel from "../features/io/panels/transports.definition";
import layerStackPanel from "../features/layers/panels/layer.definition";
import mastersPanel from "../features/masters/definition";
import objectLibraryPanel from "../features/object-library/library/object-library.definition";
import patchEditorPanel from "../features/patch/panels/patch.definition";
import programmerGridPanel from "../features/programmer/panels/programmer.definition";
import propertiesInspectorPanel from "../features/property-inspector/panels/properties-inspector.definition";
import referencesPanel from "../features/references/definition";
import selectionVisualizerPanel from "../features/selection-visualizer/panels/selection-visualizer.definition";
import sequenceEditorPanel from "../features/sequences/panels/sequence-editor.definition";
import sequenceListPanel from "../features/sequences/panels/sequence-list.definition";
import tapPatternPanel from "../features/tap-pattern/panels/tap-pattern.definition";
import timecodesPanel from "../features/timecode/definition";
import timelinePanel from "../features/timeline/panels/timeline-editor.definition";
import timelinesPanel from "../features/timeline/panels/timeline-list.definition";
import visualizerPanel from "../features/visualizer/panels/visualizer.definition";
import sceneObjectsPanel from "../features/visualizer/scene-objects/panels/scene-objects.definition";

export const PANEL_MODULES = [
  commandLinePanel,
  cueListPanel,
  cueEditorPanel,
  fixtureGridPanel,
  fixtureLibraryPanel,
  objectLibraryPanel,
  fxEditorPanel,
  stepFxEditorPanel,
  fxListPanel,
  flowEditorPanel,
  flowListPanel,
  groupsPanel,
  mastersPanel,
  blueprintsPanel,
  colorPathPanel,
  programmerGridPanel,
  selectionVisualizerPanel,
  referencesPanel,
  patchEditorPanel,
  sceneObjectsPanel,
  sequenceListPanel,
  sequenceEditorPanel,
  clipListPanel,
  statusDisplayPanel,
  tapPatternPanel,
  timelinePanel,
  timecodesPanel,
  timelinesPanel,
  layerStackPanel,
  propertiesInspectorPanel,
  visualizerPanel,
  instrumentationPanel,
  undoStackPanel,
  dmxUniversePanel,
  ioTransportsPanel,
  midiInputPanel,
  oscInputPanel,
] as const;
