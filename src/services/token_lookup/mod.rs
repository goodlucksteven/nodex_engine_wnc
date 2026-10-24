//! Token metadata lookup dispatcher.
//!
//! Provider-specific HTTP endpoints and response parsers live under
//! token_lookup/provider/. This module owns the public request/response types,
//! short-lived cache, batching, concurrent dispatch, and result merging.
pub mod provider;
pub mod registry;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::{collections::{HashMap, HashSet}, sync::{Mutex, OnceLock}, time::{Duration, Instant}};

const CACHE_TTL: Duration = Duration::from_secs(30 * 60);

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct BlockchainLookupConfig {
    pub chain_name: String,
    /// Provider-specific network slug, and optionally "evm_rpc" for on-chain
    /// ERC-20 reads. Values are supplied by the adapter, not hard-coded here.
    pub provider_networks: HashMap<String, String>,
    pub native_asset_provider_ids: HashMap<String, String>,
    pub enabled_providers: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct TokenLookupRequest {
    pub chain: String,
    /// Contract address or chain-specific identifier such as a TRC-10 asset ID.
    pub identifier: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct TokenMetadata {
    pub chain: String,
    pub identifier: String,
    pub name: Option<String>,
    pub symbol: Option<String>,
    pub decimals: Option<u32>,
    pub logo_url: Option<String>,
    pub price_usd: Option<f64>,
    pub price_change_24h_percentage: Option<f64>,
    pub source: Option<String>,
}

impl TokenMetadata {
    pub(crate) fn has_display_metadata(&self) -> bool {
        self.name.as_deref().is_some_and(|s| !s.trim().is_empty())
            || self.symbol.as_deref().is_some_and(|s| !s.trim().is_empty())
            || self.logo_url.as_deref().is_some_and(|s| !s.trim().is_empty())
            || self.decimals.is_some()
            || self.price_usd.is_some()
            || self.price_change_24h_percentage.is_some()
    }

    fn has_identity(&self) -> bool {
        self.name.as_deref().is_some_and(|s| !s.trim().is_empty())
            || self.symbol.as_deref().is_some_and(|s| !s.trim().is_empty())
    }
}

#[derive(Clone)]
struct CachedValue { value: TokenMetadata, inserted_at: Instant }
static METADATA_CACHE: OnceLock<Mutex<HashMap<String, CachedValue>>> = OnceLock::new();
fn cache() -> &'static Mutex<HashMap<String, CachedValue>> {
    METADATA_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}
fn cache_key(chain: &str, identifier: &str) -> String {
    format!("{}:{}", chain.trim().to_ascii_lowercase(), identifier.trim().to_ascii_lowercase())
}
fn normalize_chain(chain: &str) -> String {
    match chain.trim().to_ascii_lowercase().as_str() {
        "eth" | "ethereum-mainnet" => "ethereum".into(),
        "binance" | "binance-smart-chain" | "bnb" => "bsc".into(),
        "matic" | "polygon-pos" => "polygon".into(),
        "sol" => "solana".into(),
        "tron-mainnet" => "tron".into(),
        other => other.to_owned(),
    }
}
fn read_cache(request: &TokenLookupRequest) -> Option<TokenMetadata> {
    let mut entries = cache().lock().ok()?;
    match entries.get(&cache_key(&request.chain, &request.identifier)) {
        Some(entry) if entry.inserted_at.elapsed() < CACHE_TTL => Some(entry.value.clone()),
        Some(_) => { entries.remove(&cache_key(&request.chain, &request.identifier)); None },
        None => None,
    }
}
fn write_cache(value: &TokenMetadata) {
    if !value.has_display_metadata() { return; }
    if let Ok(mut entries) = cache().lock() {
        entries.insert(cache_key(&value.chain, &value.identifier), CachedValue { value: value.clone(), inserted_at: Instant::now() });
    }
}

pub async fn lookup_batch(requests: Vec<TokenLookupRequest>) -> Result<Vec<TokenMetadata>, String> {
    lookup_batch_with_config(BlockchainLookupConfig::default(), requests).await
}

pub async fn lookup_batch_with_config(config: BlockchainLookupConfig, requests: Vec<TokenLookupRequest>) -> Result<Vec<TokenMetadata>, String> {
    lookup_batch_impl(config, requests, true).await
}

/// Best-effort lookup for balance enrichment. Returns one metadata result per
/// discovered identifier even when some tokens are unindexed, so a missing
/// token identity never causes confirmed wallet balances to be discarded.
pub async fn lookup_batch_best_effort_with_config(config: BlockchainLookupConfig, requests: Vec<TokenLookupRequest>) -> Result<Vec<TokenMetadata>, String> {
    lookup_batch_impl(config, requests, false).await
}

async fn lookup_batch_impl(config: BlockchainLookupConfig, requests: Vec<TokenLookupRequest>, require_identity: bool) -> Result<Vec<TokenMetadata>, String> {
    if requests.is_empty() { return Ok(Vec::new()); }
    let client = Client::builder()
        .user_agent("NodexWalletEngine/0.1 token-metadata")
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| format!("token lookup HTTP client initialization failed: {e}"))?;

    let mut ordered = Vec::new();
    let mut pending = Vec::new();
    let mut seen = HashSet::new();
    for request in requests {
        let identifier = request.identifier.trim().to_owned();
        if identifier.is_empty() { continue; }
        let request = TokenLookupRequest { chain: normalize_chain(&request.chain), identifier };
        if !seen.insert(cache_key(&request.chain, &request.identifier)) { continue; }
        if let Some(cached) = read_cache(&request) { ordered.push(cached); }
        else {
            ordered.push(TokenMetadata { chain: request.chain.clone(), identifier: request.identifier.clone(), ..TokenMetadata::default() });
            pending.push(request);
        }
    }

    let mut provider_errors = Vec::new();
    // Each adapter usually submits one chain per batch. Grouping by chain
    // prevents a token address on one network being mistaken for another.
    let mut by_chain: HashMap<String, Vec<TokenLookupRequest>> = HashMap::new();
    for request in pending { by_chain.entry(request.chain.clone()).or_default().push(request); }
    for (_chain, batch) in by_chain {
        let (found, errors) = registry::dispatch(&client, &config, &batch).await;
        provider_errors.extend(errors);
        for item in ordered.iter_mut().filter(|item| batch.iter().any(|r| r.chain == item.chain && r.identifier.eq_ignore_ascii_case(&item.identifier))) {
            if let Some(value) = found.get(&item.identifier.to_ascii_lowercase()) {
                item.name = value.name.clone();
                item.symbol = value.symbol.clone();
                item.decimals = value.decimals;
                item.logo_url = value.logo_url.clone();
                item.price_usd = value.price_usd;
                item.price_change_24h_percentage = value.price_change_24h_percentage;
                item.source = value.source.clone();
                write_cache(item);
            }
        }
    }

    let unresolved: Vec<String> = ordered.iter()
        .filter(|item| !item.identifier.starts_with("native:") && !item.has_identity())
        .map(|item| format!("{}:{}", item.chain, item.identifier))
        .collect();
    if require_identity && !unresolved.is_empty() {
        let provider_detail = if provider_errors.is_empty() { String::new() } else { format!("; provider errors: {}", provider_errors.join(" | ")) };
        return Err(format!("token lookup could not resolve token identity (name/symbol) for {} identifier(s): {}{}", unresolved.len(), unresolved.join(", "), provider_detail));
    }
    Ok(ordered)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalizes_common_chain_names() {
        assert_eq!(normalize_chain("ETH"), "ethereum");
        assert_eq!(normalize_chain("binance-smart-chain"), "bsc");
        assert_eq!(normalize_chain("SOL"), "solana");
    }
}
