//! TRON adapter-local token metadata lookup.
//!
//! This module deliberately does not call the shared token_lookup service or TronScan.
//! Each provider is queried independently; one provider's failure cannot cancel another.
//! TRC-20 contract addresses are queried against market-data providers. TRC-10 numeric
//! asset IDs are resolved through the configured TRON node's asset-issue endpoint.
use std::collections::HashMap;
use reqwest::Client;
use serde_json::Value;
use crate::services::balance_service::service::BalanceAsset;

#[derive(Clone, Debug, Default)]
pub struct TokenMetadata {
    pub name: Option<String>,
    pub symbol: Option<String>,
    pub decimals: Option<u32>,
    pub logo_url: Option<String>,
    pub price_usd: Option<f64>,
    pub price_change_24h_percentage: Option<f64>,
}

fn text(v: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| v.get(*key).and_then(Value::as_str)
        .map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned))
}
fn number(v: &Value, keys: &[&str]) -> Option<u32> {
    keys.iter().find_map(|key| v.get(*key).and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok()))
}

/// TRON's account assetV2 metadata can expose name/abbr/url as hex-encoded UTF-8.
/// Decode only even-length hex that produces printable UTF-8; otherwise preserve
/// the original provider value so ordinary text is never corrupted.
fn decode_tron_text(value: String) -> String {
    let candidate = value.trim();
    if candidate.is_empty() || candidate.len() % 2 != 0
        || !candidate.bytes().all(|b| b.is_ascii_hexdigit()) {
        return value;
    }
    let bytes = (0..candidate.len()).step_by(2).map(|i| {
        u8::from_str_radix(&candidate[i..i + 2], 16)
    }).collect::<Result<Vec<_>, _>>();
    let Ok(bytes) = bytes else { return value; };
    let Ok(decoded) = String::from_utf8(bytes) else { return value; };
    if decoded.chars().all(|c| !c.is_control()) && decoded.chars().any(|c| c.is_ascii_alphanumeric()) {
        decoded
    } else {
        value
    }
}

fn text_decoded(v: &Value, keys: &[&str]) -> Option<String> {
    text(v, keys).map(decode_tron_text)
}
fn nonempty(v: &Option<String>) -> bool { v.as_deref().is_some_and(|s| !s.trim().is_empty()) }

fn merge(target: &mut TokenMetadata, incoming: TokenMetadata) {
    if !nonempty(&target.name) { target.name = incoming.name; }
    if !nonempty(&target.symbol) { target.symbol = incoming.symbol; }
    if target.decimals.is_none() { target.decimals = incoming.decimals; }
    if !nonempty(&target.logo_url) { target.logo_url = incoming.logo_url; }
    if target.price_usd.is_none() { target.price_usd = incoming.price_usd; }
    if target.price_change_24h_percentage.is_none() { target.price_change_24h_percentage = incoming.price_change_24h_percentage; }
}

/// Match the registered TRON provider's environment-variable support so adapter-local
/// TRC-10 lookups do not get stuck using only the first API key.
fn tron_lookup_api_keys() -> Vec<String> {
    let mut keys = Vec::new();
    for name in ["TRON_PRO_API_KEYS", "TRONGRID_API_KEYS"] {
        if let Ok(value) = std::env::var(name) {
            keys.extend(value.split(',').map(str::trim).filter(|v| !v.is_empty()).map(str::to_owned));
        }
    }
    for index in 1..=5 {
        for name in [format!("TRON_PRO_API_KEY_{index}"), format!("TRONGRID_API_KEY_{index}")] {
            if let Ok(value) = std::env::var(name) {
                let value = value.trim();
                if !value.is_empty() { keys.push(value.to_owned()); }
            }
        }
    }
    if keys.is_empty() {
        for name in ["TRON_PRO_API_KEY", "TRONGRID_API_KEY"] {
            if let Ok(value) = std::env::var(name) {
                let value = value.trim();
                if !value.is_empty() { keys.push(value.to_owned()); break; }
            }
        }
    }
    let mut unique = Vec::with_capacity(keys.len());
    for key in keys {
        if !unique.contains(&key) { unique.push(key); }
        if unique.len() == 5 { break; }
    }
    unique
}

fn should_retry_tron_lookup(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::TOO_MANY_REQUESTS || status == reqwest::StatusCode::FORBIDDEN
}

async fn lookup_trc10_from_configured_node(
    client: &Client,
    rpc_url: &str,
    id: &str,
    key_offset: usize,
) -> Result<TokenMetadata, String> {
    let url = format!("{}/wallet/getassetissuebyid", rpc_url.trim_end_matches('/'));
    let keys = tron_lookup_api_keys();
    let attempts = keys.len().max(1);
    let mut last_retryable_error = String::new();

    for attempt in 0..attempts {
        // Spread consecutive token lookups across configured keys, then try the
        // remaining keys if the selected key is rate-limited or forbidden.
        let key = if keys.is_empty() {
            None
        } else {
            Some(keys[(key_offset + attempt) % keys.len()].as_str())
        };
        let mut request = client.post(&url).json(&serde_json::json!({"value": id}));
        if let Some(key) = key {
            request = request.header("TRON-PRO-API-KEY", key);
        }
        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                let message = format!("TRON node asset lookup request failed: {error}");
                if attempt + 1 < attempts {
                    eprintln!(
                        "[tron_token_lookup] provider=configured_tron_node token=trc10:{id} status=retryable_transport_error key_attempt={}/{}",
                        attempt + 1, attempts
                    );
                    last_retryable_error = message;
                    continue;
                }
                return Err(format!("{message}; configured API keys exhausted ({attempts} attempt(s))"));
            }
        };
        let status = response.status();

        if !status.is_success() {
            let error = format!("TRON node asset lookup HTTP {status}");
            if should_retry_tron_lookup(status) && attempt + 1 < attempts {
                eprintln!(
                    "[tron_token_lookup] provider=configured_tron_node token=trc10:{id} status=retryable_http_error http_status={} key_attempt={}/{}",
                    status.as_u16(), attempt + 1, attempts
                );
                last_retryable_error = error;
                continue;
            }
            if should_retry_tron_lookup(status) && !last_retryable_error.is_empty() {
                return Err(format!("{error}; previous key attempt: {last_retryable_error}"));
            }
            return Err(error);
        }

        let v = match response.json::<Value>().await {
            Ok(value) => value,
            Err(error) => {
                let message = format!("TRON node asset lookup invalid JSON/response body: {error}");
                if attempt + 1 < attempts {
                    last_retryable_error = message;
                    continue;
                }
                return Err(format!("{message}; configured API keys exhausted ({attempts} attempt(s))"));
            }
        };
        let result = TokenMetadata {
            name: text_decoded(&v, &["name", "tokenName"]),
            symbol: text_decoded(&v, &["abbr", "tokenAbbr", "symbol"]),
            decimals: number(&v, &["precision", "decimals", "tokenDecimal"]),
            logo_url: text_decoded(&v, &["logo_url", "logoUrl", "url"]).filter(|url| {
                let lower = url.to_ascii_lowercase();
                lower.starts_with("https://") || lower.starts_with("http://")
            }),
            price_usd: None,
            price_change_24h_percentage: None,
        };
        if result.name.is_none() && result.symbol.is_none() && result.decimals.is_none() && result.logo_url.is_none() {
            return Err(format!("TRON node returned no recognizable metadata for TRC-10 id {id}"));
        }
        return Ok(result);
    }

    Err(format!("TRON node asset lookup failed for TRC-10 id {id}: {last_retryable_error}"))
}

async fn lookup_native_trx(client: &Client) -> Result<TokenMetadata, String> {
    let url = "https://api.coingecko.com/api/v3/coins/tron?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false";
    let response = client.get(url).header("accept", "application/json").send().await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = response.status();
    if !status.is_success() { return Err(format!("HTTP {status}")); }
    let v = response.json::<Value>().await.map_err(|e| format!("invalid JSON: {e}"))?;
    Ok(TokenMetadata {
        name: text(&v, &["name"]),
        symbol: text(&v, &["symbol"]).map(|s| s.to_ascii_uppercase()),
        decimals: Some(6),
        logo_url: v.pointer("/image/large").and_then(Value::as_str).map(str::to_owned),
        price_usd: v.pointer("/market_data/current_price/usd").and_then(Value::as_f64),
        price_change_24h_percentage: v.pointer("/market_data/price_change_percentage_24h").and_then(Value::as_f64),
    })
}

async fn lookup_dexscreener(client: &Client, address: &str) -> Result<TokenMetadata, String> {
    let url = format!("https://api.dexscreener.com/tokens/v1/tron/{address}");
    let response = client.get(&url).header("accept", "application/json").send().await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = response.status();
    if !status.is_success() { return Err(format!("HTTP {status}")); }
    let rows = response.json::<Value>().await.map_err(|e| format!("invalid JSON: {e}"))?;
    let pair = rows.as_array().and_then(|items| items.iter().find(|p|
        p.pointer("/baseToken/address").and_then(Value::as_str).is_some_and(|a| a.eq_ignore_ascii_case(address))
    )).ok_or_else(|| "no matching contract pair indexed".to_owned())?;
    let base = &pair["baseToken"];
    Ok(TokenMetadata {
        name: text(base, &["name"]), symbol: text(base, &["symbol"]),
        decimals: number(base, &["decimals"]),
        logo_url: pair.pointer("/info/imageUrl").and_then(Value::as_str).map(str::to_owned),
        price_usd: pair["priceUsd"].as_str().and_then(|v| v.parse().ok()),
        price_change_24h_percentage: pair.pointer("/priceChange/h24").and_then(Value::as_f64),
    })
}

async fn lookup_geckoterminal(client: &Client, address: &str) -> Result<TokenMetadata, String> {
    let url = format!("https://api.geckoterminal.com/api/v2/networks/tron/tokens/{address}");
    let response = client.get(&url).header("accept", "application/json").send().await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = response.status();
    if !status.is_success() { return Err(format!("HTTP {status}")); }
    let v = response.json::<Value>().await.map_err(|e| format!("invalid JSON: {e}"))?;
    let a = v.get("data").and_then(|d| d.get("attributes")).ok_or_else(|| "response omitted data.attributes".to_owned())?;
    Ok(TokenMetadata {
        name: text(a, &["name"]), symbol: text(a, &["symbol"]),
        decimals: number(a, &["decimals"]), logo_url: text(a, &["image_url"]),
        price_usd: a["price_usd"].as_str().and_then(|v| v.parse().ok()),
        price_change_24h_percentage: a.pointer("/price_change_percentage/h24")
            .and_then(|v| v.as_str().and_then(|s| s.parse().ok()).or_else(|| v.as_f64())),
    })
}

async fn lookup_coingecko(client: &Client, address: &str) -> Result<TokenMetadata, String> {
    let url = format!("https://api.coingecko.com/api/v3/coins/tron/contract/{address}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false");
    let response = client.get(&url).header("accept", "application/json").send().await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = response.status();
    if !status.is_success() { return Err(format!("HTTP {status}")); }
    let v = response.json::<Value>().await.map_err(|e| format!("invalid JSON: {e}"))?;
    Ok(TokenMetadata {
        name: text(&v, &["name"]),
        symbol: text(&v, &["symbol"]).map(|s| s.to_ascii_uppercase()),
        decimals: v.pointer("/detail_platforms/tron/decimal_place").and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok()),
        logo_url: v.pointer("/image/large").and_then(Value::as_str).map(str::to_owned),
        price_usd: v.pointer("/market_data/current_price/usd").and_then(Value::as_f64),
        price_change_24h_percentage: v.pointer("/market_data/price_change_percentage_24h").and_then(Value::as_f64),
    })
}

/// Enriches already-discovered TRON assets. Balances are never modified or dropped.
/// Logs each provider's outcome and each token's final field coverage.
pub async fn enrich(client: &Client, rpc_url: &str, assets: &[BalanceAsset]) -> HashMap<String, TokenMetadata> {
    let mut result = HashMap::new();
    for (asset_index, asset) in assets.iter().enumerate() {
        let key = asset.address.to_ascii_lowercase();
        let mut metadata = TokenMetadata {
            name: asset.name.clone(), symbol: asset.symbol.clone(), decimals: asset.decimals,
            logo_url: asset.logo_url.clone(), price_usd: asset.price_usd,
            price_change_24h_percentage: asset.price_change_24h_percentage,
        };
        if let Some(id) = asset.address.strip_prefix("trc10:") {
            match lookup_trc10_from_configured_node(client, rpc_url, id, asset_index).await {
                Ok(found) => { eprintln!("[tron_token_lookup] provider=configured_tron_node token={} status=ok name={} symbol={} decimals={} logo={} price=false change=false", key, found.name.is_some(), found.symbol.is_some(), found.decimals.is_some(), found.logo_url.is_some()); merge(&mut metadata, found); }
                Err(error) => eprintln!("[tron_token_lookup] provider=configured_tron_node token={} status=error error={}", key, error),
            }
            eprintln!("[tron_token_lookup] token_final token={} name={} symbol={} decimals={} logo={} price={} change={}", key, metadata.name.is_some(), metadata.symbol.is_some(), metadata.decimals.is_some(), metadata.logo_url.is_some(), metadata.price_usd.is_some(), metadata.price_change_24h_percentage.is_some());
            result.insert(key, metadata);
            continue;
        }
        if asset.is_native || asset.address.eq_ignore_ascii_case("native") || asset.address.eq_ignore_ascii_case("native:trx") {
            match lookup_native_trx(client).await {
                Ok(found) => {
                    eprintln!("[tron_token_lookup] provider=coingecko_native token={} status=ok name={} symbol={} decimals={} logo={} price={} change={}", key, found.name.is_some(), found.symbol.is_some(), found.decimals.is_some(), found.logo_url.is_some(), found.price_usd.is_some(), found.price_change_24h_percentage.is_some());
                    merge(&mut metadata, found);
                }
                Err(error) => eprintln!("[tron_token_lookup] provider=coingecko_native token={} status=error error={}", key, error),
            }
            eprintln!("[tron_token_lookup] token_final token={} name={} symbol={} decimals={} logo={} price={} change={}", key, metadata.name.is_some(), metadata.symbol.is_some(), metadata.decimals.is_some(), metadata.logo_url.is_some(), metadata.price_usd.is_some(), metadata.price_change_24h_percentage.is_some());
            result.insert(key, metadata);
            continue;
        }

        let (dex, gecko, coingecko) = tokio::join!(
            lookup_dexscreener(client, &asset.address),
            lookup_geckoterminal(client, &asset.address),
            lookup_coingecko(client, &asset.address)
        );
        for (provider, outcome) in [("dexscreener", dex), ("geckoterminal", gecko), ("coingecko", coingecko)] {
            match outcome {
                Ok(found) => {
                    eprintln!("[tron_token_lookup] provider={} token={} status=ok name={} symbol={} decimals={} logo={} price={} change={}", provider, key, found.name.is_some(), found.symbol.is_some(), found.decimals.is_some(), found.logo_url.is_some(), found.price_usd.is_some(), found.price_change_24h_percentage.is_some());
                    merge(&mut metadata, found);
                }
                Err(error) => eprintln!("[tron_token_lookup] provider={} token={} status=error error={}", provider, key, error),
            }
        }
        eprintln!("[tron_token_lookup] token_final token={} name={} symbol={} decimals={} logo={} price={} change={}", key, metadata.name.is_some(), metadata.symbol.is_some(), metadata.decimals.is_some(), metadata.logo_url.is_some(), metadata.price_usd.is_some(), metadata.price_change_24h_percentage.is_some());
        result.insert(key, metadata);
    }
    result
}
