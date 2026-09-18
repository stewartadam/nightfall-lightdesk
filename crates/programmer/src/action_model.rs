// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Programmer-owned user intents and runtime action contracts.

use nightfall::command_types::DmxChannelExpr;
use nightfall::prelude::{
    ElementSelectorExpr, FixtureRangeExpr, SelectionExpr, UnresolvedFixtureRef,
};
use nightfall_dmx::prelude::Attribute;
use nightfall_engine::command_traits;
use nightfall_engine::prelude::{EngineAction, EnginePayload, IngressCommand};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// User-facing commands that the action planner can translate.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, EnginePayload)]
#[serde(tag = "type", content = "data")]
pub enum UserCommand {
    /// User requested a clear operation.
    Clear(ClearCommand),
    /// User requested a release operation.
    Release(ReleaseCommand),
}

impl IngressCommand for UserCommand {}

/// Parsed clear command payload.
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClearCommand {
    /// Ordered clear targets from the user's input.
    pub targets: Vec<ClearTarget>,
    /// Whether the operator explicitly approved selection flattening for the complete plan.
    #[serde(default)]
    pub allow_selection_flatten: bool,
    /// Single-use backend approval proving that an operator confirmed flattening.
    #[serde(default)]
    pub selection_flatten_approval: Option<Uuid>,
}

/// Target specifiers supported by `clear`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum ClearTarget {
    /// Clear active programmer selection.
    Selection,
    /// Clear active programmer values.
    Values,
    /// Clear values for a selection with optional attribute filter.
    Fixture {
        /// Selection to clear.
        selection: SelectionExpr,
        /// Attributes to clear.
        attributes: Vec<Attribute>,
    },
    /// Clear values for attributes across programmer instructions.
    Attribute {
        /// Attributes to clear.
        attributes: Vec<Attribute>,
    },
}

/// Parsed release command payload.
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReleaseCommand {
    /// Optional target for the release command.
    pub target: Option<ReleaseTarget>,
    /// Whether the operator explicitly approved selection flattening for the complete plan.
    #[serde(default)]
    pub allow_selection_flatten: bool,
    /// Single-use backend approval proving that an operator confirmed flattening.
    #[serde(default)]
    pub selection_flatten_approval: Option<Uuid>,
}

/// Target specifiers supported by `release`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum ReleaseTarget {
    /// Release parameter output for a selection.
    Selection(SelectionExpr),
    /// Release programmer values for a selection and optional attributes.
    Fixture {
        /// Selection to release.
        selection: SelectionExpr,
        /// Attributes to release.
        attributes: Vec<Attribute>,
    },
    /// Release programmer values for attributes globally.
    Attribute {
        /// Attributes to release.
        attributes: Vec<Attribute>,
    },
    /// Release DMX channels.
    Channels {
        /// DMX channel expression to release.
        channels: DmxChannelExpr,
    },
}

impl UserCommand {
    /// Returns the same high-level request with selection flattening approved for every planned action.
    pub fn with_selection_flatten_approval(mut self, approval_id: Uuid) -> Self {
        match &mut self {
            Self::Clear(command) => {
                command.allow_selection_flatten = true;
                command.selection_flatten_approval = Some(approval_id);
            }
            Self::Release(command) => {
                command.allow_selection_flatten = true;
                command.selection_flatten_approval = Some(approval_id);
            }
        }
        self
    }

    /// Returns the approval attached to a command that requests flattening permission.
    pub fn selection_flatten_approval(&self) -> Option<Uuid> {
        match self {
            Self::Clear(command) => command.selection_flatten_approval,
            Self::Release(command) => command.selection_flatten_approval,
        }
    }

    /// Returns whether this command asks the planner to bypass flatten confirmation.
    pub fn allows_selection_flatten(&self) -> bool {
        match self {
            Self::Clear(command) => command.allow_selection_flatten,
            Self::Release(command) => command.allow_selection_flatten,
        }
    }
}

/// Scope for actions that can apply globally or to a selection.
#[derive(Debug, Clone, PartialEq)]
pub enum Scope {
    /// Apply to all fixtures/values.
    All,
    /// Apply to a specific selection.
    Selection(SelectionExpr),
}

/// Optional attribute filter for value-clearing actions.
#[derive(Debug, Clone, PartialEq)]
pub enum AttributeFilter {
    /// Apply to all attributes.
    All,
    /// Apply only to listed attributes.
    Only(Vec<Attribute>),
}

impl AttributeFilter {
    /// Build a filter from an attribute list.
    pub fn from_attributes(attributes: &[Attribute]) -> Self {
        if attributes.is_empty() {
            Self::All
        } else {
            Self::Only(attributes.to_vec())
        }
    }
}

/// Programmer runtime actions.
#[derive(Debug, Clone, PartialEq)]
pub enum ProgrammerAction {
    /// Clear active selection.
    ClearSelection,
    /// Clear values according to scope and attribute filter.
    ClearValues {
        /// Scope to clear.
        scope: Scope,
        /// Attribute filter.
        attributes: AttributeFilter,
        /// Whether this action may flatten non-resolved programmer selections.
        allow_selection_flatten: bool,
    },
    /// Release values according to scope and attribute filter.
    ///
    /// This action preserves `release` intent through the runtime pipeline so
    /// programmer handlers can apply confirmation flow before optionally
    /// emitting playback parameter release.
    ReleaseValues {
        /// Scope to release.
        scope: Scope,
        /// Attribute filter.
        attributes: AttributeFilter,
        /// Whether this action may flatten non-resolved programmer selections.
        allow_selection_flatten: bool,
    },
}

impl EnginePayload for ProgrammerAction {}
impl EngineAction for ProgrammerAction {}

fn format_attribute(attribute: &Attribute) -> String {
    let label = attribute.to_string();
    if label.chars().any(char::is_whitespace) {
        format!("\"{label}\"")
    } else {
        label.to_lowercase()
    }
}

fn format_attributes(attributes: &[Attribute]) -> String {
    attributes
        .iter()
        .map(format_attribute)
        .collect::<Vec<_>>()
        .join(" ")
}

fn format_fixture_ref(fixture_ref: &UnresolvedFixtureRef) -> String {
    match fixture_ref.element_index {
        Some(element_index) => format!("{}.{}", fixture_ref.fixture_id, element_index),
        None => fixture_ref.fixture_id.to_string(),
    }
}

fn format_fixture_range_expr(range: &FixtureRangeExpr) -> String {
    if range.start == range.end {
        range.start.to_string()
    } else {
        format!("{}>{}", range.start, range.end)
    }
}

fn format_element_selector_expr(selector: &ElementSelectorExpr) -> String {
    match selector {
        ElementSelectorExpr::Single(index) => index.to_string(),
        ElementSelectorExpr::Range { start, end } => format!("{start}>{end}"),
    }
}

fn format_selection_expr(selection: &SelectionExpr) -> Option<String> {
    match selection {
        SelectionExpr::Fixture(fixture_ref) => Some(format_fixture_ref(fixture_ref)),
        SelectionExpr::FixtureRange { start, end } => Some(format!(
            "{}>{}",
            format_fixture_ref(start),
            format_fixture_ref(end)
        )),
        SelectionExpr::FixtureMap { fixtures, elements } => Some(format!(
            "{} .{}",
            format_fixture_range_expr(fixtures),
            format_element_selector_expr(elements)
        )),
        SelectionExpr::Group(group_ref_expr) => Some(format!("g {}", group_ref_expr)),
        SelectionExpr::Add { lhs, rhs } => Some(format!(
            "{}+{}",
            format_selection_expr(lhs)?,
            format_selection_expr(rhs)?
        )),
        SelectionExpr::Sub { lhs, rhs } => Some(format!(
            "{}-{}",
            format_selection_expr(lhs)?,
            format_selection_expr(rhs)?
        )),
        SelectionExpr::Span(inner) => Some(format!("({})", format_selection_expr(inner)?)),
        SelectionExpr::Spatial(selection) => Some(format!("({selection})")),
        SelectionExpr::Resolved(_) => None,
    }
}

impl UserCommand {
    /// Render this user command into a parser-compatible CLI command string.
    ///
    /// Returns `None` when the command cannot be represented losslessly (for
    /// example, resolved selection lists).
    pub fn to_cli_command(&self) -> Option<String> {
        match self {
            UserCommand::Clear(clear) => {
                if clear.targets.is_empty() {
                    return Some("clear".to_string());
                }

                let targets = clear
                    .targets
                    .iter()
                    .map(|target| -> Option<String> {
                        Some(match target {
                            ClearTarget::Selection => "selection".to_string(),
                            ClearTarget::Values => "values".to_string(),
                            ClearTarget::Fixture {
                                selection,
                                attributes,
                            } => {
                                let selection = format_selection_expr(selection)?;
                                if attributes.is_empty() {
                                    format!("fix {selection}")
                                } else {
                                    format!(
                                        "fix {selection} attr {}",
                                        format_attributes(attributes)
                                    )
                                }
                            }
                            ClearTarget::Attribute { attributes } => {
                                format!("attr {}", format_attributes(attributes))
                            }
                        })
                    })
                    .collect::<Option<Vec<_>>>()?
                    .join(" ");

                Some(format!("clear {targets}"))
            }
            UserCommand::Release(release) => match &release.target {
                None => Some("release".to_string()),
                Some(ReleaseTarget::Selection(selection)) => {
                    Some(format!("release sel {}", format_selection_expr(selection)?))
                }
                Some(ReleaseTarget::Fixture {
                    selection,
                    attributes,
                }) => {
                    let selection = format_selection_expr(selection)?;
                    if attributes.is_empty() {
                        Some(format!("release fix {selection}"))
                    } else {
                        Some(format!(
                            "release fix {selection} attr {}",
                            format_attributes(attributes)
                        ))
                    }
                }
                Some(ReleaseTarget::Attribute { attributes }) => {
                    Some(format!("release attr {}", format_attributes(attributes)))
                }
                Some(ReleaseTarget::Channels { channels }) => {
                    Some(format!("release ch {channels}"))
                }
            },
        }
    }
}

impl command_traits::CliCommand for UserCommand {
    fn to_cli(&self) -> Option<String> {
        self.to_cli_command()
    }
}

#[cfg(test)]
mod tests {
    use nightfall::command_types::{
        DmxChannelExpr, DmxChannelRef, SelectionExpr, UnresolvedFixtureRef,
    };
    use nightfall_dmx::prelude::Attribute;

    use super::{ClearCommand, ClearTarget, ReleaseCommand, ReleaseTarget, UserCommand};

    #[test]
    fn user_command_clear_formats_to_cli() {
        let command = UserCommand::Clear(ClearCommand {
            targets: vec![ClearTarget::Fixture {
                selection: SelectionExpr::Fixture(UnresolvedFixtureRef {
                    fixture_id: 1,
                    element_index: None,
                }),
                attributes: vec![Attribute::Red, Attribute::Blue],
            }],
            allow_selection_flatten: false,
            selection_flatten_approval: None,
        });

        assert_eq!(
            command.to_cli_command().as_deref(),
            Some("clear fix 1 attr red blue")
        );
    }

    #[test]
    fn user_command_release_formats_to_cli() {
        let command = UserCommand::Release(ReleaseCommand {
            target: Some(ReleaseTarget::Channels {
                channels: DmxChannelExpr::Range {
                    start: DmxChannelRef {
                        universe: 1,
                        address: 1,
                    },
                    end: DmxChannelRef {
                        universe: 1,
                        address: 12,
                    },
                },
            }),
            allow_selection_flatten: false,
            selection_flatten_approval: None,
        });

        assert_eq!(
            command.to_cli_command().as_deref(),
            Some("release ch 1.1>1.12")
        );
    }

    #[test]
    fn user_command_with_resolved_selection_has_no_cli_form() {
        let command = UserCommand::Release(ReleaseCommand {
            target: Some(ReleaseTarget::Selection(SelectionExpr::Resolved(vec![]))),
            allow_selection_flatten: false,
            selection_flatten_approval: None,
        });
        assert_eq!(command.to_cli_command(), None);
    }
}
