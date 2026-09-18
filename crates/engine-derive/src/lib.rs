// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Derive macros for the nightfall engine command system.
//!
//! Provides `#[derive(EnginePayload)]` for implementing the `EnginePayload` trait
//! with automatic module name derivation.
//!
//! # Example
//!
//! ```ignore
//! use nightfall_engine_derive::EnginePayload;
//!
//! // Uses "FixtureCommand" as the module name (type name)
//! #[derive(EnginePayload)]
//! pub enum FixtureCommand {
//!     Store { /* ... */ },
//!     Delete(u32),
//! }
//!
//! // Override with a custom module name
//! #[derive(EnginePayload)]
//! #[command_module = "custom_module"]
//! pub enum MyCommand {
//!     DoSomething,
//! }
//! ```

use proc_macro::TokenStream;
use proc_macro_crate::{FoundCrate, crate_name};
use proc_macro2::Span;
use quote::quote;
use syn::{DeriveInput, Lit, Meta, parse_macro_input, parse_quote};

/// Derive macro for implementing `EnginePayload` trait.
///
/// By default, the command module name is derived from the type name.
/// Use `#[command_module = "name"]` to override this.
#[proc_macro_derive(EnginePayload, attributes(command_module))]
pub fn derive_engine_payload(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);
    let name = &input.ident;
    let engine_crate = engine_crate_path();

    // Look for #[command_module = "..."] attribute
    let module_name = input
        .attrs
        .iter()
        .find_map(|attr| {
            if !attr.path().is_ident("command_module") {
                return None;
            }

            match &attr.meta {
                Meta::NameValue(nv) => {
                    if let syn::Expr::Lit(expr_lit) = &nv.value {
                        if let Lit::Str(lit_str) = &expr_lit.lit {
                            return Some(lit_str.value());
                        }
                    }
                    None
                }
                _ => None,
            }
        })
        .unwrap_or_else(|| name.to_string());

    let expanded = quote! {
        impl #engine_crate::protocol::engine_command::EnginePayload for #name {}

        impl #engine_crate::protocol::engine_command::EngineIngressMeta for #name {
            const COMMAND_MODULE: &'static str = #module_name;
        }
    };

    TokenStream::from(expanded)
}

fn engine_crate_path() -> syn::Path {
    match crate_name("nightfall-engine") {
        Ok(FoundCrate::Itself) => parse_quote!(crate),
        Ok(FoundCrate::Name(name)) => {
            let ident = syn::Ident::new(&name, Span::call_site());
            parse_quote!(::#ident)
        }
        Err(_) => parse_quote!(::nightfall_engine),
    }
}
