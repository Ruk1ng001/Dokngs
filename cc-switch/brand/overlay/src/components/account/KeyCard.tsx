// [ccs] 账户面板里的单个 key 卡片。
//
// cc-switch 里「一个 Dokng key」= 一条 providerType:"newapi" 的 UniversalProvider。
// 本卡片拿单条渠道的 {baseUrl, apiKey} 调 useAccountProfile 拉 profile，展示：
//   - key 打码 + 展示名（Dokng · 渠道名）；
//   - 账户余额 / 今日用量 / 当前 key 额度（unlimited 时显示「额度不限」）；
//   - 状态徽标（禁用/过期/耗尽）、过期告警、动态倍率；
//   - 「铺开到各 CLI」按钮 → 弹出应用多选框，勾选后铺开并激活选中的 app。
//
// 换算/打码/使用率全走 03 的 format.ts 纯函数（与 open-code 同源）。key 明文绝不整段渲染。

import { RefreshCw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ProviderIcon } from "@/components/ProviderIcon";
import type { UniversalProvider } from "@/types";
import { useAccountProfile } from "./useAccountProfile";
import { dokngDisplayName } from "./importKey";
import {
  formatCurrency,
  formatTokenCount,
  maskKey,
  keyUsedPercent,
  usageLevel,
  formatExpiry,
  keyStatusLabel,
} from "@/lib/account/format";

interface KeyCardProps {
  provider: UniversalProvider;
  // [ccs] 请求铺开：打开应用多选框（真正铺开在 AccountPanel 里，勾选后调 applyAccountToApps）。
  // 可选：未接线时按钮不渲染。
  onImport?: (provider: UniversalProvider) => void;
  // 该渠道正在铺开（禁用按钮 + 文案切换）。
  importing?: boolean;
  // [ccs] 删除该渠道（含二次确认，见 AccountPanel.handleDelete）。可选：未接线时按钮不渲染。
  onDelete?: (provider: UniversalProvider) => void;
  deleting?: boolean;
}

export function KeyCard({
  provider,
  onImport,
  importing,
  onDelete,
  deleting,
}: KeyCardProps) {
  const { t } = useTranslation();
  const { data, isFetching, isError, refetch } = useAccountProfile({
    keyId: provider.id,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
  });

  const profile = data?.ok ? data.profile : undefined;
  // 展示名：存量 `NewAPI` / 空 / 已带 Dokng 前缀时优先远端 token.Name；避免
  // `Dokng · NewAPI` 和 `Dokng · Dokng · xxx`。用户明确填写的本地名仍优先。
  const storedName = provider.name.trim();
  const shouldPreferRemote =
    !storedName ||
    storedName.toLowerCase() === "newapi" ||
    /^dokng\s*·/i.test(storedName);
  const rawName = shouldPreferRemote
    ? profile?.tokenName?.trim() || storedName
    : storedName;
  const displayName = dokngDisplayName(rawName);

  const errorText =
    (data && !data.ok ? data.error : undefined) ??
    (isError
      ? t("account.loadError", { defaultValue: "加载失败，稍后重试" })
      : undefined);

  const expiry = profile ? formatExpiry(profile.keyExpiresAt) : null;
  const statusLabel = profile ? keyStatusLabel(profile.keyStatus) : "";
  // key 额度使用率：文案、进度条宽度、读屏 label 三处共用，算一次避免重复求值。
  const quotaPercent = profile
    ? keyUsedPercent(profile.keyUsedQuota, profile.keyRemainingQuota)
    : 0;

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        {/* 头部：图标 + 名称 + 打码 key + 徽标 + 刷新 */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <ProviderIcon icon="dokng" name={displayName} size={28} />
            <div className="min-w-0 flex-1">
              {/* 名称独占一行；徽标另起可换行，避免长 key 名 + 分组/状态挤出卡片。 */}
              <div className="font-medium truncate" title={displayName}>
                {displayName}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                {statusLabel && (
                  <Badge variant="destructive">{statusLabel}</Badge>
                )}
                {/* [ccs] key 所属分组（profile.keyGroup，来自 Dokng 侧定价分组）。空则不显示。 */}
                {profile?.keyGroup && (
                  <Badge variant="outline">
                    {t("account.keyGroup", { defaultValue: "分组" })}:{" "}
                    {profile.keyGroup}
                  </Badge>
                )}
                {profile?.keyDynamicRatio && (
                  <Badge variant="secondary">
                    {t("account.dynamicRatio", { defaultValue: "动态倍率" })}
                  </Badge>
                )}
                {expiry && expiry.level !== "ok" && (
                  <Badge
                    variant={
                      expiry.level === "expired" ? "destructive" : "secondary"
                    }
                  >
                    {expiry.text}
                  </Badge>
                )}
              </div>
              <div className="mt-1 truncate text-xs text-muted-foreground font-mono">
                {maskKey(provider.apiKey)}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => refetch()}
              title={t("account.refresh", { defaultValue: "刷新" })}
              disabled={isFetching}
            >
              <RefreshCw
                className={`w-4 h-4 ${isFetching ? "animate-spin" : ""}`}
              />
            </Button>
            {/* [ccs] 删除该渠道（含二次确认，见 AccountPanel.handleDelete）。 */}
            {onDelete && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onDelete(provider)}
                title={t("common.delete", { defaultValue: "删除" })}
                disabled={deleting}
                className="text-destructive hover:text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            )}
          </div>
        </div>

        {/* 错误态 */}
        {errorText && (
          <div className="text-xs text-destructive">{errorText}</div>
        )}

        {/* 就绪态：key 级用量指标（账户级余额/今日用量在面板顶部概览展示，此处不重复）。 */}
        {profile && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric
              label={t("account.keyTokensToday", {
                defaultValue: "今日 Tokens",
              })}
              value={formatTokenCount(profile.keyTokensUsedToday)}
            />
            <Metric
              label={t("account.keyCostToday", { defaultValue: "今日费用" })}
              value={
                profile.keyQuotaUsedToday == null
                  ? "—"
                  : formatCurrency(profile.keyQuotaUsedToday)
              }
            />
            <Metric
              label={t("account.keyCostTotal", { defaultValue: "累计费用" })}
              value={formatCurrency(profile.keyUsedQuota)}
            />
            {/* [ccs] 输入/输出 tokens：后端早已返回 keyPromptTokensToday /
                keyCompletionTokensToday，此前只有 open-code 侧展示。原本此格是「Key 额度」，
                与下方额度条的「剩余 $Y」重复，故让位给这项独有信息。 */}
            <Metric
              label={t("account.keyTokenIO", { defaultValue: "输入 / 输出" })}
              value={`${formatTokenCount(profile.keyPromptTokensToday)} / ${formatTokenCount(profile.keyCompletionTokensToday)}`}
            />
          </div>
        )}

        {/* key 额度使用率（unlimited 不展示条，改打「额度不限」徽标；用 key 级已用/剩余换算）。
            对齐 open-code：条上方带「额度 X% · 剩余 $Y」文案，光看条无法判断剩多少的问题就没了。 */}
        {profile &&
          (profile.keyUnlimitedQuota ? (
            <Badge variant="secondary" className="w-fit">
              {t("account.quotaUnlimited", { defaultValue: "额度不限" })}
            </Badge>
          ) : (
            <div className="space-y-1.5">
              <div className="text-xs text-muted-foreground tabular-nums">
                {t("account.quotaUsageLine", {
                  defaultValue: "额度 {{pct}}% · 剩余 {{rest}}",
                  pct: quotaPercent,
                  rest: formatCurrency(profile.keyRemainingQuota),
                })}
              </div>
              <UsageBar
                percent={quotaPercent}
                label={t("account.quotaBarLabel", {
                  defaultValue: "Key 额度已用 {{pct}}%",
                  pct: quotaPercent,
                })}
              />
            </div>
          ))}

        {/* [ccs] 铺开按钮：点击打开应用多选框（AccountPanel 承载勾选与铺开）。 */}
        {onImport && (
          <div className="flex justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onImport(provider)}
              disabled={importing}
            >
              {importing
                ? t("account.importing", { defaultValue: "铺开中…" })
                : t("account.importToClis", {
                    defaultValue: "铺开到各 CLI",
                  })}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}

// 额度使用率条：按 usageLevel 分级上色（正常主色 / 临近告警 / 即将耗尽危险色），
// 不再硬编码 bg-blue-500——跟随主题变量，明暗与品牌主色一致。
// 带 role="progressbar" + aria-valuenow，读屏可读出具体百分比。
function UsageBar({ percent, label }: { percent: number; label?: string }) {
  const level = usageLevel(percent);
  const fillClass =
    level === "danger"
      ? "bg-destructive"
      : level === "warn"
        ? "bg-amber-500"
        : "bg-primary";
  return (
    <div
      className="h-1.5 w-full rounded-full bg-muted overflow-hidden"
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div
        className={`h-full rounded-full transition-all ${fillClass}`}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
