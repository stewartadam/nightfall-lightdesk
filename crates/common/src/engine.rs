// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Foundational contracts for type-erased engine payloads.

use std::any::Any;
use std::fmt::Debug;

/// Provides object-safe access to a payload's concrete type.
pub trait AsAny: 'static {
    /// Borrows this value as `Any` for immutable downcasting.
    fn as_any(&self) -> &dyn Any;

    /// Borrows this value as `Any` for mutable downcasting.
    fn as_any_mut(&mut self) -> &mut dyn Any;

    /// Converts an owned trait object into `Any` for owned downcasting.
    fn into_any(self: Box<Self>) -> Box<dyn Any>;
}

impl<T: 'static + Any> AsAny for T {
    /// Borrows this concrete value through the object-safe downcasting surface.
    fn as_any(&self) -> &dyn Any {
        self
    }

    /// Mutably borrows this concrete value through the object-safe downcasting surface.
    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }

    /// Converts this boxed concrete value into an owned downcasting surface.
    fn into_any(self: Box<Self>) -> Box<dyn Any> {
        self
    }
}

/// Marks payloads that can cross type-erased engine routing boundaries.
pub trait EnginePayload: AsAny + Send + Sync + Debug + 'static {}

/// Supplies the stable module name used to deserialize an ingress payload.
pub trait EngineIngressMeta {
    /// Command module name used by the ingress deserializer registry.
    const COMMAND_MODULE: &'static str;
}

/// Marks payloads accepted at a user or protocol ingress boundary.
pub trait IngressCommand: EnginePayload {}

/// Marks concrete internal runtime work owned by a domain.
pub trait EngineAction: EnginePayload {}
