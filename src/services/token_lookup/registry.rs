//! Central registry and concurrent dispatcher for token metadata providers.
use std::collections::HashMap;
use crate::services::token_lookup::{provider, BlockchainLookupConfig, TokenLookupRequest, TokenMetadata};

/// Dispatch providers independently. A failure or empty result from one provider
/// must never prevent other providers from contributing metadata.
pub async fn dispatch(
    client: &reqwest::Client,
    config: &BlockchainLookupConfig,
    requests: &[TokenLookupRequest],
) -> (HashMap<String, TokenMetadata>, Vec<String>) {
    eprintln!("[token_lookup] batch_start requests={} chain={} providers=dexscreener,geckoterminal,coingecko,pump_fun,evm", requests.len(), config.chain_name);

    let (dex, gecko, coingecko, pump, evm) = tokio::join!(
        provider::dex_screener::lookup(client, config, requests),
        provider::gecko_terminal::lookup(client, config, requests),
        provider::coingecko::lookup(client, config, requests),
        provider::pump_fun::lookup(client, config, requests),
        provider::evm::lookup(client, config, requests),
    );

    let mut errors = Vec::new();
    let mut merged: HashMap<String, TokenMetadata> = HashMap::new();

    for (provider_name, result) in [
        ("dexscreener", dex),
        ("geckoterminal", gecko),
        ("coingecko", coingecko),
        ("pump_fun", pump),
        ("evm", evm),
    ] {
        match result {
            Ok(items) => {
                eprintln!("[token_lookup] provider={} status=ok returned_tokens={}/{}", provider_name, items.len(), requests.len());
                for (key, value) in items {
                    eprintln!(
                        "[token_lookup] provider={} token={} name={} symbol={} decimals={} logo={} price_usd={} change_24h={}",
                        provider_name, key,
                        value.name.as_deref().is_some_and(|v| !v.trim().is_empty()),
                        value.symbol.as_deref().is_some_and(|v| !v.trim().is_empty()),
                        value.decimals.is_some(), value.logo_url.as_deref().is_some_and(|v| !v.trim().is_empty()),
                        value.price_usd.is_some(), value.price_change_24h_percentage.is_some()
                    );
                    let target = merged.entry(key).or_insert_with(|| TokenMetadata {
                        chain: value.chain.clone(),
                        identifier: value.identifier.clone(),
                        ..TokenMetadata::default()
                    });
                    if target.name.is_none() { target.name = value.name.clone(); }
                    if target.symbol.is_none() { target.symbol = value.symbol.clone(); }
                    if target.decimals.is_none() { target.decimals = value.decimals; }
                    if target.logo_url.is_none() { target.logo_url = value.logo_url.clone(); }
                    if target.price_usd.is_none() { target.price_usd = value.price_usd; }
                    if target.price_change_24h_percentage.is_none() { target.price_change_24h_percentage = value.price_change_24h_percentage; }
                    if target.source.is_none() && (value.name.is_some() || value.symbol.is_some() || value.decimals.is_some() || value.logo_url.is_some() || value.price_usd.is_some() || value.price_change_24h_percentage.is_some()) { target.source = Some(provider_name.to_owned()); }
                }
            }
            Err(error) => {
                eprintln!("[token_lookup] provider={} status=error error={}", provider_name, error);
                errors.push(format!("{provider_name}: {error}"));
            }
        }
    }

    for request in requests {
        let key = request.identifier.to_ascii_lowercase();
        match merged.get(&key) {
            Some(value) => eprintln!(
                "[token_lookup] token_final chain={} identifier={} name={} symbol={} decimals={} logo={} price_usd={} change_24h={} source={}",
                request.chain, request.identifier,
                value.name.as_deref().is_some_and(|v| !v.trim().is_empty()),
                value.symbol.as_deref().is_some_and(|v| !v.trim().is_empty()),
                value.decimals.is_some(), value.logo_url.as_deref().is_some_and(|v| !v.trim().is_empty()),
                value.price_usd.is_some(), value.price_change_24h_percentage.is_some(),
                value.source.as_deref().unwrap_or("none")
            ),
            None => eprintln!(
                "[token_lookup] token_final chain={} identifier={} status=unresolved note={}",
                request.chain, request.identifier,
                if request.chain.eq_ignore_ascii_case("tron") && request.identifier.to_ascii_lowercase().starts_with("trc10:") {
                    "TRC-10 numeric asset ID is not a contract address; contract-address providers may not index it"
                } else { "no provider returned metadata for this identifier" }
            ),
        }
    }

    eprintln!("[token_lookup] batch_complete requests={} resolved={} provider_errors={}", requests.len(), merged.len(), errors.len());
    (merged, errors)
}
