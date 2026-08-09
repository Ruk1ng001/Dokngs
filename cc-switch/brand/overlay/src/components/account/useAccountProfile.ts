// [ccs] 账户 profile 查询 hook（React Query）。
//
// 用 cc-switch 现成的 @tanstack/react-query（SWR 缓存 + retry），替代 open-code 那边手写的
// requestVersions 防竞态 + localStorage 缓存。逐个 newapi 渠道（UniversalProvider）拉 profile：
// 后端 get_account_profile 用 Rust http_client 直发绕 CORS（见 services/account.rs）。
//
// 错误语义对齐后端：瞬时失败后端返回 Err → 这里 reject → react-query retry + 保留上次成功值；
// 确定性失败后端返回 Ok(ok:false) → 落到 data.ok=false，由 UI 展示 error 文案（不 retry）。

import { useQuery } from "@tanstack/react-query";
import { accountApi, type AccountProfileResult } from "@/lib/api/account";

// [ccs] 账户 profile 的 queryKey 工厂。按 (baseUrl, 稳定渠道 id) 区分不同 key 的查询缓存——
// 不把明文 apiKey 放进 queryKey（避免明文进 react-query devtools / 缓存快照）。
export const accountKeys = {
  all: ["account"] as const,
  profile: (baseUrl: string, keyId: string) =>
    ["account", "profile", baseUrl, keyId] as const,
  models: (baseUrl: string, keyId: string) =>
    ["account", "models", baseUrl, keyId] as const,
};

interface UseAccountProfileArgs {
  // 用于缓存区分的稳定 id（用渠道 id，不用明文 key）。
  keyId: string;
  baseUrl: string;
  apiKey: string;
  enabled?: boolean;
}

// [ccs] 拉取单个 key/渠道的账户 profile。凭据传给后端逐 key 查询（不同 key 可能属不同账户）。
export function useAccountProfile({
  keyId,
  baseUrl,
  apiKey,
  enabled = true,
}: UseAccountProfileArgs) {
  return useQuery<AccountProfileResult>({
    queryKey: accountKeys.profile(baseUrl, keyId),
    queryFn: async () => accountApi.getProfile(baseUrl, apiKey),
    enabled: enabled && Boolean(baseUrl) && Boolean(apiKey),
    // 对齐 useProviderUsage：瞬时失败 reject 时 retry 一次并保留旧 data。
    retry: 1,
    retryDelay: 1500,
    staleTime: 5 * 60 * 1000, // 5 分钟：余额/用量不需实时，减少请求。
    refetchOnWindowFocus: false,
  });
}
