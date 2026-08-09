//! [ccs] new-api 账户体系命令层
//!
//! 暴露给前端的账户只读接口，全部委托 `services::account`（用 Rust 侧 http_client 直发，
//! 绕开 Tauri WebView 的 CORS）。命令签名范式对齐 commands/balance.rs 的 get_balance。

use crate::services::account::{self, AccountProfileResult};

/// [ccs] 拉取账户 profile（余额/用量/当前 key 元数据）。凭据由前端传入（逐 key 查询）。
/// 瞬时传输失败 `Err`（前端 reject → react-query retry + 保留上次成功值）；
/// 确定性失败走 `Ok(AccountProfileResult{ok:false,error})`。
#[tauri::command]
pub async fn get_account_profile(
    base_url: String,
    api_key: String,
) -> Result<AccountProfileResult, String> {
    account::fetch_profile(&base_url, &api_key).await
}

/// [ccs] 拉取某 key 的可用模型 id 列表（OpenAI 兼容 /v1/models）。脏响应/非 2xx 返回空 Vec；
/// 仅读体中断视为瞬时 `Err`。
#[tauri::command]
pub async fn get_account_models(
    base_url: String,
    api_key: String,
) -> Result<Vec<String>, String> {
    account::fetch_models(&base_url, &api_key).await
}
