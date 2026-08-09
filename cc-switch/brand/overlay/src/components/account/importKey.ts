// [ccs] Dokng 账户「铺开到各 CLI」逻辑。
//
// cc-switch 里「一个 Dokng key」= 一条 providerType:"newapi" 的 UniversalProvider。
// 但 upstream 的 universal sync（sync_universal_provider）只覆盖 Claude/Codex/Gemini，
// 且只写 cc-switch 自己的数据库、不激活 live 配置——用户「用起来没感觉」正因如此。
//
// 本模块改为直接构造各 app 的 Provider 并调 upstream 现成命令，覆盖全部 7 个应用
// （Claude / Claude Desktop / Codex / Gemini / OpenCode / OpenClaw / Hermes），
// 完全不改 upstream 核心结构（UniversalProviderApps 保持三字段不动），最小侵入：
//   - bindAccount：绑定新账户 → 存 UniversalProvider（供账户面板列表）+ 铺到 7 个 app 的
//     「列表」（不激活，避免覆盖用户已选的当前供应商）；
//   - applyAccountToApps：KeyCard「铺开到各 CLI」按用户勾选 → 铺 + 激活选中的 app。
//
// 激活语义（对齐 upstream add/switch）：
//   - switch 类（claude/claude-desktop/codex/gemini）：add 只在该 app 无当前供应商时自动
//     激活；显式激活时再调 switch 设为当前（会替换当前选择——仅对用户勾选的 app 生效）。
//   - additive 类（opencode/openclaw/hermes）：add(addToLive) 直接决定是否写 live。

import { providersApi, universalProvidersApi } from "@/lib/api";
import { accountApi } from "@/lib/api/account";
import {
  createUniversalProviderFromPreset,
  findPresetByType,
} from "@/config/universalProviderPresets";
import { generateUUID } from "@/utils/uuid";
import type { Provider, UniversalProvider, VisibleApps } from "@/types";
import type { AppId } from "@/lib/api/types";

// [ccs] Dokng 品牌常量：官网 + 图标名（图标已注册进 icons/extracted，见补丁 04）。
export const DOKNG_WEBSITE_URL = "https://dokng.com/";
export const DOKNG_ICON = "dokng";

// [ccs] 可铺开的目标应用全集（顺序即铺开/展示顺序）。
export const DOKNG_TARGET_APPS: AppId[] = [
  "claude",
  "claude-desktop",
  "codex",
  "gemini",
  "opencode",
  "openclaw",
  "hermes",
];

// [ccs] 按 visibleApps 过滤出实际在用的目标应用，并排除平台不支持项。
//
// visibleApps 为 undefined 时按「全部可见」处理，而非返回空集合：后端 AppSettings 的
// visible_apps 是 Option 且 skip_serializing_if=Option::is_none——用户从未改过应用可见性
// 时该字段在 settings.json 里根本不存在，前端会一直拿到 undefined。此前返回空集合导致
// targetApps 恒为空、账户面板「新增 key」按钮永久置灰（无 key 的新用户直接卡死）。
// 语义与上游 App.tsx / AppVisibilitySettings.tsx 的 `visibleApps ?? {全部 true}` 一致：
// 字段缺失即默认全开，只有显式 false 才隐藏。
export function resolveTargetApps(
  visibleApps: VisibleApps | undefined,
  options?: { claudeDesktopSupported?: boolean },
): AppId[] {
  return DOKNG_TARGET_APPS.filter((app) => {
    if (visibleApps?.[app] === false) return false;
    if (app === "claude-desktop" && options?.claudeDesktopSupported === false) {
      return false;
    }
    return true;
  });
}

// [ccs] 各 app 默认模型：沿用 universalProviderPresets 的 NEWAPI 默认值，保持与既有假设一致。
const MODELS = {
  claude: "claude-sonnet-5",
  claudeHaiku: "claude-haiku-4-5-20251001",
  claudeSonnet: "claude-sonnet-5",
  claudeOpus: "claude-opus-4-8",
  codex: "gpt-5.5",
  codexEffort: "high",
  gemini: "gemini-3.5-flash",
};

// [ccs] 展示名统一加 Dokng 前缀：`Dokng · <渠道名>`（渠道名空则退回 `Dokng`）。
// 账户面板卡片与铺开到各 app 后的供应商名都走它。
export function dokngDisplayName(rawName: string | undefined | null): string {
  const n = (rawName ?? "").trim();
  if (!n || n.toLowerCase() === "newapi") return "Dokng";
  if (/^dokng\s*·\s*/i.test(n)) return n.replace(/^dokng\s*·\s*/i, "Dokng · ");
  return `Dokng · ${n}`;
}

// TOML 基本字符串与 JSON 字符串的转义规则对常见 URL/model/name 兼容；复用 JSON.stringify
// 生成可靠双引号字面量，避免动态值中的引号/反斜杠/换行破坏 config.toml。
function tomlString(value: string): string {
  return JSON.stringify(value);
}

function validateCredentials(baseUrl: string, apiKey: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`无效的上游地址: ${baseUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`上游地址只支持 http/https: ${baseUrl}`);
  }
  if (!parsed.hostname) throw new Error(`上游地址缺少主机名: ${baseUrl}`);
  if (!apiKey.trim()) throw new Error("API Key 不能为空");
}

// [ccs] additive 类应用：add 时 addToLive 直接决定写 live，无「当前供应商」概念。
function isAdditiveApp(app: AppId): boolean {
  return app === "opencode" || app === "openclaw" || app === "hermes";
}

// [ccs] Codex/OpenAI base_url：纯 origin 补 /v1，已带路径/已 /v1 则原样（对齐后端 to_codex_provider）。
function codexBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.endsWith("/v1")) return trimmed;
  const afterScheme = trimmed.includes("://")
    ? trimmed.slice(trimmed.indexOf("://") + 3)
    : trimmed;
  const originOnly = !afterScheme.includes("/");
  return originOnly ? `${trimmed}/v1` : trimmed;
}

interface BuildArgs {
  // UniversalProvider 稳定 id（用于派生各 app 子供应商 id）。
  universalId: string;
  // 展示名（已含 Dokng 前缀）。
  displayName: string;
  baseUrl: string;
  apiKey: string;
  // 置顶用的排序索引（该 app 现有最小值 - 1）。
  sortIndex?: number;
}

// [ccs] 为某个 app 构造对应 settings_config 形状的 Provider。各形状均核对自后端权威定义
// （provider.rs 的 to_xx_provider / 各 *_config.rs / 预设类型）。
function buildProviderForApp(app: AppId, args: BuildArgs): Provider {
  const { universalId, displayName, baseUrl, apiKey, sortIndex } = args;
  const common = {
    id: `dokng-${app}-${universalId}`,
    name: displayName,
    websiteUrl: DOKNG_WEBSITE_URL,
    category: "aggregator" as const,
    icon: DOKNG_ICON,
    sortIndex,
  };

  switch (app) {
    case "claude":
      return {
        ...common,
        settingsConfig: {
          env: {
            ANTHROPIC_BASE_URL: baseUrl,
            ANTHROPIC_AUTH_TOKEN: apiKey,
            ANTHROPIC_MODEL: MODELS.claude,
            ANTHROPIC_DEFAULT_HAIKU_MODEL: MODELS.claudeHaiku,
            ANTHROPIC_DEFAULT_SONNET_MODEL: MODELS.claudeSonnet,
            ANTHROPIC_DEFAULT_OPUS_MODEL: MODELS.claudeOpus,
          },
        },
      };

    // Claude Desktop：direct 直连模式（dokng 是 Anthropic 兼容端点）。需 env 双字段
    // + meta.claudeDesktopMode="direct" + claude-safe 路由（model 必须等于 routeId）。
    case "claude-desktop":
      return {
        ...common,
        settingsConfig: {
          env: {
            ANTHROPIC_BASE_URL: baseUrl,
            ANTHROPIC_AUTH_TOKEN: apiKey,
          },
        },
        meta: {
          claudeDesktopMode: "direct",
          claudeDesktopModelRoutes: {
            "claude-sonnet-5": { model: "claude-sonnet-5", supports1m: false },
            "claude-opus-4-8": { model: "claude-opus-4-8", supports1m: false },
            "claude-haiku-4-5": { model: "claude-haiku-4-5", supports1m: false },
          },
        },
      };

    case "codex": {
      const cbase = codexBaseUrl(baseUrl);
      const configToml = [
        `model_provider = ${tomlString("custom")}`,
        `model = ${tomlString(MODELS.codex)}`,
        `model_reasoning_effort = ${tomlString(MODELS.codexEffort)}`,
        `disable_response_storage = true`,
        ``,
        `[model_providers.custom]`,
        `name = ${tomlString("Dokng")}`,
        `base_url = ${tomlString(cbase)}`,
        `wire_api = ${tomlString("responses")}`,
        `requires_openai_auth = true`,
      ].join("\n");
      return {
        ...common,
        settingsConfig: {
          auth: { OPENAI_API_KEY: apiKey },
          config: configToml,
        },
      };
    }

    case "gemini":
      return {
        ...common,
        settingsConfig: {
          env: {
            GOOGLE_GEMINI_BASE_URL: baseUrl,
            GEMINI_API_KEY: apiKey,
            GEMINI_MODEL: MODELS.gemini,
          },
        },
      };

    // OpenCode：AI SDK 包名 + options 嵌套凭据 + models 字典。
    case "opencode":
      return {
        ...common,
        settingsConfig: {
          npm: "@ai-sdk/anthropic",
          name: displayName,
          options: { baseURL: baseUrl, apiKey },
          models: {
            "claude-sonnet-5": { name: "Claude Sonnet 5" },
            "claude-opus-4-8": { name: "Claude Opus 4.8" },
          },
        },
      };

    // OpenClaw：顶层 camelCase 凭据 + api 协议 + models 数组。
    case "openclaw":
      return {
        ...common,
        settingsConfig: {
          baseUrl,
          apiKey,
          api: "anthropic-messages",
          models: [
            { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
            { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
          ],
        },
      };

    // Hermes：顶层 snake_case + api_mode + models 数组（内部 name 用 slug 避免 YAML 键含空格）。
    case "hermes":
      return {
        ...common,
        settingsConfig: {
          name: `dokng-${universalId.slice(0, 8)}`,
          base_url: baseUrl,
          api_key: apiKey,
          api_mode: "anthropic_messages",
          models: [{ id: "claude-sonnet-5", name: "Claude Sonnet 5" }],
        },
      };
  }
  // 兜底守卫：上游 AppId 联合类型会新增成员（如 v3.18.0 加了 "grokbuild"），本函数
  // 刻意只实现上面 7 个铺开目标（DOKNG_TARGET_APPS）。正常路径此处不可达；一旦有人
  // 扩了目标列表却没实现构造器，会在逐 app try/catch 中报出明确错误而非静默漏配。
  // 注：也让 TS 对「switch 未覆盖全部 AppId」不再报 TS2366（v3.18.0 起必现）。
  throw new Error(`不支持的目标应用: ${app}`);
}

export interface ApplyAppResult {
  app: AppId;
  ok: boolean;
  error?: string;
}

export interface ApplyAccountOptions {
  activate: boolean;
  // 远端 profile 的真实 token.Name；用于修复存量 provider.name="NewAPI" 并铺开真实名。
  tokenName?: string;
}

async function pinProviderFirst(app: AppId, childId: string): Promise<void> {
  const providers = await providersApi.getAll(app);
  const ordered = Object.values(providers)
    .filter((p) => p.id !== childId)
    .sort((a, b) => {
      const ai = typeof a.sortIndex === "number" ? a.sortIndex : Number.MAX_SAFE_INTEGER;
      const bi = typeof b.sortIndex === "number" ? b.sortIndex : Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      return (a.createdAt ?? 0) - (b.createdAt ?? 0);
    });
  await providersApi.updateSortOrder(
    [{ id: childId, sortIndex: 0 }, ...ordered.map((p, index) => ({ id: p.id, sortIndex: index + 1 }))],
    app,
  );
}

// [ccs] 把一条 Dokng 账户铺到指定应用列表。activate=true 时激活（switch 类设为当前、
// additive 类写 live）；false 时仅加进列表不激活。逐 app 独立捕获错误，互不影响。
export async function applyAccountToApps(
  provider: UniversalProvider,
  apps: AppId[],
  options: ApplyAccountOptions,
): Promise<ApplyAppResult[]> {
  validateCredentials(provider.baseUrl, provider.apiKey);
  const storedName = provider.name.trim();
  const tokenName = options.tokenName?.trim();
  const rawName = !storedName || storedName.toLowerCase() === "newapi" || /^dokng\s*·/i.test(storedName)
    ? tokenName || storedName
    : storedName;
  const displayName = dokngDisplayName(rawName);
  const results: ApplyAppResult[] = [];

  for (const app of apps) {
    try {
      // sortIndex 在 Rust 里是 usize，绝不能发送 -1。新建/更新都先用非负 0，add 成功后再
      // 通过 updateSortOrder 把 Dokng 固定为 0、其余归一化为 1..N（幂等且真正置顶）。
      const childId = `dokng-${app}-${provider.id}`;
      const topIndex = 0;

      const appProvider = buildProviderForApp(app, {
        universalId: provider.id,
        displayName,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        sortIndex: topIndex,
      });

      // 分两步独立报错，便于定位失败环节（"加入列表" vs "激活"）：
      //   step="add"    additive 类由 addToLive=activate 决定是否写 live；switch 类仅在无当前时自动激活。
      //                 save_provider 对已存在 id 覆盖，故重复铺开幂等。
      //   step="switch" switch 类显式激活时设为当前（会替换当前选择——仅对用户勾选的 app 生效）。
      let step: "add" | "sort" | "switch" = "add";
      try {
        await providersApi.add(appProvider, app, options.activate);

        step = "sort";
        await pinProviderFirst(app, childId);

        if (options.activate && !isAdditiveApp(app)) {
          step = "switch";
          await providersApi.switch(appProvider.id, app);
        }
      } catch (inner) {
        const raw = inner instanceof Error ? inner.message : String(inner);
        throw new Error(`[${step}] ${raw}`);
      }

      results.push({ app, ok: true });
    } catch (error) {
      results.push({
        app,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

export interface BindAccountArgs {
  baseUrl: string;
  apiKey: string;
  // 渠道展示名（可选）。存进 UniversalProvider.name 的原始值；显示/铺开时再加 Dokng 前缀。
  name?: string;
  // 已解析好的目标应用：由 UI 等设置加载和平台能力查询完成后传入，避免 undefined 回退全 7 app。
  targetApps: AppId[];
}

export interface BindAccountResult {
  provider: UniversalProvider;
  applyResults: ApplyAppResult[];
}

// [ccs] 绑定新账户：建一条 newapi UniversalProvider（覆盖 Dokng 官网/图标），upsert 存盘，
// 再铺到「可见」的 app 列表（activate=false，不覆盖用户已选的当前供应商）。返回新渠道。
export async function bindAccount({
  baseUrl,
  apiKey,
  name,
  targetApps,
}: BindAccountArgs): Promise<BindAccountResult> {
  const preset = findPresetByType("newapi");
  if (!preset) {
    throw new Error("缺少 NewAPI 预设，无法绑定账户");
  }

  const trimmedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
  const trimmedApiKey = apiKey.trim();

  validateCredentials(trimmedBaseUrl, trimmedApiKey);

  // 渠道名优先用用户填写的；没填则拉一次 profile 用远端 token.Name（即该 key 在 Dokng 侧的名字），
  // 保证卡片/铺开展示的是「Dokng · <这个 key 的真实名字>」而非预设名「NewAPI」。
  let resolvedName = name?.trim();
  if (!resolvedName) {
    try {
      const result = await accountApi.getProfile(trimmedBaseUrl, trimmedApiKey);
      resolvedName = result.ok ? result.profile?.tokenName?.trim() : undefined;
    } catch {
      // 拉取失败（网络/无效 key）不阻断绑定：名字回落到预设名，用户之后可编辑。
      resolvedName = undefined;
    }
  }

  const provider = createUniversalProviderFromPreset(
    preset,
    generateUUID(),
    trimmedBaseUrl,
    trimmedApiKey,
    // 明确传入空字符串也会被 upstream 工厂的 `customName || preset.name` 变回 NewAPI，
    // 因此创建后再覆盖 name，确保 profile 暂时失败时也不把预设名当成真实 key 名。
    resolvedName || undefined,
  );
  provider.name = resolvedName || "";
  // 覆盖为 Dokng 品牌：官网指向自建站点、图标用 Dokng logo。
  provider.websiteUrl = DOKNG_WEBSITE_URL;
  provider.icon = DOKNG_ICON;

  const ok = await universalProvidersApi.upsert(provider);
  if (!ok) {
    throw new Error("保存渠道失败");
  }

  // 铺到已解析的可用 app 列表（不激活）；返回逐 app 结果，由 UI 明确提示部分失败。
  const applyResults = await applyAccountToApps(provider, targetApps, {
    activate: false,
    tokenName: resolvedName,
  });
  return { provider, applyResults };
}
