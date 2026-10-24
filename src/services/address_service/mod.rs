use crate::adapters::orchestrator::{AdapterOrchestrator, AdapterTargetRequest, AdapterTargetResponse};
use crate::common::errors::EngineError;
use crate::types::chain::ChainRequest;

pub struct AddressService;

impl AddressService {
    pub fn public_key_to_address(chain_type: &str, public_key: &[u8]) -> Result<String, EngineError> {
        crate::adapters::registry::AdapterRegistry::public_key_to_address(chain_type, public_key)
    }

    pub fn derive_address_from_path(
        chain_type: &str,
        seed: &[u8],
        path: &str,
    ) -> Result<String, EngineError> {
        let chain = ChainRequest {
            name: chain_type.to_string(),
            chain_id: String::new(),
            symbol: None,
            network: None,
            chain_type: chain_type.to_string(),
            derivation_path: Some(path.to_string()),
            rpc_provider: None,
            rpc_url: None,
            address_type: None,
            p2pkh_version: None,
            p2sh_version: None,
            bech32_hrp: None,
        };
        let addresses = match AdapterOrchestrator::with_default_rpc()?.adapter_target(AdapterTargetRequest::Derive {
            seed,
            chains: std::slice::from_ref(&chain),
        })? {
            AdapterTargetResponse::Addresses(v) => v,
            _ => unreachable!(),
        };
        Self::address_from_adapter_result(&addresses, &chain)
    }

    pub fn derive_address(seed: &[u8], chain: &ChainRequest) -> Result<String, EngineError> {
        let addresses = match AdapterOrchestrator::with_default_rpc()?.adapter_target(AdapterTargetRequest::Derive {
            seed,
            chains: std::slice::from_ref(chain),
        })? {
            AdapterTargetResponse::Addresses(v) => v,
            _ => unreachable!(),
        };
        Self::address_from_adapter_result(&addresses, chain)
    }

    /// AdapterRegistry::derive_addresses keys results by the exact configured
    /// chain name. Accept that canonical key first, while retaining compatibility
    /// with normalized/type/symbol keys emitted by older adapter implementations.
    fn address_from_adapter_result(
        addresses: &std::collections::HashMap<String, String>,
        chain: &ChainRequest,
    ) -> Result<String, EngineError> {
        let normalized_name = chain.name.trim().to_ascii_lowercase().replace([' ', '-', '/'], "_");
        addresses
            .get(&chain.name)
            .or_else(|| addresses.get(chain.name.trim()))
            .or_else(|| addresses.get(&normalized_name))
            .or_else(|| addresses.get(&chain.chain_type))
            .or_else(|| chain.symbol.as_deref().and_then(|symbol| addresses.get(symbol)))
            .cloned()
            .ok_or_else(|| EngineError::Unexpected(format!(
                "adapter_target returned no address for {}",
                chain.name
            )))
    }
}
