use anyhow::Result;
use serde_json::{Value, json};
use t3ui_core::{
    analytics::{self, Filter},
    storage::Store,
};
pub const TOOLS: &[(&str, &str)] = &[
    ("analytics_overview", "overview"),
    ("usage_by_hour", "activity/hourly"),
    ("usage_by_model", "models"),
    ("usage_by_project", "usage/projects"),
    ("usage_by_machine", "usage/machines"),
    ("quota_current", "quota/current"),
    ("quota_history", "quota/windows"),
    ("quota_waste", "quota/resets"),
    ("list_projects", "projects"),
    ("get_project", "projects"),
    ("list_threads", "threads"),
    ("get_thread", "threads"),
    ("get_thread_timeline", "timeline"),
    ("get_agent_tree", "agents"),
    ("list_tool_calls", "tool-calls"),
    ("search_conversations", "search"),
    ("compare_models", "models"),
    ("compare_projects", "usage/projects"),
    ("data_quality_report", "data-quality"),
    ("storage_statistics", "storage"),
];
pub fn schema() -> Value {
    json!({"type":"object","additionalProperties":false,"properties":{"include_content":{"type":"boolean"},"limit":{"type":"integer","minimum":1,"maximum":500},"offset":{"type":"integer","minimum":0,"maximum":1000000},"project":{"type":"string"},"model":{"type":"string"},"instance":{"type":"string"},"since":{"type":"string","format":"date-time"},"until":{"type":"string","format":"date-time"},"q":{"type":"string","maxLength":500},"id":{"type":"string"}}})
}
const PROMPTS: &[&str] = &[
    "analyse-my-day",
    "analyse-my-week",
    "compare-model-efficiency",
    "analyse-subagent-behaviour",
    "find-unused-quota",
    "review-project-usage",
    "investigate-failed-runs",
    "identify-data-quality-gaps",
];
pub fn serve_remote(c: &t3ui_core::config::Config) -> Result<()> {
    let local = Store::open(c).ok();
    let base = format!("http://{}:{}/api/v1", c.server.host, c.server.port);
    if local.is_none() {
        let client: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(std::time::Duration::from_secs(5)))
            .build()
            .into();
        let health: Value = client
            .get(format!(
                "http://{}:{}/health/ready",
                c.server.host, c.server.port
            ))
            .call()?
            .body_mut()
            .read_json()?;
        anyhow::ensure!(
            health["storage_identity"].as_str() == Some(c.storage_identity()?.as_str()),
            "MCP proxy refused: running service does not own the configured analytics database"
        );
    }
    serve(local.as_ref(), &base)
}
pub fn serve(s: Option<&Store>, base: &str) -> Result<()> {
    use std::io::{BufRead, Write};
    for line in std::io::stdin().lock().lines() {
        let line = line?;
        anyhow::ensure!(line.len() <= 1024 * 1024, "MCP input exceeds 1 MiB");
        let r: Value = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let Some(id) = r.get("id") else { continue };
        println!(
            "{}",
            match dispatch(s, base, &r) {
                Ok(v) => json!({"jsonrpc":"2.0","id":id,"result":v}),
                Err(_) =>
                    json!({"jsonrpc":"2.0","id":id,"error":{"code":-32602,"message":"Invalid request. Only redacted read-only analytics is authorized."}}),
            }
        );
        std::io::stdout().flush()?;
    }
    Ok(())
}
pub fn dispatch(s: Option<&Store>, base: &str, r: &Value) -> Result<Value> {
    let p = &r["params"];
    Ok(match r["method"].as_str().unwrap_or("") {
        "initialize" => {
            json!({"protocolVersion":"2024-11-05","capabilities":{"tools":{},"resources":{},"prompts":{}},"serverInfo":{"name":"t3-usage-intelligence","version":"0.1.0"},"instructions":"Read-only redacted analytics. Null means unavailable; full-content scope unsupported."})
        }
        "ping" => json!({}),
        "tools/list" => {
            json!({"tools":TOOLS.iter().map(|(n,_)|json!({"name":n,"description":"Read-only redacted T3 usage. Missing telemetry is null. Up to 500 rows.","inputSchema":schema()})).collect::<Vec<_>>()})
        }
        "tools/call" => {
            let op = TOOLS
                .iter()
                .find(|(n, _)| Some(*n) == p["name"].as_str())
                .ok_or_else(|| anyhow::anyhow!("Unknown tool"))?
                .1;
            let f: Filter =
                serde_json::from_value(p.get("arguments").cloned().unwrap_or(json!({})))?;
            json!({"content":[{"type":"text","text":query(s,base,op,&f)?.to_string()}],"isError":false})
        }
        "resources/list" => {
            json!({"resources":(["overview","projects","quota/current","quota/resets","data-quality"].iter().map(|x|json!({"uri":format!("t3analytics://{x}"),"name":x,"mimeType":"application/json"})).collect::<Vec<_>>())})
        }
        "resources/templates/list" => {
            json!({"resourceTemplates":(["projects/{project_id}","threads/{thread_id}","agents/{agent_run_id}"].iter().map(|x|json!({"uriTemplate":format!("t3analytics://{x}"),"name":x,"mimeType":"application/json"})).collect::<Vec<_>>())})
        }
        "resources/read" => {
            let uri = p["uri"].as_str().unwrap_or("");
            let path = uri
                .strip_prefix("t3analytics://")
                .ok_or_else(|| anyhow::anyhow!("Invalid URI"))?;
            let mut f = Filter::default();
            let (op, id) = path.split_once('/').unwrap_or((path, ""));
            let route = if ["projects", "threads", "agents"].contains(&op) && !id.is_empty() {
                f.id = Some(id.into());
                op
            } else {
                path
            };
            json!({"contents":[{"uri":uri,"mimeType":"application/json","text":query(s,base,route,&f)?.to_string()}]})
        }
        "prompts/list" => {
            json!({"prompts":PROMPTS.iter().map(|n|json!({"name":n,"description":"Analyse observed usage with explicit telemetry gaps"})).collect::<Vec<_>>()})
        }
        "prompts/get" => {
            let name = p["name"].as_str().unwrap_or("");
            anyhow::ensure!(PROMPTS.contains(&name), "Unknown prompt");
            json!({"messages":[{"role":"user","content":{"type":"text","text":format!("Perform {name} using analytics tools. State range/timezone. Treat null as unknown. Distinguish complete quota windows. Behavioural proxies are not quality measurements.")}}]})
        }
        _ => anyhow::bail!("Unsupported method"),
    })
}
fn query(s: Option<&Store>, base: &str, op: &str, f: &Filter) -> Result<Value> {
    if let Some(s) = s {
        return analytics::query(s, op, f);
    }
    f.validate()?;
    let mut request = ureq::get(format!("{base}/{op}"));
    let value = serde_json::to_value(f)?;
    for (k, v) in value.as_object().unwrap() {
        if !v.is_null() {
            let text = v.as_str().map(str::to_string).unwrap_or(v.to_string());
            request = request.query(k, &text);
        }
    }
    Ok(request.call()?.body_mut().read_json::<Value>()?)
}

#[cfg(test)]
mod tests {
    #[test]
    fn strict_schema() {
        assert_eq!(super::schema()["additionalProperties"], false);
        assert_eq!(super::TOOLS.len(), 20);
    }
}
