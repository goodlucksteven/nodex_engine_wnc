//! GeckoTerminal token metadata, logo, and price provider.
use std::collections::HashMap;
use serde_json::Value;
use crate::services::token_lookup::{BlockchainLookupConfig, TokenLookupRequest, TokenMetadata};

pub async fn lookup(client: &reqwest::Client, config: &BlockchainLookupConfig, requests: &[TokenLookupRequest]) -> Result<HashMap<String, TokenMetadata>, String> {
    let network=config.provider_networks.get("geckoterminal").ok_or("GeckoTerminal network slug not configured")?;
    let mut out=HashMap::new(); let mut errors=Vec::new();
    // TRC-10 asset IDs are numeric asset identifiers, not contract addresses.
    // Query eligible tokens one at a time to reduce provider throttling.
    for batch in requests.iter()
        .filter(|r| !r.identifier.starts_with("native:"))
        .filter(|r| !(r.chain == "tron" && r.identifier.to_ascii_lowercase().starts_with("trc10:")))
        .collect::<Vec<_>>().chunks(1) {
        let ids=batch.iter().map(|r|r.identifier.as_str()).collect::<Vec<_>>().join(",");
        let url=format!("https://api.geckoterminal.com/api/v2/networks/{network}/tokens/multi/{ids}");
        match client.get(&url).header("accept","application/json").send().await {
            Ok(response) if response.status().is_success()=>match response.json::<Value>().await {
                Ok(value)=>if let Some(rows)=value.get("data").and_then(Value::as_array) { for req in batch {
                    if let Some(row)=rows.iter().find(|r|r.pointer("/attributes/address").and_then(Value::as_str).is_some_and(|a|a.eq_ignore_ascii_case(&req.identifier))) {
                        let a=&row["attributes"];
                        out.insert(req.identifier.to_ascii_lowercase(),TokenMetadata{chain:req.chain.clone(),identifier:req.identifier.clone(),name:a["name"].as_str().map(str::to_owned),symbol:a["symbol"].as_str().map(str::to_owned),decimals:a["decimals"].as_u64().map(|v|v as u32),logo_url:a["image_url"].as_str().map(str::to_owned),price_usd:a["price_usd"].as_str().and_then(|v|v.parse().ok()),price_change_24h_percentage:a.pointer("/price_change_percentage/h24").and_then(|v|v.as_str().and_then(|s|s.parse().ok()).or_else(||v.as_f64())),source:Some("geckoterminal".into())});
                    }
                }},
                Err(e)=>errors.push(format!("{url}: invalid JSON: {e}")),
            },
            Ok(response)=>errors.push(format!("{url}: HTTP {}",response.status())),
            Err(e)=>errors.push(format!("{url}: {e}")),
        }
    }
    if out.is_empty()&&!errors.is_empty(){Err(errors.join("; "))}else{Ok(out)}
}
