// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Alias canonicalization metadata.

/// Rule-gated alias canonicalization switches.
///
/// This stays as a set of independent flags rather than a single enum because
/// alias resolution may need to combine scopes in the future, even though
/// current production call sites only enable one contextual scope at a time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct AliasCanonicalizationContext {
    pub attribute_context: bool,
    pub selection_or_object_context: bool,
    pub duration_context: bool,
    pub action_context: bool,
    pub identifier_context: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
/// Declares which parsing contexts may treat an alias spelling as valid.
enum AliasScope {
    Always,
    Attribute,
    SelectionOrObject,
    Duration,
    Action,
    Identifier,
}

impl AliasScope {
    /// Returns whether this alias scope is active for the current canonicalization context.
    fn applies_to(self, context: AliasCanonicalizationContext) -> bool {
        match self {
            AliasScope::Always => true,
            AliasScope::Attribute => context.attribute_context,
            AliasScope::SelectionOrObject => context.selection_or_object_context,
            AliasScope::Duration => context.duration_context,
            AliasScope::Action => context.action_context,
            AliasScope::Identifier => context.identifier_context,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
/// Maps accepted alias spellings onto a canonical token within a given scope.
struct AliasSpec {
    canonical: &'static str,
    aliases: &'static [&'static str],
    scope: AliasScope,
}

const ALIAS_SPECS: &[AliasSpec] = &[
    AliasSpec {
        canonical: "priority",
        aliases: &["prio"],
        scope: AliasScope::Always,
    },
    AliasSpec {
        canonical: "rm",
        aliases: &["delete", "del"],
        scope: AliasScope::Always,
    },
    AliasSpec {
        canonical: "rename",
        aliases: &["mv"],
        scope: AliasScope::Always,
    },
    AliasSpec {
        canonical: ">",
        aliases: &["thru", "t"],
        scope: AliasScope::Identifier,
    },
    AliasSpec {
        canonical: "s",
        aliases: &["sec", "seconds"],
        scope: AliasScope::Duration,
    },
    AliasSpec {
        canonical: "start",
        aliases: &["on"],
        scope: AliasScope::Action,
    },
    AliasSpec {
        canonical: "stop",
        aliases: &["off"],
        scope: AliasScope::Action,
    },
    AliasSpec {
        canonical: "fixture",
        aliases: &["fix", "f"],
        scope: AliasScope::SelectionOrObject,
    },
    AliasSpec {
        canonical: "group",
        aliases: &["grp", "g"],
        scope: AliasScope::SelectionOrObject,
    },
    AliasSpec {
        canonical: "parameter",
        aliases: &["param", "p"],
        scope: AliasScope::SelectionOrObject,
    },
    AliasSpec {
        canonical: "clip",
        aliases: &["exec", "e"],
        scope: AliasScope::SelectionOrObject,
    },
    AliasSpec {
        canonical: "sequence",
        aliases: &["seq", "s"],
        scope: AliasScope::SelectionOrObject,
    },
    AliasSpec {
        canonical: "path",
        aliases: &[
            "color-path",
            "colour-path",
            "colorpath",
            "colourpath",
            "color_path",
            "colour_path",
        ],
        scope: AliasScope::SelectionOrObject,
    },
    AliasSpec {
        canonical: "timecode",
        aliases: &["tc"],
        scope: AliasScope::SelectionOrObject,
    },
    AliasSpec {
        canonical: "timeline",
        aliases: &["tl"],
        scope: AliasScope::SelectionOrObject,
    },
    AliasSpec {
        canonical: "blueprint",
        aliases: &["bp"],
        scope: AliasScope::SelectionOrObject,
    },
    AliasSpec {
        canonical: "channel",
        aliases: &["chan", "ch"],
        scope: AliasScope::SelectionOrObject,
    },
    AliasSpec {
        canonical: "values",
        aliases: &["val"],
        scope: AliasScope::Always,
    },
    AliasSpec {
        canonical: "selected",
        aliases: &["selection", "sel"],
        scope: AliasScope::Always,
    },
    AliasSpec {
        canonical: "cue",
        aliases: &["c"],
        scope: AliasScope::SelectionOrObject,
    },
    AliasSpec {
        canonical: "int",
        aliases: &["intensity", "i"],
        scope: AliasScope::Attribute,
    },
    AliasSpec {
        canonical: "red",
        aliases: &["r"],
        scope: AliasScope::Attribute,
    },
    AliasSpec {
        canonical: "green",
        aliases: &["g"],
        scope: AliasScope::Attribute,
    },
    AliasSpec {
        canonical: "blue",
        aliases: &["b"],
        scope: AliasScope::Attribute,
    },
    AliasSpec {
        canonical: "white",
        aliases: &["w"],
        scope: AliasScope::Attribute,
    },
];

fn canonical_alias_for(
    raw: &str,
    context_filter: impl Fn(AliasScope) -> bool,
) -> Option<&'static str> {
    let lower = raw.to_ascii_lowercase();
    for spec in ALIAS_SPECS {
        if !context_filter(spec.scope) {
            continue;
        }
        if spec.aliases.iter().any(|alias| lower == *alias) {
            return Some(spec.canonical);
        }
    }
    None
}

/// Canonicalize a token-like string using shared lexicon alias metadata.
pub fn canonicalize_token(raw: &str, context: AliasCanonicalizationContext) -> String {
    canonical_alias_for(raw, |scope| scope.applies_to(context))
        .unwrap_or(raw)
        .to_ascii_lowercase()
}

/// Resolve a raw alias spelling without applying any context gating.
pub fn canonicalize_alias_any_scope(raw: &str) -> Option<&'static str> {
    canonical_alias_for(raw, |_| true)
}

/// Return true when any known alias of `canonical_token` matches `prefix`.
pub fn canonical_token_has_alias_prefix(canonical_token: &str, prefix: &str) -> bool {
    let canonical_lower = canonical_token.to_ascii_lowercase();
    ALIAS_SPECS.iter().any(|spec| {
        spec.canonical == canonical_lower
            && spec.aliases.iter().any(|alias| alias.starts_with(prefix))
    })
}

#[cfg(test)]
mod tests {
    use super::{
        AliasCanonicalizationContext, canonical_token_has_alias_prefix,
        canonicalize_alias_any_scope, canonicalize_token,
    };

    #[test]
    fn canonicalizes_global_aliases() {
        let context = AliasCanonicalizationContext::default();
        assert_eq!(canonicalize_token("del", context), "rm");
        assert_eq!(canonicalize_token("prio", context), "priority");
    }

    #[test]
    fn canonicalizes_contextual_aliases() {
        let selection_context = AliasCanonicalizationContext {
            selection_or_object_context: true,
            ..AliasCanonicalizationContext::default()
        };
        let attribute_context = AliasCanonicalizationContext {
            attribute_context: true,
            ..AliasCanonicalizationContext::default()
        };
        let duration_context = AliasCanonicalizationContext {
            duration_context: true,
            ..AliasCanonicalizationContext::default()
        };
        let action_context = AliasCanonicalizationContext {
            action_context: true,
            ..AliasCanonicalizationContext::default()
        };
        let identifier_context = AliasCanonicalizationContext {
            identifier_context: true,
            ..AliasCanonicalizationContext::default()
        };

        assert_eq!(canonicalize_token("g", selection_context), "group");
        assert_eq!(canonicalize_token("g", attribute_context), "green");
        assert_eq!(canonicalize_token("seconds", duration_context), "s");
        assert_eq!(canonicalize_token("on", action_context), "start");
        assert_eq!(canonicalize_token("t", identifier_context), ">");
    }

    #[test]
    fn preserves_unmapped_tokens() {
        let context = AliasCanonicalizationContext::default();
        assert_eq!(canonicalize_token("patch", context), "patch");
    }

    #[test]
    fn matches_alias_prefix_for_canonical_token() {
        assert!(canonical_token_has_alias_prefix("fixture", "fi"));
        assert!(canonical_token_has_alias_prefix("fixture", "f"));
        assert!(canonical_token_has_alias_prefix("s", "sec"));
        assert!(!canonical_token_has_alias_prefix("fixture", "x"));
    }

    #[test]
    fn resolves_context_free_alias_inventory() {
        assert_eq!(canonicalize_alias_any_scope("val"), Some("values"));
        assert_eq!(canonicalize_alias_any_scope("selection"), Some("selected"));
        assert_eq!(canonicalize_alias_any_scope("intensity"), Some("int"));
    }
}
