//! CoinGecko API v3 provider for native coins and contract-address tokens.
//! Native: /api/v3/coins/{id}; contract: /api/v3/coins/{platform}/contract/{address}.
use std::collections::HashMap;
use serde_json::Value;
use crate::services::token_lookup::{BlockchainLookupConfig, TokenLookupRequest, TokenMetadata};

fn platform_id(chain:&str)->Option<&'static str>{
 match chain {
  "ethereum"=>Some("ethereum"),
  "bsc"=>Some("binance-smart-chain"),
  "polygon"=>Some("polygon-pos"),
  "avalanche"=>Some("avalanche"),
  "arbitrum"=>Some("arbitrum-one"),
  "optimism"=>Some("optimistic-ethereum"),
  "base"=>Some("base"),
  "fantom"=>Some("fantom"),
  "gnosis"=>Some("xdai"),
  "cronos"=>Some("cronos"),
  "solana"=>Some("solana"),
  "tron"=>Some("tron"),
  _=>None,
 }
}
fn parse(req:&TokenLookupRequest,v:&Value)->TokenMetadata{
 TokenMetadata{chain:req.chain.clone(),identifier:req.identifier.clone(),
  name:v["name"].as_str().map(str::to_owned),
  symbol:v["symbol"].as_str().map(|s|s.to_ascii_uppercase()),
  decimals:v["detail_platforms"].as_object().and_then(|platforms|platforms.values().find_map(|p|p["decimal_place"].as_u64().map(|n|n as u32))),
  logo_url:v.pointer("/image/large").and_then(Value::as_str).map(str::to_owned),
  price_usd:v.pointer("/market_data/current_price/usd").and_then(Value::as_f64),
  price_change_24h_percentage:v.pointer("/market_data/price_change_percentage_24h").and_then(Value::as_f64),
  source:Some("coingecko".into())}
}
pub async fn lookup(client:&reqwest::Client,config:&BlockchainLookupConfig,requests:&[TokenLookupRequest])->Result<HashMap<String,TokenMetadata>,String>{
 let mut out=HashMap::new();let mut errors=Vec::new();
 for req in requests {
  let url=if req.identifier.starts_with("native:") {
   config.native_asset_provider_ids.get("coingecko").map(|id|format!("https://api.coingecko.com/api/v3/coins/{id}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false"))
  } else if req.chain == "tron" && req.identifier.to_ascii_lowercase().starts_with("trc10:") {
   // TRC-10 asset IDs are not contract addresses. CoinGecko's contract endpoint
   // must not be called with identifiers such as trc10:1004977.
   None
  } else {
   platform_id(&req.chain).map(|platform|format!("https://api.coingecko.com/api/v3/coins/{platform}/contract/{}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false",req.identifier))
  };
  let Some(url)=url else {continue};
  match client.get(&url).header("accept","application/json").send().await {
   Ok(resp) if resp.status().is_success()=>match resp.json::<Value>().await {
    Ok(value)=>{out.insert(req.identifier.to_ascii_lowercase(),parse(req,&value));},
    Err(e)=>errors.push(format!("{url}: invalid JSON: {e}"))
   },
   Ok(resp)=>errors.push(format!("{url}: HTTP {}",resp.status())),
   Err(e)=>errors.push(format!("{url}: {e}"))
  }
 }
 if out.is_empty()&&!errors.is_empty(){Err(errors.join("; "))}else{Ok(out)}
}
