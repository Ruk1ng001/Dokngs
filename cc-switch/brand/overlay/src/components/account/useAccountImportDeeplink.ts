// [ccs] 消费 Rust 侧 deeplink_account.rs 发来的账户导入事件，直接完成绑定。
//
// 链路：new-api 的 key 列表点「导入到 Dokng 桌面端」→ 浏览器拉起 ccswitch://v1/import?
// resource=account&apiKey=... → Rust 的 try_handle_account_deeplink 拦下并 emit
// "ccs-account-import" → 本 hook 收到后调 bindAccount 落账户，并打开账户面板展示结果。
//
// 为什么不复用上游的 DeepLinkImportDialog（二次确认对话框）：那套面向「导入陌生供应商配置」，
// 需要用户核对 endpoint/模型等一堆字段；这里 endpoint 写死为自建网关、字段只有一个 key，
// 用户在 new-api 侧点按钮时已经表达了意图，再弹一次确认纯属多余。
//
// 幂等：同一个 key 重复导入会命中下面的去重，只提示「已存在」并打开面板定位，不产生重复渠道。
// 这不是理论情况——用户在 new-api 连点两次按钮，或 Windows 上 single_instance 与 on_open_url
// 都递一次同一 URL，都会走到这里。

import { useEffect, useRef } from "react";
import type { TFunction } from "i18next";
import { toast } from "sonner";
import { settingsApi, providersApi, universalProvidersApi } from "@/lib/api";
import { accountApi, type AccountImportPayload } from "@/lib/api/account";
import type { AppId } from "@/lib/api/types";
import { bindAccount, resolveTargetApps } from "./importKey";
import { BUILTIN_NEWAPI_BASE_URL } from "./AccountPanel";

/**
 * [ccs] 解析本次导入应铺开的目标应用。
 *
 * 深链接导入没有面板那套 react-query 上下文（事件可能在面板从未打开时到达），故直接查一次
 * settings + claude-desktop 支持状态。visibleApps 缺失时 resolveTargetApps 按全部可见处理。
 */
async function resolveAppsForImport(): Promise<AppId[]> {
  // settings 读失败必须抛，不能吞成 undefined：resolveTargetApps 把 undefined 当「全部
  // 可见」（字段缺失的正常语义），一旦请求失败也走这条路，就会把 key 铺到用户显式隐藏
  // 的 app 上。而铺开不只是「加进列表」——upstream ProviderService::add 对 switch 类
  // 在该 app 尚无当前供应商时会 set_current_provider + write_live_with_common_config，
  // 即直接改写 live 配置。字段缺失（读到了但没这个字段）与读取失败必须区别对待。
  const [settings, claudeDesktop] = await Promise.all([
    settingsApi.get(),
    providersApi
      .getClaudeDesktopStatus()
      .then((s) => s.supported)
      // 查不到就按不支持处理：宁可少铺一个，也不要在 Linux 上铺一个必然失败的目标。
      .catch(() => false),
  ]);
  return resolveTargetApps(settings?.visibleApps, {
    claudeDesktopSupported: claudeDesktop,
  });
}

/** [ccs] 该 key 是否已经绑定过（按 apiKey 精确比对，避免重复建渠道）。 */
async function findExistingKey(apiKey: string): Promise<string | undefined> {
  try {
    const providers = await universalProvidersApi.getAll();
    return Object.values(providers).find(
      (p) => p.providerType === "newapi" && p.apiKey === apiKey,
    )?.name;
  } catch {
    // 查询失败不阻断导入：最坏情况是多出一条渠道，用户可自行删除。
    return undefined;
  }
}

interface HandleArgs {
  payload: AccountImportPayload;
  t: TFunction;
  onOpenPanel: () => void;
  onBound: () => void;
}

/** [ccs] 执行一次深链接导入：去重 → bindAccount → 提示 → 打开面板。 */
async function handleImport({
  payload,
  t,
  onOpenPanel,
  onBound,
}: HandleArgs): Promise<void> {
  const apiKey = payload.apiKey?.trim();
  if (!apiKey) {
    toast.error(
      t("account.deeplinkMissingKey", {
        defaultValue: "导入链接缺少 API Key",
      }),
    );
    return;
  }

  // 先把面板开出来：绑定要发网络请求（拉 profile + 逐 app 写配置），用户从浏览器跳过来
  // 总得先看到界面在动，否则窗口起来一片静止会以为没生效。
  onOpenPanel();

  const existingName = await findExistingKey(apiKey);
  if (existingName !== undefined) {
    toast.info(
      t("account.deeplinkDuplicate", {
        defaultValue: "该 key 已绑定，未重复添加",
      }),
    );
    onBound();
    return;
  }

  const toastId = toast.loading(
    t("account.deeplinkBinding", { defaultValue: "正在导入 Dokng key…" }),
  );
  try {
    const targetApps = await resolveAppsForImport();
    const result = await bindAccount({
      baseUrl: BUILTIN_NEWAPI_BASE_URL,
      apiKey,
      name: payload.name,
      targetApps,
    });
    const failed = result.applyResults.filter((r) => !r.ok);
    if (failed.length === 0) {
      toast.success(
        t("account.deeplinkSuccess", {
          defaultValue: "已导入 key，可在卡片上铺开并激活",
        }),
        { id: toastId },
      );
    } else {
      toast.warning(
        t("account.bindPartial", {
          defaultValue: "key 已保存，但 {{count}} 个应用加入列表失败",
          count: failed.length,
        }),
        {
          id: toastId,
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
    onBound();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    toast.error(
      t("account.deeplinkError", {
        defaultValue: "导入失败：{{error}}",
        error: message,
      }),
      { id: toastId, duration: 12000 },
    );
  }
}

interface Options {
  /** 打开账户面板（导入前调用，让用户看到进展）。 */
  onOpenPanel: () => void;
  /** 绑定完成后刷新面板列表。 */
  onBound: () => void;
  t: TFunction;
}

// [ccs] 导入队列尾，模块级而非 effect 内局部变量。
//
// 放在 effect 里会随监听器重挂被重置成 Promise.resolve()：切语言时若有导入在飞，新事件
// 就会与旧导入并发跑 findExistingKey，双双查不到已存在渠道、各建一条重复记录。提到模块
// 作用域后，整个进程生命周期内所有导入严格串行，去重才真正成立。
let importQueue: Promise<void> = Promise.resolve();

/** [ccs] 把一次导入排到队尾（保证 findExistingKey 看到的是上一次落盘后的状态）。 */
function enqueueImport(args: HandleArgs): void {
  importQueue = importQueue.then(() =>
    handleImport(args).catch(() => {
      // handleImport 内部已提示；此处兜底防止链条断裂导致后续导入失效。
    }),
  );
}

/**
 * [ccs] 监听账户导入深链接事件（"ccs-account-import" / "ccs-account-import-error"），
 * 并在挂载时领取一次 Rust 侧的 pending 请求。
 *
 * 为什么需要 pending 领取：Tauri 的 emit 不重放。冷启动（应用没开着时点按钮，最典型的
 * 场景）、macOS 的 RunEvent::Opened、轻量模式唤醒重建 webview，这三种情况下 Rust 侧
 * emit 的时刻前端监听器都还没挂上，事件直接丢弃 —— 用户看到窗口弹出后一片静止。
 * 故 Rust 侧 emit 的同时把 request 存进 PENDING，此处挂载后主动取一次。两条轨道都投到
 * 同一个串行队列，Rust 侧按 apiKey 做了 3 秒窗口去重，重叠时不会重复导入。
 *
 * effect 依赖刻意为空：t 经 ref 透传。react-i18next 的 t 引用不稳定（languageChanged 与
 * ready 变化都会换新引用），若进依赖数组会导致监听器反复卸载重挂，重挂期间（await import
 * + 一次 listen IPC 往返）到达的事件会直接丢失。
 */
export function useAccountImportDeeplink({
  onOpenPanel,
  onBound,
  t,
}: Options): void {
  // 回调与 t 都走 ref：effect 只在挂载时跑一次，内部始终读到最新值。
  const tRef = useRef(t);
  tRef.current = t;
  const onOpenPanelRef = useRef(onOpenPanel);
  onOpenPanelRef.current = onOpenPanel;
  const onBoundRef = useRef(onBound);
  onBoundRef.current = onBound;

  useEffect(() => {
    let active = true;
    const unlisteners: Array<() => void> = [];

    const dispatch = (payload: AccountImportPayload) => {
      enqueueImport({
        payload,
        t: tRef.current,
        onOpenPanel: () => onOpenPanelRef.current(),
        onBound: () => onBoundRef.current(),
      });
    };

    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");

      const unImport = await listen<AccountImportPayload>(
        "ccs-account-import",
        (event) => dispatch(event.payload),
      );

      const unError = await listen<{ error: string }>(
        "ccs-account-import-error",
        (event) => {
          toast.error(
            tRef.current("account.deeplinkParseError", {
              defaultValue: "导入链接无效：{{error}}",
              error: event.payload?.error ?? "",
            }),
          );
        },
      );

      if (active) {
        unlisteners.push(unImport, unError);
      } else {
        unImport();
        unError();
        return;
      }

      // 监听器就位后再领 pending：顺序反了的话，pending 取走与 emit 到达之间存在真空，
      // 那一瞬间的事件会两头都接不到。Rust 侧去重保证这里不会与 emit 重复导入。
      try {
        const pending = await accountApi.takePendingImport();
        if (active && pending) dispatch(pending);
      } catch {
        // 命令不可用（旧版后端）或调用失败：热路径的 emit 仍然工作，不必打扰用户。
      }
    })();

    return () => {
      active = false;
      unlisteners.forEach((un) => un());
    };
  }, []);
}
