// [ccs] 账户功能在 App.tsx 的唯一挂载点。
//
// 设计目标：把二开对上游 src/App.tsx 的侵入压缩到 3 行（1 个 import + 2 个 JSX 挂载），
// 其余全部收敛在本 overlay 文件内，随上游升级零冲突：
//   - AccountEntryButton：顶栏「账户」图标按钮（插在设置按钮之后）；
//   - CcsAccountMount：面板 Dialog 容器 + 自动弹出策略 + 托盘事件监听。
//
// 面板开关状态用模块级微 store（useSyncExternalStore）承载，使按钮与挂载点无需共享
// React 状态/Context，也让托盘事件、首启逻辑都能在组件外触发打开。
//
// 自动弹出策略（对齐 open-code 首启逻辑）：
//   - 首次运行（localStorage 无标记）→ 弹出并落标记；
//   - 非首次但本地没有任何已绑定的 newapi 渠道 → 弹出（引导绑定）；
//   - 其余情况静默，不打扰常驻托盘使用。
//
// 托盘联动：Rust 侧补丁 06 在托盘「我的账户」点击后 emit("ccs-open-account")，
// 此处监听并打开面板；动态 import("@tauri-apps/api/event") 避免加重 App 首屏。
//
// 深链接导入：Rust 侧 deeplink_account.rs 拦下 resource=account 的 ccswitch:// 链接后
// emit("ccs-account-import")，由 useAccountImportDeeplink 直接完成绑定（无二次确认），
// 并通过下面的 reloadSignal 让已挂载的面板重拉列表。

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { UserCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { universalProvidersApi } from "@/lib/api";
import { AccountPanel } from "./AccountPanel";
import { useAccountImportDeeplink } from "./useAccountImportDeeplink";

// ── 模块级微 store：面板开关 ─────────────────────────────────
let panelOpen = false;
const listeners = new Set<() => void>();

function setPanelOpen(next: boolean): void {
  if (panelOpen === next) return;
  panelOpen = next;
  listeners.forEach((l) => l());
}

/** [ccs] 任意位置打开账户面板（按钮/托盘事件/首启逻辑共用）。 */
export function openAccountPanel(): void {
  setPanelOpen(true);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function usePanelOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => panelOpen,
    () => panelOpen,
  );
}

// ── 模块级微 store：列表刷新令牌 ─────────────────────────────
// 深链接导入在面板组件之外完成绑定（事件可能在面板从未挂载时到达），需要一条通道通知
// 已挂载的 AccountPanel 重拉列表。单调递增的计数当作 useEffect 依赖即可，无需事件总线。
let reloadToken = 0;
const reloadListeners = new Set<() => void>();

/** [ccs] 通知账户面板重新加载渠道列表。 */
function bumpReloadToken(): void {
  reloadToken += 1;
  reloadListeners.forEach((l) => l());
}

function subscribeReload(listener: () => void): () => void {
  reloadListeners.add(listener);
  return () => {
    reloadListeners.delete(listener);
  };
}

function useReloadToken(): number {
  return useSyncExternalStore(
    subscribeReload,
    () => reloadToken,
    () => reloadToken,
  );
}

// 首启标记：出现过账户面板即落盘，此后仅在「无已绑定渠道」时才自动弹出。
const FIRST_RUN_KEY = "ccs-account-panel-seen";

/** [ccs] 顶栏账户入口按钮（App.tsx 顶栏工具条内挂载）。 */
export function AccountEntryButton() {
  const { t } = useTranslation();
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={openAccountPanel}
      title={t("account.title", { defaultValue: "账户" })}
      className="hover:bg-black/5 dark:hover:bg-white/5"
    >
      <UserCircle className="w-4 h-4" />
    </Button>
  );
}

interface CcsAccountMountProps {
  // App.tsx 的固定顶栏高度（拖拽条 + header）。Dialog 需在顶栏下方的可用区内垂直
  // 居中并限高，否则小窗口下面板顶部会被顶栏遮住。
  contentTopOffset: number;
}

/** [ccs] 账户面板挂载点：Dialog 容器 + 自动弹出策略 + 托盘事件监听。 */
export function CcsAccountMount({ contentTopOffset }: CcsAccountMountProps) {
  const { t } = useTranslation();
  const open = usePanelOpen();
  const reload = useReloadToken();

  // [ccs] new-api「导入到 Dokng 桌面端」深链接：收到即绑定，并打开面板展示结果。
  // 回调用 useCallback 固化：hook 的 effect 以它们为依赖，每次渲染换新函数会反复重挂监听。
  useAccountImportDeeplink({
    onOpenPanel: useCallback(() => setPanelOpen(true), []),
    onBound: useCallback(() => bumpReloadToken(), []),
    t,
  });

  // 自动弹出：首次运行，或没有任何已绑定的 newapi 渠道时。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let seen = false;
      try {
        seen = window.localStorage.getItem(FIRST_RUN_KEY) === "1";
      } catch {
        // localStorage 不可用时按「已见过」处理，避免每次启动都弹。
        seen = true;
      }
      if (!seen) {
        try {
          window.localStorage.setItem(FIRST_RUN_KEY, "1");
        } catch {
          // 写失败无妨：下次会再按首启弹一次，不影响功能。
        }
        if (!cancelled) setPanelOpen(true);
        return;
      }
      try {
        const providers = await universalProvidersApi.getAll();
        const hasKey = Object.values(providers).some(
          (p) => p.providerType === "newapi",
        );
        if (!cancelled && !hasKey) setPanelOpen(true);
      } catch {
        // 渠道列表查询失败：静默，不因后端异常打扰用户。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 托盘「我的账户」事件（Rust 侧补丁 06 emit）。带 active 守卫防 async import 期间卸载竞态。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let active = true;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const un = await listen("ccs-open-account", () => {
        setPanelOpen(true);
      });
      if (active) {
        unlisten = un;
      } else {
        un();
      }
    })();
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  return (
    // 位置/尺寸：固定顶栏盖在 base 层 Dialog 之上，故不按整窗垂直居中，而是在顶栏下方
    // 可用区内居中：top 取该区中心、maxHeight 扣掉顶栏高度；高度 680 兜底，放不下时由
    // 面板内部 key 列表滚动区消化。p-0 去掉默认内边距（面板各区自带 px-6）。
    <Dialog open={open} onOpenChange={setPanelOpen}>
      <DialogContent
        className="w-[640px] max-w-[calc(100vw-2rem)] h-[680px] p-0 gap-0 overflow-hidden"
        style={{
          top: `calc(${contentTopOffset}px / 2 + 50vh)`,
          maxHeight: `calc(100vh - ${contentTopOffset}px - 1rem)`,
        }}
      >
        <AccountPanel
          onClose={() => setPanelOpen(false)}
          reloadToken={reload}
        />
      </DialogContent>
    </Dialog>
  );
}
