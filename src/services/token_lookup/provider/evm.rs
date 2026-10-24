//! EVM token metadata via ethers ERC-20 contract calls.
//! Market data (price/logo) is merged from DexScreener and GeckoTerminal.
use std::{collections::HashMap, str::FromStr, sync::Arc};
use ethers::abi::Abi;
use ethers::providers::{Http, Provider};
use ethers::types::Address;
use crate::services::token_lookup::{BlockchainLookupConfig,TokenLookupRequest,TokenMetadata};

const ERC20_ABI:&str=r#"[{"constant":true,"inputs":[],"name":"name","outputs":[{"name":"","type":"string"}],"type":"function"},{"constant":true,"inputs":[],"name":"symbol","outputs":[{"name":"","type":"string"}],"type":"function"},{"constant":true,"inputs":[],"name":"decimals","outputs":[{"name":"","type":"uint8"}],"type":"function"}]"#;

fn public_rpc(chain:&str)->Option<&'static str>{
 match chain {
  "ethereum"=>Some("https://ethereum.publicnode.com"),
  "bsc"=>Some("https://bsc-dataseed.binance.org"),
  "polygon"=>Some("https://polygon-bor-rpc.publicnode.com"),
  "avalanche"=>Some("https://avalanche-c-chain-rpc.publicnode.com"),
  "arbitrum"=>Some("https://arbitrum-one-rpc.publicnode.com"),
  "optimism"=>Some("https://optimism-rpc.publicnode.com"),
  "base"=>Some("https://base-rpc.publicnode.com"),
  "fantom"=>Some("https://fantom-rpc.publicnode.com"),
  "gnosis"=>Some("https://gnosis-rpc.publicnode.com"),
  "cronos"=>Some("https://evm.cronos.org"),
  _=>None,
 }
}

pub async fn lookup(_client:&reqwest::Client,config:&BlockchainLookupConfig,requests:&[TokenLookupRequest])->Result<HashMap<String,TokenMetadata>,String>{
 let abi:Abi=serde_json::from_str(ERC20_ABI).map_err(|e|format!("invalid ERC-20 ABI: {e}"))?;
 let mut out=HashMap::new();
 let mut errors=Vec::new();
 for req in requests.iter().filter(|r|!r.identifier.starts_with("native:")) {
  let Some(rpc)=config.provider_networks.get("evm_rpc").map(String::as_str).or_else(||public_rpc(&req.chain)) else {continue};
  let address=match Address::from_str(&req.identifier){Ok(v)=>v,Err(_)=>continue};
  let provider=Provider::<Http>::try_from(rpc).map_err(|e|format!("invalid EVM RPC endpoint for {}: {e}",req.chain))?;
  let contract=ethers::contract::Contract::new(address,abi.clone(),Arc::new(provider));
  let name=match contract.method::<_,String>("name",()).map_err(|e|format!("{} name ABI: {e}",req.identifier))?.call().await { Ok(v)=>Some(v), Err(e)=>{errors.push(format!("{} name() at {rpc}: {e}",req.identifier));None} };
  let symbol=match contract.method::<_,String>("symbol",()).map_err(|e|format!("{} symbol ABI: {e}",req.identifier))?.call().await { Ok(v)=>Some(v), Err(e)=>{errors.push(format!("{} symbol() at {rpc}: {e}",req.identifier));None} };
  let decimals=match contract.method::<_,u8>("decimals",()).map_err(|e|format!("{} decimals ABI: {e}",req.identifier))?.call().await { Ok(v)=>Some(u32::from(v)), Err(e)=>{errors.push(format!("{} decimals() at {rpc}: {e}",req.identifier));None} };
  if name.is_some()||symbol.is_some()||decimals.is_some(){out.insert(req.identifier.to_ascii_lowercase(),TokenMetadata{chain:req.chain.clone(),identifier:req.identifier.clone(),name,symbol,decimals,logo_url:None,price_usd:None,price_change_24h_percentage:None,source:Some("evm_erc20_rpc".into())});}
 }
 if out.is_empty() && !errors.is_empty() { Err(errors.join("; ")) } else { Ok(out) }
}
