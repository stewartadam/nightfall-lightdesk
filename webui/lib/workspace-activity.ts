// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { type Accessor, createContext, useContext } from "solid-js";

/** Whether the owning layout workspace is currently presented to the user. */
export const WorkspaceActivityContext = createContext<Accessor<boolean>>(
  () => true,
);

/** Supplies layout visibility to panel work and registrations without unmounting views. */
export function useWorkspaceActivity(): Accessor<boolean> {
  return useContext(WorkspaceActivityContext);
}
