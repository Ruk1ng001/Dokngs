// [ccs] 账户面板容器（对齐 open-code 完整版：固定头部 + 固定账户概览 + 独立滚动 key 列表 + 底部新增）。
//
// 列出所有 providerType:"newapi" 的 UniversalProvider（= 一个个 Dokng key），逐个渲染 KeyCard
// 展示 key 级用量；顶部账户概览取首个渠道的 profile 展示账户余额/额度环/今日用量；「新增账户」
// 走嵌套 Dialog（AddAccountDialog），绑定即 bindAccount（upsert + sync 铺开到各 CLI）。
//
// 与 open-code 的账户体系对齐：那边是「账户 → 多 key → 激活写入各 CLI」；cc-switch 里没有独立的
// 账户实体，一条 newapi 渠道即一个 key，绑定/激活统一落到 UniversalProvider 的 upsert + sync。
// 渠道列表用 cc-switch 现成的 universalProvidersApi（settings KV 落盘），本层不新增任何存储。
//
// 布局（点 2/4/5）：整体 flex 纵向占满 Dialog 高度，只有 key 列表区 flex-1 overflow-y-auto 滚动，
// 头部/账户概览/底部固定不滚动；右上角自带关闭 X。Dialog 尺寸在 App.tsx 用 min() 约束（点 5）。
// 样式全走项目 UI 基元与主题变量（点 6）。

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  RefreshCw,
  LayoutDashboard,
  Wallet,
  X,
  KeyRound,
  ExternalLink,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Checkbox } from "@/components/ui/checkbox";
import { universalProvidersApi, providersApi, settingsApi } from "@/lib/api";
import type { AppId } from "@/lib/api/types";
import type { UniversalProvider, UniversalProvidersMap } from "@/types";
import { useSettingsQuery } from "@/lib/query";
import { KeyCard } from "./KeyCard";
import { useAccountProfile, accountKeys } from "./useAccountProfile";
import {
  bindAccount,
  applyAccountToApps,
  resolveTargetApps,
} from "./importKey";
import {
  formatCurrency,
  formatTokenCount,
  usedPercent,
  usageLevel,
  avatarInitial,
} from "@/lib/account/format";

// [ccs] 内置 Dokng 站点根：写死为本项目自建网关，用户绑定时无需（也无法）填接口地址。
// 该值会同时用于 (1) 铺开到各 CLI 的 ANTHROPIC_BASE_URL（原样写入，Dokng 在站点根挂
// Anthropic 兼容端点）；(2) 查余额（后端 derive_api_base 从此推导 /api/app/profile）。
// 换网关只改这一处常量即可。
export const BUILTIN_NEWAPI_BASE_URL = "https://dokng.com";
// [ccs] 控制台 / 充值外链（对齐 open-code：控制台 = 站点根 + /dashboard；充值回退站点根）。
const CONSOLE_URL = `${BUILTIN_NEWAPI_BASE_URL}/dashboard`;
const TOPUP_URL = BUILTIN_NEWAPI_BASE_URL;

interface AccountPanelProps {
  // [ccs] 关闭整个账户面板（右上角 X 与外层 Dialog 共用）。
  onClose: () => void;
  // [ccs] 外部刷新令牌：值变化即重拉渠道列表。深链接导入（useAccountImportDeeplink）在
  // 面板之外完成绑定，需要一条通道让已挂载的面板把新 key 显示出来。
  reloadToken?: number;
}

export function AccountPanel({ onClose, reloadToken }: AccountPanelProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  // [ccs] 用户当前可见的应用集合。绑定/铺开只针对可见 app，避免向未装/已隐藏的应用写入。
  const { data: settingsData, isLoading: settingsLoading } = useSettingsQuery();
  const visibleApps = settingsData?.visibleApps;
  const [claudeDesktopSupported, setClaudeDesktopSupported] = useState<
    boolean | undefined
  >(undefined);

  useEffect(() => {
    let cancelled = false;
    providersApi
      .getClaudeDesktopStatus()
      .then((status) => {
        if (!cancelled) setClaudeDesktopSupported(status.supported);
      })
      .catch(() => {
        // 查询失败时按不支持处理，宁可不展示也不要让 Linux/未知平台铺开后确定失败。
        if (!cancelled) setClaudeDesktopSupported(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // [ccs] 只等 settings 查询本身结束，不再要求 visibleApps 字段存在：该字段在后端是
  // Option + skip_serializing_if，用户没改过应用可见性时压根不下发，附加 !== undefined
  // 会让 targetsReady 恒为 false、「新增 key」按钮永久置灰。字段缺失的默认语义（全部
  // 可见）交由 resolveTargetApps 处理，与上游 App.tsx 的 `?? {全部 true}` 回退一致。
  const targetsReady = !settingsLoading;
  const targetApps = useMemo(
    () =>
      targetsReady
        ? resolveTargetApps(visibleApps, { claudeDesktopSupported })
        : [],
    [targetsReady, visibleApps, claudeDesktopSupported],
  );

  const [providers, setProviders] = useState<UniversalProvidersMap>({});
  const [loading, setLoading] = useState(true);
  // 正在「铺开」的渠道 id（禁用对应卡片按钮 + 多选框确认按钮）。
  const [reapplyingId, setReapplyingId] = useState<string | null>(null);
  // [ccs] 待铺开的渠道（非空即弹出应用多选框；勾选确认后调 applyAccountToApps）。
  const [applyTarget, setApplyTarget] = useState<UniversalProvider | null>(
    null,
  );
  // [ccs] 正在删除的渠道 id（禁用对应卡片删除按钮）。
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // [ccs] 待确认删除的渠道（非空即弹出 ConfirmDialog）。
  const [deleteTarget, setDeleteTarget] = useState<UniversalProvider | null>(
    null,
  );
  // [ccs] 新增账户嵌套 Dialog 开关（点 3）。
  const [addOpen, setAddOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const data = await universalProvidersApi.getAll();
      setProviders(data);
    } catch (error) {
      console.error("Failed to load providers:", error);
      toast.error(
        t("account.loadListError", { defaultValue: "加载账户列表失败" }),
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    load();
    // reloadToken 变化即重拉：深链接导入在面板外绑定，靠它把新 key 推进列表。
  }, [load, reloadToken]);

  // 只展示 newapi 渠道（一条 = 一个 Dokng key）。按 sortIndex → createdAt 稳定排序。
  const newapiProviders = Object.values(providers)
    .filter((p) => p.providerType === "newapi")
    .sort((a, b) => {
      const si = (a.sortIndex ?? 0) - (b.sortIndex ?? 0);
      if (si !== 0) return si;
      return (a.createdAt ?? 0) - (b.createdAt ?? 0);
    });

  // [ccs] 账户概览取首个渠道的 profile（账户级余额/额度为账户维度，同账户各 key 同源）。
  const primaryProvider = newapiProviders[0];

  // [ccs] 请求铺开：打开应用多选框（KeyCard「铺开到各 CLI」→ 此处）。真正铺开在 confirmApply。
  const requestApply = useCallback((provider: UniversalProvider) => {
    setApplyTarget(provider);
  }, []);

  // [ccs] 确认铺开：把该渠道铺到勾选的 app 并激活（switch 类设为当前、additive 类写 live）。
  // 逐 app 独立捕获错误：全成功提示成功，部分失败列出失败的 app，不影响成功的部分。
  const confirmApply = useCallback(
    async (provider: UniversalProvider, apps: AppId[]) => {
      try {
        setReapplyingId(provider.id);
        const results = await applyAccountToApps(provider, apps, {
          activate: true,
        });
        const failed = results.filter((r) => !r.ok);
        if (failed.length === 0) {
          toast.success(
            t("account.reapplySuccess", { defaultValue: "已铺开并激活" }),
          );
        } else {
          // 逐个失败 app 单独弹一条错误，带上具体原因（后端返回的 error），
          // 便于定位「某应用为何铺开失败」——不再只显示 app 名而吞掉错误细节。
          for (const r of failed) {
            const appName = t(`apps.${r.app}`, { defaultValue: r.app });
            const errorText =
              r.error ??
              t("account.unknownError", { defaultValue: "未知错误" });
            toast.error(
              t("account.reapplyOneFailed", {
                defaultValue: "{{app}} 铺开失败：{{error}}",
                app: appName,
                error: errorText,
              }),
              {
                description: `${appName}: ${errorText}`,
                duration: 12000,
              },
            );
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toast.error(
          t("account.reapplyError", {
            defaultValue: "铺开失败：{{error}}",
            error: message,
          }),
        );
      } finally {
        setReapplyingId(null);
        setApplyTarget(null);
      }
    },
    [t],
  );

  // [ccs] 请求删除：仅打开确认框（KeyCard 删除按钮点击 → 此处）。真正删除在 confirmDelete。
  const requestDelete = useCallback((provider: UniversalProvider) => {
    setDeleteTarget(provider);
  }, []);

  // [ccs] 确认删除：从存储移除该 newapi 渠道（delete_universal_provider），成功后刷新列表。
  // 删除只移除渠道记录，不回收已铺开到各 CLI 的现存配置（与 upstream 删除语义一致）。
  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    const provider = deleteTarget;
    try {
      setDeletingId(provider.id);
      await universalProvidersApi.delete(provider.id);
      toast.success(t("account.deleteSuccess", { defaultValue: "已删除账户" }));
      await load();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(
        t("account.deleteError", {
          defaultValue: "删除失败：{{error}}",
          error: message,
        }),
      );
    } finally {
      setDeletingId(null);
      setDeleteTarget(null);
    }
  }, [deleteTarget, load, t]);

  // [ccs] 在系统默认浏览器打开外链（控制台 / 充值）。走 settingsApi.openExternal
  // （→ 后端 opener），已内建 http/https 校验；客户端内不实现任何支付逻辑。
  const openExternal = useCallback(
    async (url: string) => {
      try {
        await settingsApi.openExternal(url);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toast.error(
          t("account.openLinkError", {
            defaultValue: "打开链接失败：{{error}}",
            error: message,
          }),
        );
      }
    },
    [t],
  );

  // [ccs] 刷新全部：让列表 + 所有 key/账户 profile 查询失效重拉（react-query 统一驱动）。
  const refreshAll = useCallback(() => {
    load();
    queryClient.invalidateQueries({ queryKey: accountKeys.all });
  }, [load, queryClient]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* ── 固定头部：标题 + 控制台/充值 + 关闭 X（点 1/4）───────────────── */}
      <div className="flex items-start justify-between gap-3 border-b border-border-default bg-muted/20 px-6 py-4 flex-shrink-0">
        <div className="min-w-0 space-y-1">
          <DialogTitle className="text-lg font-semibold leading-tight tracking-tight">
            {t("account.title", { defaultValue: "我的账户" })}
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            {t("account.subtitle", {
              defaultValue: "管理 Dokng 账户，一键铺开到各命令行工具",
            })}
          </DialogDescription>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => openExternal(CONSOLE_URL)}
          >
            <LayoutDashboard className="w-4 h-4 mr-1.5" />
            {t("account.console", { defaultValue: "控制台" })}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => openExternal(TOPUP_URL)}
          >
            <Wallet className="w-4 h-4 mr-1.5" />
            {t("account.topup", { defaultValue: "充值" })}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            title={t("common.close", { defaultValue: "关闭" })}
            aria-label={t("common.close", { defaultValue: "关闭" })}
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* ── 固定账户概览（点 2：这块不滚动）──────────────────────────────── */}
      {primaryProvider && <AccountOverview provider={primaryProvider} />}

      {/* ── 列表工具条（固定）：已绑定账户 (N) + 刷新 ──────────────────── */}
      <div className="flex items-center justify-between px-6 pt-4 pb-2 flex-shrink-0">
        <span className="text-sm font-medium">
          {t("account.listTitle", { defaultValue: "已绑定 key" })}
          {newapiProviders.length > 0 ? ` (${newapiProviders.length})` : ""}
        </span>
        <Button
          variant="ghost"
          size="icon"
          onClick={refreshAll}
          disabled={loading}
          title={t("account.reloadList", { defaultValue: "刷新列表" })}
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* ── 唯一滚动区：key 列表（点 2）────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-4 space-y-3">
        {loading ? (
          // 骨架屏而非「加载中…」一行字：占位高度与 KeyCard 一致，数据到位时不发生跳动。
          <KeyCardSkeleton />
        ) : newapiProviders.length === 0 ? (
          // [ccs] 空态引导卡（对齐 open-code 的 cx-onboard）：图标 + 标题 + 说明 + 主行动按钮，
          // 而非一行灰字。首次打开面板的用户在这里就能直接开始绑定，不用自己去找底部按钮。
          <div className="mx-auto mt-6 max-w-md rounded-lg border border-border-default bg-muted/20 p-6 text-center">
            <div className="mx-auto mb-3.5 flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <KeyRound className="h-5 w-5" />
            </div>
            <div className="mb-2 text-[15px] font-semibold">
              {t("account.emptyTitle", { defaultValue: "连接你的 Dokng 账户" })}
            </div>
            <div className="mb-4 text-sm leading-relaxed text-muted-foreground">
              {t("account.emptyDesc", {
                defaultValue:
                  "先在 Dokng 控制台创建 API Key，再粘贴到这里。Key 只保存在本机，绑定后可一键铺开到各命令行工具。",
              })}
            </div>
            <div className="flex flex-col items-center gap-2">
              <Button onClick={() => setAddOpen(true)} disabled={!targetsReady}>
                <Plus className="mr-1.5 h-4 w-4" />
                {t("account.addAccount", { defaultValue: "新增 key" })}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => openExternal(CONSOLE_URL)}
              >
                <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                {t("account.emptyGetKey", {
                  defaultValue: "前往 Dokng 获取 API Key",
                })}
              </Button>
            </div>
          </div>
        ) : (
          newapiProviders.map((provider) => (
            <KeyCard
              key={provider.id}
              provider={provider}
              onImport={requestApply}
              importing={reapplyingId === provider.id}
              onDelete={requestDelete}
              deleting={deletingId === provider.id}
            />
          ))
        )}
      </div>

      {/* ── 固定底部：新增账户（点 3，弹嵌套 Dialog）───────────────────── */}
      <div className="border-t border-border-default bg-muted/20 px-6 py-3 flex-shrink-0">
        <Button
          className="w-full"
          onClick={() => setAddOpen(true)}
          disabled={!targetsReady}
          title={
            targetsReady
              ? undefined
              : t("account.targetsLoading", {
                  defaultValue: "正在加载应用设置…",
                })
          }
        >
          <Plus className="w-4 h-4 mr-1.5" />
          {t("account.addAccount", { defaultValue: "新增 key" })}
        </Button>
      </div>

      {/* [ccs] 新增账户嵌套 Dialog（zIndex=nested，覆于账户面板之上）。 */}
      <AddAccountDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onBound={load}
        targetApps={targetApps}
      />

      {/* [ccs] 删除确认：复用项目统一 ConfirmDialog（危险色 + 警告图标）。 */}
      <ConfirmDialog
        isOpen={deleteTarget !== null}
        title={t("account.deleteConfirmTitle", { defaultValue: "删除账户" })}
        message={t("account.deleteConfirm", {
          defaultValue: "确定删除账户「{{name}}」？此操作不可撤销。",
          name:
            deleteTarget?.name.trim() ||
            t("account.unnamedKey", { defaultValue: "未命名 key" }),
        })}
        confirmText={t("common.delete", { defaultValue: "删除" })}
        cancelText={t("common.cancel", { defaultValue: "取消" })}
        variant="destructive"
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* [ccs] 铺开应用多选框：勾选要激活的 app（默认全选），确认后铺开并激活选中的 app。 */}
      <ApplyDialog
        provider={applyTarget}
        applying={reapplyingId !== null}
        onCancel={() => setApplyTarget(null)}
        onConfirm={confirmApply}
        targetApps={targetApps}
      />
    </div>
  );
}

// [ccs] 铺开应用多选框：仅列出「可见」的目标应用（settings.visibleApps 过滤后），用户勾选后
// 铺开并激活选中的 app。默认全选；至少勾一个才能确认。app 显示名走 i18n（回退英文名）。
function ApplyDialog({
  provider,
  applying,
  onCancel,
  onConfirm,
  targetApps,
}: {
  provider: UniversalProvider | null;
  applying: boolean;
  onCancel: () => void;
  onConfirm: (provider: UniversalProvider, apps: AppId[]) => void;
  targetApps: AppId[];
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Set<AppId>>(
    () => new Set(targetApps),
  );

  // 每次打开重置为全选（按当前可见 app）。
  useEffect(() => {
    if (provider) setSelected(new Set(targetApps));
  }, [provider, targetApps]);

  const toggle = (app: AppId) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(app)) next.delete(app);
      else next.add(app);
      return next;
    });
  };

  // [ccs] 快捷操作：全选 / 全不选 / 反选（仅在可见 app 范围内）。
  const allSelected =
    targetApps.length > 0 && targetApps.every((app) => selected.has(app));
  const selectAll = () => setSelected(new Set(targetApps));
  const selectNone = () => setSelected(new Set());
  const invert = () =>
    setSelected(new Set(targetApps.filter((app) => !selected.has(app))));

  return (
    <Dialog
      open={provider !== null}
      onOpenChange={(open) => {
        if (!open && !applying) onCancel();
      }}
    >
      {/* [ccs] 顶栏避让：固定顶栏（拖拽条+header，最坏 96px）为 base 层但盖在 Dialog 之上，
          小窗口下整窗居中会让 Dialog 顶部被遮。下移中心 + 限高，确保恒落在顶栏之下。 */}
      <DialogContent
        className="max-w-md overflow-y-auto"
        zIndex="nested"
        style={{
          top: "calc(96px / 2 + 50vh)",
          maxHeight: "calc(100vh - 96px - 1rem)",
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {t("account.applyTitle", { defaultValue: "铺开到应用" })}
          </DialogTitle>
          <DialogDescription>
            {t("account.applySubtitle", {
              defaultValue:
                "勾选要写入并激活的应用。仅选中的应用会被改动，其它应用不受影响。",
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 px-6 py-4">
          {targetApps.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              {t("account.noTargetApps", {
                defaultValue: "没有可铺开的应用，请先在设置中启用支持的应用",
              })}
            </div>
          ) : (
            <>
              {/* [ccs] 快捷操作条：全选 / 全不选 / 反选。 */}
              <div className="flex items-center gap-2 pb-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={allSelected ? selectNone : selectAll}
                  disabled={applying || targetApps.length === 0}
                >
                  {allSelected
                    ? t("account.selectNone", { defaultValue: "全不选" })
                    : t("account.selectAll", { defaultValue: "全选" })}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={invert}
                  disabled={applying || targetApps.length === 0}
                >
                  {t("account.selectInvert", { defaultValue: "反选" })}
                </Button>
                <span className="ml-auto text-xs text-muted-foreground">
                  {t("account.selectedCount", {
                    defaultValue: "已选 {{count}} / {{total}}",
                    count: selected.size,
                    total: targetApps.length,
                  })}
                </span>
              </div>
              {targetApps.map((app) => (
                <label
                  key={app}
                  className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/50 cursor-pointer"
                >
                  <Checkbox
                    checked={selected.has(app)}
                    onCheckedChange={() => toggle(app)}
                    disabled={applying}
                  />
                  <span className="text-sm">
                    {t(`apps.${app}`, { defaultValue: app })}
                  </span>
                </label>
              ))}
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={applying}>
            {t("common.cancel", { defaultValue: "取消" })}
          </Button>
          <Button
            onClick={() =>
              provider && onConfirm(provider, Array.from(selected))
            }
            disabled={applying || selected.size === 0}
          >
            {applying
              ? t("account.importing", { defaultValue: "铺开中…" })
              : t("account.applyConfirm", { defaultValue: "铺开并激活" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// [ccs] 账户概览：取首个渠道 profile 展示账户级余额 + 额度环 + 今日用量。固定不滚动（点 2）。
// 自身调 useAccountProfile（与对应 KeyCard 同 queryKey，react-query 去重，不重复请求）。
function AccountOverview({ provider }: { provider: UniversalProvider }) {
  const { t } = useTranslation();
  const { data } = useAccountProfile({
    keyId: provider.id,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
  });
  const profile = data?.ok ? data.profile : undefined;

  const displayName =
    profile?.displayName?.trim() ||
    profile?.username?.trim() ||
    provider.name.trim() ||
    t("account.unnamedKey", { defaultValue: "未命名 key" });
  const username = profile?.username?.trim() ?? "";
  const pct = profile
    ? usedPercent(profile.accountUsedQuota, profile.accountTotalQuota)
    : 0;
  // 额度环配色：与 KeyCard 的额度条共用 usageLevel 分级（正常主色 / 临近琥珀 / 耗尽危险色）。
  // conic-gradient 只能走内联 style，故这里取 CSS 变量字符串而非 Tailwind class。
  const ringLevel = usageLevel(pct);
  const ringColor =
    ringLevel === "danger"
      ? "hsl(var(--destructive))"
      : ringLevel === "warn"
        ? "rgb(245 158 11)"
        : "hsl(var(--primary))";

  return (
    <div className="border-b border-border-default px-6 py-4 flex-shrink-0 space-y-4">
      {/* 身份行：头像 + 名称 + 已连接 */}
      <div className="flex items-center gap-3">
        {profile?.avatar ? (
          <img
            src={profile.avatar}
            alt=""
            className="h-10 w-10 rounded-full object-cover"
          />
        ) : (
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary font-semibold">
            {avatarInitial(displayName)}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium truncate">{displayName}</span>
            {profile && (
              <Badge variant="secondary" className="flex-shrink-0">
                {t("account.connected", { defaultValue: "已连接" })}
              </Badge>
            )}
          </div>
          {username && (
            <span className="text-xs text-muted-foreground truncate">
              @{username}
            </span>
          )}
        </div>
      </div>

      {/* 账户级指标：额度环 + 余额 / 今日 Tokens / 今日请求 */}
      <div className="flex items-center gap-5">
        {/* 额度环：conic-gradient 无法用 Tailwind class 表达，故保留内联 style，但颜色改走
            主题变量（hsl(var(--primary)) / --muted）而非硬编码 rgb——明暗主题与品牌主色一致。
            已用比例高时按 usageLevel 切到告警/危险色，与 KeyCard 的额度条同一套分级。 */}
        <div
          className="relative h-[72px] w-[72px] flex-shrink-0 rounded-full"
          style={{
            background: `conic-gradient(${ringColor} ${pct * 3.6}deg, hsl(var(--muted)) 0deg)`,
          }}
          role="img"
          aria-label={t("account.usageRingLabel", {
            defaultValue: "账户额度已用 {{pct}}%",
            pct,
          })}
        >
          <div className="absolute inset-[7px] flex flex-col items-center justify-center rounded-full bg-background">
            <strong className="text-sm font-semibold tabular-nums">
              {profile ? `${pct}%` : "—"}
            </strong>
            <span className="text-[10px] text-muted-foreground">
              {t("account.used", { defaultValue: "已用" })}
            </span>
          </div>
        </div>
        {/* 2×2 网格：窄窗口下 4 格并排会把数字压到换行，故 grid-cols-2 起、宽屏才铺成 4 列。 */}
        <div className="grid flex-1 grid-cols-2 gap-3 sm:grid-cols-4">
          <OverviewMetric
            label={t("account.accountBalance", { defaultValue: "账户余额" })}
            value={
              profile ? formatCurrency(profile.accountRemainingQuota) : "—"
            }
          />
          <OverviewMetric
            label={t("account.todayTokens", { defaultValue: "今日 Tokens" })}
            value={
              profile ? formatTokenCount(profile.accountTokensUsedToday) : "—"
            }
          />
          {/* [ccs] 账户级输入/输出 tokens：后端一直返回 accountPromptTokensToday /
              accountCompletionTokensToday，此前只有 open-code 侧展示，这边白拿不用。 */}
          <OverviewMetric
            label={t("account.tokenIO", { defaultValue: "输入 / 输出" })}
            value={
              profile
                ? `${formatTokenCount(profile.accountPromptTokensToday)} / ${formatTokenCount(profile.accountCompletionTokensToday)}`
                : "—"
            }
          />
          <OverviewMetric
            label={t("account.todayRequests", { defaultValue: "今日请求" })}
            value={
              profile?.requestCountToday == null
                ? "—"
                : String(profile.requestCountToday)
            }
          />
        </div>
      </div>
    </div>
  );
}

function OverviewMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}

// [ccs] 列表加载骨架屏：形状与 KeyCard 对齐（头像 + 两行文字 + 指标网格 + 额度条），
// 占位高度接近真实卡片，数据到位替换时不会整块跳动——这是相较「加载中…」一行字的主要收益。
// 纯装饰，aria-hidden + role="presentation"：读屏不必逐块朗读占位方块。
function KeyCardSkeleton() {
  return (
    <div
      className="rounded-lg border border-border-default p-4 space-y-3"
      aria-hidden="true"
      role="presentation"
    >
      <div className="flex items-center gap-3">
        <div className="h-7 w-7 flex-shrink-0 animate-pulse rounded-md bg-muted" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="h-3.5 w-1/3 animate-pulse rounded bg-muted" />
          <div className="h-3 w-1/4 animate-pulse rounded bg-muted" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="space-y-1">
            <div className="h-2.5 w-2/3 animate-pulse rounded bg-muted" />
            <div className="h-3.5 w-1/2 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>
      <div className="h-1.5 w-full animate-pulse rounded-full bg-muted" />
    </div>
  );
}

// [ccs] 新增账户嵌套 Dialog（点 3）。接口地址内置为 BUILTIN_NEWAPI_BASE_URL，不暴露给用户。
// 绑定 = bindAccount：建一条 newapi 渠道 → upsert 存盘 → 加进「可见」app 的列表（不激活）。
// zIndex=nested（z-50）覆于账户面板（z-40）之上；成功后回调 onBound 刷新父列表并自关。
function AddAccountDialog({
  open,
  onOpenChange,
  onBound,
  targetApps,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onBound: () => void | Promise<void>;
  targetApps: AppId[];
}) {
  const { t } = useTranslation();
  const [apiKey, setApiKey] = useState("");
  const [name, setName] = useState("");
  const [binding, setBinding] = useState(false);

  // 每次打开重置表单，避免上次残留。
  useEffect(() => {
    if (open) {
      setApiKey("");
      setName("");
      setBinding(false);
    }
  }, [open]);

  const handleBind = useCallback(async () => {
    if (!apiKey.trim()) {
      toast.error(t("account.bindMissing", { defaultValue: "请填写 API Key" }));
      return;
    }
    try {
      setBinding(true);
      const result = await bindAccount({
        baseUrl: BUILTIN_NEWAPI_BASE_URL,
        apiKey,
        name,
        targetApps,
      });
      const failed = result.applyResults.filter((r) => !r.ok);
      if (failed.length === 0) {
        toast.success(
          t("account.bindSuccess", {
            defaultValue: "已绑定 key，可在卡片上铺开并激活",
          }),
        );
      } else {
        toast.warning(
          t("account.bindPartial", {
            defaultValue: "key 已保存，但 {{count}} 个应用加入列表失败",
            count: failed.length,
          }),
          {
            description: failed
              .map(
                (r) =>
                  `${t(`apps.${r.app}`, { defaultValue: r.app })}: ${
                    r.error ??
                    t("account.unknownError", { defaultValue: "未知错误" })
                  }`,
              )
              .join("\n"),
            duration: 12000,
          },
        );
      }
      await onBound();
      onOpenChange(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(
        t("account.bindError", {
          defaultValue: "绑定失败：{{error}}",
          error: message,
        }),
      );
    } finally {
      setBinding(false);
    }
  }, [apiKey, name, targetApps, onBound, onOpenChange, t]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md"
        zIndex="nested"
        style={{
          top: "calc(96px / 2 + 50vh)",
          maxHeight: "calc(100vh - 96px - 1rem)",
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {t("account.addAccount", { defaultValue: "新增 key" })}
          </DialogTitle>
          <DialogDescription>
            {t("account.addSubtitle", {
              defaultValue:
                "粘贴 Dokng API Key 绑定账户，绑定后在卡片上「铺开到各 CLI」即可激活",
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-6 py-4">
          <div className="space-y-1">
            <Label htmlFor="ccs-account-name">
              {t("account.displayName", { defaultValue: "展示名（可选）" })}
            </Label>
            <Input
              id="ccs-account-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("account.namePlaceholder", {
                defaultValue: "留空用远端名称",
              })}
              disabled={binding}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ccs-account-key">
              {t("account.apiKey", { defaultValue: "API Key" })}
            </Label>
            <Input
              id="ccs-account-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !binding) handleBind();
              }}
              placeholder="sk-..."
              disabled={binding}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={binding}
          >
            {t("common.cancel", { defaultValue: "取消" })}
          </Button>
          <Button onClick={handleBind} disabled={binding}>
            {binding
              ? t("account.binding", { defaultValue: "绑定中…" })
              : t("account.bind", { defaultValue: "绑定账户" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
