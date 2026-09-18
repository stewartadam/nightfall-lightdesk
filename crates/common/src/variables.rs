// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use serde::{Deserialize, Serialize};

/// Runtime value that can be stored in a named show variable.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum VariableValue {
    Integer(i32),
    Float(f32),
    String(String),
}
