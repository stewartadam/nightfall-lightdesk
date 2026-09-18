// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { FileTextIcon } from "@squidlab/phosphor-solid/file-text";
import { QuestionIcon } from "@squidlab/phosphor-solid/question";
import { onMount } from "solid-js";
import { openFeedbackPage } from "../../../../lib/feedback";
import { useAppShell } from "../../../providers/app-shell";
import { useCommand } from "../../../providers/command-registry";

/** Makes project feedback and local diagnostics discoverable through shell search. */
export default function FeedbackCommands() {
  const { openDiagnostics } = useAppShell();
  /** Registers feedback actions for this mounted application shell. */
  onMount(() => {
    useCommand({
      id: "app.feedback",
      name: "Give Feedback",
      description: "Share an idea or feedback on GitHub",
      icon: QuestionIcon,
      execute: () => openFeedbackPage("feedback"),
    });
    useCommand({
      id: "app.report-bug",
      name: "Report a Bug",
      description: "Describe a problem on GitHub",
      icon: QuestionIcon,
      execute: () => openFeedbackPage("bug"),
    });
    useCommand({
      id: "app.diagnostics",
      name: "Collect Diagnostics",
      description: "Preview, copy, or download a local diagnostic report",
      icon: FileTextIcon,
      execute: openDiagnostics,
    });
  });
  return null;
}
