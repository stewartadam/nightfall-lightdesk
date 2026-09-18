// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { BasePanelComponentProps } from "../../../lib/panel-registry";
import { CommandLineView } from "../components/command-line-view";
import { createCommandLineController } from "../controllers/command-line-controller";

interface CommandLineProps extends BasePanelComponentProps {
  variant?: "panel" | "nav";
}

/** Connects the command-line feature controller to its registered panel view. */
function CommandLine(props: CommandLineProps) {
  const variant = props.variant ?? "panel";
  const componentId =
    (props as BasePanelComponentProps & { initialPanelId?: string })
      .initialPanelId ??
    props.id ??
    "command-line";
  const controller = createCommandLineController({ variant, componentId });
  return <CommandLineView controller={controller} />;
}

export default CommandLine;
