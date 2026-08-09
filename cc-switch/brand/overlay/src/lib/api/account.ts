// [ccs] new-api 账户体系前端接口封装。
//
// 只调后端 Tauri command（get_account_profile / get_account_models），不在前端直接
// fetch new-api —— cc-switch 前端是 Tauri WebView，fetch 受 CORS 约束，故请求全走
// Rust 侧 http_client 直发（见 src-tauri/src/services/account.rs）。接口方式与 open-code
// 那套 cx-account-api.ts 完全一致，字段与 Rust AccountProfile（camelCase）1:1。

import { invoke } from "@tauri-apps/api/core";

// [ccs] 账户 profile 就绪态。额度类均为 new-api 原始 quota 整数，换算（QUOTA_PER_UNIT）
// 在渲染层 format.ts 做（对齐 open-code：数据层不换算）。字段与后端 AccountProfile 对齐。
export interface AccountProfile {
  username: string;
  displayName: string;
  avatar: string;
  // 账户额度来自 user.Quota（剩余）与 user.UsedQuota（累计），不受当前 key 是否不限额影响。
  accountRemainingQuota: number;
  accountUsedQuota: number;
  accountTotalQuota: number;
  accountQuotaUsedToday: number | null;
  // 实际模型 token 数 = logs.prompt_tokens + logs.completion_tokens；与 API Key 记录严格区分。
  accountTokensUsedToday: number | null;
  accountPromptTokensToday: number | null;
  accountCompletionTokensToday: number | null;
  keyRemainingQuota: number;
  keyUsedQuota: number;
  keyQuotaUsedToday: number | null;
  keyTokensUsedToday: number | null;
  keyPromptTokensToday: number | null;
  keyCompletionTokensToday: number | null;
  keyUnlimitedQuota: boolean;
  // 当前 key 生效的定价分组，及该分组是否走二开的动态倍率（auto 分组恒 false）。
  keyGroup: string;
  keyDynamicRatio: boolean;
  // 当前 key 状态（1 启用 / 2 禁用 / 3 过期 / 4 耗尽）与过期时间（秒；0 表示永不过期）。
  keyStatus: number;
  keyExpiresAt: number;
  // 当前 key 的模型白名单：未启用时 keyModelLimits 为空数组、表示不限模型。
  keyModelLimitsEnabled: boolean;
  keyModelLimits: string[];
  requestCountToday: number | null;
  // 该 key 在 new-api 侧的 token.Name。本地没填名称时 UI 直接用此字段展示。
  tokenName: string;
}

// [ccs] profile 查询结果（对齐后端 AccountProfileResult）。确定性失败走 ok:false + error；
// 就绪走 ok:true + profile。瞬时失败不在此体现（invoke 直接 reject → react-query retry）。
export interface AccountProfileResult {
  ok: boolean;
  profile?: AccountProfile;
  error?: string;
}

export const accountApi = {
  // [ccs] 拉取账户 profile（余额/用量/当前 key 元数据）。凭据逐次传入（不同 key 可能属不同账户）。
  // 瞬时传输失败会 reject（react-query retry + 保留上次成功值）；确定性失败走 ok:false。
  getProfile: (baseUrl: string, apiKey: string): Promise<AccountProfileResult> =>
    invoke("get_account_profile", { baseUrl, apiKey }),

  // [ccs] 拉取某 key 的可用模型 id 列表（OpenAI 兼容 /v1/models）。脏响应/非 2xx 返回空数组。
  getModels: (baseUrl: string, apiKey: string): Promise<string[]> =>
    invoke("get_account_models", { baseUrl, apiKey }),

  // [ccs] 取走 Rust 侧暂存的深链接导入请求（挂载时调一次）。
  //
  // 为什么需要它：Tauri 的 emit 不重放，没有监听器时载荷直接丢。而深链接最典型的场景恰恰是
  // 「应用没开着 → 点按钮 → 应用被拉起」，此时 Rust 侧 emit 时前端 JS 还没跑到 listen。
  // 故 Rust 侧 emit 的同时把请求存进 pending slot，前端挂载后主动取一次，两条轨哪条先到都不丢
  // （Rust 侧按 apiKey 做了窗口去重，不会重复导入）。返回 null 表示没有待处理请求。
  takePendingImport: (): Promise<AccountImportPayload | null> =>
    invoke("take_pending_account_import"),
};

// [ccs] Rust 侧 AccountImportRequest 的镜像（serde 已转 camelCase）。
// 刻意只有这两个字段：baseUrl 不接受外部注入，见 deeplink_account.rs 头注释。
export interface AccountImportPayload {
  apiKey: string;
  name?: string;
}
