use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::HashMap;
use futures::future::join_all;

use crate::services::balance_service::service::{BalanceAsset, ChainBalance};
use crate::services::rpc::providers::RpcRequest;

use super::{
    BalanceProvider, BalanceProviderError, BalanceProviderRequest,
    BalanceProviderResponse,
};

/// Dedicated TRON balance provider. Native TRX/TRC-10 data comes from
/// /wallet/getaccount; TRC-20 contracts are discovered through TronGrid's
/// indexed account endpoint, so callers do not need to pre-supply contract IDs.
pub struct TronBalanceProvider;

fn tron_api_key() -> Option<String> {
    std::env::var("TRON_PRO_API_KEY").ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| std::env::var("TRONGRID_API_KEY").ok()
            .filter(|value| !value.trim().is_empty()))
}

fn headers_params() -> Value {
    match tron_api_key() {
        Some(key) => json!({"__headers": {"TRON-PRO-API-KEY": key}}),
        None => Value::Null,
    }
}

fn parse_integer(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
        .or_else(|| value.as_u64().map(|number| number.to_string()))
        .or_else(|| value.as_i64().filter(|number| *number >= 0).map(|number| number.to_string()))
}

fn cursor_escape(value: &str) -> String {
    value.replace('%', "%25").replace('+', "%2B")
        .replace('/', "%2F").replace('=', "%3D")
        .replace('&', "%26").replace('?', "%3F")
}

async fn tron_request(
    request: &BalanceProviderRequest,
    endpoint: String,
    method: &str,
    params: Value,
) -> Result<Value, BalanceProviderError> {
    request.rpc.execute_one(RpcRequest {
        provider: "tron".into(),
        chain_type: "http".into(),
        chain_id: request.request.chain.chain_id.clone(),
        endpoint,
        method: method.into(),
        params,
    }).await.map(|response| response.result).map_err(BalanceProviderError::Message)
}

async fn fetch_one(request: BalanceProviderRequest) -> BalanceProviderResponse {
    let wallet_request = &request.request;
    let wallet_id = wallet_request.wallet_id.clone();
    let chain_id = wallet_request.chain.chain_id.clone();
    let base = wallet_request.rpc_endpoint.trim_end_matches('/').to_owned();

    let account = match tron_request(
        &request,
        base.clone(),
        "/wallet/getaccount",
        json!({"address": wallet_request.address, "visible": true, "__headers": headers_params().get("__headers").cloned().unwrap_or(Value::Null)}),
    ).await {
        Ok(value) => value,
        Err(error) => return BalanceProviderResponse::error(&request.request, error),
    };

    let native_raw = parse_integer(account.get("balance").unwrap_or(&Value::Null))
        .unwrap_or_else(|| "0".to_owned());
    let mut native = BalanceAsset {
        address: "native".into(),
        symbol: Some("TRX".into()),
        name: Some("TRON".into()),
        decimals: Some(6),
        balance: native_raw,
        is_native: true,
                logo_url: None,
                price_usd: None,
                price_change_24h_percentage: None,
    };

    let mut tokens = Vec::<BalanceAsset>::new();
    let mut seen = std::collections::HashSet::<String>::new();

    let mut fingerprint: Option<String> = None;
    const MAX_PAGES: usize = 100;
    for _ in 0..MAX_PAGES {
        let mut url = format!("{}/v1/accounts/{}/trc20/balance?limit=200", base, wallet_request.address);
        if let Some(cursor) = fingerprint.as_deref() {
            url.push_str("&fingerprint=");
            url.push_str(&cursor_escape(cursor));
        }

        let page = match tron_request(&request, url, "__http_get", headers_params()).await {
            Ok(value) => value,
            Err(error) => {
                crate::services::event_service::EventService::publish(
                    "balance.token_discovery.failed",
                    json!({"wallet_id": wallet_id, "chain_id": chain_id, "provider": "tron", "message": error.to_string()}),
                );
                return BalanceProviderResponse::error(&request.request, error);
            }
        };

        let Some(items) = page.get("data").and_then(Value::as_array) else {
            crate::services::event_service::EventService::publish(
                "balance.token_discovery.failed",
                json!({"wallet_id": wallet_id, "chain_id": chain_id, "provider": "tron", "message": format!("TronGrid response omitted data array: {}", page)}),
            );
            return BalanceProviderResponse::error(
                &request.request,
                BalanceProviderError::Message(format!(
                    "TRON token discovery incomplete: TronGrid response omitted data array: {}",
                    page
                )),
            );
        };

        for item in items {
            // TronGrid's documented TRC-20 balance response uses token_info.
            // Accept token as well for compatible indexers, but never assume the
            // metadata is flattened onto the balance row.
            let token = item.get("token_info")
                .or_else(|| item.get("token"))
                .unwrap_or(item);
            let contract = token.get("address").and_then(Value::as_str)
                .or_else(|| item.get("contract_address").and_then(Value::as_str))
                .or_else(|| item.get("contractAddress").and_then(Value::as_str))
                .or_else(|| item.get("token_address").and_then(Value::as_str));
            let Some(contract) = contract.map(str::trim).filter(|value| !value.is_empty()) else { continue; };
            if !seen.insert(contract.to_ascii_lowercase()) { continue; }

            let Some(raw_balance) = item.get("balance").and_then(parse_integer) else { continue; };
            let is_zero = raw_balance.parse::<u128>().map(|value| value == 0).unwrap_or(raw_balance.chars().all(|c| c == '0'));
            if is_zero { continue; }

            tokens.push(BalanceAsset {
                address: contract.to_owned(),
                symbol: token.get("symbol").and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).map(str::to_owned),
                name: token.get("name").and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).map(str::to_owned),
                decimals: token.get("decimals").and_then(Value::as_u64).and_then(|value| u32::try_from(value).ok()),
                balance: raw_balance,
                is_native: false,
                logo_url: None,
                price_usd: None,
                price_change_24h_percentage: None,
            });
        }

        fingerprint = page.pointer("/meta/fingerprint").and_then(Value::as_str)
            .filter(|value| !value.is_empty()).map(str::to_owned);
        if fingerprint.is_none() { break; }
    }

    // Keep TRC-10 holdings returned by getaccount; they are distinct from TRC-20 contracts.
    if let Some(asset_rows) = account.get("assetV2").and_then(Value::as_array) {
        for asset in asset_rows {
            let id = asset.get("key").and_then(parse_integer);
            let balance = asset.get("value").and_then(parse_integer);
            let (Some(id), Some(balance)) = (id, balance) else { continue; };
            if balance.parse::<u128>().map(|value| value == 0).unwrap_or(false) { continue; }
            tokens.push(BalanceAsset {
                address: format!("trc10:{}", id),
                symbol: None,
                name: None,
                decimals: None,
                balance,
                is_native: false,
                logo_url: None,
                price_usd: None,
                price_change_24h_percentage: None,
            });
        }
    }

    // TRON adapter-local lookup: each metadata provider is isolated and logged.
    // Metadata failures never discard the balances already discovered above.
    let metadata_client = reqwest::Client::builder()
        .user_agent("NodexWalletEngine/0.1 tron-token-metadata")
        .connect_timeout(std::time::Duration::from_secs(3))
        .timeout(std::time::Duration::from_secs(8))
        .build();
    match metadata_client {
        Ok(client) => {
            let mut lookup_assets = Vec::with_capacity(tokens.len() + 1);
            lookup_assets.push(native.clone());
            lookup_assets.extend(tokens.iter().cloned());
            let metadata = crate::adapters::tron_token_lookup::enrich(&client, &base, &lookup_assets).await;
            if let Some(found) = metadata.get("native") {
                if native.name.is_none() { native.name = found.name.clone(); }
                if native.symbol.is_none() { native.symbol = found.symbol.clone(); }
                if native.decimals.is_none() { native.decimals = found.decimals; }
                if native.logo_url.is_none() { native.logo_url = found.logo_url.clone(); }
                native.price_usd = found.price_usd;
                native.price_change_24h_percentage = found.price_change_24h_percentage;
            }
            for token in &mut tokens {
                if let Some(found) = metadata.get(&token.address.to_ascii_lowercase()) {
                    if token.name.is_none() { token.name = found.name.clone(); }
                    if token.symbol.is_none() { token.symbol = found.symbol.clone(); }
                    if token.decimals.is_none() { token.decimals = found.decimals; }
                    if token.logo_url.is_none() { token.logo_url = found.logo_url.clone(); }
                    if token.price_usd.is_none() { token.price_usd = found.price_usd; }
                    if token.price_change_24h_percentage.is_none() { token.price_change_24h_percentage = found.price_change_24h_percentage; }
                }
            }
        }
        Err(error) => eprintln!("[tron_token_lookup] status=client_init_error error={}", error),
    }

    BalanceProviderResponse::success(ChainBalance {
        wallet_id,
        chain_id: wallet_request.chain.chain_id.clone(),
        chain_type: wallet_request.chain.chain_type.clone(),
        address: wallet_request.address.clone(),
        native: Some(native),
        tokens,
    })
}

#[async_trait]
impl BalanceProvider for TronBalanceProvider {
    async fn fetch_batch(
        &self,
        requests: Vec<BalanceProviderRequest>,
    ) -> Result<Vec<BalanceProviderResponse>, BalanceProviderError> {
        Ok(join_all(requests.into_iter().map(fetch_one)).await)
    }
}
