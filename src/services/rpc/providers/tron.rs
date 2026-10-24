use async_trait::async_trait;
use futures::StreamExt;
use reqwest::{Client, Method, StatusCode};
use serde_json::Value;

use crate::common::errors::EngineError;
use crate::services::rpc::providers::{RpcProvider, RpcRequest, RpcResponse};

/// TRON HTTP transport. Supports native wallet POST endpoints plus GET/POST
/// REST calls (including TronGrid indexed APIs) through the same registered provider.
/// Multiple TronGrid keys are rotated on rate limits and distributed across batches.
pub struct TronProvider;

impl TronProvider {
    pub fn new() -> Self { Self }
}

fn tron_api_keys() -> Vec<String> {
    let mut keys = Vec::new();
    for name in ["TRON_PRO_API_KEYS", "TRONGRID_API_KEYS"] {
        if let Ok(value) = std::env::var(name) {
            keys.extend(value.split(',').map(str::trim).filter(|v| !v.is_empty()).map(str::to_owned));
        }
    }
    for index in 1..=5 {
        for name in [format!("TRON_PRO_API_KEY_{index}"), format!("TRONGRID_API_KEY_{index}")] {
            if let Ok(value) = std::env::var(name) {
                let value = value.trim();
                if !value.is_empty() { keys.push(value.to_owned()); }
            }
        }
    }
    if keys.is_empty() {
        for name in ["TRON_PRO_API_KEY", "TRONGRID_API_KEY"] {
            if let Ok(value) = std::env::var(name) {
                let value = value.trim();
                if !value.is_empty() { keys.push(value.to_owned()); break; }
            }
        }
    }
    let mut unique = Vec::with_capacity(keys.len());
    for key in keys {
        if !unique.contains(&key) { unique.push(key); }
        if unique.len() == 5 { break; }
    }
    unique
}

fn should_retry_with_next_key(status: StatusCode, text: &str, body: Option<&Value>) -> bool {
    // 403 may mean a key was rejected/throttled; 429 is explicit rate limiting.
    // Transient upstream 5xx errors can also clear by switching endpoints credentials.
    if status == StatusCode::TOO_MANY_REQUESTS || status == StatusCode::FORBIDDEN || status.is_server_error() { return true; }
    let lower = text.to_ascii_lowercase();
    let markers = ["too many request", "rate limit", "rate-limit", "rate_limit", "频率限制"];
    if markers.iter().any(|marker| lower.contains(marker)) { return true; }
    body.and_then(|v| v.get("Error").or_else(|| v.get("error")))
        .and_then(Value::as_str)
        .map(|message| {
            let lower = message.to_ascii_lowercase();
            markers.iter().any(|marker| lower.contains(marker))
        })
        .unwrap_or(false)
}

async fn execute_one(
    client: &Client,
    request: RpcRequest,
    keys: &[String],
    first_key_index: usize,
) -> Result<RpcResponse, EngineError> {
    let path = request.method.trim();
    let is_get = path == "__http_get";
    let is_post = path == "__http_post";
    let url = if is_get || is_post {
        request.endpoint.clone()
    } else if path.starts_with("http://") || path.starts_with("https://") {
        path.to_owned()
    } else {
        format!("{}/{}", request.endpoint.trim_end_matches('/'), path.trim_start_matches('/'))
    };

    let attempts = keys.len().max(1);
    let mut last_rate_limit = String::new();
    for attempt in 0..attempts {
        let key = if keys.is_empty() { None } else { Some(&keys[(first_key_index + attempt) % keys.len()]) };
        let mut builder = if is_get {
            client.request(Method::GET, &url)
        } else {
            let body = if let Some(body) = request.params.get("__http_body") {
                body.clone()
            } else if let Some(object) = request.params.as_object() {
                let mut body = object.clone();
                body.remove("__headers");
                Value::Object(body)
            } else {
                request.params.clone()
            };
            client.request(Method::POST, &url).json(&body)
        };

        if let Some(headers) = request.params.get("__headers").and_then(Value::as_object) {
            for (name, value) in headers {
                if key.is_some() && name.eq_ignore_ascii_case("TRON-PRO-API-KEY") { continue; }
                if let Some(value) = value.as_str() { builder = builder.header(name, value); }
            }
        }
        if let Some(key) = key { builder = builder.header("TRON-PRO-API-KEY", key); }

        let response = match builder.send().await {
            Ok(response) => response,
            Err(error) => {
                let message = format!("TRON RPC request failed: {}", error);
                if attempt + 1 < attempts {
                    eprintln!("[tron_rpc] status=retryable_transport_error key_attempt={}/{} error={}", attempt + 1, attempts, error);
                    last_rate_limit = message;
                    continue;
                }
                return Err(EngineError::Validation(format!(
                    "{} configured API key(s) exhausted; last error: {}",
                    keys.len(), message
                )));
            }
        };
        let status = response.status();
        let body_text = match response.text().await {
            Ok(text) => text,
            Err(error) => {
                let message = format!("TRON response read failed (HTTP {}): {}", status, error);
                if attempt + 1 < attempts {
                    eprintln!("[tron_rpc] status=retryable_response_read_error key_attempt={}/{} error={}", attempt + 1, attempts, error);
                    last_rate_limit = message;
                    continue;
                }
                return Err(EngineError::Validation(format!(
                    "{} configured API key(s) exhausted; last error: {}",
                    keys.len(), message
                )));
            }
        };
        let parsed = serde_json::from_str::<Value>(&body_text).ok();

        if should_retry_with_next_key(status, &body_text, parsed.as_ref()) {
            last_rate_limit = format!("HTTP {}: {}", status, body_text.chars().take(240).collect::<String>());
            if attempt + 1 < attempts { continue; }
            return Err(EngineError::Validation(format!(
                "TRON RPC rate limited after trying {} configured API key(s): {}",
                keys.len(), last_rate_limit
            )));
        }

        let body = match parsed {
            Some(body) => body,
            None if !status.is_success() => {
                let excerpt: String = body_text.chars().take(240).collect();
                return Err(EngineError::Validation(format!("TRON RPC HTTP {} (non-JSON response): {}", status, excerpt)));
            }
            None => {
                let excerpt: String = body_text.chars().take(240).collect();
                return Err(EngineError::Validation(format!("TRON returned invalid JSON (HTTP {}): {}", status, excerpt)));
            }
        };
        if !status.is_success() {
            let message = body.get("Error").or_else(|| body.get("error"))
                .and_then(Value::as_str).unwrap_or("TRON provider returned an HTTP error");
            return Err(EngineError::Validation(format!("TRON RPC HTTP {}: {}", status, message)));
        }
        if let Some(error) = body.get("Error").and_then(Value::as_str) {
            return Err(EngineError::Validation(format!("TRON RPC error: {}", error)));
        }
        return Ok(RpcResponse { provider: "tron".into(), chain_id: request.chain_id, result: body });
    }
    Err(EngineError::Validation("TRON RPC request failed without a response".into()))
}

#[async_trait]
impl RpcProvider for TronProvider {
    fn provider_name(&self) -> &'static str { "tron" }

    async fn execute_batch(&self, requests: Vec<RpcRequest>) -> Vec<Result<RpcResponse, EngineError>> {
        if requests.is_empty() { return Vec::new(); }
        let client = match Client::builder().timeout(std::time::Duration::from_secs(35)).build() {
            Ok(client) => client,
            Err(error) => return requests.into_iter().map(|_| Err(EngineError::Validation(
                format!("failed to initialize TRON HTTP client: {}", error)
            ))).collect(),
        };
        let keys = tron_api_keys();
        let concurrency = requests.len().min(20).max(1);
        futures::stream::iter(requests.into_iter().enumerate().map(|(index, request)| {
            let client = client.clone();
            let keys = keys.clone();
            async move {
                let start = if keys.is_empty() { 0 } else { index % keys.len() };
                execute_one(&client, request, &keys, start).await
            }
        }))
        .buffered(concurrency)
        .collect::<Vec<_>>()
        .await
    }
}
