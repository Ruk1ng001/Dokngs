// [ccs] 账户面板展示用纯函数。从 open-code 的 cx-account-api.ts 移植，
// 与 UI / 网络解耦，可单测。额度→美元换算的 QUOTA_PER_UNIT 也在此（对齐 open-code：换算在渲染层）。
// 文案走 i18next 全局实例（组件外无法用 useTranslation hook），随当前语言切换；
// defaultValue 保持中文兜底，locale 缺 key 时不空白。

import i18n from "@/i18n";

// new-api 默认 QuotaPerUnit：500000 额度 = 1 美元（common.QuotaPerUnit 默认值）。目标站点若改了
// 该值，展示金额会有偏差——额度原值同时可展示以便对照。
const QUOTA_PER_UNIT = 500000;

// 额度 → 美元金额（两位小数）。
export function formatCurrency(quotaUnits: number): string {
  return "$" + (quotaUnits / QUOTA_PER_UNIT).toFixed(2);
}

// 模型实际消耗 token 数的人类可读格式。注意：这里的 token 指 prompt_tokens +
// completion_tokens，不是 new-api 的 API Token / Key 记录。
export function formatTokenCount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const count = Math.max(0, value);
  const units = [
    { value: 1_000_000_000, suffix: "B" },
    { value: 1_000_000, suffix: "M" },
    { value: 1_000, suffix: "K" },
  ];
  const unit = units.find((item) => count >= item.value);
  if (!unit) return Math.round(count).toLocaleString(i18n.language);
  const scaled = count / unit.value;
  const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${Number(scaled.toFixed(digits))}${unit.suffix}`;
}

// 无头像时的占位首字（取用户名首字符，空则用「?」）。
export function avatarInitial(username: string): string {
  const trimmed = username.trim();
  return trimmed ? trimmed[0].toUpperCase() : "?";
}

// key 打码展示（`sk-…abcd`）。仅保留可辨识前缀与末 4 位，绝不整段渲染 key 明文。
export function maskKey(key: string): string {
  const k = key.trim();
  if (!k) return "";
  if (k.length <= 7) return "…" + k.slice(-Math.min(4, k.length));
  return `${k.slice(0, 3)}…${k.slice(-4)}`;
}

// 账户已用占比（0~100，整数）。总额度为 0 时返回 0，避免除零。
export function usedPercent(usedQuota: number, quota: number): number {
  if (quota <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((usedQuota / quota) * 100)));
}

// per-key 使用率（0~100，整数）——已用 /（已用 + 剩余）。分母为 0 时返回 0。
// unlimited 时该值无意义，调用点已用 unlimited 分支屏蔽。
export function keyUsedPercent(tokenUsed: number, tokenRemain: number): number {
  const granted = tokenUsed + tokenRemain;
  if (granted <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((tokenUsed / granted) * 100)));
}

// 使用率告警级别：供进度条/文案按剩余额度分级上色。
//   - >= 90% 已用 → "danger"（快用完，红）
//   - >= 75% 已用 → "warn"（提醒，琥珀）
//   - 其余 → "ok"（正常，主色）
// 与 formatExpiry 的 level 同构：只算级别，配色留给渲染层，避免在纯函数里写死颜色。
export function usageLevel(percent: number): "ok" | "warn" | "danger" {
  if (percent >= 90) return "danger";
  if (percent >= 75) return "warn";
  return "ok";
}

// key 过期展示：把秒级时间戳转成人类可读文案 + 告警级别，供卡片过期提示用。
//   - 0（永不过期）→ level "ok"，text account.expiryNever
//   - 已过期（expiresAt <= now）→ level "expired"，text account.expiryExpired
//   - 7 天内到期 → level "soon"，text account.expiryDays（不足 1 天 account.expiryToday）
//   - 更远 → level "ok"，text account.expiryDate（本地日期 YYYY-MM-DD）
// level 供渲染层决定是否用告警色；不依赖时区库，用本地时间。
export function formatExpiry(expiresAt: number): {
  text: string;
  level: "ok" | "soon" | "expired";
} {
  if (!Number.isFinite(expiresAt) || expiresAt <= 0)
    return {
      text: i18n.t("account.expiryNever", { defaultValue: "永不过期" }),
      level: "ok",
    };
  const nowSec = Math.floor(Date.now() / 1000);
  if (expiresAt <= nowSec)
    return {
      text: i18n.t("account.expiryExpired", { defaultValue: "已过期" }),
      level: "expired",
    };
  const daysLeft = Math.ceil((expiresAt - nowSec) / 86400);
  if (daysLeft <= 7) {
    return {
      text:
        daysLeft <= 1
          ? i18n.t("account.expiryToday", { defaultValue: "今日到期" })
          : i18n.t("account.expiryDays", {
              defaultValue: "{{count}} 天后过期",
              count: daysLeft,
            }),
      level: "soon",
    };
  }
  const d = new Date(expiresAt * 1000);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return {
    text: i18n.t("account.expiryDate", {
      defaultValue: "{{date}} 到期",
      date: `${yyyy}-${mm}-${dd}`,
    }),
    level: "ok",
  };
}

// key 状态文案：new-api TokenStatus（1 启用 / 2 禁用 / 3 过期 / 4 耗尽）。
// 仅在非启用态需要在卡片上打徽标；启用态返回空串（调用方据此不渲染徽标）。
export function keyStatusLabel(status: number): string {
  switch (status) {
    case 2:
      return i18n.t("account.statusDisabled", { defaultValue: "已禁用" });
    case 3:
      return i18n.t("account.statusExpired", { defaultValue: "已过期" });
    case 4:
      return i18n.t("account.statusExhausted", { defaultValue: "额度耗尽" });
    default:
      return "";
  }
}
