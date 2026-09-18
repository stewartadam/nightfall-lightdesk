// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { DockviewPanelApi } from "dockview";
import { getLogger } from "../../../lib/logger";
import { usePanelLiveness } from "../../../lib/panel-liveness";
import type { BasePanelComponentProps } from "../../../lib/panel-registry";
import { createSequenceEditorContextValue } from "../context/sequence-editor-context";
import { SequenceEditorController } from "../controllers/sequence-editor-controller";

const log = getLogger(import.meta.url);

export interface SequenceEditorPanelProps extends BasePanelComponentProps {
  initialPanelId: string;
  initialSequenceUid?: string;
  panelApi?: DockviewPanelApi;
}

/** Composes the sequence editor context value with its feature controller. */
export default function SequenceEditorPanel(props: SequenceEditorPanelProps) {
  const panelId = props.initialPanelId ?? props.id;
  const contextValue = createSequenceEditorContextValue(
    props.initialSequenceUid ?? "",
  );
  usePanelLiveness({
    panelId,
    closeWhenDead: true,
    isAlive: () => contextValue.loadingState().status !== "not_found",
  });

  log.trace("mounting SequenceEditorPanel");

  return (
    <SequenceEditorController
      panelId={panelId}
      contextValue={contextValue}
      panelApi={props.panelApi}
    />
  );
}
