//! Pump.fun metadata endpoint for Solana mint addresses.
use std::collections::HashMap;
use serde_json::Value;
use futures::stream::{self,StreamExt};
use crate::services::token_lookup::{BlockchainLookupConfig,TokenLookupRequest,TokenMetadata};

pub async fn lookup(client:&reqwest::Client,config:&BlockchainLookupConfig,requests:&[TokenLookupRequest])->Result<HashMap<String,TokenMetadata>,String>{
 if !config.enabled_providers.iter().any(|p|p=="pump_fun") {return Ok(HashMap::new())}
 let selected:Vec<_>=requests.iter().filter(|r|r.chain.eq_ignore_ascii_case("solana")&&!r.identifier.starts_with("native:")).cloned().collect();
 let rows:Vec<_>=stream::iter(selected).map(|r|async move{
  let url=format!("https://frontend-api-v3.pump.fun/coins/{}",r.identifier);
  let response=client.get(&url).header("accept","application/json").send().await.map_err(|e|format!("{url}: {e}"))?;
  if !response.status().is_success(){return Err(format!("{url}: HTTP {}",response.status()))}
  let v=response.json::<Value>().await.map_err(|e|format!("{url}: invalid JSON: {e}"))?;
  Ok((r.identifier.to_ascii_lowercase(),TokenMetadata{chain:r.chain,identifier:r.identifier,name:v["name"].as_str().or_else(||v["token_name"].as_str()).map(str::to_owned),symbol:v["symbol"].as_str().or_else(||v["ticker"].as_str()).map(str::to_owned),decimals:v["decimals"].as_u64().map(|v|v as u32),logo_url:v["image_uri"].as_str().or_else(||v["image"].as_str()).map(str::to_owned),price_usd:v["price_usd"].as_f64(),price_change_24h_percentage:v["price_change_24h"].as_f64(),source:Some("pump_fun".into())}))
 }).buffer_unordered(4).collect().await;
 let mut out=HashMap::new();let mut errors=Vec::new();for row in rows{match row{Ok((k,v))=>{out.insert(k,v);},Err(e)=>errors.push(e)}}
 if out.is_empty()&&!errors.is_empty(){Err(errors.join("; "))}else{Ok(out)}
}
