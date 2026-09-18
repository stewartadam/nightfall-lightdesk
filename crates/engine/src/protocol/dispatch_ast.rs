// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::{any::TypeId, sync::RwLock};

use nightfall_cmd_parse::ast;
use once_cell::sync::Lazy;
use thiserror::Error;

use crate::protocol::erased::DynEnginePayload;

/// Converter function type:
/// - Accepts a borrowed AST and returns boxed engine commands.
/// - `Ok(cmds)` means "handled" (cmds may be empty if that's meaningful for you).
/// - `Err(msg)` means "I matched this AST but conversion failed".
///
/// If you need "not applicable, try next", use `DispatchError::NotApplicable` (below).
pub type AstConverterFn = fn(&ast::CommandAst) -> Result<Vec<DynEnginePayload>, DispatchError>;

/// Stored entry: (TypeId, converter fn pointer)
static CONVERTERS: Lazy<RwLock<Vec<(TypeId, AstConverterFn)>>> =
    Lazy::new(|| RwLock::new(Vec::new()));

/// Reason an AST converter failed, declined, or could not be found.
#[derive(Debug, Error)]
pub enum DispatchError {
    /// Converter matched but failed to convert.
    #[error("conversion failed: {0}")]
    ConversionFailed(String),

    /// Converter did not apply to this AST; dispatcher should try the next one.
    #[error("not applicable")]
    NotApplicable,

    /// No converter handled the AST.
    #[error("unhandled AST")]
    Unhandled,
}

/// Generic “common handler” that delegates to `T`’s implementation.
///
/// Domain crates implement `AstConvert` for their marker type `T` (often the plugin type),
/// then register `T` once.
pub trait AstConvert: 'static {
    fn convert(ast: &ast::CommandAst) -> Result<Vec<DynEnginePayload>, DispatchError>;
}

/// Common adapter used for all `T: AstConvert`.
fn convert_typed<T: AstConvert>(
    ast: &ast::CommandAst,
) -> Result<Vec<DynEnginePayload>, DispatchError> {
    T::convert(ast)
}

/// Register a converter for `T` using the common typed adapter.
///
/// Domain crates call: `register_converter::<MyDomainPlugin>();`
pub fn register_converter<T: AstConvert>() {
    let type_id = TypeId::of::<T>();
    let mut guard = CONVERTERS.write().expect("ast dispatch lock poisoned");
    guard.push((type_id, convert_typed::<T> as AstConverterFn));
}

/// Remove all converters (useful for tests).
pub fn clear_converters() {
    let mut guard = CONVERTERS.write().expect("ast dispatch lock poisoned");
    guard.clear();
}

/// Dispatch the AST to registered converters in registration order.
///
/// - Returns `Ok(cmds)` from the first converter that applies and succeeds.
/// - Returns `Err(ConversionFailed(..))` from the first converter that applies and fails.
/// - Skips converters that return `NotApplicable`.
/// - Returns `Err(Unhandled)` if none apply.
pub fn dispatch_ast(ast: &ast::CommandAst) -> Result<Vec<DynEnginePayload>, DispatchError> {
    let guard = CONVERTERS.read().expect("ast dispatch lock poisoned");

    for (type_id, conv) in guard.iter() {
        match conv(ast) {
            Ok(cmds) => return Ok(cmds),
            Err(DispatchError::NotApplicable) => continue,
            Err(DispatchError::ConversionFailed(e)) => {
                return Err(DispatchError::ConversionFailed(format!(
                    "{:?}: {}",
                    type_id, e
                )));
            }
            Err(e) => {
                // Preserve any other error variants with type context
                return Err(DispatchError::ConversionFailed(format!(
                    "{:?}: {}",
                    type_id, e
                )));
            }
        }
    }

    Err(DispatchError::Unhandled)
}

/// Return a list of registered converter TypeIds (useful for debug introspection).
pub fn registered_converters() -> Vec<TypeId> {
    CONVERTERS
        .read()
        .expect("ast dispatch lock poisoned")
        .iter()
        .map(|(id, _)| *id)
        .collect()
}
