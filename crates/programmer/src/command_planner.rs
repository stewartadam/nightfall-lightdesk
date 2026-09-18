// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Planning from programmer-owned user intents into concrete domain actions.

use nightfall_engine::prelude::EngineAction;
use nightfall_fixtures::DmxAction;

use crate::action_model::{
    AttributeFilter, ClearCommand, ClearTarget, ProgrammerAction, ReleaseCommand, ReleaseTarget,
    Scope, UserCommand,
};

/// One concrete domain action erased only for heterogeneous plan storage.
pub type PlannedEngineAction = Box<dyn EngineAction>;

/// Erases a concrete domain action after planning has selected its type.
fn planned<A: EngineAction>(action: A) -> PlannedEngineAction {
    Box::new(action)
}

/// Runtime state needed while planning actions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProgrammerPlanContext {
    /// True when the active programmer selection is empty.
    pub active_selection_is_empty: bool,
}

impl Default for ProgrammerPlanContext {
    fn default() -> Self {
        Self {
            active_selection_is_empty: true,
        }
    }
}

/// Translates user commands into engine actions.
#[derive(Debug, Default, Clone, Copy)]
pub struct ProgrammerCommandPlanner;

impl ProgrammerCommandPlanner {
    /// Plan actions for a user command.
    pub fn plan(
        &self,
        command: &UserCommand,
        context: &ProgrammerPlanContext,
    ) -> Vec<PlannedEngineAction> {
        match command {
            UserCommand::Clear(clear) => self.plan_clear(clear, context),
            UserCommand::Release(release) => self.plan_release(release),
        }
    }

    fn plan_clear(
        &self,
        clear: &ClearCommand,
        context: &ProgrammerPlanContext,
    ) -> Vec<PlannedEngineAction> {
        if clear.targets.is_empty() {
            return if context.active_selection_is_empty {
                vec![planned(ProgrammerAction::ClearValues {
                    scope: Scope::All,
                    attributes: AttributeFilter::All,
                    allow_selection_flatten: clear.allow_selection_flatten,
                })]
            } else {
                vec![planned(ProgrammerAction::ClearSelection)]
            };
        }

        let mut actions = Vec::new();
        let mut clear_selection_emitted = false;
        let mut clear_values_emitted = false;

        for target in &clear.targets {
            match target {
                ClearTarget::Selection if !clear_selection_emitted => {
                    clear_selection_emitted = true;
                    actions.push(planned(ProgrammerAction::ClearSelection));
                }
                ClearTarget::Values if !clear_values_emitted => {
                    clear_values_emitted = true;
                    actions.push(planned(ProgrammerAction::ClearValues {
                        scope: Scope::All,
                        attributes: AttributeFilter::All,
                        allow_selection_flatten: clear.allow_selection_flatten,
                    }));
                }
                ClearTarget::Fixture {
                    selection,
                    attributes,
                } => {
                    let filter = AttributeFilter::from_attributes(attributes);
                    if matches!(filter, AttributeFilter::All) {
                        actions.push(planned(ProgrammerAction::ReleaseValues {
                            scope: Scope::Selection(selection.clone()),
                            attributes: filter,
                            allow_selection_flatten: clear.allow_selection_flatten,
                        }));
                    } else {
                        actions.push(planned(ProgrammerAction::ClearValues {
                            scope: Scope::Selection(selection.clone()),
                            attributes: filter,
                            allow_selection_flatten: clear.allow_selection_flatten,
                        }));
                    }
                }
                ClearTarget::Attribute { attributes } => {
                    actions.push(planned(ProgrammerAction::ClearValues {
                        scope: Scope::All,
                        attributes: AttributeFilter::from_attributes(attributes),
                        allow_selection_flatten: clear.allow_selection_flatten,
                    }));
                }
                _ => {}
            }
        }

        actions
    }

    fn plan_release(&self, release: &ReleaseCommand) -> Vec<PlannedEngineAction> {
        match &release.target {
            None => vec![planned(ProgrammerAction::ReleaseValues {
                scope: Scope::All,
                attributes: AttributeFilter::All,
                allow_selection_flatten: release.allow_selection_flatten,
            })],
            Some(ReleaseTarget::Selection(selection)) => {
                vec![planned(ProgrammerAction::ReleaseValues {
                    scope: Scope::Selection(selection.clone()),
                    attributes: AttributeFilter::All,
                    allow_selection_flatten: release.allow_selection_flatten,
                })]
            }
            Some(ReleaseTarget::Fixture {
                selection,
                attributes,
            }) => vec![planned(ProgrammerAction::ReleaseValues {
                scope: Scope::Selection(selection.clone()),
                attributes: AttributeFilter::from_attributes(attributes),
                allow_selection_flatten: release.allow_selection_flatten,
            })],
            Some(ReleaseTarget::Attribute { attributes }) => {
                vec![planned(ProgrammerAction::ReleaseValues {
                    scope: Scope::All,
                    attributes: AttributeFilter::Only(attributes.clone()),
                    allow_selection_flatten: release.allow_selection_flatten,
                })]
            }
            Some(ReleaseTarget::Channels { channels }) => {
                vec![planned(DmxAction::ReleaseChannels {
                    channels: channels.clone(),
                })]
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fmt::Debug;

    use nightfall::command_types::{DmxChannelExpr, DmxChannelRef, SelectionExpr};
    use nightfall_dmx::prelude::Attribute;

    use super::*;
    use crate::action_model::{ClearTarget, ReleaseTarget};

    /// Verifies that one erased plan entry contains the expected concrete action.
    fn assert_planned_action<A>(actual: &PlannedEngineAction, expected: &A)
    where
        A: EngineAction + Debug + PartialEq,
    {
        assert_eq!(actual.as_any().downcast_ref::<A>(), Some(expected));
    }

    #[test]
    fn clear_without_targets_uses_context_to_pick_selection_or_values() {
        let planner = ProgrammerCommandPlanner;
        let clear = UserCommand::Clear(ClearCommand::default());

        let selection_present = ProgrammerPlanContext {
            active_selection_is_empty: false,
        };
        let actions = planner.plan(&clear, &selection_present);
        assert_eq!(actions.len(), 1);
        assert_planned_action(&actions[0], &ProgrammerAction::ClearSelection);

        let selection_empty = ProgrammerPlanContext {
            active_selection_is_empty: true,
        };
        let actions = planner.plan(&clear, &selection_empty);
        assert_eq!(actions.len(), 1);
        assert_planned_action(
            &actions[0],
            &ProgrammerAction::ClearValues {
                scope: Scope::All,
                attributes: AttributeFilter::All,
                allow_selection_flatten: false,
            },
        );
    }

    #[test]
    fn clear_targets_dedupe_selection_and_values() {
        let planner = ProgrammerCommandPlanner;
        let clear = UserCommand::Clear(ClearCommand {
            targets: vec![
                ClearTarget::Selection,
                ClearTarget::Values,
                ClearTarget::Selection,
                ClearTarget::Values,
            ],
            allow_selection_flatten: false,
            selection_flatten_approval: None,
        });
        let actions = planner.plan(&clear, &ProgrammerPlanContext::default());

        assert_eq!(actions.len(), 2);
        assert_planned_action(&actions[0], &ProgrammerAction::ClearSelection);
        assert_planned_action(
            &actions[1],
            &ProgrammerAction::ClearValues {
                scope: Scope::All,
                attributes: AttributeFilter::All,
                allow_selection_flatten: false,
            },
        );
    }

    #[test]
    fn release_all_plans_programmer_release_action() {
        let planner = ProgrammerCommandPlanner;
        let release = UserCommand::Release(ReleaseCommand::default());
        let actions = planner.plan(&release, &ProgrammerPlanContext::default());

        assert_eq!(actions.len(), 1);
        assert_planned_action(
            &actions[0],
            &ProgrammerAction::ReleaseValues {
                scope: Scope::All,
                attributes: AttributeFilter::All,
                allow_selection_flatten: false,
            },
        );
    }

    #[test]
    fn release_fixture_with_attributes_plans_programmer_release_action() {
        let planner = ProgrammerCommandPlanner;
        let selection = SelectionExpr::Resolved(Default::default());
        let release = UserCommand::Release(ReleaseCommand {
            target: Some(ReleaseTarget::Fixture {
                selection: selection.clone(),
                attributes: vec![Attribute::Red],
            }),
            allow_selection_flatten: false,
            selection_flatten_approval: None,
        });
        let actions = planner.plan(&release, &ProgrammerPlanContext::default());

        assert_eq!(actions.len(), 1);
        assert_planned_action(
            &actions[0],
            &ProgrammerAction::ReleaseValues {
                scope: Scope::Selection(selection),
                attributes: AttributeFilter::Only(vec![Attribute::Red]),
                allow_selection_flatten: false,
            },
        );
    }

    #[test]
    fn clear_fixture_without_attributes_plans_programmer_release_action() {
        let planner = ProgrammerCommandPlanner;
        let selection = SelectionExpr::Resolved(Default::default());
        let clear = UserCommand::Clear(ClearCommand {
            targets: vec![ClearTarget::Fixture {
                selection: selection.clone(),
                attributes: vec![],
            }],
            allow_selection_flatten: false,
            selection_flatten_approval: None,
        });
        let actions = planner.plan(&clear, &ProgrammerPlanContext::default());

        assert_eq!(actions.len(), 1);
        assert_planned_action(
            &actions[0],
            &ProgrammerAction::ReleaseValues {
                scope: Scope::Selection(selection),
                attributes: AttributeFilter::All,
                allow_selection_flatten: false,
            },
        );
    }

    #[test]
    fn release_channels_plans_dmx_action() {
        let planner = ProgrammerCommandPlanner;
        let channels = DmxChannelExpr::Single(DmxChannelRef {
            universe: 1,
            address: 10,
        });
        let release = UserCommand::Release(ReleaseCommand {
            target: Some(ReleaseTarget::Channels {
                channels: channels.clone(),
            }),
            allow_selection_flatten: false,
            selection_flatten_approval: None,
        });
        let actions = planner.plan(&release, &ProgrammerPlanContext::default());

        assert_eq!(actions.len(), 1);
        assert_planned_action(&actions[0], &DmxAction::ReleaseChannels { channels });
    }
}
