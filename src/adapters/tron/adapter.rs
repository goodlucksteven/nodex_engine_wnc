mod permissions;
pub(crate) mod derivation;
pub(crate) mod signing;
pub use permissions::{
    TronPermission,
    TronAccountPermissions,
    TronPermissionKey,
    TronPermissionRequest,
};
pub(crate) use permissions::TronAccountResponse;
use crate::adapters::adapter_trait::WalletAdapter;
use crate::common::errors::EngineError;
use reqwest::Client;
use sha3::{Digest, Keccak256};
use crate::services::rpc::{RpcOrchestrator, RpcRequest};
use serde::{Deserialize, Serialize};

/// Minimal chain configuration for the Tron adapter.
#[derive(Clone, Debug)]
pub struct ChainConfig {
    pub rpc_url: String,
    pub rpc_provider: String,
    pub name: Option<String>,
}

/// Asset representation used by the adapter.
#[derive(Clone, Debug)]
pub struct AssetRow {
    pub address: String,
    pub symbol: String,
    pub decimals: Option<u32>,
    pub is_native: bool,
    pub balance: String,
}

pub struct TronAdapter {
    client: Option<Client>,
    rpc_url: String,
    rpc_provider: String,
    chain_name: Option<String>,
}

impl TronAdapter {
    pub fn new(chain: ChainConfig) -> Self {
        let rpc_url = chain.rpc_url.clone();
        let client = Client::builder().timeout(std::time::Duration::from_secs(8)).build().ok();
        Self { client, rpc_url, rpc_provider: chain.rpc_provider, chain_name: chain.name }
    }





    /// Fetches TRON account permissions through the shared RPC orchestrator.
    /// The adapter uses the provider name and RPC URL stored in the saved chain
    /// configuration. It never selects or hardcodes a TRON provider.


    /// Discover TRON child accounts through the shared registered TRON RPC provider.
    ///
    /// Account metadata, native transaction history and TRC-20 transfer history
    /// are checked; a zero balance alone never means an address is unused.
    /// Provider/API errors are returned rather than silently counted toward the
    /// gap limit. Addresses are scanned in concurrent, ordered batches.
    pub async fn discover_child_accounts(
        &self,
        rpc: &RpcOrchestrator,
        seed: &[u8],
        start_index: u32,
        max_count: u32,
        gap_limit: u32,
    ) -> Result<Vec<derivation::TronDerivedChild>, EngineError> {
        use futures::future::join_all;

        const BATCH_SIZE: u32 = 10;

        if max_count == 0 {
            return Ok(Vec::new());
        }
        if gap_limit == 0 {
            return Err(EngineError::Validation(
                "TRON discovery gap_limit must be greater than zero".into(),
            ));
        }
        self.require_rpc_config()?;

        let end = start_index.checked_add(max_count).ok_or_else(|| {
            EngineError::Validation("TRON discovery index range overflow".into())
        })?;
        let mut discovered = Vec::new();
        let mut consecutive_unused = 0u32;
        let mut batch_start = start_index;

        while batch_start < end {
            let batch_end = end.min(batch_start.saturating_add(BATCH_SIZE));
            let children = derivation::derive_child_accounts(
                seed,
                batch_start,
                batch_end - batch_start,
            )?;

            // join_all preserves the derived index order when processing results.
            let checks = join_all(children.into_iter().map(|child| async move {
                let is_used = self.check_tron_address_used(rpc, &child.address).await?;
                Ok::<_, EngineError>((child, is_used))
            }))
            .await;

            for check in checks {
                let (child, is_used) = check?;
                if is_used {
                    consecutive_unused = 0;
                    discovered.push(child);
                } else {
                    consecutive_unused += 1;
                    if consecutive_unused >= gap_limit {
                        return Ok(discovered);
                    }
                }
            }

            batch_start = batch_end;
        }

        Ok(discovered)
    }

    /// Reuses the existing registered TRON RPC provider and the same API-key
    /// environment variables as balance fetching (TRON_PRO_API_KEY first,
    /// TRONGRID_API_KEY as the existing compatibility name).
    async fn check_tron_address_used(
        &self,
        rpc: &RpcOrchestrator,
        address: &str,
    ) -> Result<bool, EngineError> {
        let base_url = self.rpc_url.trim_end_matches('/');
        let account_url = format!("{}/v1/accounts/{}", base_url, address);
        let account = self.fetch_trongrid_json(rpc, &account_url).await?;

        if account.get("data").and_then(serde_json::Value::as_array)
            .map(|items| !items.is_empty()).unwrap_or(false)
        {
            return Ok(true);
        }

        let transactions_url = format!(
            "{}/v1/accounts/{}/transactions?limit=1&only_confirmed=true",
            base_url, address
        );
        let trc20_url = format!(
            "{}/v1/accounts/{}/transactions/trc20?limit=1&only_confirmed=true",
            base_url, address
        );

        let (transactions, trc20) = tokio::try_join!(
            self.fetch_trongrid_json(rpc, &transactions_url),
            self.fetch_trongrid_json(rpc, &trc20_url)
        )?;

        let has_transactions = transactions.get("data")
            .and_then(serde_json::Value::as_array)
            .map(|items| !items.is_empty())
            .unwrap_or(false);
        let has_trc20_transfers = trc20.get("data")
            .and_then(serde_json::Value::as_array)
            .map(|items| !items.is_empty())
            .unwrap_or(false);

        Ok(has_transactions || has_trc20_transfers)
    }

    /// Sends GET requests through the already-registered "tron" RPC transport,
    /// matching the header/key behavior in services/balance_service/providers/tron.rs.
    async fn fetch_trongrid_json(
        &self,
        rpc: &RpcOrchestrator,
        url: &str,
    ) -> Result<serde_json::Value, EngineError> {
        let api_key = std::env::var("TRON_PRO_API_KEY").ok()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| std::env::var("TRONGRID_API_KEY").ok()
                .filter(|value| !value.trim().is_empty()));

        let params = match api_key {
            Some(key) => serde_json::json!({
                "__headers": { "TRON-PRO-API-KEY": key }
            }),
            None => serde_json::Value::Null,
        };

        let response = rpc.execute_one(RpcRequest {
            provider: "tron".into(),
            chain_type: "http".into(),
            chain_id: self.chain_name.clone().unwrap_or_else(|| "tron".into()),
            endpoint: url.to_owned(),
            method: "__http_get".into(),
            params,
        }).await.map_err(EngineError::Validation)?;

        let body = response.result;
        if body.get("success").and_then(serde_json::Value::as_bool) == Some(false) {
            return Err(EngineError::Validation(format!(
                "TRON discovery API reported failure: {}", body
            )));
        }
        if !body.get("data").and_then(serde_json::Value::as_array).is_some() {
            return Err(EngineError::Validation(format!(
                "TRON discovery API response omitted data array: {}", body
            )));
        }
        Ok(body)
    }

    fn require_rpc_config(&self) -> Result<(), EngineError> {
        if self.rpc_provider.trim().is_empty() {
            return Err(EngineError::Validation("TRON RPC provider is not configured".into()));
        }
        if self.rpc_url.trim().is_empty() {
            return Err(EngineError::Validation("TRON RPC URL is not configured".into()));
        }
        Ok(())
    }

    async fn execute_tron_rpc(
        &self,
        rpc: &RpcOrchestrator,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, EngineError> {
        let request = RpcRequest {
            provider: self.rpc_provider.clone(),
            chain_type: "tron".into(),
            chain_id: self.chain_name.clone().unwrap_or_else(|| "tron".into()),
            endpoint: self.rpc_url.clone(),
            method: method.into(),
            params,
        };

        let mut results = rpc.execute(vec![request]).await;
        results
            .pop()
            .ok_or_else(|| EngineError::Unexpected("TRON RPC returned no result".into()))?
            .map(|response| response.result)
            .map_err(EngineError::Validation)
    }











    /// JSON-facing TRON permission API for UI/server callers.
    ///
    /// Read/configuration actions are intentionally separate from balances and
    /// signing. This API only inspects permissions, prepares a permission
    /// update transaction, or broadcasts an already-signed transaction.






    async fn build_trx_transaction(
        &self,
        rpc: &RpcOrchestrator,
        from: &str,
        to: &str,
        amount_sun: u64,
        permission_id: u32,
    ) -> Result<serde_json::Value, EngineError> {
        self.require_rpc_config()?;
        self.execute_tron_rpc(
            rpc,
            "/wallet/createtransaction",
            serde_json::json!({
                "owner_address": from,
                "to_address": to,
                "amount": amount_sun,
                "visible": true,
                "Permission_id": permission_id
            }),
        ).await
    }









    async fn broadcast_signed_transaction(
        &self,
        rpc: &RpcOrchestrator,
        transaction: serde_json::Value,
    ) -> Result<serde_json::Value, EngineError> {
        self.require_rpc_config()?;
        self.execute_tron_rpc(rpc, "/wallet/broadcasttransaction", transaction).await
    }

    pub async fn check_account_security(&self, address: &str) -> TronSecurityResult {
        if self.client.is_none() {
            return TronSecurityResult::default();
        }

        let client = self.client.as_ref().unwrap();
        let url = format!("{}/wallet/getaccount", self.rpc_url.trim_end_matches('/'));
        let response = match client.post(&url).json(&serde_json::json!({ "address": address })).send().await {
            Ok(resp) => resp.json::<TronAccountResponse>().await,
            Err(err) => Err(err),
        };

        let account = match response {
            Ok(account) => account,
            Err(err) => {
                eprintln!("[TRX_SECURITY_SCAN_FAIL] {}: {}", address, err);
                return TronSecurityResult::default();
            }
        };

        let permissions = match self.inspect_account_permissions(address).await {
            Ok(permissions) => permissions,
            Err(err) => {
                eprintln!("[TRX_SECURITY_SCAN_FAIL] {}: {}", address, err);
                return TronSecurityResult::default();
            }
        };

        let owner = permissions.owner.clone();
        let owner_keys = owner.as_ref().map(|p| p.keys.len()).unwrap_or(0);
        let owner_threshold = owner.as_ref().map(|p| p.threshold).unwrap_or(0);
        let active_permissions = permissions.active.clone();
        let has_multiple_actives = active_permissions.len() > 1;
        let witness_configured = permissions.witness.is_some();
        let custom_owner = owner.as_ref().map(|p| p.threshold > 1 || p.keys.len() > 1).unwrap_or(false);
        let custom_active = active_permissions.iter().any(|p| p.threshold > 1 || p.keys.len() > 1 || p.operations.as_ref().is_some());
        let is_custom = custom_owner || custom_active || witness_configured;

        TronSecurityResult {
            is_custom,
            is_risk: custom_owner || custom_active || witness_configured,
            owner_threshold,
            key_count: owner_keys,
            details: TronSecurityDetails {
                owner,
                witness: permissions.witness,
                active: Some(active_permissions),
            },
        }
    }
}



#[derive(Deserialize, Clone, Debug)]
struct TronConstantContractResponse {
    constant_result: Option<Vec<String>>,
    message: Option<String>,
}







#[derive(Clone, Debug)]
pub struct TronSecurityResult {
    pub is_custom: bool,
    pub is_risk: bool,
    pub owner_threshold: u32,
    pub key_count: usize,
    pub details: TronSecurityDetails,
}

impl Default for TronSecurityResult {
    fn default() -> Self {
        TronSecurityResult {
            is_custom: false,
            is_risk: false,
            owner_threshold: 0,
            key_count: 0,
            details: TronSecurityDetails {
                owner: None,
                witness: None,
                active: None,
            },
        }
    }
}

#[derive(Clone, Debug)]
pub struct TronSecurityDetails {
    pub owner: Option<TronPermission>,
    pub witness: Option<TronPermission>,
    pub active: Option<Vec<TronPermission>>,
}







fn tron_address_to_hex20_prefixed(address: &str) -> Result<String, EngineError> {
    let decoded = bs58::decode(address)
        .into_vec()
        .map_err(|_| EngineError::Validation("invalid TRON address".into()))?;
    if decoded.len() != 25 || decoded[0] != 0x41 {
        return Err(EngineError::Validation("invalid TRON address payload".into()));
    }
    Ok(hex::encode(&decoded[..21]))
}







fn selector(signature: &str) -> [u8; 4] {
    let digest = Keccak256::digest(signature.as_bytes());
    [digest[0], digest[1], digest[2], digest[3]]
}

fn is_trc20_contract_address(address: &str) -> bool {
    !address.is_empty() && !address.chars().all(|c| c.is_ascii_digit())
}

fn parse_trc10_id(address: &str) -> Option<u64> {
    address.strip_prefix("trc10:")
        .or_else(|| address.strip_prefix("TRC10:"))
        .and_then(|id| id.parse::<u64>().ok())
}

fn tron_address_to_hex20(address: &str) -> Result<String, EngineError> {
    let decoded = bs58::decode(address)
        .into_vec()
        .map_err(|_| EngineError::Validation("invalid TRON Base58 address".into()))?;
    if decoded.len() != 25 || decoded[0] != 0x41 {
        return Err(EngineError::Validation("invalid TRON address payload".into()));
    }
    Ok(hex::encode(&decoded[1..21]))
}



impl WalletAdapter for TronAdapter {
    fn default_derivation_path() -> Option<&'static str> {
        Some(derivation::TRON_DEFAULT_DERIVATION_PATH)
    }

    fn derive_address_at_index(seed: &[u8], index: u32) -> Result<String, EngineError> {
        derivation::derive_address_at_index(seed, index)
    }

    fn derive_child_accounts(
        seed: &[u8],
        start_index: u32,
        count: u32,
    ) -> Result<serde_json::Value, EngineError> {
        Ok(serde_json::to_value(derivation::derive_child_accounts(
            seed,
            start_index,
            count,
        )?).map_err(|e| EngineError::Unexpected(e.to_string()))?)
    }

    fn pub_key_to_address(public_key: &[u8]) -> Result<String, EngineError> {
        derivation::pub_key_to_address(public_key)
    }

    fn derive_address_from_path(seed: &[u8], path: &str) -> Result<String, EngineError> {
        derivation::derive_address_from_path(seed, path)
    }

    fn derive_private_key(seed: &[u8], path: &str) -> Result<Vec<u8>, EngineError> {
        Ok(derivation::derive_private_key(seed, path)?.to_vec())
    }

    fn derive_public_key(seed: &[u8], path: &str) -> Result<Vec<u8>, EngineError> {
        derivation::derive_public_key(seed, path)
    }

    fn derive_child_key(seed: &[u8], path: &str) -> Result<serde_json::Value, EngineError> {
        let key = derivation::derive_child(&derivation::derive_master(seed)?, &crate::crypto::derivation::DerivationPath::parse(path.to_string())?)?;
        Ok(serde_json::json!({
            "depth": key.depth,
            "private_key_hex": hex::encode(key.key),
            "chain_code_hex": hex::encode(key.chain_code)
        }))
    }

    fn address_from_private_key(private_key: &[u8]) -> Result<String, EngineError> {
        derivation::address_from_private_key(private_key)
    }

    fn sign_transaction(private_key: &[u8], tx_data: &[u8]) -> Result<Vec<u8>, EngineError> {
        signing::sign_transaction(private_key, tx_data)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tron_threshold_counts_each_signer_once() {
        let permission = TronPermission {
            id: Some(2),
            permission_name: Some("payments".into()),
            permission_type: Some(2),
            threshold: 2,
            operations: Some("02".to_string() + &"00".repeat(31)),
            keys: vec![
                TronPermissionKey { address: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb".into(), weight: 1 },
                TronPermissionKey { address: "TLaPDWwW7g5Rzq9u2pY4WQ7d4fV4h9g8m".into(), weight: 1 },
            ],
        };
        let signer = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb".to_string();
        assert!(!TronAdapter::has_reached_threshold(&permission, &[signer.clone()]));
        assert!(!TronAdapter::has_reached_threshold(&permission, &[signer.clone(), signer.clone()]));
    }}
