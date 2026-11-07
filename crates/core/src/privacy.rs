use anyhow::{Result, anyhow};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce, aead::Aead};
use rand::RngCore;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::LazyLock;
pub fn hash(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}
static PATTERNS: LazyLock<Vec<(&str, Regex)>> = LazyLock::new(|| {
    vec![
 ("private_key",r"(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----"),
 ("provider_key",r"\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|AKIA[A-Z0-9]{16})\b"),
 ("bearer",r"(?i)bearer\s+[A-Za-z0-9._~+/=-]{8,}"),
 ("jwt",r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"),
 ("connection_string",r"(?i)(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|mssql)://[^\s\x22']+"),
 ("secret_assignment",r"(?im)\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|CREDENTIAL)[A-Z0-9_]*\s*[:=]\s*[^\s,;]+"),
 ("path",r"(?:[A-Za-z]:\\(?:[^\s\x22<>|]+)|/(?:home|Users)/[^\s\x22]+)"),
].into_iter().map(|(n,p)|(n,Regex::new(p).unwrap())).collect()
});
#[derive(Debug, Serialize, Deserialize)]
pub struct Protected {
    pub content_redacted: Option<String>,
    pub content_ciphertext: Option<String>,
    pub content_hash: String,
    pub redaction_count: usize,
    pub redaction_categories: Vec<String>,
    pub character_count: usize,
    pub line_count: usize,
}
static ATOMS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b[A-Za-z0-9_+/=-]{32,}\b").unwrap());
pub fn redact(s: &str) -> (String, usize, Vec<String>) {
    let mut out = s.to_owned();
    let mut count = 0;
    let mut categories = vec![];
    for (name, re) in PATTERNS.iter() {
        let n = re.find_iter(&out).count();
        if n > 0 {
            count += n;
            categories.push(name.to_string());
            out = re
                .replace_all(&out, format!("[REDACTED:{name}]"))
                .into_owned();
        }
    }
    // Conservatively remove long high-entropy atoms, including opaque session tokens.
    let atoms = &*ATOMS;
    out = atoms
        .replace_all(&out, |cap: &regex::Captures| {
            let x = &cap[0];
            let mut freq = [0f64; 256];
            for b in x.bytes() {
                freq[b as usize] += 1.;
            }
            let entropy: f64 = freq
                .iter()
                .filter(|v| **v > 0.)
                .map(|v| {
                    let p = v / x.len() as f64;
                    -p * p.log2()
                })
                .sum();
            if entropy > 4.3 {
                count += 1;
                categories.push("high_entropy".into());
                "[REDACTED:high_entropy]".to_string()
            } else {
                x.to_string()
            }
        })
        .into_owned();
    categories.sort();
    categories.dedup();
    (out, count, categories)
}
pub fn key(create: bool) -> Result<[u8; 32]> {
    let entry = keyring::Entry::new("t3-usage-intelligence", "content-key-v1")?;
    match entry.get_password() {
        Ok(x) => Ok(hex::decode(x)?
            .try_into()
            .map_err(|_| anyhow!("Invalid keychain key length"))?),
        Err(keyring::Error::NoEntry) if create => {
            let mut k = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut k);
            entry.set_password(&hex::encode(k))?;
            Ok(k)
        }
        Err(_) => Err(anyhow!(
            "OS keychain unavailable; run t3ui init or use redacted_only"
        )),
    }
}
pub fn encrypt(s: &str, k: &[u8; 32]) -> Result<String> {
    let cipher = XChaCha20Poly1305::new(k.into());
    let mut nonce = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut nonce);
    let bytes = cipher
        .encrypt(XNonce::from_slice(&nonce), s.as_bytes())
        .map_err(|_| anyhow!("Encryption failed"))?;
    Ok(format!("{}:{}", hex::encode(nonce), hex::encode(bytes)))
}
pub fn decrypt(s: &str, k: &[u8; 32]) -> Result<String> {
    let (n, c) = s
        .split_once(':')
        .ok_or_else(|| anyhow!("Invalid ciphertext"))?;
    let n = hex::decode(n)?;
    anyhow::ensure!(n.len() == 24, "Invalid nonce");
    let bytes = XChaCha20Poly1305::new(k.into())
        .decrypt(XNonce::from_slice(&n), hex::decode(c)?.as_ref())
        .map_err(|_| anyhow!("Authentication failed"))?;
    Ok(String::from_utf8(bytes)?)
}
pub fn protect(s: &str, policy: &str, k: Option<&[u8; 32]>) -> Result<Protected> {
    let (text, count, categories) = redact(s);
    Ok(Protected {
        content_redacted: if ["metadata_only", "disabled"].contains(&policy) {
            None
        } else {
            Some(text)
        },
        content_ciphertext: if policy == "full_encrypted" {
            Some(encrypt(
                s,
                k.ok_or_else(|| anyhow!("Encryption key required"))?,
            )?)
        } else {
            None
        },
        content_hash: hash(s),
        redaction_count: count,
        redaction_categories: categories,
        character_count: s.chars().count(),
        line_count: s.lines().count(),
    })
}
/// Redact values before serializing so paths, quotes and secret assignments
/// cannot corrupt the surrounding tool argument/result JSON structure.
pub fn protect_json(
    value: &serde_json::Value,
    policy: &str,
    key: Option<&[u8; 32]>,
) -> Result<Protected> {
    fn visit(
        value: &serde_json::Value,
        count: &mut usize,
        categories: &mut Vec<String>,
        secret_field: bool,
    ) -> serde_json::Value {
        if secret_field && !value.is_null() {
            *count += 1;
            categories.push("secret_json_field".into());
            return serde_json::Value::String("[REDACTED:secret_json_field]".into());
        }
        match value {
            serde_json::Value::String(s) => {
                let (text, n, found) = redact(s);
                *count += n;
                categories.extend(found);
                serde_json::Value::String(text)
            }
            serde_json::Value::Array(values) => serde_json::Value::Array(
                values
                    .iter()
                    .map(|v| visit(v, count, categories, secret_field))
                    .collect(),
            ),
            serde_json::Value::Object(values) => {
                let mut mapped = serde_json::Map::new();
                for (index, (key, value)) in values.iter().enumerate() {
                    let (redacted, n, found) = redact(key);
                    *count += n;
                    categories.extend(found);
                    let mut name = if n > 0 {
                        format!("{redacted}#{index}")
                    } else {
                        redacted
                    };
                    while mapped.contains_key(&name) {
                        name.push('_');
                    }
                    let normalized = key.to_ascii_lowercase().replace(['_', '-'], "");
                    let sensitive = secret_field
                        || normalized.ends_with("password")
                        || normalized.ends_with("token")
                        || normalized.ends_with("apikey")
                        || normalized.ends_with("secret")
                        || normalized == "authorization"
                        || normalized.ends_with("privatekey")
                        || normalized == "credentials";
                    mapped.insert(name, visit(value, count, categories, sensitive));
                }
                serde_json::Value::Object(mapped)
            }
            other => other.clone(),
        }
    }
    let original = value.to_string();
    let mut count = 0;
    let mut categories = vec![];
    let redacted = visit(value, &mut count, &mut categories, false);
    categories.sort();
    categories.dedup();
    Ok(Protected {
        content_redacted: if ["metadata_only", "disabled"].contains(&policy) {
            None
        } else {
            Some(redacted.to_string())
        },
        content_ciphertext: if policy == "full_encrypted" {
            Some(encrypt(
                &original,
                key.ok_or_else(|| anyhow!("Encryption key required"))?,
            )?)
        } else {
            None
        },
        content_hash: hash(&original),
        redaction_count: count,
        redaction_categories: categories,
        character_count: original.chars().count(),
        line_count: original.lines().count(),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn secrets() {
        for secret in [
            "sk-ant-abcdefghijklmnopqrstuvwxyz123456",
            "ghp_abcdefghijklmnopqrstuvwxyz123456",
            "Bearer abcdefghijklmnop",
            "PASSWORD=hello-secret",
            "AKIA1234567890123456",
            "postgres://user:pass@host/db",
        ] {
            assert!(!redact(secret).0.contains(secret));
        }
    }
    #[test]
    fn encryption() {
        let c = encrypt("sensitive", &[1; 32]).unwrap();
        assert_eq!(decrypt(&c, &[1; 32]).unwrap(), "sensitive");
        assert!(decrypt(&c, &[2; 32]).is_err());
    }
    #[test]
    fn metadata() {
        assert!(
            protect("secret", "metadata_only", None)
                .unwrap()
                .content_redacted
                .is_none()
        );
    }
}
