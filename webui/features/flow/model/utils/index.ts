// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Flow editor utilities.
 */

export {
  attributeLabelToHsv,
  formatColorHex,
  parseHexColor,
  rgbToAttributeLabel,
} from "../../../../lib/color-utils";
export {
  buildNodeDimensions,
  calculateBestLayout,
  centerToTopLeft,
} from "./autoLayout";

export {
  buildConnectedInputsSet,
  buildDeleteNodeOps,
  copyNodeToClipboard,
  duplicateNodeDefinition,
  edgeDefinitionFromId,
  edgeIdForDefinition,
  getNextNodeId,
  readNodeFromClipboard,
  toPortRef,
} from "./nodeOperations";

export {
  portColorHex,
  portHandleId,
  portTypeLabel,
} from "./portUtils";

export {
  DEFAULT_WAVEFORM,
  resolveAttributeValue,
  resolveBoolValue,
  resolveNumberValue,
  resolveSelectionValue,
  resolveStringValue,
  resolveWaveformValue,
} from "./portValueResolvers";

export {
  formatFlowValueLabel,
  formatNodeKindLabel,
} from "./valueFormatting";
