//! A small synthetic history for repeatable browser tests.
//!
//! Every record is placed relative to one instant, so the same `--now` always gives the same database, byte for byte in
//! its records. Nothing is random: the few varying numbers come from a fixed-seed generator walked in a fixed order.
//! No name, path or text comes from real use; the secrets in tool output are placeholders shaped to trip the redactor.
//!
//! The layout, counted in days back from midnight UTC of `--now` (dashboard/tests/fixture.ts mirrors these numbers):
//! - day 148 to 121 and 105 to 45: session-log hours only before day 88, the way imported logs look.
//! - day 121 22:00 to day 105 08:00: nothing at all, a stretch the dashboard calls "Not captured".
//! - day 88 to 3: provider turns, prompts, answers, runs, tools and delegation trees, a few runs a day.
//! - the last 72 hours: a run every 90 minutes, and four more inside the last hour.
//! - named moments: day 8 17:00-21:00 (an evening where Opus ran and reported nothing at 18:45), day 21 00:00-07:00 (an hour
//!   where only unreported turns ran), day 27 (a burst of unreported turns), day 35 (no Sonnet), day 1 03:15 (a repeat
//!   delegation), day 2 11:00 (a thread with one turn that reported no total).
use crate::{privacy, storage::Store};
use anyhow::{Result, ensure};
use chrono::{DateTime, Duration, SecondsFormat, Timelike, Utc};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const VERSION: &str = "fixture-1";

const PROJECTS: [&str; 12] = [
    "atlas", "harbor", "lumen", "quill", "orbit", "cedar", "ember", "fjord", "granite", "helix",
    "iris", "juniper",
];
const VERBS: [&str; 6] = ["Tidy", "Speed up", "Document", "Fix", "Rework", "Test"];
const THINGS: [&str; 10] = [
    "parser",
    "ledger",
    "export",
    "sync",
    "search",
    "layout",
    "cache",
    "router",
    "scheduler",
    "report",
];
const TOPICS: [&str; 8] = [
    "retry", "timezone", "paging", "filter", "summary", "limit", "preview", "history",
];

/// The models of the provider-turn era, in the order runs take them. None is a run that names no model.
const ROTATION: [Option<&str>; 11] = [
    Some("gpt-6.1-sol"),
    Some("claude-opus-5-5"),
    Some("gpt-6.1-sol"),
    Some("claude-sonnet-5-5"),
    None,
    Some("gpt-5.5-codex"),
    Some("claude-haiku-5-5"),
    Some("gpt-6.1-sol"),
    None,
    Some("muse-spark-2"),
    Some("claude-opus-5-5"),
];

#[derive(Clone, Copy, PartialEq)]
enum Usage {
    Complete,
    /// Token fields but no complete total.
    Partial,
    /// Nothing reported.
    Unavailable,
}

/// The agent that runs a model, as T3 names its providers.
fn driver(model: &str) -> &'static str {
    if model.starts_with("gpt") || model.starts_with("o9") {
        "codex"
    } else if model.starts_with("claude") {
        "claudeAgent"
    } else if model.starts_with("grok") {
        "grok"
    } else if model.starts_with("muse") {
        "muse"
    } else {
        "gemini"
    }
}

fn iso(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Millis, true)
}

struct Fx<'a> {
    s: &'a Store,
    instance: String,
    now: DateTime<Utc>,
    day0: DateTime<Utc>,
    seed: u64,
    titles: usize,
    serial: u64,
    counts: BTreeMap<String, u64>,
}

struct Run<'a> {
    thread: &'a str,
    project: &'a str,
    at: DateTime<Utc>,
    model: Option<&'a str>,
    /// The driver for a run that names no model.
    unnamed_driver: &'a str,
    turns: &'a [Usage],
    subagent_task: bool,
    has_subagents: bool,
    tools: usize,
}

impl<'a> Fx<'a> {
    /// A fixed-seed linear congruential step. Called in a fixed order, so the numbers never change between builds.
    fn next(&mut self) -> u64 {
        self.seed = self
            .seed
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.seed >> 33
    }
    fn between(&mut self, lo: i64, hi: i64) -> i64 {
        lo + (self.next() % (hi - lo) as u64) as i64
    }
    fn day(&self, n: i64, h: i64, m: i64) -> DateTime<Utc> {
        self.day0 - Duration::days(n) + Duration::hours(h) + Duration::minutes(m)
    }
    fn ago(&self, minutes: i64) -> DateTime<Utc> {
        self.now - Duration::minutes(minutes)
    }
    /// A stable id shaped like the UUIDs T3 uses.
    fn uid(&mut self, kind: &str) -> String {
        self.serial += 1;
        let h = privacy::hash(&format!("fixture\0{kind}\0{}", self.serial));
        format!(
            "{}-{}-4{}-8{}-{}",
            &h[0..8],
            &h[8..12],
            &h[13..16],
            &h[17..20],
            &h[20..32]
        )
    }
    fn project_id(name: &str) -> String {
        let h = privacy::hash(&format!("fixture\0project\0{name}"));
        format!(
            "{}-{}-4{}-8{}-{}",
            &h[0..8],
            &h[8..12],
            &h[13..16],
            &h[17..20],
            &h[20..32]
        )
    }
    /// Unique titles: every combination of verb, thing and topic once, then numbered follow-ups.
    fn title(&mut self) -> String {
        let c = self.titles;
        self.titles += 1;
        let base = format!(
            "{} the {} {}",
            VERBS[c % 6],
            THINGS[(c / 6) % 10],
            TOPICS[(c / 60) % 8]
        );
        if c < 480 {
            base
        } else {
            format!("{base} (follow-up {})", c - 479)
        }
    }
    #[allow(clippy::too_many_arguments)]
    fn put(
        &mut self,
        kind: &str,
        source: &str,
        project: &str,
        thread: &str,
        run: &str,
        at: DateTime<Utc>,
        updated: DateTime<Utc>,
        data: Value,
    ) -> Result<()> {
        ensure!(
            at <= self.now && updated <= self.now,
            "fixture record {kind} {source} lies after --now"
        );
        self.s.put(
            &self.instance,
            kind,
            source,
            project,
            thread,
            run,
            &iso(at),
            &iso(updated),
            "partial",
            VERSION,
            data,
        )?;
        *self.counts.entry(kind.to_string()).or_default() += 1;
        Ok(())
    }

    fn project(&mut self, name: &str, at: DateTime<Utc>) -> Result<()> {
        let id = Self::project_id(name);
        let data = json!({"name":name,"t3_project_id":id,"repository_path_hash":privacy::hash(&format!("fixture-path-{name}")),"repository_root_alias":name,"git_remote_hash":privacy::hash(&format!("fixture-remote-{name}")),"git_remote_alias":format!("example.invalid/fixture/{name}"),"logical_project_id":privacy::hash(&format!("fixture-remote-{name}")),"current_branch":"main"});
        self.put("project", &id, &id, "", &id, at, at, data)
    }

    /// A thread. Lineage is (root, parent, depth) for a sub-agent's thread.
    fn thread(
        &mut self,
        project: &str,
        at: DateTime<Utc>,
        model: Option<&str>,
        lineage: Option<(&str, &str, i64)>,
        title: Option<String>,
    ) -> Result<String> {
        let id = self.uid("thread");
        let title = title.unwrap_or_else(|| self.title());
        let (typ, parent, root, depth, rel) = match lineage {
            Some((root, parent, depth)) => (
                "child",
                json!(parent),
                root.to_string(),
                depth,
                json!("subagent"),
            ),
            None => ("primary", Value::Null, id.clone(), 0, Value::Null),
        };
        let branch = format!(
            "fixture/{}",
            title
                .to_lowercase()
                .replace(' ', "-")
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '/')
                .collect::<String>()
        );
        let data = json!({"title":title,"thread_type":typ,"parent_thread_id":parent,"root_thread_id":root,"depth":depth,"lineage_resolved":true,"relationship_to_parent":rel,"branch":branch,"worktree_available":depth == 0,"model":model,"archived_at":null,"tool_coverage":"partial","token_usage":null});
        self.put("thread", &id, project, &id, "", at, at, data)?;
        Ok(id)
    }

    fn text(&mut self, kind: &str) -> String {
        let a = THINGS[self.between(0, 10) as usize];
        let b = TOPICS[self.between(0, 8) as usize];
        let pick = self.between(0, 12);
        match (kind, pick) {
            ("prompt", 0) => format!(
                "The {a} job fails with API_KEY=fixture-placeholder-value in the log. Find out why the {b} step breaks."
            ),
            ("prompt", 1) => {
                format!("Look at /home/fixture/work/{a}/notes.md and tidy the {b} section.")
            }
            ("prompt", 2..=4) => {
                format!("Please tidy the {a} module and keep the {b} tests passing.")
            }
            ("prompt", 5..=7) => {
                format!("Why does the {a} view render twice when the {b} changes?")
            }
            ("prompt", _) => {
                format!("Add a {b} option to the {a} settings and document the default.")
            }
            ("task", _) => format!("Check the {a} {b} handling\nReport anything that looks wrong."),
            ("result", _) => format!(
                "The {a} {b} handling looks right; two edge cases are noted in the summary."
            ),
            (_, p) if p < 6 => format!("Done: the {a} change is in and the {b} tests pass."),
            _ => format!("I looked at the {a} code; the {b} path was the cause and is fixed now."),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn message(
        &mut self,
        kind: &str,
        run: &Run,
        run_id: &str,
        at: DateTime<Utc>,
        model: Option<&str>,
        prompt_id: &str,
        text: &str,
    ) -> Result<String> {
        let id = self.uid(kind);
        let mut data = serde_json::to_value(privacy::protect(text, "redacted_only", None)?)?;
        data["source_message_id"] = json!(id);
        data["model"] = json!(model);
        data["status"] = json!("completed");
        data["prompt_id"] = json!(prompt_id);
        data["prompt_type"] = json!(if kind == "answer" {
            "unknown"
        } else if run.subagent_task {
            "subagent_task"
        } else {
            "primary"
        });
        self.put(kind, &id, run.project, run.thread, run_id, at, at, data)?;
        Ok(id)
    }

    fn turn(
        &mut self,
        run: &Run,
        run_id: &str,
        at: DateTime<Utc>,
        usage: Usage,
        prompt_id: &str,
    ) -> Result<()> {
        let id = self.uid("turn");
        let model = run.model;
        let drv = model.map(driver).unwrap_or(run.unnamed_driver);
        let mut d = json!({"usage_scope":"main_agent","usage_status":"complete","input_tokens":null,"cached_input_tokens":null,"cache_write_tokens":null,"output_tokens":null,"reasoning_tokens":null,"total_tokens":null,"has_subagents":run.has_subagents});
        let input = self.between(18_000, 240_000);
        let output = self.between(900, 14_000);
        match usage {
            Usage::Unavailable => {
                d["usage_scope"] = json!("unavailable");
                d["usage_status"] = json!("unavailable");
            }
            Usage::Partial => {
                d["usage_status"] = json!("partial");
                d["input_tokens"] = json!(input);
                d["output_tokens"] = json!(output);
            }
            Usage::Complete => {
                let cached = input * self.between(45, 85) / 100;
                d["input_tokens"] = json!(input);
                d["cached_input_tokens"] = json!(cached);
                d["output_tokens"] = json!(output);
                d["total_tokens"] = json!(input + output);
                if drv == "codex" {
                    d["reasoning_tokens"] = json!(output * self.between(10, 40) / 100);
                }
                if drv == "claudeAgent" {
                    d["cache_write_tokens"] = json!(input * self.between(2, 15) / 100);
                }
            }
        }
        let ms = self.between(8_000, 95_000);
        let end = at + Duration::milliseconds(ms);
        // A turn that names no model carries its agent only in the provider thread id.
        d["provider"] = if model.is_some() {
            json!(drv)
        } else {
            Value::Null
        };
        d["requested_model"] = json!(model);
        d["resolved_model"] = Value::Null;
        d["status"] = json!("completed");
        d["duration_ms"] = json!(ms);
        d["model"] = json!(model);
        d["started_at"] = json!(iso(at));
        d["completed_at"] = json!(iso(end));
        d["node_id"] = json!(format!("node-{}", &id[..8]));
        d["provider_thread_id"] = json!(format!(
            "provider-thread:provider:{drv}:native-thread:{}",
            &run.thread[..8]
        ));
        d["prompt_id"] = json!(prompt_id);
        self.put(
            "model_turn",
            &id,
            run.project,
            run.thread,
            run_id,
            at,
            end.min(self.now),
            d,
        )
    }

    fn tool(&mut self, run: &Run, run_id: &str, at: DateTime<Utc>) -> Result<()> {
        let id = self.uid("tool");
        let pick = self.between(0, 20);
        let thing = THINGS[self.between(0, 10) as usize];
        let (typ, name, category, args, result, exit, status): (
            &str,
            &str,
            &str,
            String,
            String,
            Value,
            &str,
        ) = match pick {
            0..=5 => (
                "command_execution",
                "command_execution",
                "shell",
                format!("cargo test -p {thing}"),
                "test result: ok".into(),
                json!(0),
                "completed",
            ),
            6 => (
                "command_execution",
                "command_execution",
                "shell",
                format!("npm run lint -- {thing}"),
                "1 problem found".into(),
                json!(1),
                "failed",
            ),
            7 => (
                "command_execution",
                "command_execution",
                "shell",
                format!("./scripts/{thing}.sh"),
                "command not found".into(),
                json!(127),
                "failed",
            ),
            8 => (
                "command_execution",
                "command_execution",
                "shell",
                "printenv | grep FIXTURE".into(),
                "FIXTURE_TOKEN=placeholder-not-a-secret".into(),
                json!(0),
                "completed",
            ),
            9 => (
                "command_execution",
                "command_execution",
                "shell",
                format!(
                    "curl -H 'Authorization: Bearer fixturetoken0123456' http://127.0.0.1:9/{thing}"
                ),
                "connection refused".into(),
                json!(7),
                "failed",
            ),
            10..=12 => (
                "file_change",
                "file_change",
                "file_write",
                format!("src/{thing}.rs"),
                "applied".into(),
                Value::Null,
                "completed",
            ),
            13 => (
                "file_change",
                "file_change",
                "file_write",
                format!("/home/fixture/work/{thing}/config.toml"),
                "applied".into(),
                Value::Null,
                "completed",
            ),
            14 | 15 => (
                "file_search",
                "file_search",
                "search",
                format!("fn {thing}"),
                "3 matches".into(),
                Value::Null,
                "completed",
            ),
            16 => (
                "web_search",
                "web_search",
                "search",
                format!("{thing} release notes"),
                "5 results".into(),
                Value::Null,
                "completed",
            ),
            17 => (
                "dynamic_tool",
                "read_file",
                "unknown",
                format!("docs/{thing}.md"),
                "read 120 lines".into(),
                Value::Null,
                "completed",
            ),
            18 => (
                "dynamic_tool",
                "read_file",
                "unknown",
                "settings.local.json".into(),
                "{\"key\":\"sk-fixture00000000000000\"}".into(),
                Value::Null,
                "completed",
            ),
            _ => (
                "command_execution",
                "command_execution",
                "shell",
                format!("cargo build -p {thing}"),
                "cancelled".into(),
                Value::Null,
                "cancelled",
            ),
        };
        let ms = self.between(40, 12_000);
        let content = json!({"arguments":args,"result":result,"diff":if typ=="file_change"{json!("+ fixture line")}else{Value::Null},"file":if typ=="file_change"{json!(args)}else{Value::Null}});
        let mut d = serde_json::to_value(privacy::protect_json(&content, "redacted_only", None)?)?;
        d["status"] = json!(status);
        d["duration_ms"] = json!(ms);
        d["model"] = json!(run.model);
        d["started_at"] = json!(iso(at));
        d["completed_at"] = json!(iso(at + Duration::milliseconds(ms)));
        d["tool_name"] = json!(name);
        d["tool_category"] = json!(category);
        d["exit_code"] = exit;
        d["parent_tool_call_id"] = Value::Null;
        self.put("tool", &id, run.project, run.thread, run_id, at, at, d)
    }

    /// A run: its prompt, turns, tool calls and answer. Returns the run id.
    fn run(&mut self, r: Run) -> Result<String> {
        let run_id = self.uid("run");
        let prompt_text = if r.subagent_task {
            self.text("task")
        } else {
            self.text("prompt")
        };
        let prompt = self.message("prompt", &r, &run_id, r.at, r.model, "", &prompt_text)?;
        let mut t = r.at + Duration::seconds(40);
        for (i, usage) in r.turns.iter().enumerate() {
            self.turn(&r, &run_id, t, *usage, &prompt)?;
            if i < r.tools {
                self.tool(&r, &run_id, t + Duration::seconds(50))?;
            }
            t += Duration::seconds(self.between(100, 160));
        }
        for _ in r.turns.len()..r.tools {
            self.tool(&r, &run_id, t)?;
            t += Duration::seconds(30);
        }
        let end = t.min(self.now);
        let answer = self.text("answer");
        self.message("answer", &r, &run_id, end, r.model, &prompt, &answer)?;
        let status = if r.turns.iter().all(|u| *u == Usage::Unavailable) && self.between(0, 3) == 0
        {
            "failed"
        } else {
            "completed"
        };
        let data = json!({"duration_ms":(end - r.at).num_milliseconds(),"provider":r.model.map(driver).unwrap_or(r.unnamed_driver),"requested_model":r.model,"resolved_model":null,"status":status,"started_at":iso(r.at),"completed_at":iso(end),"user_message_id":prompt,"input_tokens":null,"cached_input_tokens":null,"output_tokens":null,"reasoning_tokens":null,"total_tokens":null});
        self.put(
            "run", &run_id, r.project, r.thread, &run_id, r.at, end, data,
        )?;
        Ok(run_id)
    }

    /// A simple run in a thread: one model, some turns of one usage, a couple of tools.
    fn simple(
        &mut self,
        thread: &str,
        project: &str,
        at: DateTime<Utc>,
        model: Option<&str>,
        unnamed_driver: &str,
        turns: &[Usage],
    ) -> Result<String> {
        let tools = self.between(1, 4) as usize;
        self.run(Run {
            thread,
            project,
            at,
            model,
            unnamed_driver,
            turns,
            subagent_task: false,
            has_subagents: false,
            tools,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn agent(
        &mut self,
        thread: &str,
        project: &str,
        run_id: &str,
        at: DateTime<Utc>,
        child: Option<&str>,
        model: &str,
        status: &str,
        returned: Option<bool>,
        parent_agent: Option<&str>,
    ) -> Result<String> {
        let id = self.uid("agent");
        let ms = self.between(60_000, 540_000);
        let done = if status == "running" {
            None
        } else {
            Some((at + Duration::milliseconds(ms)).min(self.now))
        };
        let task = self.text("task");
        let result = match status {
            "failed" => json!("Rate limit reached for the fixture provider."),
            "running" => Value::Null,
            _ => json!(self.text("result")),
        };
        let mut d = serde_json::to_value(privacy::protect_json(
            &json!({"task":task,"result":result}),
            "redacted_only",
            None,
        )?)?;
        d["status"] = json!(status);
        d["duration_ms"] = done
            .map(|e| json!((e - at).num_milliseconds()))
            .unwrap_or(Value::Null);
        d["model"] = json!(model);
        d["started_at"] = json!(iso(at));
        d["completed_at"] = done.map(|e| json!(iso(e))).unwrap_or(Value::Null);
        d["agent_type"] = json!(if child.is_some() {
            "t3_child"
        } else {
            "provider_native_subagent"
        });
        d["child_thread_id"] = json!(child);
        d["parent_agent_run_id"] = json!(parent_agent);
        d["completion_delivery_state"] = match returned {
            Some(true) => json!("delivered"),
            _ if status == "running" => Value::Null,
            _ => json!("pending"),
        };
        d["result_returned_to_parent"] = json!(returned);
        self.put(
            "agent",
            &id,
            project,
            thread,
            run_id,
            at,
            done.unwrap_or(at),
            d,
        )?;
        Ok(id)
    }

    /// A sub-agent's thread with its one run, started by an agent record in the parent thread.
    #[allow(clippy::too_many_arguments)]
    fn child(
        &mut self,
        root: &str,
        parent: &str,
        parent_run: &str,
        project: &str,
        at: DateTime<Utc>,
        depth: i64,
        model: &str,
        status: &str,
        returned: Option<bool>,
        parent_agent: Option<&str>,
    ) -> Result<(String, String, String)> {
        let thread = self.thread(project, at, Some(model), Some((root, parent, depth)), None)?;
        let agent = self.agent(
            parent,
            project,
            parent_run,
            at,
            Some(&thread),
            model,
            status,
            returned,
            parent_agent,
        )?;
        let usage = if status == "failed" {
            vec![Usage::Complete]
        } else {
            vec![Usage::Complete, Usage::Complete]
        };
        let tools = self.between(1, 3) as usize;
        let run = self.run(Run {
            thread: &thread,
            project,
            at: at + Duration::seconds(20),
            model: Some(model),
            unnamed_driver: "codex",
            turns: &usage,
            subagent_task: true,
            has_subagents: false,
            tools,
        })?;
        Ok((thread, agent, run))
    }

    /// A primary thread that delegates: children, optionally a grandchild, a native sub-agent and a failure.
    #[allow(clippy::too_many_arguments)]
    fn tree(
        &mut self,
        project: &str,
        at: DateTime<Utc>,
        root_model: &str,
        children: usize,
        fail: bool,
        grand: bool,
        native: bool,
    ) -> Result<String> {
        let root = self.thread(project, at, Some(root_model), None, None)?;
        let run = self.run(Run {
            thread: &root,
            project,
            at,
            model: Some(root_model),
            unnamed_driver: "codex",
            turns: &[Usage::Complete, Usage::Complete],
            subagent_task: false,
            has_subagents: true,
            tools: 1,
        })?;
        let models = ["claude-haiku-5-5", "claude-opus-5-5", "gpt-6.1-sol"];
        let mut first: Option<(String, String, String)> = None;
        for i in 0..children {
            let failed = fail && i == 1;
            // The third child's delivery is not recorded, so a tree can say so.
            let returned = if failed || i == 2 { None } else { Some(true) };
            let c = self.child(
                &root,
                &root,
                &run,
                project,
                at + Duration::minutes(3 + 4 * i as i64),
                1,
                models[i % 3],
                if failed { "failed" } else { "completed" },
                returned,
                None,
            )?;
            if first.is_none() {
                first = Some(c);
            }
        }
        if grand && let Some((child, agent, child_run)) = &first {
            self.child(
                &root,
                child,
                child_run,
                project,
                at + Duration::minutes(5),
                2,
                "claude-haiku-5-5",
                "completed",
                Some(true),
                Some(agent),
            )?;
        }
        if native {
            self.agent(
                &root,
                project,
                &run,
                at + Duration::minutes(2),
                None,
                root_model,
                "completed",
                Some(true),
                None,
            )?;
        }
        Ok(root)
    }

    #[allow(clippy::too_many_arguments)]
    fn log_hour(
        &mut self,
        at: DateTime<Utc>,
        model: &str,
        project: &str,
        input: i64,
        cached_pct: i64,
        written: i64,
        output: i64,
        reasoning: i64,
    ) -> Result<()> {
        let drv = driver(model);
        let session = format!("fixture-session-{}-{drv}", at.format("%Y%m%d"));
        let hour = at.format("%Y-%m-%dT%H").to_string();
        let last = at + Duration::minutes(self.between(10, 55));
        let data = json!({
            "usage_scope": "main_agent", "usage_status": "complete", "usage_source": "session_log", "calls": self.between(4, 40),
            "input_tokens": input, "cached_input_tokens": input * cached_pct / 100, "cache_write_tokens": written, "output_tokens": output,
            "reasoning_tokens": if reasoning > 0 { json!(reasoning) } else { Value::Null }, "total_tokens": input + output,
            "provider": drv, "requested_model": model, "resolved_model": null, "model": model, "status": "completed",
            "duration_ms": (last - at).num_milliseconds(), "started_at": iso(at), "completed_at": iso(last), "node_id": null,
            "provider_thread_id": session, "prompt_id": null,
        });
        self.put(
            "model_turn",
            &format!("log:{session}:{hour}:{model}"),
            project,
            "",
            "",
            at,
            last,
            data,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn quota_sample(
        &mut self,
        provider: &str,
        window: &str,
        at: DateTime<Utc>,
        used: f64,
        reset: DateTime<Utc>,
        minutes: i64,
        plan: Option<&str>,
        source: &str,
    ) -> Result<()> {
        ensure!(at <= self.now, "quota sample after --now");
        let reset = reset
            .with_second(0)
            .unwrap()
            .with_nanosecond(0)
            .unwrap()
            .to_rfc3339_opts(SecondsFormat::Secs, true);
        self.s.conn.execute(
            "INSERT INTO quota_samples VALUES (?,?,?,?,?,?,?,?)",
            duckdb::params![
                provider,
                window,
                iso(at),
                used,
                reset,
                minutes,
                plan,
                source
            ],
        )?;
        *self.counts.entry("quota_sample".into()).or_default() += 1;
        Ok(())
    }
    fn quota_event(
        &mut self,
        provider: &str,
        at: DateTime<Utc>,
        window: &str,
        reset: Option<DateTime<Utc>>,
        source: &str,
    ) -> Result<()> {
        let reset = reset.map(|r| {
            r.with_second(0)
                .unwrap()
                .with_nanosecond(0)
                .unwrap()
                .to_rfc3339_opts(SecondsFormat::Secs, true)
        });
        self.s.conn.execute(
            "INSERT INTO quota_events VALUES (?,?,?,?,?,?)",
            duckdb::params![provider, "limit_reached", iso(at), window, reset, source],
        )?;
        *self.counts.entry("quota_event".into()).or_default() += 1;
        Ok(())
    }
}

/// Fills an empty database with the synthetic history, placed relative to `now` (RFC 3339).
pub fn build(s: &Store, instance: &str, now: &str) -> Result<Value> {
    let now = chrono::DateTime::parse_from_rfc3339(now)?.with_timezone(&Utc);
    let existing: i64 = s.conn.query_row("SELECT (SELECT count(*) FROM records)+(SELECT count(*) FROM quota_samples)+(SELECT count(*) FROM quota_events)", [], |r| r.get(0))?;
    ensure!(
        existing == 0,
        "The fixture only fills an empty database; this one already holds {existing} rows"
    );
    let day0 = now.date_naive().and_hms_opt(0, 0, 0).unwrap().and_utc();
    let mut fx = Fx {
        s,
        instance: instance.to_string(),
        now,
        day0,
        seed: 0x5eed_f1c7_u64,
        titles: 0,
        serial: 0,
        counts: BTreeMap::new(),
    };
    s.conn.execute_batch("BEGIN")?;
    let result = fill(&mut fx);
    match &result {
        Ok(()) => s.conn.execute_batch("COMMIT; CHECKPOINT")?,
        Err(_) => {
            let _ = s.conn.execute_batch("ROLLBACK");
        }
    }
    s.capture_source.set("t3_sqlite_v2");
    result?;
    Ok(
        json!({"now":iso(now),"records":fx.counts,"first_record_at":iso(fx.day(148, 9, 0)),"capture_gap":[iso(fx.day(121, 22, 0)),iso(fx.day(105, 8, 0))]}),
    )
}

fn fill(fx: &mut Fx) -> Result<()> {
    let p: Vec<String> = PROJECTS.iter().map(|n| Fx::project_id(n)).collect();
    fx.put("instance", &fx.instance.clone(), "", "", "", DateTime::<Utc>::UNIX_EPOCH, DateTime::<Utc>::UNIX_EPOCH, json!({"display_name":"Fixture instance","connection_type":"sqlite_readonly","capabilities":["projects","threads","runs","messages","tools","agents"],"quota":"unavailable","version":VERSION}))?;
    for (i, name) in PROJECTS.iter().enumerate() {
        let at = if i < 4 {
            fx.day(149, 8, 0)
        } else {
            fx.day(89, 8, 0)
        };
        fx.project(name, at)?;
    }

    // Session-log hours, before and after the capture gap. Nothing else exists before day 88.
    fx.s.capture_source.set(crate::session_logs::SOURCE);
    for n in (45..=148).rev().filter(|n| !(106..=120).contains(n)) {
        let project = p[(n as usize) % 4].clone();
        for h in [9, 11, 14, 16] {
            if n == 121 && h > 16 {
                continue;
            }
            let input = fx.between(1_800_000, 4_200_000);
            let output = fx.between(20_000, 70_000);
            let reasoning = fx.between(4_000, 16_000);
            fx.log_hour(
                fx.day(n, h, 0),
                "gpt-5.5-codex",
                &project,
                input,
                72,
                0,
                output,
                reasoning,
            )?;
        }
        for h in [10, 15] {
            let input = fx.between(900_000, 2_100_000);
            let written = fx.between(20_000, 90_000);
            let output = fx.between(9_000, 32_000);
            fx.log_hour(
                fx.day(n, h, 0),
                "claude-opus-5-5",
                &project,
                input,
                80,
                written,
                output,
                0,
            )?;
        }
        if n % 2 == 0 {
            let input = fx.between(400_000, 1_500_000);
            let output = fx.between(5_000, 15_000);
            fx.log_hour(
                fx.day(n, 13, 0),
                "grok-4.3",
                &project,
                input,
                50,
                0,
                output,
                0,
            )?;
        }
    }
    // The last hour before the gap, so the gap starts at 22:00 on day 121.
    let input = fx.between(1_000_000, 2_000_000);
    fx.log_hour(
        fx.day(121, 21, 0),
        "gpt-5.5-codex",
        &p[1].clone(),
        input,
        70,
        0,
        30_000,
        8_000,
    )?;
    fx.s.capture_source.set("t3_sqlite_v2");

    // The provider-turn era, a few runs a day at fixed hours.
    use Usage::*;
    for n in (3..=88).rev() {
        let pa = p[((n * 7) % 12) as usize].clone();
        let pb = p[((n * 3 + 1) % 4) as usize].clone();
        let pick = |j: i64| {
            let m = ROTATION[((n * 5 + j) % ROTATION.len() as i64) as usize];
            // Sonnet sits out every seventh day, so a day with no Sonnet at all exists.
            if m == Some("claude-sonnet-5-5") && n % 7 == 0 {
                Some("claude-haiku-5-5")
            } else {
                m
            }
        };
        let unnamed = |j: i64| if j % 2 == 0 { "codex" } else { "claudeAgent" };
        let a = fx.thread(&pa, fx.day(n, 8, 0), pick(0), None, None)?;
        for (j, h) in [(0, 8), (1, 10), (2, 13)] {
            if j == 2 && n % 4 == 0 {
                continue;
            }
            let m = pick(j);
            // Opus occasionally leaves one turn unreported, so its total is a lower bound.
            let turns: &[Usage] = if m == Some("claude-opus-5-5") && n % 10 == 4 {
                &[Complete, Unavailable]
            } else if j == 1 {
                &[Complete, Complete, Complete]
            } else {
                &[Complete, Complete]
            };
            fx.simple(&a, &pa, fx.day(n, h, 0), m, unnamed(j), turns)?;
        }
        match n % 3 {
            0 => {
                fx.simple(
                    &a,
                    &pa,
                    fx.day(n, 11, 30),
                    Some("grok-4.7"),
                    "grok",
                    &[Unavailable],
                )?;
            }
            1 => {
                fx.simple(
                    &a,
                    &pa,
                    fx.day(n, 12, 30),
                    Some("muse-wonder-1.0"),
                    "muse",
                    &[Partial],
                )?;
            }
            _ => {
                let children = 2 + (n % 4) as usize;
                fx.tree(
                    &pa,
                    fx.day(n, 16, 0),
                    if n % 2 == 0 {
                        "gpt-6.1-sol"
                    } else {
                        "claude-opus-5-5"
                    },
                    children,
                    n % 6 == 2,
                    n % 9 == 2,
                    n % 4 == 1,
                )?;
            }
        }
        if n % 4 == 2 {
            fx.simple(
                &a,
                &pa,
                fx.day(n, 9, 20),
                Some("gemini-3-pro"),
                "gemini",
                &[Complete, Complete],
            )?;
        }
        let b = fx.thread(&pb, fx.day(n, 15, 0), pick(3), None, None)?;
        for (j, h) in [(3, 15), (4, 21)] {
            if j == 4 && n % 5 == 0 {
                continue;
            }
            fx.simple(
                &b,
                &pb,
                fx.day(n, h, 0),
                pick(j),
                unnamed(j),
                &[Complete, Complete],
            )?;
        }
        if n % 6 == 1 {
            fx.simple(
                &b,
                &pb,
                fx.day(n, 14, 10),
                Some("o9-mini"),
                "codex",
                &[Complete],
            )?;
        }
    }

    // One older delegation that never finished.
    let root = fx.thread(
        &p[2].clone(),
        fx.day(50, 17, 0),
        Some("gpt-6.1-sol"),
        None,
        None,
    )?;
    let run = fx.simple(
        &root,
        &p[2].clone(),
        fx.day(50, 17, 0),
        Some("gpt-6.1-sol"),
        "codex",
        &[Complete],
    )?;
    fx.child(
        &root,
        &root,
        &run,
        &p[2].clone(),
        fx.day(50, 17, 4),
        1,
        "claude-haiku-5-5",
        "running",
        None,
        None,
    )?;

    // Day 8, 17:00-21:00 UTC: an evening where Opus ran at 18:45 and reported nothing, and a Muse turn reported only parts.
    let pe = p[0].clone();
    let ev = fx.thread(&pe, fx.day(8, 17, 5), Some("gpt-6.1-sol"), None, None)?;
    for (h, m, model, turns) in [
        (17, 5, "gpt-6.1-sol", &[Complete, Complete][..]),
        (17, 25, "claude-opus-5-5", &[Complete][..]),
        (18, 10, "gpt-6.1-sol", &[Complete, Complete][..]),
        (18, 30, "muse-wonder-1.0", &[Partial][..]),
        (18, 45, "claude-opus-5-5", &[Unavailable][..]),
        (19, 2, "claude-opus-5-5", &[Complete][..]),
        (19, 10, "gpt-6.1-sol", &[Complete][..]),
        (19, 17, "claude-opus-5-5", &[Complete][..]),
        (19, 32, "claude-opus-5-5", &[Complete][..]),
        (20, 15, "gpt-6.1-sol", &[Complete, Complete][..]),
        (20, 30, "claude-sonnet-5-5", &[Complete][..]),
    ] {
        fx.simple(&ev, &pe, fx.day(8, h, m), Some(model), "codex", turns)?;
    }

    // Day 21, 00:00-07:00 UTC: the 03:00 hour has only turns that reported nothing, so a total line breaks there.
    let br = fx.thread(
        &p[1].clone(),
        fx.day(21, 1, 10),
        Some("gpt-6.1-sol"),
        None,
        None,
    )?;
    fx.simple(
        &br,
        &p[1].clone(),
        fx.day(21, 1, 10),
        Some("gpt-6.1-sol"),
        "codex",
        &[Complete, Complete],
    )?;
    fx.simple(
        &br,
        &p[1].clone(),
        fx.day(21, 3, 20),
        Some("grok-4.7"),
        "grok",
        &[Unavailable, Unavailable],
    )?;
    fx.simple(
        &br,
        &p[1].clone(),
        fx.day(21, 5, 15),
        Some("claude-opus-5-5"),
        "codex",
        &[Complete],
    )?;

    // Day 27, early morning UTC: a burst of turns that reported nothing, so too few turns reported for a percentage.
    let bu = fx.thread(
        &p[3].clone(),
        fx.day(27, 2, 0),
        Some("grok-4.7"),
        None,
        None,
    )?;
    for i in 0..12 {
        fx.simple(
            &bu,
            &p[3].clone(),
            fx.day(27, 2, 15 * i),
            Some("grok-4.7"),
            "grok",
            &[Unavailable],
        )?;
    }

    // Day 2, 11:00 UTC: a thread with one turn that reported a total and one that did not.
    let lb = fx.thread(
        &p[4].clone(),
        fx.day(2, 11, 0),
        Some("claude-opus-5-5"),
        None,
        Some("Measure the partly reported totals".into()),
    )?;
    fx.simple(
        &lb,
        &p[4].clone(),
        fx.day(2, 11, 0),
        Some("claude-opus-5-5"),
        "codex",
        &[Complete, Unavailable],
    )?;
    fx.simple(
        &lb,
        &p[4].clone(),
        fx.day(2, 18, 10),
        Some("claude-opus-5-5"),
        "codex",
        &[Complete],
    )?;

    // Day 1, 03:15 UTC: the same child is delegated to twice.
    let pr = p[5].clone();
    let rr = fx.thread(&pr, fx.day(1, 3, 12), Some("gpt-6.1-sol"), None, None)?;
    let rrun = fx.run(Run {
        thread: &rr,
        project: &pr,
        at: fx.day(1, 3, 12),
        model: Some("gpt-6.1-sol"),
        unnamed_driver: "codex",
        turns: &[Complete],
        subagent_task: false,
        has_subagents: true,
        tools: 1,
    })?;
    let (kid, _, _) = fx.child(
        &rr,
        &rr,
        &rrun,
        &pr,
        fx.day(1, 3, 15),
        1,
        "claude-haiku-5-5",
        "completed",
        Some(true),
        None,
    )?;
    fx.agent(
        &rr,
        &pr,
        &rrun,
        fx.day(1, 3, 30),
        Some(&kid),
        "claude-haiku-5-5",
        "completed",
        Some(true),
        None,
    )?;

    // The last 72 hours: a run every 90 minutes, a thread per four runs, and a few delegations.
    let mut thread = String::new();
    for k in (0..48i64).rev() {
        let at = fx.ago(k * 90 + 7);
        let project = p[((k / 4) % 6) as usize].clone();
        if thread.is_empty() || k % 4 == 3 {
            thread = fx.thread(&project, at, ROTATION[(k % 11) as usize], None, None)?;
        }
        let (model, turns): (Option<&str>, &[Usage]) = match k {
            5 | 30 => (Some("grok-4.7"), &[Unavailable]),
            9 | 40 => (Some("muse-wonder-1.0"), &[Partial]),
            _ => (ROTATION[(k % 11) as usize], &[Complete, Complete]),
        };
        fx.simple(
            &thread,
            &project,
            at,
            model,
            if k % 2 == 0 { "codex" } else { "claudeAgent" },
            turns,
        )?;
        if [3, 14, 26, 37].contains(&k) {
            fx.tree(
                &project,
                at + Duration::minutes(2),
                if k % 2 == 0 {
                    "gpt-6.1-sol"
                } else {
                    "claude-opus-5-5"
                },
                2 + (k % 3) as usize,
                k == 14,
                k == 26,
                k == 3,
            )?;
        }
    }
    // A tree that started 30 hours ago and delegated again 4 hours ago, so the last day holds only part of it.
    let pt = p[6].clone();
    let sr = fx.thread(&pt, fx.ago(30 * 60), Some("claude-opus-5-5"), None, None)?;
    let srun = fx.run(Run {
        thread: &sr,
        project: &pt,
        at: fx.ago(30 * 60),
        model: Some("claude-opus-5-5"),
        unnamed_driver: "codex",
        turns: &[Complete, Complete],
        subagent_task: false,
        has_subagents: true,
        tools: 1,
    })?;
    fx.child(
        &sr,
        &sr,
        &srun,
        &pt,
        fx.ago(30 * 60 - 4),
        1,
        "claude-haiku-5-5",
        "completed",
        Some(true),
        None,
    )?;
    fx.child(
        &sr,
        &sr,
        &srun,
        &pt,
        fx.ago(29 * 60),
        1,
        "gpt-6.1-sol",
        "completed",
        Some(true),
        None,
    )?;
    let srun2 = fx.simple(
        &sr,
        &pt,
        fx.ago(4 * 60),
        Some("claude-opus-5-5"),
        "codex",
        &[Complete],
    )?;
    fx.child(
        &sr,
        &sr,
        &srun2,
        &pt,
        fx.ago(4 * 60 - 3),
        1,
        "claude-haiku-5-5",
        "failed",
        None,
        None,
    )?;
    // Four more runs inside the last hour.
    let last = fx.thread(&p[0].clone(), fx.ago(55), Some("gpt-6.1-sol"), None, None)?;
    for (m, model, drv) in [
        (55, Some("gpt-6.1-sol"), "codex"),
        (41, None, "codex"),
        (25, Some("claude-opus-5-5"), "codex"),
        (12, Some("claude-sonnet-5-5"), "codex"),
    ] {
        fx.simple(&last, &p[0].clone(), fx.ago(m), model, drv, &[Complete])?;
    }

    // Requests that came in from an outside tool.
    for (i, k) in [(1, 6), (2, 20)] {
        let at = fx.ago(k * 90 + 7);
        let id = format!("fixture-request-{i}");
        fx.put("external_request", &id, &p[0].clone(), "", "", at, at, json!({"external_source":"fixture","external_request_id":id,"external_thread_id":format!("fixture-external-{i}"),"t3_thread_id":null,"t3_project_id":p[0],"requested_at":iso(at),"submitted_at":null,"originating_user_fingerprint":privacy::hash("fixture-user"),"originating_device":null,"status":"completed"}))?;
    }

    // Quota. Codex reports a 5-hour and a weekly window on every turn; Claude Code's latest 5-hour and 7-day reading.
    let now = fx.now;
    for k in 0..5i64 {
        let reset = now + Duration::hours(2) - Duration::hours(5 * k);
        let start = reset - Duration::hours(5);
        for j in 0..7i64 {
            let at = start + Duration::minutes(20 + 40 * j);
            if at > now - Duration::minutes(4) {
                break;
            }
            let used = if k == 2 {
                (40.0 + 12.0 * j as f64).min(100.0)
            } else {
                8.0 + (k as f64) * 6.0 + 7.0 * j as f64
            };
            fx.quota_sample(
                "codex",
                "five_hour",
                at,
                used,
                reset,
                300,
                Some("pro"),
                "codex_session_log",
            )?;
            if k == 2 && used >= 100.0 {
                fx.quota_event("codex", at, "primary", None, "codex_session_log")?;
            }
        }
    }
    let weekly = now + Duration::days(3);
    for j in 0..8i64 {
        fx.quota_sample(
            "codex",
            "weekly",
            now - Duration::hours(96) + Duration::hours(12 * j),
            10.0 + 5.0 * j as f64,
            weekly,
            10_080,
            Some("pro"),
            "codex_session_log",
        )?;
    }
    for j in 0..6i64 {
        fx.quota_sample(
            "codex",
            "weekly",
            weekly - Duration::days(14) + Duration::days(1) + Duration::hours(24 * j),
            30.0 + 12.0 * j as f64,
            weekly - Duration::days(7),
            10_080,
            Some("pro"),
            "codex_session_log",
        )?;
    }
    let five = now + Duration::minutes(90);
    for j in 0..7i64 {
        fx.quota_sample(
            "claude",
            "five_hour",
            now - Duration::minutes(200) + Duration::minutes(30 * j),
            40.0 + 5.0 * j as f64,
            five,
            300,
            None,
            "claude_usage_cache",
        )?;
    }
    let past = five - Duration::hours(5);
    for j in 0..5i64 {
        fx.quota_sample(
            "claude",
            "five_hour",
            past - Duration::minutes(250) + Duration::minutes(50 * j),
            (55.0 + 12.0 * j as f64).min(100.0),
            past,
            300,
            None,
            "claude_usage_cache",
        )?;
    }
    fx.quota_event(
        "claude",
        past - Duration::minutes(40),
        "five_hour",
        Some(past),
        "claude_session_log",
    )?;
    fx.quota_event(
        "claude",
        past - Duration::minutes(25),
        "five_hour",
        Some(past),
        "claude_session_log",
    )?;
    let seven = now + Duration::days(4);
    for j in 0..4i64 {
        fx.quota_sample(
            "claude",
            "seven_day",
            now - Duration::hours(72) + Duration::hours(24 * j) - Duration::minutes(10),
            30.0 + 8.0 * j as f64,
            seven,
            10_080,
            None,
            "claude_usage_cache",
        )?;
    }

    // One finished sync, so Data Quality has a checkpoint to show.
    fx.s.conn.execute(
        "INSERT INTO checkpoints VALUES (?,?,?)",
        duckdb::params![
            fx.instance,
            iso(now - Duration::minutes(2)),
            iso(now - Duration::minutes(1))
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analytics::{Filter, query};

    fn store(dir: &std::path::Path) -> Store {
        let toml = format!(
            "[server]\nhost='127.0.0.1'\nport=1\n[dashboard]\ntimezone='UTC'\n[storage]\nduckdb_path='{}'\narchive_path='{}'\nhot_retention_days=30\ncontent_retention_days=90\nzstd_level=3\n[capture]\ndefault_policy='redacted_only'\nstore_stream_chunks=false\n[source]\ninstance_id='local'\ndisplay_name='x'\nsqlite_path='none'\npoll_seconds=60\n",
            dir.join("db.duckdb").to_string_lossy().replace('\\', "/"),
            dir.join("archive").to_string_lossy().replace('\\', "/")
        );
        let c: crate::config::Config = toml::from_str(&toml).unwrap();
        Store::open(&c).unwrap()
    }

    #[test]
    fn the_same_instant_builds_the_same_history() {
        let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let now = "2026-11-08T13:37:00.000Z";
        // The two builds are independent databases, so they run side by side; one after the other doubled the test's time.
        let (sa, sb) = std::thread::scope(|scope| {
            let one = scope.spawn(|| {
                let s = store(a.path());
                build(&s, "local", now).unwrap();
                s
            });
            let s = store(b.path());
            build(&s, "local", now).unwrap();
            (one.join().unwrap(), s)
        });
        let digest = |s: &Store| -> Vec<(String, String)> {
            s.conn
                .prepare("SELECT id,payload_hash FROM records ORDER BY id")
                .unwrap()
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .unwrap()
                .map(|r| r.unwrap())
                .collect()
        };
        assert_eq!(digest(&sa), digest(&sb));
        assert!(
            build(&sa, "local", now).is_err(),
            "a second build refuses a filled database"
        );
        let last: String = sa
            .conn
            .query_row("SELECT max(occurred_at) FROM records", [], |r| r.get(0))
            .unwrap();
        assert!(last.as_str() <= now);
    }

    #[test]
    fn every_shape_the_dashboard_tests_read_is_there() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path());
        build(&s, "local", "2026-11-08T01:00:00.000Z").unwrap();
        let models = query(&s, "models", &Filter::default()).unwrap();
        let names: Vec<&str> = models["data"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|m| m["model"].as_str())
            .collect();
        for m in [
            "gpt-6.1-sol",
            "gpt-5.5-codex",
            "o9-mini",
            "claude-opus-5-5",
            "claude-sonnet-5-5",
            "claude-haiku-5-5",
            "grok-4.7",
            "grok-4.3",
            "muse-spark-2",
            "muse-wonder-1.0",
            "gemini-3-pro",
        ] {
            assert!(names.contains(&m), "{m} missing");
        }
        assert!(
            models["data"]
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m["model"].is_null() && m["observed_provider_turns"].as_i64() > Some(0))
        );
        let n = |sql: &str| -> i64 { s.conn.query_row(sql, [], |r| r.get(0)).unwrap() };
        assert!(
            n(
                "SELECT count(*) FROM records WHERE kind='model_turn' AND model IS NULL AND agent_provider IS NULL"
            ) == 0,
            "every unnamed turn has a driver"
        );
        assert!(
            n(
                "SELECT count(*) FROM records WHERE kind='tool' AND tool_category='shell' AND exit_code<>0"
            ) > 0
        );
        assert!(n("SELECT count(*) FROM records WHERE kind='agent' AND status='failed'") > 0);
        assert!(
            n(
                "SELECT count(*) FROM records WHERE kind='agent' AND json_extract_string(data,'$.result_returned_to_parent')='true'"
            ) > 0
        );
        assert!(
            n(
                "SELECT count(DISTINCT category) FROM (SELECT unnest(json_extract_string(data,'$.redaction_categories[*]')) category FROM records)"
            ) >= 4
        );
        assert!(n("SELECT count(*) FROM records WHERE capture_source='session_logs'") > 100);
        assert!(n("SELECT count(*) FROM quota_events") >= 2);
        // The gap: nothing between day 121 22:00 and day 105 08:00.
        assert_eq!(
            n(
                "SELECT count(*) FROM records WHERE kind<>'instance' AND kind<>'project' AND occurred_at>'2026-07-10T22:00:00.000Z' AND occurred_at<'2026-07-26T08:00:00.000Z'"
            ),
            0
        );
        let current = query(&s, "quota/current", &Filter::default()).unwrap();
        assert_eq!(current["data"].as_array().unwrap().len(), 4);
    }
}
