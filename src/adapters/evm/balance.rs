//! Chain-specific balance normalization for the evm adapter.
//!
//! Transport and provider authentication remain in balance_service providers;
//! this module owns the adapter-specific conversion into the shared balance model.
use crate::common::errors::EngineError;
use crate::services::balance_service::service::{BalanceAsset, ChainBalance};

pub fn normalize(mut balance: ChainBalance) -> Result<ChainBalance, EngineError> {
    let native = balance.native.take().ok_or_else(|| EngineError::Validation("evm balance response has no native asset".into()))?;
    let original_tokens = balance.tokens.clone();
    let rows: Vec<crate::adapters::evm::AssetRow> = std::iter::once(native.clone()).chain(balance.tokens.iter().cloned()).map(|a| crate::adapters::evm::AssetRow {
        address: a.address, symbol: a.symbol.unwrap_or_else(|| String::new()), decimals: a.decimals, is_native: a.is_native, balance: a.balance
    }).collect();
    let rows = crate::adapters::evm::EvmAdapter::normalize_balances(rows);
    let mut iter = rows.into_iter();
    let first = iter.next().ok_or_else(|| EngineError::Validation("evm adapter returned no normalized native balance".into()))?;
    balance.native = Some(BalanceAsset {
        address: first.address,
        symbol: if first.symbol.is_empty() { native.symbol.clone() } else { Some(first.symbol) },
        name: native.name,
        decimals: first.decimals,
        balance: first.balance,
        is_native: true,
        logo_url: native.logo_url,
        price_usd: native.price_usd,
        price_change_24h_percentage: native.price_change_24h_percentage,
    });
    balance.tokens = iter.zip(original_tokens.into_iter()).map(|(r, original)| BalanceAsset {
        address: r.address,
        symbol: if r.symbol.is_empty() { original.symbol.clone() } else { Some(r.symbol) },
        name: original.name,
        decimals: r.decimals.or(original.decimals),
        balance: r.balance,
        is_native: false,
        logo_url: original.logo_url,
        price_usd: original.price_usd,
        price_change_24h_percentage: original.price_change_24h_percentage,
    }).collect();
    Ok(balance)
}

/// Fetch a batch through the selected balance-service provider, then normalize
/// each successful result with this adapter's chain-specific policy.
pub async fn fetch_batch(
    provider: std::sync::Arc<dyn crate::services::balance_service::providers::BalanceProvider>,
    requests: Vec<crate::services::balance_service::providers::BalanceProviderRequest>,
) -> Result<Vec<crate::services::balance_service::providers::BalanceProviderResponse>, crate::services::balance_service::providers::BalanceProviderError> {
    crate::adapters::balance_support::fetch_batch(provider, requests, normalize).await
}
