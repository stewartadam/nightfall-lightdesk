// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import CommandLine from "../../../features/command-line";

/** Renders the header command input, or a Console button beside Clear when `collapsed`. */
export default function HeaderCommandLine(props: {
  collapsed?: () => boolean;
}) {
  return (
    <CommandLine
      id="header-command-line"
      variant="nav"
      collapsed={props.collapsed}
    />
  );
}
