// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Display label metadata.

use crate::parser::analysis::TokenId;
use crate::slots::contracts::SlotId;

/// Optional display label for a canonical token.
pub fn token_label(token: TokenId) -> Option<&'static str> {
    match token {
        TokenId::ThreeD => Some("3D Visualizer Position"),
        _ => None,
    }
}

/// Optional display label for a slot.
pub fn slot_label(slot_id: SlotId) -> Option<&'static str> {
    match slot_id {
        SlotId::SelectionType => Some("Selection Head"),
        SlotId::SelectionIdentifier => Some("Identifier"),
        SlotId::SetAttrValue | SlotId::StoreFixtureOffsetValue => Some("Value"),
        SlotId::ReleaseChannelExpr => Some("DMX Expression"),
        SlotId::ChannelOverrideValue => Some("DMX Value"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{slot_label, token_label};
    use crate::parser::analysis::TokenId;
    use crate::slots::contracts::SlotId;

    #[test]
    fn resolves_token_labels() {
        assert_eq!(token_label(TokenId::ThreeD), Some("3D Visualizer Position"));
        assert_eq!(token_label(TokenId::Fx), None);
    }

    #[test]
    fn resolves_slot_labels() {
        assert_eq!(slot_label(SlotId::SelectionType), Some("Selection Head"));
        assert_eq!(slot_label(SlotId::SetAttrAttribute), None);
    }
}
