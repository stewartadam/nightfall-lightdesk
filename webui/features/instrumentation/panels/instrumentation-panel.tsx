// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { BasePanelComponentProps } from "../../../lib/panel-registry";
import { InstrumentationController } from "../controllers/instrumentation-controller";

interface InstrumentationPanelProps extends BasePanelComponentProps {
  initialPanelId: string;
}

/** Mounts the instrumentation feature coordinator at the registered panel boundary. */
export default function InstrumentationPanel(
  _props: InstrumentationPanelProps,
) {
  return <InstrumentationController />;
}
