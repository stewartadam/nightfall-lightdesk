// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { BasePanelComponentProps } from "../../../lib/panel-registry";
import { TapPatternController } from "../controllers/tap-pattern-controller";

export interface TapPatternPanelProps extends BasePanelComponentProps {
  initialPanelId?: string;
}

/** Mounts the tap-pattern feature coordinator at the registered panel boundary. */
export default function TapPatternPanel(props: TapPatternPanelProps) {
  return <TapPatternController {...props} />;
}
