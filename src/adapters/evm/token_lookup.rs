//! EVM adapter-local metadata and market-data lookup.
//!
//! Queries DexScreener, GeckoTerminal, and CoinGecko independently. Existing
//! RPC-discovered metadata is preserved, provider results fill missing fields,
//! and provider failures never affect token balances or remove assets.
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

fn text(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value.get(*key).and_then(Value::as_str).map(str::trim)
            .filter(|s| !s.is_empty()).map(str::to_owned)
    })
}

fn number(value: &Value, keys: &[&str]) -> Option<u32> {
    keys.iter().find_map(|key| value.get(*key).and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok()))
}

fn number_or_string(value: &Value) -> Option<f64> {
    value.as_f64().or_else(|| value.as_str().and_then(|s| s.parse::<f64>().ok()))
        .filter(|n| n.is_finite())
}

fn valid_http_url(value: Option<String>) -> Option<String> {
    value.filter(|url| {
        let url = url.trim().to_ascii_lowercase();
        url.starts_with("https://") || url.starts_with("http://")
    })
}

fn merge(target: &mut TokenMetadata, incoming: TokenMetadata) {
    if target.name.as_deref().map_or(true, str::is_empty) {
        target.name = incoming.name.filter(|s| !s.trim().is_empty());
    }
    if target.symbol.as_deref().map_or(true, str::is_empty) {
        target.symbol = incoming.symbol.filter(|s| !s.trim().is_empty());
    }
    if target.decimals.is_none() { target.decimals = incoming.decimals; }
    if target.logo_url.as_deref().map_or(true, str::is_empty) {
        target.logo_url = incoming.logo_url;
    }
    if target.price_usd.is_none() { target.price_usd = incoming.price_usd; }
    if target.price_change_24h_percentage.is_none() {
        target.price_change_24h_percentage = incoming.price_change_24h_percentage;
    }
}

fn chain_key(name: &str, chain_id: &str) -> String {
    let name = name.trim().to_ascii_lowercase().replace(' ', "-").replace('_', "-");
    match name.as_str() {
        "eth" | "ethereum-mainnet" => "ethereum".into(),
        "bnb" | "binance" | "binance-smart-chain" | "bnb-smart-chain" => "bsc".into(),
        "matic" | "polygon-pos" | "polygon-mainnet" => "polygon".into(),
        "avax" | "avalanche-c-chain" => "avalanche".into(),
        "arb" | "arbitrum-one" => "arbitrum".into(),
        "op" | "optimistic-ethereum" => "optimism".into(),
        "ftm" => "fantom".into(),
        "xdai" => "gnosis".into(),
        "cro" => "cronos".into(),
        "movr" => "moonriver".into(),
        "pol" => "polygon".into(),
        "ethereum" | "bsc" | "polygon" | "avalanche" | "arbitrum" | "optimism"
        | "base" | "fantom" | "gnosis" | "cronos" | "moonriver" | "celo"
        | "linea" | "mantle" | "scroll" | "zksync" | "blast" | "opbnb"
        | "zora" | "mode" | "fraxtal" | "metis" | "world-chain" | "sonic" => name,
        _ => match chain_id.trim() {
            "1" => "ethereum".into(),
            "56" | "97" => "bsc".into(),
            "137" | "80002" => "polygon".into(),
            "43114" | "43113" => "avalanche".into(),
            "42161" | "421614" => "arbitrum".into(),
            "10" | "11155420" => "optimism".into(),
            "8453" | "84532" => "base".into(),
            "250" | "4002" => "fantom".into(),
            "100" => "gnosis".into(),
            "25" | "338" => "cronos".into(),
            "1285" | "1287" => "moonriver".into(),
            "42220" | "44787" => "celo".into(),
            "59144" | "59141" => "linea".into(),
            "5000" | "5003" => "mantle".into(),
            "534352" | "534351" => "scroll".into(),
            "324" | "300" => "zksync".into(),
            "81457" | "168587773" => "blast".into(),
            "204" | "5611" => "opbnb".into(),
            _ => name,
        },
    }
}

fn dexscreener_network(chain: &str) -> Option<&'static str> {
    match chain {
        "ethereum" => Some("ethereum"),
        "bsc" => Some("bsc"),
        "polygon" => Some("polygon"),
        "avalanche" => Some("avalanche"),
        "arbitrum" => Some("arbitrum"),
        "optimism" => Some("optimism"),
        "base" => Some("base"),
        "fantom" => Some("fantom"),
        "gnosis" => Some("gnosis"),
        "cronos" => Some("cronos"),
        "moonriver" => Some("moonriver"),
        "celo" => Some("celo"),
        "linea" => Some("linea"),
        "mantle" => Some("mantle"),
        "scroll" => Some("scroll"),
        "zksync" => Some("zksync"),
        "blast" => Some("blast"),
        "opbnb" => Some("opbnb"),
        "zora" => Some("zora"),
        "mode" => Some("mode"),
        "fraxtal" => Some("fraxtal"),
        "metis" => Some("metis"),
        "world-chain" => Some("worldchain"),
        "sonic" => Some("sonic"),
        _ => None,
    }
}

fn geckoterminal_network(chain: &str) -> Option<&'static str> {
    match chain {
        "ethereum" => Some("eth"),
        "bsc" => Some("bsc"),
        "polygon" => Some("polygon_pos"),
        "avalanche" => Some("avax"),
        "arbitrum" => Some("arbitrum"),
        "optimism" => Some("optimism"),
        "base" => Some("base"),
        "fantom" => Some("ftm"),
        "gnosis" => Some("xdai"),
        "cronos" => Some("cro"),
        "moonriver" => Some("moonriver"),
        "celo" => Some("celo"),
        "linea" => Some("linea"),
        "mantle" => Some("mantle"),
        "scroll" => Some("scroll"),
        "zksync" => Some("zksync"),
        "blast" => Some("blast"),
        "opbnb" => Some("op_bnb"),
        "zora" => Some("zora"),
        "mode" => Some("mode"),
        "fraxtal" => Some("fraxtal"),
        "metis" => Some("metis"),
        "world-chain" => Some("world_chain"),
        "sonic" => Some("sonic"),
        _ => None,
    }
}

fn coingecko_platform(chain: &str) -> Option<&'static str> {
    match chain {
        "ethereum" => Some("ethereum"),
        "bsc" => Some("binance-smart-chain"),
        "polygon" => Some("polygon-pos"),
        "avalanche" => Some("avalanche"),
        "arbitrum" => Some("arbitrum-one"),
        "optimism" => Some("optimistic-ethereum"),
        "base" => Some("base"),
        "fantom" => Some("fantom"),
        "gnosis" => Some("xdai"),
        "cronos" => Some("cronos"),
        "moonriver" => Some("moonriver"),
        "celo" => Some("celo"),
        "linea" => Some("linea"),
        "mantle" => Some("mantle"),
        "scroll" => Some("scroll"),
        "zksync" => Some("zksync"),
        "blast" => Some("blast"),
        "opbnb" => Some("opbnb"),
        _ => None,
    }
}

fn native_coingecko_id(chain: &str) -> Option<&'static str> {
    match chain {
        "ethereum" | "arbitrum" | "optimism" | "base" | "linea" | "scroll"
        | "zksync" | "blast" | "zora" | "mode" | "fraxtal" | "world-chain" => Some("ethereum"),
        "bsc" | "opbnb" => Some("binancecoin"),
        "polygon" => Some("polygon-ecosystem-token"),
        "avalanche" => Some("avalanche-2"),
        "fantom" => Some("fantom"),
        "gnosis" => Some("xdai"),
        "cronos" => Some("crypto-com-chain"),
        "moonriver" => Some("moonriver"),
        "celo" => Some("celo"),
        "mantle" => Some("mantle"),
        "metis" => Some("metis-token"),
        "sonic" => Some("sonic-3"),
        _ => None,
    }
}

async fn lookup_native(client: &Client, chain: &str) -> Result<TokenMetadata, String> {
    let id = native_coingecko_id(chain).ok_or_else(|| format!("CoinGecko native asset id not configured for EVM network {chain}"))?;
    let url = format!("https://api.coingecko.com/api/v3/coins/{id}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false");
    let response = client.get(&url).header("accept", "application/json").send().await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = response.status();
    if !status.is_success() { return Err(format!("HTTP {status}")); }
    let value = response.json::<Value>().await.map_err(|e| format!("invalid JSON: {e}"))?;
    Ok(TokenMetadata {
        name: text(&value, &["name"]),
        symbol: text(&value, &["symbol"]).map(|s| s.to_ascii_uppercase()),
        decimals: Some(18),
        logo_url: valid_http_url(value.pointer("/image/large").and_then(Value::as_str).map(str::to_owned)),
        price_usd: value.pointer("/market_data/current_price/usd").and_then(number_or_string),
        price_change_24h_percentage: value.pointer("/market_data/price_change_percentage_24h").and_then(number_or_string),
    })
}

async fn lookup_dexscreener(client: &Client, chain: &str, address: &str) -> Result<TokenMetadata, String> {
    let network = dexscreener_network(chain).ok_or_else(|| format!("DexScreener network slug not configured for {chain}"))?;
    let url = format!("https://api.dexscreener.com/tokens/v1/{network}/{address}");
    let response = client.get(&url).header("accept", "application/json").send().await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = response.status();
    if !status.is_success() { return Err(format!("HTTP {status}")); }
    let rows = response.json::<Value>().await.map_err(|e| format!("invalid JSON: {e}"))?;
    let pair = rows.as_array().and_then(|items| items.iter().find(|pair| {
        pair.get("chainId").and_then(Value::as_str).is_some_and(|c| c.eq_ignore_ascii_case(network))
            && pair.pointer("/baseToken/address").and_then(Value::as_str).is_some_and(|a| a.eq_ignore_ascii_case(address))
    })).ok_or_else(|| "no matching base-token market pair indexed".to_owned())?;
    let base = &pair["baseToken"];
    Ok(TokenMetadata {
        name: text(base, &["name"]),
        symbol: text(base, &["symbol"]),
        decimals: number(base, &["decimals"]),
        logo_url: valid_http_url(pair.pointer("/info/imageUrl").and_then(Value::as_str).map(str::to_owned)),
        price_usd: pair.get("priceUsd").and_then(number_or_string),
        price_change_24h_percentage: pair.pointer("/priceChange/h24").and_then(number_or_string),
    })
}

async fn lookup_geckoterminal(client: &Client, chain: &str, address: &str) -> Result<TokenMetadata, String> {
    let network = geckoterminal_network(chain).ok_or_else(|| format!("GeckoTerminal network slug not configured for {chain}"))?;
    let url = format!("https://api.geckoterminal.com/api/v2/networks/{network}/tokens/{address}");
    let response = client.get(&url).header("accept", "application/json").send().await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = response.status();
    if !status.is_success() { return Err(format!("HTTP {status}")); }
    let value = response.json::<Value>().await.map_err(|e| format!("invalid JSON: {e}"))?;
    let attributes = value.get("data").and_then(|d| d.get("attributes"))
        .ok_or_else(|| "response omitted data.attributes".to_owned())?;
    Ok(TokenMetadata {
        name: text(attributes, &["name"]),
        symbol: text(attributes, &["symbol"]),
        decimals: number(attributes, &["decimals"]),
        logo_url: valid_http_url(text(attributes, &["image_url"])),
        price_usd: attributes.get("price_usd").and_then(number_or_string),
        price_change_24h_percentage: attributes.pointer("/price_change_percentage/h24").and_then(number_or_string),
    })
}

async fn lookup_coingecko(client: &Client, chain: &str, address: &str) -> Result<TokenMetadata, String> {
    let platform = coingecko_platform(chain).ok_or_else(|| format!("CoinGecko platform not configured for {chain}"))?;
    let url = format!("https://api.coingecko.com/api/v3/coins/{platform}/contract/{address}?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false");
    let response = client.get(&url).header("accept", "application/json").send().await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = response.status();
    if !status.is_success() { return Err(format!("HTTP {status}")); }
    let value = response.json::<Value>().await.map_err(|e| format!("invalid JSON: {e}"))?;
    let decimals = value.get("detail_platforms").and_then(Value::as_object)
        .and_then(|platforms| platforms.get(platform))
        .and_then(|platform| platform.get("decimal_place"))
        .and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok());
    Ok(TokenMetadata {
        name: text(&value, &["name"]),
        symbol: text(&value, &["symbol"]).map(|s| s.to_ascii_uppercase()),
        decimals,
        logo_url: valid_http_url(value.pointer("/image/large").and_then(Value::as_str).map(str::to_owned)),
        price_usd: value.pointer("/market_data/current_price/usd").and_then(number_or_string),
        price_change_24h_percentage: value.pointer("/market_data/price_change_percentage_24h").and_then(number_or_string),
    })
}

/// Enrich already-discovered EVM assets. Contract addresses are matched without
/// case sensitivity; native coin lookup is selected by network. All provider
/// calls are independent and metadata failure never changes a balance.
pub async fn enrich(client: &Client, chain_name: &str, chain_id: &str, assets: &[BalanceAsset]) -> HashMap<String, TokenMetadata> {
    let chain = chain_key(chain_name, chain_id);
    let mut result = HashMap::new();

    // Bound concurrency to avoid serial per-token latency and excessive provider
    // fan-out for wallets holding many ERC-20 assets.
    for batch in assets.chunks(8) {
        let outcomes = futures::future::join_all(batch.iter().map(|asset| {
            let chain = chain.as_str();
            async move {
            let key = if asset.is_native { "native".to_owned() } else { asset.address.to_ascii_lowercase() };
            let mut metadata = TokenMetadata {
                name: asset.name.clone(),
                symbol: asset.symbol.clone(),
                decimals: asset.decimals,
                logo_url: asset.logo_url.clone(),
                price_usd: asset.price_usd,
                price_change_24h_percentage: asset.price_change_24h_percentage,
            };

            if asset.is_native || asset.address.eq_ignore_ascii_case("native") {
                match lookup_native(client, chain).await {
                    Ok(found) => {
                        eprintln!("[evm_token_lookup] provider=coingecko_native chain={} status=ok price={} change={} logo={}", chain, found.price_usd.is_some(), found.price_change_24h_percentage.is_some(), found.logo_url.is_some());
                        merge(&mut metadata, found);
                    }
                    Err(error) => eprintln!("[evm_token_lookup] provider=coingecko_native chain={} status=error error={}", chain, error),
                }
                eprintln!("[evm_token_lookup] token_final chain={} token=native price={} change={} logo={}", chain, metadata.price_usd.is_some(), metadata.price_change_24h_percentage.is_some(), metadata.logo_url.is_some());
                return (key, metadata);
            }

            let (dex, gecko, coingecko) = tokio::join!(
                lookup_dexscreener(client, chain, &asset.address),
                lookup_geckoterminal(client, chain, &asset.address),
                lookup_coingecko(client, chain, &asset.address)
            );
            for (provider, outcome) in [("dexscreener", dex), ("geckoterminal", gecko), ("coingecko", coingecko)] {
                match outcome {
                    Ok(found) => {
                        eprintln!("[evm_token_lookup] provider={} chain={} token={} status=ok name={} symbol={} decimals={} logo={} price={} change={}", provider, chain, key, found.name.is_some(), found.symbol.is_some(), found.decimals.is_some(), found.logo_url.is_some(), found.price_usd.is_some(), found.price_change_24h_percentage.is_some());
                        merge(&mut metadata, found);
                    }
                    Err(error) => eprintln!("[evm_token_lookup] provider={} chain={} token={} status=error error={}", provider, chain, key, error),
                }
            }
            eprintln!("[evm_token_lookup] token_final chain={} token={} name={} symbol={} decimals={} logo={} price={} change={}", chain, key, metadata.name.is_some(), metadata.symbol.is_some(), metadata.decimals.is_some(), metadata.logo_url.is_some(), metadata.price_usd.is_some(), metadata.price_change_24h_percentage.is_some());
            (key, metadata)
            }
        })).await;
        for (key, metadata) in outcomes {
            result.insert(key, metadata);
        }
    }
    result
}
