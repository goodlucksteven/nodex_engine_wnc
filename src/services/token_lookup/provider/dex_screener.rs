//! DexScreener token metadata and market-price provider.
use std::collections::HashMap;
use serde_json::Value;
use crate::services::token_lookup::{BlockchainLookupConfig, TokenLookupRequest, TokenMetadata};

pub async fn lookup(client: &reqwest::Client, config: &BlockchainLookupConfig, requests: &[TokenLookupRequest]) -> Result<HashMap<String, TokenMetadata>, String> {
    let network = config.provider_networks.get("dexscreener").ok_or("DexScreener network slug not configured")?;
    let mut out = HashMap::new();
    let mut errors = Vec::new();
    // TRC-10 IDs are not contract addresses. Send one eligible token per request
    // to reduce large URL payloads and avoid invalid lookups.
    for batch in requests.iter()
        .filter(|r| !r.identifier.starts_with("native:"))
        .filter(|r| !(r.chain == "tron" && r.identifier.to_ascii_lowercase().starts_with("trc10:")))
        .collect::<Vec<_>>().chunks(1) {
        let ids = batch.iter().map(|r| r.identifier.as_str()).collect::<Vec<_>>().join(",");
        let url = format!("https://api.dexscreener.com/tokens/v1/{network}/{ids}");
        match client.get(&url).header("accept","application/json").send().await {
            Ok(response) if response.status().is_success() => match response.json::<Value>().await {
                Ok(value) => if let Some(rows)=value.as_array() { for req in batch {
                    if let Some(pair)=rows.iter().find(|p| p.get("chainId").and_then(Value::as_str).is_some_and(|c| c.eq_ignore_ascii_case(network)) && p.pointer("/baseToken/address").and_then(Value::as_str).is_some_and(|a| a.eq_ignore_ascii_case(&req.identifier))) {
                        let base=&pair["baseToken"];
                        out.insert(req.identifier.to_ascii_lowercase(), TokenMetadata { chain:req.chain.clone(), identifier:req.identifier.clone(), name:base["name"].as_str().map(str::to_owned), symbol:base["symbol"].as_str().map(str::to_owned), decimals:base["decimals"].as_u64().map(|v|v as u32), logo_url:pair.pointer("/info/imageUrl").and_then(Value::as_str).map(str::to_owned), price_usd:pair["priceUsd"].as_str().and_then(|v|v.parse().ok()), price_change_24h_percentage:pair.pointer("/priceChange/h24").and_then(Value::as_f64), source:Some("dexscreener".into()) });
                    }
                }},
                Err(e)=>errors.push(format!("{url}: invalid JSON: {e}")),
            },
            Ok(response)=>errors.push(format!("{url}: HTTP {}",response.status())),
            Err(e)=>errors.push(format!("{url}: {e}")),
        }
    }
    if out.is_empty() && !errors.is_empty() { Err(errors.join("; ")) } else { Ok(out) }
}
