// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Adapts general object references and identities to clip playback contracts.

use nightfall::prelude::{ObjectIdentity, ObjectRef, ObjectType};

use crate::{ClipSourceRef, Source};

impl From<&ClipSourceRef> for ObjectRef {
    /// Expresses a numeric clip source address in the shared object namespace.
    fn from(reference: &ClipSourceRef) -> Self {
        let (object_type, id) = match reference {
            ClipSourceRef::Sequence(id) => (ObjectType::Sequence, *id),
            ClipSourceRef::Fx(id) => (ObjectType::Fx, *id),
            ClipSourceRef::StepFx(id) => (ObjectType::StepFx, *id),
            ClipSourceRef::Flow(id) => (ObjectType::Flow, *id),
            ClipSourceRef::FxModule(id) => (ObjectType::FxModule, *id),
        };
        Self::ById { object_type, id }
    }
}

/// An object identity whose kind cannot be assigned as clip playback.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UnsupportedClipSource(pub ObjectType);

impl TryFrom<ObjectIdentity> for Source {
    type Error = UnsupportedClipSource;

    /// Accepts only object kinds for which clips support playback.
    fn try_from(identity: ObjectIdentity) -> Result<Self, Self::Error> {
        let uid = identity.uid;
        match identity.object_type {
            ObjectType::Sequence => Ok(Self::Sequence(uid)),
            ObjectType::Fx => Ok(Self::Fx(uid)),
            ObjectType::StepFx => Ok(Self::StepFx(uid)),
            ObjectType::Flow => Ok(Self::Flow(uid)),
            ObjectType::FxModule => Ok(Self::FxModule(uid)),
            other => Err(UnsupportedClipSource(other)),
        }
    }
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use super::*;

    /// A resolved object does not automatically qualify as a clip playback source.
    #[test]
    fn source_conversion_rejects_non_playback_objects() {
        let identity = ObjectIdentity {
            object_type: ObjectType::Group,
            uid: Uuid::new_v4(),
        };
        assert!(matches!(
            Source::try_from(identity),
            Err(UnsupportedClipSource(ObjectType::Group))
        ));
    }
}
