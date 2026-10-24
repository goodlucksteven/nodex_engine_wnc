use std::sync::Arc;
use tokio::sync::mpsc::{self, UnboundedReceiver};
use serde::{Deserialize, Serialize};
use crate::services::balance_service::providers::{BalanceProvider, BalanceProviderRequest};
use crate::adapters::registry::AdapterRegistry;
use crate::services::balance_service::registry::BalanceProviderRegistry;
use crate::types::chain::ChainRequest;
use crate::services::rpc::RpcOrchestrator;
use crate::services::wallet::WalletRegistry;
use crate::common::errors::EngineError;
use crate::services::event_service::EventService;
use serde_json::json;
use futures::FutureExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BalanceAsset {
    pub address: String,
    pub symbol: Option<String>,
    pub name: Option<String>,
    pub decimals: Option<u32>,
    pub balance: String,
    pub is_native: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logo_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub price_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub price_change_24h_percentage: Option<f64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChainBalance { pub wallet_id: String, pub chain_id: String, pub chain_type: String, pub address: String, pub native: Option<BalanceAsset>, pub tokens: Vec<BalanceAsset> }
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BalanceError { pub wallet_id: String, pub chain_id: String, pub provider: String, pub message: String }

/// A per-chain result. A batch is successful at the transport level even when
/// one or more chains fail; each chain carries its own success/error state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BalanceBatchResult {
    pub results: Vec<Result<ChainBalance, BalanceError>>,
}
#[derive(Debug, Clone)]
pub struct BalanceRequest {
    pub wallet_id: String,
    pub provider: String,
    pub rpc_endpoint: String,
    pub chain: ChainRequest,
    pub address: String,
    /// Empty means native balance only. Otherwise contains token contract addresses.
    pub assets: Vec<String>,
}

#[derive(Debug, Clone)]
pub enum BalanceUpdateScope {
    All,
    Chain { chain_id: String, tokens: Vec<String> },
}

#[derive(Debug, Clone)]
pub struct BalanceUpdateRequest {
    pub wallet_id: String,
    pub scope: BalanceUpdateScope,
    pub address: Option<String>,
}

/// Balance administrator. It routes requests to balance-specific providers.
/// Provider implementations own balance batching/grouping and use RPC underneath when needed.
pub struct BalanceFetchService { registry: BalanceProviderRegistry, rpc: Arc<RpcOrchestrator> }
impl BalanceFetchService {
    pub fn new(registry: BalanceProviderRegistry, rpc: Arc<RpcOrchestrator>) -> Self { Self { registry, rpc } }
    pub fn registry(&self) -> &BalanceProviderRegistry { &self.registry }
    /// Single public balance endpoint. Every balance operation uses the same
    /// streaming response path. Each chain is dispatched independently; results
    /// are emitted as soon as that chain completes, without waiting for other chains.
    pub async fn get_balance(
        self: Arc<Self>,
        requests: Vec<BalanceRequest>,
    ) -> UnboundedReceiver<Result<ChainBalance, BalanceError>> {
        let (tx, rx) = mpsc::unbounded_channel();
        // Bound cross-chain fan-out. Launching 100+ requests at once can cause
        // provider rate limits, socket pressure, and long tail latency. Each
        // chain still reports immediately when its own work finishes.
        let concurrency = Arc::new(tokio::sync::Semaphore::new(12));

        // One task per chain. The stream carries one terminal result per request
        // (a complete chain balance or a chain-local error), not token-by-token
        // updates. This preserves the current consumer contract while allowing
        // fast chains to arrive before slow chains.
        for request in requests {
            let service = Arc::clone(&self);
            let tx = tx.clone();
            let concurrency = Arc::clone(&concurrency);

            tokio::spawn(async move {
                let _permit = match concurrency.acquire_owned().await {
                    Ok(permit) => permit,
                    Err(_) => {
                        let _ = tx.send(Err(BalanceError {
                            wallet_id: request.wallet_id.clone(),
                            chain_id: request.chain.chain_id.clone(),
                            provider: request.provider.trim().to_ascii_lowercase(),
                            message: "balance worker queue was closed before this chain could start".into(),
                        }));
                        return;
                    }
                };

                let failure_context = (
                    request.wallet_id.clone(),
                    request.chain.chain_id.clone(),
                    request.provider.trim().to_ascii_lowercase(),
                    request.chain.normalized_type().to_ascii_lowercase(),
                    request.chain.name.clone(),
                    request.address.clone(),
                );

                // Catch panics at the per-chain boundary so a faulty adapter
                // cannot cancel other tasks or silently omit this request.
                let result = std::panic::AssertUnwindSafe(
                    service.fetch_one_chain(request)
                ).catch_unwind().await;

                let result = match result {
                    Ok(result) => result,
                    Err(_) => {
                        let failure = BalanceError {
                            wallet_id: failure_context.0,
                            chain_id: failure_context.1,
                            provider: failure_context.2.clone(),
                            message: "balance adapter panicked while fetching this chain".into(),
                        };
                        EventService::publish("balance.fetch.failed", json!({
                            "wallet_id": failure.wallet_id,
                            "chain_id": failure.chain_id,
                            "chain_type": failure_context.3,
                            "chain_name": failure_context.4,
                            "address": failure_context.5,
                            "provider": failure.provider,
                            "message": failure.message
                        }));
                        Err(failure)
                    }
                };

                // A caller may stop listening early. A closed receiver is not
                // a fetch failure and must not affect any other chain task.
                let _ = tx.send(result);
            });
        }

        // The stream closes naturally after all per-chain senders are dropped.
        drop(tx);
        rx
    }

    async fn fetch_one_chain(
        self: Arc<Self>,
        request: BalanceRequest,
    ) -> Result<ChainBalance, BalanceError> {
        let provider_name = request.provider.trim().to_ascii_lowercase();
        let chain_type = request.chain.normalized_type().to_ascii_lowercase();
        let wallet_id = request.wallet_id.clone();
        let chain_id = request.chain.chain_id.clone();
        let chain_name = request.chain.name.clone();
        let chain_address = request.address.clone();
        let asset_count = request.assets.len();
        let started_at = std::time::Instant::now();

        EventService::publish("balance.fetch.started", json!({
            "wallet_id": wallet_id,
            "chain_id": chain_id,
            "chain_type": chain_type,
            "chain_name": chain_name,
            "address": chain_address,
            "provider": provider_name,
            "asset_count": asset_count
        }));

        let Some(provider) = self.registry.get(&provider_name) else {
            let failure = BalanceError {
                wallet_id: request.wallet_id.clone(),
                chain_id: request.chain.chain_id.clone(),
                provider: provider_name,
                message: "no balance provider registered".into(),
            };
            EventService::publish("balance.fetch.failed", json!({
                "wallet_id": failure.wallet_id,
                "chain_id": failure.chain_id,
                "chain_type": chain_type,
                "chain_name": chain_name,
                "address": chain_address,
                "provider": failure.provider,
                "duration_ms": started_at.elapsed().as_millis(),
                "message": failure.message
            }));
            return Err(failure);
        };

        // Keep adapter/provider calls chain-local; unrelated chains are never
        // combined into one provider batch.
        let wrapped = vec![BalanceProviderRequest {
            request,
            rpc: Arc::clone(&self.rpc),
        }];

        match AdapterRegistry::fetch_balance_batch(
            &chain_type,
            Arc::clone(&provider),
            wrapped,
        ).await {
            Ok(mut responses) if responses.len() == 1 => {
                let response = responses.remove(0);
                match response.result {
                    Ok(balance) => {
                        EventService::publish("balance.result", json!({
                            "wallet_id": balance.wallet_id,
                            "chain_id": balance.chain_id,
                            "chain_type": balance.chain_type,
                            "chain_name": chain_name,
                            "address": balance.address,
                            "provider": provider_name,
                            "duration_ms": started_at.elapsed().as_millis(),
                            "balance": balance
                        }));
                        Ok(balance)
                    }
                    Err(error) => {
                        let failure = BalanceError {
                            wallet_id: response.wallet_id,
                            chain_id: response.chain_id,
                            provider: provider_name,
                            message: error.to_string(),
                        };
                        EventService::publish("balance.fetch.failed", json!({
                            "wallet_id": failure.wallet_id,
                            "chain_id": failure.chain_id,
                            "chain_type": chain_type,
                            "chain_name": chain_name,
                            "address": chain_address,
                            "provider": failure.provider,
                            "duration_ms": started_at.elapsed().as_millis(),
                            "message": failure.message
                        }));
                        Err(failure)
                    }
                }
            }
            Ok(responses) => {
                let failure = BalanceError {
                    wallet_id,
                    chain_id,
                    provider: provider_name,
                    message: format!(
                        "adapter returned {} results for one blockchain request",
                        responses.len()
                    ),
                };
                EventService::publish("balance.fetch.failed", json!({
                    "wallet_id": failure.wallet_id,
                    "chain_id": failure.chain_id,
                    "chain_type": chain_type,
                    "chain_name": chain_name,
                    "address": chain_address,
                    "provider": failure.provider,
                    "duration_ms": started_at.elapsed().as_millis(),
                    "message": failure.message
                }));
                Err(failure)
            }
            Err(error) => {
                let failure = BalanceError {
                    wallet_id,
                    chain_id,
                    provider: provider_name,
                    message: error.to_string(),
                };
                EventService::publish("balance.fetch.failed", json!({
                    "wallet_id": failure.wallet_id,
                    "chain_id": failure.chain_id,
                    "provider": failure.provider,
                    "duration_ms": started_at.elapsed().as_millis(),
                    "message": failure.message
                }));
                Err(failure)
            }
        }
    }

    /// Returns the saved balances for the currently active wallet.
    /// This never contacts RPC.
    pub fn get_active_balance(chain_id: Option<&str>) -> Result<Vec<ChainBalance>, EngineError> {
        let wallet = WalletRegistry::active()?
            .ok_or_else(|| EngineError::Validation("no active wallet".into()))?;
        Self::get_saved_balance(&wallet.wallet_id, chain_id)
    }

    /// Returns the balances already persisted in the active/local wallet.
    /// This operation never contacts RPC and never invokes an adapter.
    pub fn get_saved_balance(
        wallet_id: &str,
        chain_id: Option<&str>,
    ) -> Result<Vec<ChainBalance>, EngineError> {
        let wallet = WalletRegistry::get(wallet_id)?;
        let mut results = Vec::new();

        for chain in wallet.blockchains {
            if let Some(requested) = chain_id {
                if chain.chain_id != requested {
                    continue;
                }
            }

            let native = chain.balance.as_ref().map(|balance| BalanceAsset {
                address: chain.address.clone(),
                symbol: chain.symbol.clone(),
                name: Some(chain.name.clone()),
                decimals: None,
                balance: balance.clone(),
                is_native: true,
            
                logo_url: None,
                price_usd: None,
                price_change_24h_percentage: None,
            });

            let tokens = chain.tokens.into_iter().map(|token| BalanceAsset {
                address: token.contract_address,
                symbol: Some(token.symbol),
                name: Some(token.name),
                decimals: Some(token.decimals),
                balance: token.balance.unwrap_or_else(|| "0".into()),
                is_native: false,
            
                logo_url: None,
                price_usd: None,
                price_change_24h_percentage: None,
            }).collect();

            results.push(ChainBalance {
                wallet_id: wallet.wallet_id.clone(),
                chain_id: chain.chain_id,
                chain_type: chain.chain_type,
                address: chain.address,
                native,
                tokens,
            });
        }

        Ok(results)
    }

    pub async fn update_balance(
        self: Arc<Self>,
        request: BalanceUpdateRequest,
        stored_chains: Vec<BalanceRequest>,
    ) -> UnboundedReceiver<Result<ChainBalance, BalanceError>> {
        let selected = match request.scope {
            BalanceUpdateScope::All => stored_chains,
            BalanceUpdateScope::Chain { chain_id, tokens } => {
                stored_chains.into_iter()
                    .filter(|item| item.chain.chain_id == chain_id)
                    .map(|mut item| {
                        if !tokens.is_empty() {
                            item.assets = tokens.clone();
                        }
                        if let Some(address) = request.address.clone() {
                            item.address = address;
                        }
                        item
                    })
                    .collect()
            }
        };

        self.get_balance(selected).await
    }

}
