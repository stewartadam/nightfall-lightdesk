// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

//! Programmer command contracts, planning, and responsibility-focused runtime handlers.

use std::collections::{HashMap, HashSet, VecDeque};

use bevy_ecs::prelude::*;
use nightfall::prelude::*;
use nightfall_cues::prelude::*;
use nightfall_desk::prelude::*;
use nightfall_dmx::prelude::*;
use nightfall_engine::prelude::*;
use nightfall_fixtures::prelude::FixtureDataProviderExt;
use nightfall_fixtures::selection::{SelectionResolver, SpatialSelectionResolver};
use nightfall_instances::{PlaybackAction, PlaybackScope};
use serde::{Deserialize, Serialize};

use crate::action_model::{AttributeFilter, ProgrammerAction, Scope, UserCommand};
use crate::command_planner::{ProgrammerCommandPlanner, ProgrammerPlanContext};
use crate::resources::Programmer;

mod blueprints;
mod contracts;
mod cues;
mod groups;
mod planning;
mod programmer;
mod release;
mod removal;
mod store_mode;
mod undo;
mod workflows;

pub use blueprints::{
    ProgrammerBlueprintState, handle_blueprint_events,
    rebuild_programmer_blueprint_reference_index, resume_store_object_workflows,
};
pub use contracts::{
    ProgrammerAttributeOperation, ProgrammerAttributeSource, ProgrammerCommand, StoreCueId,
    StoreCuePartId, StoreMode,
};
pub use cues::{ProgrammerCueState, handle_cue_events, resume_store_cue_workflows};
pub use groups::handle_group_events;
pub use planning::plan_pending_user_commands;
pub use programmer::{ProgrammerMutationState, handle_programmer_events};
pub use removal::handle_remove_instruction_events;
pub use undo::handle_undo_events;
pub use workflows::{
    PendingProgrammerActionWorkflows, PendingUserCommandPlans, SelectionFlattenApprovals,
    StoreCueWorkflows, StoreObjectWorkflows,
};
