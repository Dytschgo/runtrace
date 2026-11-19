use crate::storage::Store;
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Filter {
    pub limit: Option<u32>,
    pub offset: Option<u32>,
    pub project: Option<String>,
    pub model: Option<String>,
    /// A provider family (openai, anthropic, xai, meta, google, qwen, other), worked out per record as the dashboard does.
    pub provider: Option<String>,
    /// The agent program that ran a record (codex, claudeAgent, grok…), as T3 names its provider instance.
    /// A turn or run matches by its own; anything else by the thread it ran in, so prompts, tools and sub-agents follow.
    pub harness: Option<String>,
    pub instance: Option<String>,
    /// Status of the containing run. Metadata rows match related runs on the same machine.
    #[serde(rename = "run_status")]
    pub status: Option<String>,
    pub since: Option<String>,
    pub until: Option<String>,
    pub q: Option<String>,
    pub id: Option<String>,
    pub include_content: Option<bool>,
    /// One record kind, for the timeline only.
    pub kind: Option<String>,
    /// "lean" returns provider turns with only the fields the dashboard reads, about half the bytes of the stored document.
    pub shape: Option<String>,
}
impl Filter {
    pub fn validate(&self) -> Result<()> {
        // A preview page is the same price at any size, see below.
        // Reading the stored records costs about the same for 500 rows as for 20,000, so pages of previews may be large.
        // Full content stays in small pages, because that is what can be big.
        let most = if self.include_content == Some(true) {
            500
        } else {
            20_000
        };
        ensure!(
            (1..=most).contains(&self.limit.unwrap_or(100)),
            "limit must be <= 500, or <= 20000 without full content"
        );
        ensure!(self.offset.unwrap_or(0) <= 1_000_000, "offset too large");
        ensure!(
            self.kind.as_ref().is_none_or(
                |k| k.len() <= 32 && k.chars().all(|c| c.is_ascii_lowercase() || c == '_')
            ),
            "kind must be a record kind"
        );
        for d in [&self.since, &self.until].into_iter().flatten() {
            chrono::DateTime::parse_from_rfc3339(d)?;
        }
        ensure!(
            self.shape.as_deref().is_none_or(|s| s == "lean"),
            "shape must be lean"
        );
        ensure!(
            self.provider
                .as_ref()
                .is_none_or(|p| p.len() <= 32 && p.chars().all(|c| c.is_ascii_lowercase())),
            "provider must be a provider family"
        );
        ensure!(
            self.harness
                .as_ref()
                .is_none_or(|h| (1..=64).contains(&h.len())
                    && h.chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')),
            "harness must be a provider instance name"
        );
        ensure!(
            self.status
                .as_deref()
                .is_none_or(|s| ["running", "completed", "failed", "cancelled"].contains(&s)),
            "status must be running, completed, failed or cancelled"
        );
        ensure!(
            self.q.as_ref().is_none_or(|q| q.len() <= 500),
            "Search must be <= 500 characters"
        );
        Ok(())
    }
}
/// The agent that ran a record, from its own field or from a provider thread id such as provider-thread:provider:codex:native-thread:abc.
/// agent_provider is stored from the record's own field or its provider thread id; the thread it ran in is the last resort.
const DRIVER: &str = "coalesce(agent_provider,nullif(regexp_extract(coalesce(thread_id,''),'(?:^|:)provider:([^:]+)',1),''))";

/// A record's provider family. The model name decides when it is recorded, otherwise the agent that ran it does.
/// This matches modelProvider and turnProvider in the dashboard, so a provider's rows and its counts agree.
pub fn provider_sql() -> String {
    format!(
        "CASE WHEN nullif(model,'') IS NOT NULL THEN CASE WHEN regexp_matches(model,'(?i)^(gpt|codex|o[0-9]|chatgpt)') THEN 'openai' WHEN regexp_matches(model,'(?i)claude') THEN 'anthropic' WHEN regexp_matches(model,'(?i)grok') THEN 'xai' WHEN regexp_matches(model,'(?i)muse|llama') THEN 'meta' WHEN regexp_matches(model,'(?i)gemini') THEN 'google' WHEN regexp_matches(model,'(?i)qwen') THEN 'qwen' ELSE 'other' END WHEN {DRIVER} IS NULL THEN NULL WHEN {DRIVER}='codex' THEN 'openai' WHEN {DRIVER} IN ('claudeAgent','claude') THEN 'anthropic' WHEN {DRIVER}='grok' THEN 'xai' WHEN {DRIVER}='muse' THEN 'meta' WHEN {DRIVER} IN ('gemini','antigravity') THEN 'google' ELSE 'other' END"
    )
}

/// Whether a record belongs to the harness given as the next three parameters. A turn or run by its own; a record of a run
/// (a prompt, answer, tool call or sub-agent) by that run's; anything else by the harness that ran most of its thread.
/// Each record belongs to one harness, so the counts of all harnesses add up to the whole.
fn harness_match() -> String {
    format!(
        "CASE WHEN kind IN ('model_turn','run') THEN {DRIVER} IS NOT DISTINCT FROM ?          WHEN nullif(run_id,'') IS NOT NULL AND (instance_id,run_id) IN (SELECT instance_id,source_id FROM records WHERE kind='run') THEN (instance_id,run_id) IN (SELECT instance_id,source_id FROM records WHERE kind='run' AND {DRIVER}=?)          ELSE (instance_id,thread_id) IN (SELECT instance_id,thread_id FROM (SELECT instance_id,thread_id,d,row_number() OVER (PARTITION BY instance_id,thread_id ORDER BY n DESC,d) rn FROM (SELECT instance_id,thread_id,{DRIVER} d,count(*) n FROM records WHERE kind IN ('model_turn','run') GROUP BY ALL HAVING d IS NOT NULL)) WHERE rn=1 AND d=?) END"
    )
}

pub fn query(s: &Store, name: &str, f: &Filter) -> Result<Value> {
    f.validate()?;
    let _snapshot = crate::cold::read_snapshot(s)?;
    let filter = format!(
        "(? IS NULL OR project_id=?) AND (? IS NULL OR instance_id=?) AND (? IS NULL OR runtrace_time_us(occurred_at)>=runtrace_time_us(?)) AND (? IS NULL OR runtrace_time_us(occurred_at)<=runtrace_time_us(?)) AND (? IS NULL OR model=?) AND (? IS NULL OR ({})=?) AND (? IS NULL OR {}) AND (? IS NULL OR EXISTS (SELECT 1 FROM records status_run WHERE status_run.kind='run' AND status_run.instance_id=records.instance_id AND status_run.status=? AND CASE records.kind WHEN 'run' THEN status_run.id=records.id WHEN 'thread' THEN status_run.thread_id=records.source_id WHEN 'project' THEN status_run.project_id=records.source_id WHEN 'instance' THEN true ELSE nullif(records.run_id,'')=status_run.source_id END))",
        provider_sql(),
        harness_match()
    );
    let filter = filter.as_str();
    let args: Vec<&dyn duckdb::ToSql> = vec![
        &f.project,
        &f.project,
        &f.instance,
        &f.instance,
        &f.since,
        &f.since,
        &f.until,
        &f.until,
        &f.model,
        &f.model,
        &f.provider,
        &f.provider,
        &f.harness,
        &f.harness,
        &f.harness,
        &f.harness,
        &f.status,
        &f.status,
    ];
    // Quota compares resets with now, which T3UI_NOW can pin for repeatable tests.
    let now = crate::storage::now_sql();
    let rows=match name{
 // Session-log hours are not provider turns, so they are never counted as records here.
 "overview"=>s.rows(&format!("SELECT json_object('kind',kind,'count',count(*))::VARCHAR FROM records WHERE {filter} AND NOT (kind='model_turn' AND capture_source IS NOT DISTINCT FROM 'session_logs') GROUP BY kind ORDER BY kind"),&args)?,
 "usage/efficiency"=>efficiency(s,filter,&args)?,
 // Session-log hours add their tokens but are never provider turns, so turn counts, coverage and latency leave them out.
 // Threads and sub-agents per model come in the same pass, so the Models page needs no query per model. A model is listed only when it ran.
 "models"=>s.rows(&format!("SELECT json_object('model',model,'calls',NULL,'observed_runs',count(*) FILTER(WHERE kind='run'),'observed_provider_turns',count(*) FILTER(WHERE kind='model_turn' AND capture_source IS DISTINCT FROM 'session_logs'),'session_log_blocks',count(*) FILTER(WHERE kind='model_turn' AND capture_source='session_logs'),'input_tokens',sum(CASE WHEN kind='model_turn' THEN input_tokens END),'cached_input_tokens',sum(CASE WHEN kind='model_turn' THEN cached_input_tokens END),'cache_write_tokens',sum(CASE WHEN kind='model_turn' THEN cache_write_tokens END),'cache_write_observed_turns',count(*) FILTER(WHERE kind='model_turn' AND capture_source IS DISTINCT FROM 'session_logs' AND cache_write_tokens IS NOT NULL),'output_tokens',sum(CASE WHEN kind='model_turn' THEN output_tokens END),'reasoning_tokens',sum(CASE WHEN kind='model_turn' THEN reasoning_tokens END),'total_tokens',sum(CASE WHEN kind='model_turn' THEN total_tokens END),'complete_usage_turns',count(*) FILTER(WHERE kind='model_turn' AND capture_source IS DISTINCT FROM 'session_logs' AND usage_status='complete'),'turns_with_usage',count(*) FILTER(WHERE kind='model_turn' AND capture_source IS DISTINCT FROM 'session_logs' AND (input_tokens IS NOT NULL OR cached_input_tokens IS NOT NULL OR output_tokens IS NOT NULL OR reasoning_tokens IS NOT NULL OR cache_write_tokens IS NOT NULL)),'median_latency_ms',median(duration_ms) FILTER(WHERE kind='model_turn' AND capture_source IS DISTINCT FROM 'session_logs'),'p95_latency_ms',quantile_cont(duration_ms,0.95) FILTER(WHERE kind='model_turn' AND capture_source IS DISTINCT FROM 'session_logs'),'observed_threads',count(*) FILTER(WHERE kind='thread'),'observed_agents',count(*) FILTER(WHERE kind='agent'),'capture_quality','partial')::VARCHAR FROM records WHERE kind IN ('run','model_turn','thread','agent') AND {filter} GROUP BY model HAVING count(*) FILTER(WHERE kind IN ('run','model_turn'))>0 ORDER BY count(*) FILTER(WHERE kind='run') DESC,model ASC NULLS LAST LIMIT 500"),&args)?,
 "activity/hourly"=>s.rows(&format!("SELECT json_object('hour',substr(occurred_at,1,13)||':00:00Z','prompts',count(*))::VARCHAR FROM records WHERE kind='prompt' AND {filter} GROUP BY substr(occurred_at,1,13) ORDER BY substr(occurred_at,1,13) LIMIT 500"),&args)?,
 "usage/projects"|"usage/machines"=>{let dimension=if name=="usage/projects"{"project_id"}else{"instance_id"};s.rows(&format!("SELECT json_object('dimension','{dimension}','identity',{dimension},'observed_threads',count(*) FILTER(WHERE kind='thread'),'observed_prompts',count(*) FILTER(WHERE kind='prompt'),'observed_answers',count(*) FILTER(WHERE kind='answer'),'observed_runs',count(*) FILTER(WHERE kind='run'),'observed_provider_turns',count(*) FILTER(WHERE kind='model_turn' AND capture_source IS DISTINCT FROM 'session_logs'),'reported_turns',count(total_tokens) FILTER(WHERE kind='model_turn' AND capture_source IS DISTINCT FROM 'session_logs'),'observed_tool_calls',count(*) FILTER(WHERE kind='tool'),'observed_agents',count(*) FILTER(WHERE kind='agent'),'input_tokens',sum(CASE WHEN kind='model_turn' THEN input_tokens END),'output_tokens',sum(CASE WHEN kind='model_turn' THEN output_tokens END),'total_tokens',sum(CASE WHEN kind='model_turn' THEN total_tokens END),'capture_quality','partial')::VARCHAR FROM records WHERE {filter} AND {dimension}<>'' GROUP BY {dimension} ORDER BY count(*) FILTER(WHERE kind='prompt') DESC,{dimension} ASC LIMIT 500"),&args)?},
 "usage/tools"=>s.rows(&format!("SELECT json_object('name',coalesce(tool_name,'Tool not recorded'),'category',CASE WHEN count(DISTINCT tool_category)>1 THEN 'mixed' ELSE coalesce(min(tool_category),'unknown') END,'calls',count(*),'failed',count(*) FILTER(WHERE status='failed'),'statusKnown',count(status),'p50',median(duration_ms),'p95',quantile_cont(duration_ms,0.95),'max',max(duration_ms),'timed',count(duration_ms),'chars',coalesce(sum(redacted_characters),0),'capture_quality','partial')::VARCHAR FROM records WHERE kind='tool' AND {filter} GROUP BY tool_name ORDER BY count(*) DESC,tool_name LIMIT 500"),&args)?,
 // One row summarising every tool call in the window, so headline rates never come from a sample.
 "usage/tool-summary"=>s.rows(&format!("SELECT json_object('calls',count(*),'failed',count(*) FILTER(WHERE status='failed'),'statusKnown',count(status),'p50',median(duration_ms),'p95',quantile_cont(duration_ms,0.95),'timed',count(duration_ms),'shell',count(*) FILTER(WHERE tool_category='shell'),'exitKnown',count(*) FILTER(WHERE tool_category='shell' AND exit_code IS NOT NULL),'nonZero',count(*) FILTER(WHERE tool_category='shell' AND exit_code<>0),'capture_quality','partial')::VARCHAR FROM records WHERE kind='tool' AND {filter}"),&args)?,
 // Tool calls per hour by status, so the daily chart covers the whole window rather than the calls loaded.
 "usage/tool-hours"=>s.rows(&format!("SELECT json_object('hour',substr(occurred_at,1,13)||':00:00Z','completed',count(*) FILTER(WHERE status='completed'),'cancelled',count(*) FILTER(WHERE status='cancelled'),'failed',count(*) FILTER(WHERE status='failed'),'running',count(*) FILTER(WHERE status='running'),'unknown',count(*) FILTER(WHERE status IS NULL OR status NOT IN ('completed','cancelled','failed','running')))::VARCHAR FROM records WHERE kind='tool' AND {filter} GROUP BY substr(occurred_at,1,13) ORDER BY substr(occurred_at,1,13) LIMIT 500"),&args)?,
 // Field coverage of every tool call and the redaction categories of every tool call and sub-agent, so Data Quality never measures a sample.
 // Each count matches how the dashboard reads a record: an empty string is not a value, and an unknown category is not a category.
 "data-quality/fields"=>{
    let tools=s.rows(&format!("SELECT json_object('calls',count(*),'duration',count(elapsed_ms),'status',count(nullif(status,'')),'category',count(*) FILTER(WHERE nullif(tool_category,'') IS NOT NULL AND tool_category<>'unknown'),'shell',count(*) FILTER(WHERE tool_category='shell'),'exit',count(*) FILTER(WHERE tool_category='shell' AND exit_code IS NOT NULL))::VARCHAR FROM records WHERE kind='tool' AND {filter}"),&args)?;
    let redactions=s.rows(&format!("SELECT json_object('category',category,'records',count(*))::VARCHAR FROM (SELECT DISTINCT id,unnest(json_extract_string(preview_doc,'$.redaction_categories[*]')) category FROM records WHERE kind IN ('tool','agent') AND {filter}) WHERE nullif(category,'') IS NOT NULL GROUP BY category ORDER BY count(*) DESC,category"),&args)?;
    return Ok(json!({"tools":tools.into_iter().next(),"redactions":redactions,"capture_quality":"partial","null_semantics":"null means unavailable, never zero"}));
 },
 "data-quality"=>{let data=s.rows(&format!("SELECT json_object('kind',kind,'capture_quality',capture_quality,'count',count(*))::VARCHAR FROM records WHERE {filter} GROUP BY kind,capture_quality ORDER BY kind"),&args)?;
 let checkpoints=s.rows("SELECT json_object('instance_id',instance_id,'source_updated_at',source_updated_at,'last_successful_sync_at',last_successful_sync_at)::VARCHAR FROM checkpoints",&[])?;
 let project_checkpoints=s.rows("SELECT json_object('instance_id',instance_id,'project_id',project_id,'source_updated_at',source_updated_at,'last_successful_sync_at',last_successful_sync_at)::VARCHAR FROM project_sync_checkpoints ORDER BY instance_id,project_id LIMIT 500",&[])?;
 let reports=s.rows("SELECT value FROM settings WHERE key LIKE 'import_report:%'",&[])?;
 let progress=s.rows("SELECT value FROM settings WHERE key LIKE 'collector_progress:%'",&[])?;
 let orphans:i64=s.conn.query_row(&format!("SELECT count(*) FROM (SELECT * FROM records WHERE {filter}) r LEFT JOIN records t ON t.kind='thread' AND t.instance_id=r.instance_id AND t.source_id=r.thread_id WHERE r.thread_id<>'' AND r.kind<>'thread' AND t.id IS NULL"),args.as_slice(),|r|r.get(0))?;
 let mut report=json!({"data":data,"capture_quality":"partial","checkpoints":checkpoints,"project_checkpoints":project_checkpoints,"import_reports":reports,"sync_progress":progress,"missing_thread_relationships":orphans,"unavailable_fields":["resolved_model","first_token_at","cost","historical_quota"],"partial_fields":["legacy_messages_without_terminal_runs","historical_tools","provider_turn_tokens","native_subagent_tokens"],"quota_status":"unsupported_adapter","null_semantics":"null means unavailable, never zero"});
 if f.instance.is_some() || f.status.is_some() {
   report["scope_reason"]=json!("Record coverage follows the selected machine and run status. Collector checkpoints and import reports remain installation-wide across all machines and run statuses.");
   report["collection_scope"]=json!("installation");
 }
 return Ok(report);},
 "storage"=>{
    if f.instance.is_none() && f.status.is_none() {return s.stats();}
    let counts=s.rows(&format!("SELECT json_object('table',kind,'rows',count(*))::VARCHAR FROM records WHERE {filter} GROUP BY kind ORDER BY kind"),&args)?;
    let content=s.rows(&format!("SELECT json_object('redacted_content_characters',coalesce(sum(redacted_characters),0),'normalized_json_characters',coalesce(sum(json_characters),0),'oldest_at',min(occurred_at) FILTER(WHERE kind<>'instance'),'newest_at',max(occurred_at) FILTER(WHERE kind<>'instance'))::VARCHAR FROM records WHERE {filter}"),&args)?;
    let mut result=s.stats()?;
    if let Some(content)=content.into_iter().next() {for (key,value) in content.as_object().unwrap() {result[key]=value.clone();}}
    result["rows"]=json!(counts);
    result["scope_reason"]=json!("Logical records match the selected machine and run status. File sizes, archive segments, maintenance and event-history totals remain installation-wide across all machines and run statuses.");
    result["physical_scope"]=json!("installation");
    return Ok(result);
 },
 // The latest reading per provider and window. Once its reset has passed, what is left is unknown until the next reading.
 "quota/current"=>s.rows(&format!("SELECT json_object('provider',provider,'window',window_kind,'used_percentage',used_percent,'remaining_percentage',CASE WHEN runtrace_time_us(reset_at)>{now} THEN 100-used_percent END,'reset_at',reset_at,'reset_passed',runtrace_time_us(reset_at)<={now},'window_minutes',window_minutes,'sampled_at',sampled_at,'plan',plan,'source',source,'capture_quality','partial')::VARCHAR FROM (SELECT *,row_number() OVER (PARTITION BY provider,window_kind ORDER BY sampled_at DESC) rn FROM quota_samples) WHERE rn=1 ORDER BY provider,window_kind"),&[])?,
 // One row per window that reset or will reset. The last reading before a reset is the most that is known to have been used.
 "quota/windows"=>window_coverage(s,s.rows(&format!("WITH w AS (SELECT provider,window_kind,reset_at,max(used_percent) peak,arg_max(used_percent,sampled_at) last_used,min(sampled_at) first_at,max(sampled_at) last_at,count(*) n,any_value(window_minutes) window_minutes,list(sampled_at ORDER BY sampled_at) times FROM quota_samples GROUP BY provider,window_kind,reset_at), e AS (SELECT *, runtrace_time_us(reset_at)<={now} OR EXISTS (SELECT 1 FROM w later WHERE later.provider=w.provider AND later.window_kind=w.window_kind AND later.first_at>w.last_at AND later.reset_at<>w.reset_at) ended, CASE WHEN runtrace_time_us(reset_at)>{now} THEN (SELECT min(later.first_at) FROM w later WHERE later.provider=w.provider AND later.window_kind=w.window_kind AND later.first_at>w.last_at AND later.reset_at<>w.reset_at) END ended_early_at FROM w) SELECT json_object('provider',provider,'window',window_kind,'reset_at',reset_at,'ended',ended,'ended_early_at',ended_early_at,'peak_used_percentage',peak,'unused_percentage_before_reset',CASE WHEN ended THEN 100-last_used END,'first_sample_at',first_at,'last_sample_at',last_at,'samples',n,'window_minutes',window_minutes,'sample_times',times,'limit_hits',(SELECT count(*) FROM quota_events x WHERE x.provider=e.provider AND x.reset_at=e.reset_at))::VARCHAR FROM e ORDER BY reset_at DESC LIMIT 200"),&[])?)?,
 "quota/notifications"=>s.setting("quota:notifications").map(|v|serde_json::from_str(&v)).transpose()?.into_iter().collect(),
 // What T3 last heard from every harness about its limits, as read on the last sync.
 "quota/live"=>live_quota(s),
 // Every time a provider refused work for a reached limit, grouped by the reset it was waiting for.
 "quota/resets"=>s.rows("SELECT json_object('provider',provider,'window',window_kind,'reset_at',reset_at,'first_hit_at',min(happened_at),'last_hit_at',max(happened_at),'hits',count(*),'capture_quality','partial')::VARCHAR FROM quota_events GROUP BY provider,window_kind,reset_at ORDER BY min(happened_at) DESC LIMIT 200",&[])?,
 "quota/samples"=>s.rows("SELECT json_object('provider',provider,'window',window_kind,'sampled_at',sampled_at,'used_percentage',used_percent,'reset_at',reset_at)::VARCHAR FROM quota_samples WHERE (? IS NULL OR runtrace_time_us(sampled_at)>=runtrace_time_us(?)) AND (? IS NULL OR runtrace_time_us(sampled_at)<=runtrace_time_us(?)) ORDER BY sampled_at",&[&f.since,&f.since,&f.until,&f.until])?,
 "projects"|"threads"|"tool-calls"|"agents"|"model-turns"|"search"|"timeline"=>{
    let timeline_kind=if name=="timeline"{f.kind.clone().unwrap_or_default()}else{String::new()};
    let kind=match name{"projects"=>"project","threads"=>"thread","tool-calls"=>"tool","agents"=>"agent","model-turns"=>"model_turn",_=>timeline_kind.as_str()};
    let limit=f.limit.unwrap_or(100);
    let offset=f.offset.unwrap_or(0);
    let full=f.include_content.unwrap_or(name=="timeline");
    let pattern=f.q.as_ref().map(|q|format!("%{q}%"));
    let mut a=args;
    a.extend([&kind as &dyn duckdb::ToSql,&kind,&f.id,&f.id,&f.id,&pattern,&pattern,&limit,&offset]);
    let projection=if full {
      "data".to_string()
    } else {
      // The stored list view, so a page never reads the full documents. Opening the database fills it for every row, and each write stores it.
      "CASE WHEN kind='model_turn' THEN json_merge_patch(preview_doc::JSON,json_object('total_tokens',CASE WHEN usage_status='complete' THEN total_tokens ELSE NULL END)) ELSE preview_doc::JSON END".to_string()
    };
    // A lean turn carries what a chart and a list need: the token columns, the model, the provider worked out here, and how long it ran.
    let lean=format!("json_object('id',id,'source_id',source_id,'kind',kind,'instance_id',instance_id,'project_id',project_id,'thread_id',thread_id,'run_id',run_id,'occurred_at',occurred_at,'capture_quality',capture_quality,'data',json_object('provider',{DRIVER},'model',nullif(model,''),'resolved_model',resolved_model,'status',status,'usage_status',usage_status,'usage_scope',usage_scope,'usage_source',usage_source,'has_subagents',has_subagents,'duration_ms',elapsed_ms,'input_tokens',input_tokens,'cached_input_tokens',cached_input_tokens,'cache_write_tokens',cache_write_tokens,'output_tokens',output_tokens,'reasoning_tokens',reasoning_tokens,'total_tokens',CASE WHEN usage_status='complete' THEN total_tokens END))::VARCHAR");
    let metadata="'id',id,'source_id',source_id,'kind',kind,'instance_id',instance_id,'project_id',project_id,'thread_id',thread_id,'run_id',run_id,'occurred_at',occurred_at,'source_updated_at',source_updated_at,'capture_quality',capture_quality,'capture_source',capture_source,'source_version',source_version,'captured_at',captured_at,'payload_hash',payload_hash";
    let full_fields=if full {format!("json_object({metadata})::VARCHAR,data::VARCHAR,total_tokens,usage_status")} else {format!("json_object({metadata},'data',{projection})::VARCHAR")};
    let lean_turn=kind=="model_turn" && f.shape.as_deref()==Some("lean");
    let fields=if lean_turn {lean} else {full_fields};
    let read=|sql:&str,args:&[&dyn duckdb::ToSql]| if full && !lean_turn {full_record_rows(s,sql,args)} else {s.rows(sql,args)};
    let predicate=format!("{filter} AND (?='' OR kind=?) AND (? IS NULL OR source_id=? OR thread_id=?) AND (? IS NULL OR search_text LIKE lower(?))");
    // Measured narrow late-fetch helps small tool pages. Large IN lists force
    // costly random reads. Bulk pages materialize narrow IDs, then join once;
    // this keeps large JSON out of the offset TopN memory at the shared budget.
    if name=="tool-calls" && limit<=100 {
      let sql=format!("SELECT id FROM records WHERE {predicate} ORDER BY runtrace_time_us(occurred_at) DESC NULLS LAST,id LIMIT ? OFFSET ?");
      let ids:Vec<String>=s.conn.prepare(&sql)?.query_map(a.as_slice(),|r|r.get(0))?.collect::<duckdb::Result<_>>()?;
      if ids.is_empty() { vec![] } else {
        let placeholders=std::iter::repeat_n("?",ids.len()).collect::<Vec<_>>().join(",");
        let selected:Vec<&dyn duckdb::ToSql>=ids.iter().map(|id|id as &dyn duckdb::ToSql).collect();
        read(&format!("SELECT {fields} FROM records WHERE id IN ({placeholders}) ORDER BY runtrace_time_us(occurred_at) DESC NULLS LAST,id"),&selected)?
      }
    } else if name=="tool-calls" {
      read(&format!("WITH selected_page AS MATERIALIZED (SELECT id FROM records WHERE {predicate} ORDER BY runtrace_time_us(occurred_at) DESC NULLS LAST,id LIMIT ? OFFSET ?) SELECT {fields} FROM records JOIN selected_page USING(id) ORDER BY runtrace_time_us(occurred_at) DESC NULLS LAST,id"),&a)?
    } else {
      read(&format!("SELECT {fields} FROM (SELECT * FROM records WHERE {predicate} ORDER BY runtrace_time_us(occurred_at) DESC NULLS LAST,id LIMIT ? OFFSET ?) page ORDER BY runtrace_time_us(occurred_at) DESC NULLS LAST,id"),&a)?
    }
 },
 _=>anyhow::bail!("Unknown analytics operation")};
    let mut result = json!({"data":rows,"limit":f.limit.unwrap_or(100),"offset":f.offset.unwrap_or(0),"timezone":"UTC","capture_quality":"partial","null_semantics":"null means unavailable, never zero"});
    if name.starts_with("quota/") && (f.instance.is_some() || f.status.is_some()) {
        result["scope"] = json!("installation");
        result["scope_reason"] = json!(
            "Quota readings and alert status remain installation-wide across all machines and run statuses. They are not attributed to individual runs."
        );
    }
    Ok(result)
}

/// Ratios of captured work, with separate denominators for supported coverage.
/// A conversation's run ordinal does not measure retries. Only explicit attempt
/// ordinals count, and a missing ordinal makes that thread's retry rate unknown.
fn efficiency(s: &Store, filter: &str, args: &[&dyn duckdb::ToSql]) -> Result<Vec<Value>> {
    s.rows(&format!(r#"
WITH scoped AS MATERIALIZED (
    SELECT instance_id,thread_id,run_id,kind,capture_source,preview_doc
    FROM records WHERE kind IN ('run','model_turn','tool') AND {filter}
), turns AS (
    SELECT instance_id,run_id,count(*) n FROM scoped
    WHERE kind='model_turn' AND capture_source IS DISTINCT FROM 'session_logs'
      AND nullif(run_id,'') IS NOT NULL GROUP BY instance_id,run_id
), linked_tools AS (
    SELECT count(*) n FROM scoped t JOIN turns p USING(instance_id,run_id) WHERE t.kind='tool'
), thread_attempts AS (
    SELECT instance_id,thread_id,count(*) runs,
      count(*) FILTER(WHERE json_extract_string(preview_doc,'$.attempts.coverage')='complete') covered_runs,
      sum(try_cast(json_extract_string(preview_doc,'$.attempts.reattempts') AS BIGINT)) reattempts,
      sum(try_cast(json_extract_string(preview_doc,'$.attempts.steering_restarts') AS BIGINT)) steering
    FROM scoped WHERE kind='run' AND nullif(thread_id,'') IS NOT NULL GROUP BY instance_id,thread_id
), attempt_totals AS (
    SELECT coalesce(sum(runs),0) runs,coalesce(sum(covered_runs),0) covered_runs,count(*) threads,
      count(*) FILTER(WHERE runs=covered_runs) covered_threads,
      sum(reattempts) FILTER(WHERE runs=covered_runs) reattempts,
      sum(steering) FILTER(WHERE runs=covered_runs) steering FROM thread_attempts
), totals AS (
    SELECT count(*) FILTER(WHERE kind='tool') tools,
      count(*) FILTER(WHERE kind='model_turn' AND capture_source IS DISTINCT FROM 'session_logs') provider_turns
    FROM scoped
)
SELECT json_object('tools',tools,'provider_turns',provider_turns,
    'linked_tools',(SELECT n FROM linked_tools),'linked_turns',(SELECT coalesce(sum(n),0) FROM turns),
    'tools_per_turn',(SELECT n FROM linked_tools)*1.0/nullif((SELECT sum(n) FROM turns),0),
    'runs',runs,'covered_runs',covered_runs,'threads',threads,'covered_threads',covered_threads,
    'reattempts',reattempts,'steering_restarts',steering,
    'retries_per_thread',reattempts*1.0/nullif(covered_threads,0),
    'capture_quality','partial')::VARCHAR FROM totals CROSS JOIN attempt_totals
"#),args)
}

// DuckDB's JSON object builder retains large parsed documents for an entire
// vector. Read bounded full documents as strings and assemble the API envelope
// one row at a time, preserving null-token and ciphertext-exclusion semantics.
fn full_record_rows(s: &Store, sql: &str, args: &[&dyn duckdb::ToSql]) -> Result<Vec<Value>> {
    let mut stmt = s.conn.prepare(sql)?;
    let rows = stmt.query_map(args, |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, Option<i64>>(2)?,
            r.get::<_, Option<String>>(3)?,
        ))
    })?;
    rows.map(|row| {
        let (metadata, data, tokens, status) = row?;
        let mut metadata: Value = serde_json::from_str(&metadata)?;
        let mut data: Value = serde_json::from_str(data.as_deref().unwrap_or("null"))?;
        if !data.is_object() {
            data = json!({});
        }
        let object = data.as_object_mut().unwrap();
        object.remove("content_ciphertext");
        object.remove("repository_path_encrypted");
        if metadata["kind"] == "model_turn" {
            match tokens.filter(|_| status.as_deref() == Some("complete")) {
                Some(tokens) => {
                    object.insert("total_tokens".into(), json!(tokens));
                }
                None => {
                    object.remove("total_tokens");
                }
            }
        }
        metadata["data"] = data;
        Ok(metadata)
    })
    .collect()
}

/// Readings no further apart than this, starting and ending this close to a window's edges, watched the whole window.
const COVERED_GAP_MS: i64 = crate::quota::MAX_READING_GAP_MS;

/// A finished window is complete when its readings cover it from start to end, so the last one before the reset is close
/// to what was really left. Anything less is partial: more may have been used between readings.
fn window_coverage(s: &Store, rows: Vec<Value>) -> Result<Vec<Value>> {
    let power: Value = s
        .setting("quota:power")
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null);
    let sleep = power["intervals"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    let ms = |v: &Value| {
        v.as_str()
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
            .map(|d| d.timestamp_millis())
    };
    Ok(rows
        .into_iter()
        .map(|mut r| {
            let reset = ms(&r["reset_at"]);
            let end = ms(&r["ended_early_at"]).or(reset);
            let start = reset
                .zip(r["window_minutes"].as_i64())
                .filter(|(_, m)| *m > 0)
                .and_then(|(reset, m)| reset.checked_sub(m.checked_mul(60_000)?));
            let times: Vec<i64> = r["sample_times"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(ms)
                .collect();
            let gaps = start
                .zip(end)
                .map(|(start, end)| {
                    crate::quota::reading_gaps(
                        &times,
                        start,
                        if r["ended"] == true {
                            end
                        } else {
                            end.min(crate::storage::clock().timestamp_millis())
                        },
                        sleep,
                    )
                })
                .unwrap_or_default();
            let mut reasons = vec![];
            if r["ended"] != true {
                reasons.push("window_still_running");
            }
            if start.is_none() || end.is_none() {
                reasons.push("window_length_unreported");
            }
            if !gaps.is_empty() {
                reasons.push("missing_readings");
            }
            let complete = r["ended"] == true
                && start.zip(end).is_some_and(|(start, end)| {
                    let samples: Vec<crate::quota::Sample> = r["sample_times"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(ms)
                        .map(|at| crate::quota::Sample {
                            sampled_at: at,
                            reset_at: end,
                            remaining_percentage: Some(0.0),
                            valid: true,
                        })
                        .collect();
                    crate::quota::reset_window(&samples, start, end, COVERED_GAP_MS).complete
                });
            if let Some(o) = r.as_object_mut() {
                o.remove("sample_times");
                o.insert("gaps".into(), json!(gaps));
                o.insert("coverage_reasons".into(), json!(reasons));
                o.insert(
                    "capture_quality".into(),
                    json!(if complete { "complete" } else { "partial" }),
                );
            }
            r
        })
        .collect())
}

/// The live snapshot the collector keeps, one row per harness, each carrying when it was read.
fn live_quota(s: &Store) -> Vec<Value> {
    let Some(v) = s
        .setting(crate::quota_sources::LIVE)
        .and_then(|v| serde_json::from_str::<Value>(&v).ok())
    else {
        return vec![];
    };
    v["harnesses"]
        .as_array()
        .into_iter()
        .flatten()
        .cloned()
        .map(|mut h| {
            h["read_at"] = v["read_at"].clone();
            h
        })
        .collect()
}
