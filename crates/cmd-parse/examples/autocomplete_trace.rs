// SPDX-License-Identifier: MPL-2.0

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

use std::io::IsTerminal;

use nightfall_cmd_parse::autocomplete::{TextRange, complete_command};
use nightfall_cmd_parse::completion::composer::compose_candidates_with_snapshot;
use nightfall_cmd_parse::completion::formatting::token_replace_bounds;
use nightfall_cmd_parse::lexicon::tokens::canonical_text;
use nightfall_cmd_parse::parser::analysis::TokenId;
use nightfall_cmd_parse::parser::prefix::parse_prefix;
use nightfall_cmd_parse::slots::planner::build_slot_plan_with_snapshot;
use serde::Serialize;
use serde_json::{Map as JsonMap, Value as JsonValue, json};

/// Output formats supported by the autocomplete trace example.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OutputMode {
    Human,
    Json,
}

/// Command-line arguments accepted by this diagnostic example.
#[derive(Debug, Clone, PartialEq, Eq)]
struct CliArgs {
    input: String,
    cursor: usize,
    output_mode: OutputMode,
}

/// Captured parser and completion details emitted by the autocomplete trace example.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct AutocompleteTrace {
    committed_breadcrumb: Option<String>,
    command_prefix_snapshot: JsonValue,
    composed_candidates: JsonValue,
    slot_plan: JsonValue,
    command_completion_response: JsonValue,
}

fn main() {
    let args = parse_args();
    let trace = build_trace(&args.input, args.cursor);

    match args.output_mode {
        OutputMode::Human => render_human_trace(&trace),
        OutputMode::Json => {
            println!(
                "{}",
                serde_json::to_string_pretty(&trace)
                    .expect("autocomplete trace should serialize to JSON")
            );
        }
    }
}

fn render_human_trace(trace: &AutocompleteTrace) {
    print_section(
        "CommandPrefixSnapshot (Branch Snapshot)",
        &trace.command_prefix_snapshot,
    );
    print_section(
        "ComposedCandidates (Completion Candidates)",
        &trace.composed_candidates,
    );
    print_section("SlotPlan (Slot Planner)", &trace.slot_plan);
    print_section(
        "CommandCompletionResponse (Autocomplete Response)",
        &trace.command_completion_response,
    );
}

fn print_section<T: Serialize>(label: &str, value: &T) {
    println!("{}", style_section(label));
    let json = serde_json::to_value(value).expect("trace section should serialize");
    println!("{}", render_human_value(&json, 0));
    println!();
}

fn render_human_value(value: &JsonValue, indent: usize) -> String {
    match value {
        JsonValue::Array(items) => render_human_array(items),
        JsonValue::Object(fields) => render_human_object(fields, indent),
        _ => render_human_scalar(value),
    }
}

fn render_human_object(fields: &JsonMap<String, JsonValue>, indent: usize) -> String {
    if let Some(rendered_tagged) = render_tagged_value(fields) {
        return rendered_tagged;
    }
    if fields.is_empty() {
        return "{}".to_owned();
    }

    let mut lines = Vec::with_capacity(fields.len() + 2);
    lines.push(style_punctuation("{"));
    let field_indent = "  ".repeat(indent + 1);
    let nested_indent = "  ".repeat(indent + 2);
    for (key, value) in fields {
        let rendered = render_human_value(value, indent + 1);
        if rendered.contains('\n') {
            let mut rendered_lines = rendered.lines();
            if let Some(first_line) = rendered_lines.next() {
                lines.push(format!("{field_indent}{}: {first_line}", style_key(key)));
                lines.extend(rendered_lines.map(|line| format!("{nested_indent}{line}")));
            } else {
                lines.push(format!("{field_indent}{}:", style_key(key)));
            }
        } else {
            lines.push(format!("{field_indent}{}: {rendered}", style_key(key)));
        }
    }
    lines.push(format!("{}{}", "  ".repeat(indent), style_punctuation("}")));
    lines.join("\n")
}

fn render_inline_array(items: &[JsonValue]) -> String {
    if items.is_empty() {
        return format!("{}{}", style_punctuation("["), style_punctuation("]"));
    }
    let rendered_items = items.iter().map(render_inline_value).collect::<Vec<_>>();
    format!(
        "{}{}{}",
        style_punctuation("["),
        rendered_items.join(", "),
        style_punctuation("]")
    )
}

fn render_human_array(items: &[JsonValue]) -> String {
    if items.is_empty() {
        return format!("{}{}", style_punctuation("["), style_punctuation("]"));
    }
    if items.iter().all(is_simple_list_item) {
        return render_inline_array(items);
    }

    let mut lines = Vec::with_capacity(items.len() + 2);
    lines.push(style_punctuation("["));
    for (index, item) in items.iter().enumerate() {
        let suffix = if index + 1 < items.len() { "," } else { "" };
        let inline_rendered = render_inline_value(item);
        let rendered = if should_expand_array_item(item, &inline_rendered) {
            render_human_value(item, 0)
        } else {
            inline_rendered
        };
        if rendered.contains('\n') {
            for line in rendered.lines() {
                lines.push(format!("  {line}"));
            }
            if !suffix.is_empty() {
                if let Some(last_line) = lines.last_mut() {
                    last_line.push_str(suffix);
                }
            }
        } else {
            lines.push(format!("  {rendered}{suffix}"));
        }
    }
    lines.push(style_punctuation("]"));
    lines.join("\n")
}

fn render_inline_value(value: &JsonValue) -> String {
    match value {
        JsonValue::Array(items) => render_inline_array(items),
        JsonValue::Object(fields) => {
            if let Some(rendered_tagged) = render_tagged_value(fields) {
                return rendered_tagged;
            }
            if fields.is_empty() {
                return format!("{}{}", style_punctuation("{"), style_punctuation("}"));
            }
            let rendered_fields = fields
                .iter()
                .map(|(key, value)| format!("{}: {}", style_key(key), render_inline_value(value)))
                .collect::<Vec<_>>();
            format!(
                "{}{}{}",
                style_punctuation("{"),
                rendered_fields.join(", "),
                style_punctuation("}")
            )
        }
        _ => render_human_scalar(value),
    }
}

fn render_tagged_value(fields: &JsonMap<String, JsonValue>) -> Option<String> {
    let kind = fields.get("kind")?.as_str()?;
    let value = fields.get("value")?;
    if fields.len() != 2 {
        return None;
    }

    let rendered_value = render_inline_value(value);
    match kind {
        "token" => Some(render_token_value(value).unwrap_or(rendered_value)),
        "literal" | "lexeme" => Some(rendered_value),
        "placeholder" => Some(format!(
            "{}{}{}",
            style_kind("<"),
            rendered_value,
            style_kind(">")
        )),
        _ => Some(format!("{}({rendered_value})", style_kind(kind))),
    }
}

fn render_token_value(value: &JsonValue) -> Option<String> {
    let token_id = serde_json::from_value::<TokenId>(value.clone()).ok()?;
    let canonical = canonical_text(token_id)?;
    Some(style_token(canonical))
}

fn render_human_scalar(value: &JsonValue) -> String {
    match value {
        JsonValue::String(text) => style_string(&render_human_string(text)),
        JsonValue::Number(number) => style_number(&number.to_string()),
        JsonValue::Bool(flag) => style_bool(&flag.to_string()),
        JsonValue::Null => style_null("null"),
        JsonValue::Array(_) | JsonValue::Object(_) => unreachable!("non-scalar JSON value"),
    }
}

fn is_simple_list_item(value: &JsonValue) -> bool {
    match value {
        JsonValue::Array(_) => false,
        JsonValue::Object(fields) => {
            if let Some(tagged) = render_tagged_value(fields) {
                return is_single_word(&tagged);
            }
            false
        }
        _ => is_single_word(&render_human_scalar(value)),
    }
}

fn should_expand_array_item(value: &JsonValue, inline_rendered: &str) -> bool {
    let display_len = strip_ansi_codes(inline_rendered).chars().count();
    match value {
        JsonValue::Object(fields) => render_tagged_value(fields).is_none() && display_len > 180,
        JsonValue::Array(_) => display_len > 180,
        _ => false,
    }
}

fn is_single_word(text: &str) -> bool {
    let plain = strip_ansi_codes(text);
    !plain.is_empty()
        && !plain.chars().any(char::is_whitespace)
        && !plain.contains(',')
        && !plain.contains('{')
        && !plain.contains('}')
        && !plain.contains('[')
        && !plain.contains(']')
}

fn render_human_string(text: &str) -> String {
    let simplified = simplify_debug_wrapper(text);
    if simplified
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || "_-./:".contains(ch))
    {
        return simplified;
    }
    format!("{simplified:?}")
}

fn simplify_debug_wrapper(text: &str) -> String {
    let mut simplified = text.to_owned();
    for wrapper in ["Token", "Placeholder", "Literal", "Lexeme"] {
        simplified = strip_wrapper_calls(&simplified, wrapper);
    }
    simplified
}

fn strip_wrapper_calls(text: &str, wrapper: &str) -> String {
    let pattern = format!("{wrapper}(");
    let mut result = String::with_capacity(text.len());
    let mut rest = text;

    while let Some(index) = rest.find(&pattern) {
        result.push_str(&rest[..index]);
        let after_pattern = &rest[index + pattern.len()..];
        if let Some((inner, consumed)) = consume_parenthesized(after_pattern) {
            result.push_str(inner);
            rest = &after_pattern[consumed..];
        } else {
            result.push_str(&rest[index..]);
            return result;
        }
    }

    result.push_str(rest);
    result
}

fn consume_parenthesized(text: &str) -> Option<(&str, usize)> {
    let mut depth = 1usize;
    for (index, ch) in text.char_indices() {
        match ch {
            '(' => depth = depth.saturating_add(1),
            ')' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return Some((&text[..index], index + ch.len_utf8()));
                }
            }
            _ => {}
        }
    }
    None
}

fn color_enabled() -> bool {
    if std::env::var_os("CLICOLOR_FORCE")
        .and_then(|value| value.into_string().ok())
        .as_deref()
        == Some("1")
    {
        return true;
    }
    if std::env::var_os("CLICOLOR")
        .and_then(|value| value.into_string().ok())
        .as_deref()
        == Some("0")
    {
        return false;
    }
    std::io::stdout().is_terminal()
}

fn style_ansi(text: &str, code: &str) -> String {
    if color_enabled() {
        format!("\x1b[{code}m{text}\x1b[0m")
    } else {
        text.to_owned()
    }
}

fn style_section(text: &str) -> String {
    style_ansi(text, "1;36")
}

fn style_key(text: &str) -> String {
    style_ansi(text, "36")
}

fn style_kind(text: &str) -> String {
    style_ansi(text, "35")
}

fn style_string(text: &str) -> String {
    style_ansi(text, "32")
}

fn style_token(text: &str) -> String {
    style_ansi(text, "32")
}

fn style_number(text: &str) -> String {
    style_ansi(text, "33")
}

fn style_bool(text: &str) -> String {
    style_ansi(text, "35")
}

fn style_null(text: &str) -> String {
    style_ansi(text, "90")
}

fn style_punctuation(text: &str) -> String {
    style_ansi(text, "90")
}

fn strip_ansi_codes(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\x1b' && chars.peek() == Some(&'[') {
            chars.next();
            for control in chars.by_ref() {
                if control.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            result.push(ch);
        }
    }
    result
}

/// Captures parser ownership, formatted edits, and presentation state for one cursor location.
fn build_trace(input: &str, cursor: usize) -> AutocompleteTrace {
    let cursor = cursor.min(input.len());
    let completion_response = complete_command(input, cursor);
    let (segment_start, segment_end) = segment_bounds(input, cursor);
    let prefix = &input[segment_start..cursor];
    let snapshot = parse_prefix(prefix, prefix.len());
    let replace = replace_range(input, cursor, segment_start, segment_end);
    let slot_plan = build_slot_plan_with_snapshot(&snapshot);
    let composed = compose_candidates_with_snapshot(
        input,
        cursor,
        segment_start,
        replace,
        &snapshot,
        &slot_plan,
    );

    AutocompleteTrace {
        committed_breadcrumb: (!completion_response.slot_plan.committed_path.is_empty()).then(
            || {
                completion_response
                    .slot_plan
                    .committed_path
                    .iter()
                    .map(|item| {
                        nightfall_cmd_parse::slots::planner::clause_display_label(item.clause)
                    })
                    .collect::<Vec<_>>()
                    .join(" > ")
            },
        ),
        command_prefix_snapshot: command_prefix_snapshot_json(&snapshot),
        composed_candidates: serde_json::to_value(composed)
            .expect("composed candidates should serialize"),
        slot_plan: serde_json::to_value(slot_plan).expect("slot plan should serialize"),
        command_completion_response: serde_json::to_value(completion_response)
            .expect("completion response should serialize"),
    }
}

fn command_prefix_snapshot_json(
    snapshot: &nightfall_cmd_parse::parser::analysis::CommandPrefixSnapshot<'_>,
) -> JsonValue {
    json!({
        "status": snapshot.status(),
        "furthest_pos": snapshot.furthest_pos(),
        "context": snapshot.context,
        "committed_clause_path": snapshot.committed_clause_path(),
        "projected_clause_paths": snapshot.projected_clause_paths(),
        "frontier": snapshot.frontier(),
        "consumed_items": snapshot
            .consumed_items()
            .into_iter()
            .map(|item| json!({
                "slot": item.slot,
                "clause": item.clause,
                "surface": item.surface,
                "normalized_value": format!("{:?}", item.normalized_value),
                "source_span": item.source_span,
                "source_token_start": item.source_token_start,
                "source_token_end": item.source_token_end,
            }))
            .collect::<Vec<_>>(),
        "branches": snapshot
            .branches
            .iter()
            .map(branch_json)
            .collect::<Vec<_>>(),
        "replacement_branches": snapshot.replacement_branches.iter().map(branch_json).collect::<Vec<_>>(),
    })
}

fn branch_json(branch: &nightfall_cmd_parse::parser::analysis::ParseBranchState<'_>) -> JsonValue {
    json!({
        "cursor": {
            "token_index": branch.cursor.token_index,
            "furthest_pos": branch.cursor.furthest_pos,
        },
        "status": format!("{:?}", branch.status),
        "clause_stack": branch
            .clause_stack
            .iter()
            .map(|frame| json!({
                "clause": frame.clause,
                "phase": format!("{:?}", frame.phase),
                "commit_state": format!("{:?}", frame.commit_state),
            }))
            .collect::<Vec<_>>(),
        "clause_usage": branch
            .clause_usage
            .iter()
            .map(|usage| json!({
                "clause": usage.clause,
                "used_values": usage
                    .used_values
                    .iter()
                    .map(|value| format!("{value:?}"))
                    .collect::<Vec<_>>(),
            }))
            .collect::<Vec<_>>(),
        "frontier": branch
            .frontier
            .iter()
            .map(|expectation| json!({
                "target": expectation_target_json(&expectation.target),
                "continuation_kind": format!("{:?}", expectation.continuation_kind),
                "expected_tokens": expectation.expected_tokens,
                "rule": expectation.rule,
            }))
            .collect::<Vec<_>>(),
        "clause_tree": branch.clause_tree,
    })
}

fn expectation_target_json(
    target: &nightfall_cmd_parse::parser::analysis::ContinuationTarget,
) -> JsonValue {
    match target {
        nightfall_cmd_parse::parser::analysis::ContinuationTarget::Slot(slot) => json!({
            "kind": "slot",
            "value": slot,
        }),
        nightfall_cmd_parse::parser::analysis::ContinuationTarget::Clause(clause) => json!({
            "kind": "clause",
            "value": clause,
        }),
    }
}

fn replace_range(
    input: &str,
    cursor: usize,
    segment_start: usize,
    segment_end: usize,
) -> TextRange {
    let (start, end) = token_replace_bounds(input, cursor, segment_start, segment_end);
    TextRange { start, end }
}

fn parse_args() -> CliArgs {
    let mut args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.is_empty() {
        print_usage_and_exit(2);
    }
    if args.len() == 1 && (args[0] == "--help" || args[0] == "-h") {
        print_usage_and_exit(0);
    }

    let mut cursor = None::<usize>;
    let mut output_mode = OutputMode::Human;
    let mut index = 0usize;
    while index < args.len() {
        match args[index].as_str() {
            "--cursor" => {
                if index + 1 >= args.len() {
                    eprintln!("--cursor requires a value");
                    std::process::exit(2);
                }
                let value = args[index + 1].parse::<usize>().unwrap_or_else(|_| {
                    eprintln!("invalid --cursor value: {}", args[index + 1]);
                    std::process::exit(2);
                });
                cursor = Some(value);
                args.drain(index..=index + 1);
                continue;
            }
            "--json" => {
                output_mode = OutputMode::Json;
                args.remove(index);
                continue;
            }
            flag if flag.starts_with("--") => {
                eprintln!("unknown option: {flag}");
                print_usage_and_exit(2);
            }
            _ => {}
        }
        index += 1;
    }

    if args.is_empty() {
        eprintln!("input is required");
        print_usage_and_exit(2);
    }

    let input = args.join(" ");
    let cursor = cursor.unwrap_or(input.len());
    CliArgs {
        input,
        cursor,
        output_mode,
    }
}

fn print_usage_and_exit(code: i32) -> ! {
    eprintln!(
        "Usage: cargo run -p nightfall-cmd-parse --example autocomplete_trace -- \"<input>\" [--cursor <n>] [--json]"
    );
    std::process::exit(code);
}

fn segment_bounds(input: &str, cursor: usize) -> (usize, usize) {
    let segment_start = input[..cursor]
        .rfind(';')
        .map_or(0usize, |index| index.saturating_add(1));
    let segment_end = input[cursor..]
        .find(';')
        .map_or(input.len(), |offset| cursor + offset);
    (segment_start, segment_end)
}
