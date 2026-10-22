// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { CommandClient } from "./command-client";
import { engineRuntime } from "./engine-runtime";

/**
 * Application-wide command client over the active engine runtime. Use `emit` to send a command
 * without waiting and `invoke` to await its result.
 */
export const commandClient = new CommandClient(engineRuntime);
