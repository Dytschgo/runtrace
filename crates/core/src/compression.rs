//! Lossless Parquet codec/row-group comparisons on the actual normalized dataset.
use crate::{
    config::Config,
    storage::{Store, now},
};
use anyhow::{Result, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::io::Read;
pub fn checksum(path: &std::path::Path) -> Result<String> {
    let mut input = std::fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = input.read(&mut buf)?;
        if n == 0 {
            break;
        }
        digest.update(&buf[..n]);
    }
    Ok(hex::encode(digest.finalize()))
}
pub fn benchmark(c: &Config, s: &Store) -> Result<Value> {
    let dir = std::path::Path::new(&c.storage.archive_path)
        .join(format!("compression-benchmark-{}", uuid::Uuid::now_v7()));
    std::fs::create_dir_all(&dir)?;
    let count: i64 = s
        .conn
        .query_row("SELECT count(*) FROM records", [], |r| r.get(0))?;
    ensure!(count > 0, "Import data before benchmarking compression");
    let mut results = vec![];
    for (codec, level, group) in [
        ("uncompressed", 0, 16384),
        ("snappy", 0, 16384),
        ("zstd", 1, 16384),
        ("zstd", 3, 16384),
        ("zstd", 8, 16384),
        ("zstd", 15, 16384),
        ("zstd", 3, 2048),
        ("zstd", 8, 2048),
        ("zstd", 15, 2048),
        ("zstd", 3, 8192),
        ("zstd", 8, 8192),
        ("zstd", 3, 65536),
        ("zstd", 8, 65536),
    ] {
        let path = dir.join(format!("{codec}-{level}-{group}.parquet"));
        let quoted = path.to_string_lossy().replace('\'', "''");
        let settings = if codec == "zstd" {
            format!(",COMPRESSION_LEVEL {level}")
        } else {
            String::new()
        };
        let start = std::time::Instant::now();
        s.conn.execute_batch(&format!("COPY (SELECT * FROM records ORDER BY kind,project_id,occurred_at,id) TO '{quoted}' (FORMAT PARQUET, COMPRESSION {codec},ROW_GROUP_SIZE {group}{settings})"))?;
        let write_ms = start.elapsed().as_secs_f64() * 1000.;
        let diff:i64=s.conn.query_row(&format!("SELECT count(*) FROM ((SELECT * FROM records EXCEPT ALL SELECT * FROM read_parquet('{quoted}')) UNION ALL (SELECT * FROM read_parquet('{quoted}') EXCEPT ALL SELECT * FROM records)) difference"),[],|r|r.get(0))?;
        ensure!(diff == 0, "Compression round trip changed data");
        let mut queries = vec![];
        for _ in 0..7 {
            let t = std::time::Instant::now();
            let n: i64 = s.conn.query_row(
                &format!("SELECT count(*) FROM read_parquet('{quoted}') WHERE kind='prompt'"),
                [],
                |r| r.get(0),
            )?;
            queries.push(t.elapsed().as_secs_f64() * 1000.);
            std::hint::black_box(n);
        }
        queries.sort_by(f64::total_cmp);
        let mut retrieval = vec![];
        for _ in 0..5 {
            let t = std::time::Instant::now();
            let rows=s.rows(&format!("SELECT data::VARCHAR FROM read_parquet('{quoted}') WHERE kind='tool' ORDER BY occurred_at DESC,id LIMIT 100"),&[])?;
            std::hint::black_box(rows);
            retrieval.push(t.elapsed().as_secs_f64() * 1000.);
        }
        retrieval.sort_by(f64::total_cmp);
        results.push(json!({"codec":codec,"level":level,"row_group_size":group,"bytes":std::fs::metadata(&path)?.len(),"write_ms":write_ms,"aggregate_median_ms":queries[3],"retrieval_median_ms":retrieval[2],"exact_roundtrip":true,"sha256":checksum(&path)?}));
    }
    let report = json!({"captured_at":now(),"record_count":count,"directory":dir,"results":results,"build_profile":if cfg!(debug_assertions){"debug"}else{"release"},"notes":"Warm local measurements. Every field compared bidirectionally with EXCEPT ALL; no content truncation, rounding or dropping."});
    std::fs::write(
        dir.join("results.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    Ok(report)
}
