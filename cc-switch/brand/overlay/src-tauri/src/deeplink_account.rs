// [ccs] Dokng 账户深链接：`ccswitch://v1/import?resource=account&apiKey=...`
//
// 为什么不走上游 deeplink 模块：
//   上游 parse_deeplink_url 的 resource 白名单只有 provider/prompt/mcp/skill，account 会被
//   判为「不支持的资源类型」→ 走 emit("deeplink-error") → 前端弹一条解析失败 toast。功能
//   上不可用，且那条错误事件的 payload 带的是**未脱敏的完整 URL**（上游 lib.rs 的 error
//   分支塞 "url": url_str），前端 console.error 会把含 apiKey 的 URL 打进 devtools。
//
// 因此这里在 handle_deeplink_url 的最前面拦一道：URL 是 resource=account 就自己解析、发
// 品牌事件 "ccs-account-import"，并让调用方 early-return，上游解析链路根本看不到这个 URL。
// 其它 resource 一律原样透传给上游，行为零变化。附带收益就是上面那条：key 不再有机会
// 经上游的错误回显路径进入前端日志。
//
// scheme 复用上游已注册的 ccswitch://（tauri.conf.json 的 deep-link.schemes）——不新增
// dokng:// 是刻意的：tauri.conf.json 由 updater 注入步骤接管，属于补丁保留路径，且多注册
// 一个 scheme 还要在三个平台各自登记一遍，收益为零。
//
// ── 送达保证（这块是本模块的主要复杂度所在）──────────────────────────────
// Tauri 的 emit 不重放：没有已注册的监听器时载荷直接丢弃。而前端监听器要等 webview 起来、
// React 挂载、动态 import("@tauri-apps/api/event") 完成才存在。以下三条路径都会踩空：
//   1. Windows/Linux 冷启动（应用没在跑时点按钮——最典型场景）：OS 把 URL 作 argv 启动进程，
//      single_instance 只对第 2+ 个实例触发，deep-link 插件在自己的 init 阶段就 emit 了，
//      而上游 on_open_url 注册在 setup（晚于插件 init）。上游从不调 get_current()，
//      所以这条 URL 根本无人接手；
//   2. macOS 冷启动：RunEvent::Opened 到达时 webview 存在但 JS 尚未挂监听器；
//   3. 轻量模式唤醒：exit_lightweight_mode 用 WebviewWindowBuilder 重建了全新 webview，
//      紧接着 emit，页面 JS 必然还没加载完。
// 故采用「emit + pending slot」双轨：emit 照发（热路径下最快），同时把 request 存进
// PENDING；前端 hook 挂载时先调 take_pending_account_import 取一次。哪条先到都不丢，
// 且 PENDING 被取走即清空，配合下面的 dedup 不会重复导入。
//
// 冷启动那条还需要 lib.rs 在 setup 里补一次 deep_link().get_current() 的检查（补丁 02），
// 否则 Windows/Linux 上根本没有任何代码碰过那条 URL。
//
// 去重：macOS 上同一个 URL 会被投递两次——deep-link 插件的 on_event 和上游 app.run 闭包的
// RunEvent::Opened 分支都会触发（插件在 macOS 没有自己的 objc handler，它的 on_event 就是
// 把 RunEvent::Opened 转成 emit）。加上 emit/PENDING 双轨本身也可能重叠，故按 apiKey 记
// 最近一次处理时间，窗口内重复到达只聚焦窗口、不再投递。
//
// 契约（new-api 侧 data-table-row-actions.tsx 的「导入到 Dokng 桌面端」按钮生成该 URL）：
//   ccswitch://v1/import?resource=account&apiKey=sk-xxx[&name=<key 名>]
//   - apiKey  必填，非空；
//   - name    可选，缺省时前端回落到远端 token 名（bindAccount 自己会拉 profile）；
//   - baseUrl 刻意不接受：与手动「新增 key」保持一致（那边表单也只有展示名 + API Key，
//     地址取 BUILTIN_NEWAPI_BASE_URL）。key 由链接构造者提供、泄露不了用户任何东西，
//     真正要防的是反方向：baseUrl 若可注入，任意页面就能在用户机器上装一条指向自己
//     服务器的配置，此后该 CLI 的全部请求（含代码与对话内容）都过那台机器。

use once_cell::sync::Lazy;
use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use url::Url;

/// 发给前端的账户导入载荷（camelCase 对齐前端 TS 约定）。
///
/// 刻意不 derive Debug：`{:?}` 会把 api_key 全文打进日志。需要排查时用下面的
/// 手写实现（只暴露 name 与 key 长度）。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountImportRequest {
    /// Dokng API Key（原样透传，前端交给 bindAccount）。
    pub api_key: String,
    /// 可选展示名（该 key 在 Dokng 侧的名字）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

// 手写 Debug 屏蔽 key：日志可能被用户贴进 issue，derive 版本会泄露完整密钥。
impl std::fmt::Debug for AccountImportRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AccountImportRequest")
            .field("name", &self.name)
            .field("api_key_len", &self.api_key.len())
            .finish()
    }
}

/// 前端事件名：CcsAccountMount 监听并执行绑定。
const ACCOUNT_IMPORT_EVENT: &str = "ccs-account-import";
/// 解析失败时的前端事件名（前端弹 toast，避免用户点了按钮毫无反应）。
const ACCOUNT_ERROR_EVENT: &str = "ccs-account-import-error";

/// 同一 key 在此窗口内重复到达即视为重复投递（macOS 双入口 + emit/PENDING 双轨）。
/// 3 秒足够覆盖两条入口的时间差，又不会把用户「导入 → 删除 → 立刻重新导入」判成重复。
const DEDUP_WINDOW: Duration = Duration::from_secs(3);

/// 待前端领取的导入请求。emit 与它是双轨：谁先到都算，取走即清空。
static PENDING: Lazy<Mutex<Option<AccountImportRequest>>> = Lazy::new(|| Mutex::new(None));

/// 最近一次已投递的 (apiKey, 时刻)，用于 DEDUP_WINDOW 内去重。
static LAST_DELIVERED: Lazy<Mutex<Option<(String, Instant)>>> = Lazy::new(|| Mutex::new(None));

/// 该 key 是否属于窗口内的重复投递；不是则记录本次并返回 false。
///
/// 锁中毒（另一线程 panic）时按「不是重复」处理：宁可多投一次由前端去重，也不要
/// 因为一次 panic 让导入功能彻底失效。
fn is_duplicate_delivery(api_key: &str) -> bool {
    let mut guard = match LAST_DELIVERED.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    let now = Instant::now();
    if let Some((last_key, at)) = guard.as_ref() {
        if last_key == api_key && now.duration_since(*at) < DEDUP_WINDOW {
            return true;
        }
    }
    *guard = Some((api_key.to_string(), now));
    false
}

/// [ccs] 前端取走待处理的导入请求（挂载时调用一次，覆盖 emit 早于监听器的场景）。
///
/// 返回 Some 即表示有一条待处理请求，取走后 slot 清空。
#[tauri::command]
pub fn take_pending_account_import() -> Option<AccountImportRequest> {
    match PENDING.lock() {
        Ok(mut guard) => guard.take(),
        Err(poisoned) => poisoned.into_inner().take(),
    }
}

/// 存入待领取的导入请求（覆盖式：只保留最后一条，用户连点两次也只导入一次）。
fn set_pending(request: AccountImportRequest) {
    match PENDING.lock() {
        Ok(mut guard) => *guard = Some(request),
        Err(poisoned) => *poisoned.into_inner() = Some(request),
    }
}

/// [ccs] 冷启动补扫：把插件在 init 阶段已经吃掉的启动 URL 捞回来。
///
/// Windows/Linux 冷启动时 OS 把 URL 作为 argv 传给新进程，deep-link 插件在自己的 init 里
/// 就 emit 掉了（此时上游的 on_open_url 尚未注册、webview 也不存在），上游从不调
/// get_current，所以那条 URL 事实上无人接手——功能在「应用没开着时点按钮」这个最典型的
/// 场景下会完全失效。在 setup 里调一次本函数即可补上：命中则写入 PENDING，前端挂载后取走。
///
/// 此处不显示窗口：冷启动的窗口本来就会显示，且 setup 阶段窗口可能还没建好。
pub fn drain_launch_deeplinks(app: &tauri::AppHandle) {
    use tauri_plugin_deep_link::DeepLinkExt;

    let urls = match app.deep_link().get_current() {
        Ok(Some(urls)) => urls,
        Ok(None) => return,
        Err(e) => {
            log::debug!("· [ccs] 读取启动深链接失败（通常表示没有）: {e}");
            return;
        }
    };

    for url in urls {
        let url_str = url.as_str();
        let Ok(parsed) = Url::parse(url_str) else {
            continue;
        };
        if !is_account_deeplink(&parsed) {
            // 非 account 的启动链接交回上游语义（上游目前不处理冷启动，这里不越界代劳）。
            continue;
        }
        match parse_account_deeplink(&parsed) {
            Ok(request) => {
                if is_duplicate_delivery(&request.api_key) {
                    continue;
                }
                log::info!(
                    "✓ [ccs] 冷启动账户导入深链接：name={:?}, key 长度={}",
                    request.name,
                    request.api_key.len()
                );
                set_pending(request);
            }
            Err(e) => {
                log::error!("✗ [ccs] 冷启动账户导入深链接解析失败: {e}");
            }
        }
        // 只取第一条 account 链接，与上游 on_open_url 的 break 语义一致。
        break;
    }
}

/// 判断该 URL 是否为账户导入深链接（`resource=account`）。
///
/// 只做识别、不做校验：识别成功即由本模块接管（哪怕后续校验失败也不该回落到上游解析，
/// 否则上游会因未知 resource 再报一次错，用户看到两条互相矛盾的提示）。
fn is_account_deeplink(url: &Url) -> bool {
    // resource 大小写不敏感、path 容忍末尾斜杠：识别得宽一点是刻意的。near-miss 链接
    // （resource=Account、/import/）若漏给上游，会走 emit("deeplink-error") 那条路——
    // 而那里的 payload 带的是**未脱敏的完整 URL**，前端 console.error 会把 apiKey
    // 打进 devtools。宁可多接管，也不让密钥落到上游的错误回显里。
    url.scheme() == "ccswitch"
        && matches!(url.path(), "/import" | "/import/")
        && url
            .query_pairs()
            .any(|(k, v)| k == "resource" && v.eq_ignore_ascii_case("account"))
}

/// 从已识别的账户深链接里取出 apiKey / name。
fn parse_account_deeplink(url: &Url) -> Result<AccountImportRequest, String> {
    // 版本位在 host（与上游一致：ccswitch://v1/import）。
    match url.host_str() {
        Some("v1") => {}
        Some(other) => return Err(format!("不支持的协议版本: {other}")),
        None => return Err("URL 缺少版本段（应为 ccswitch://v1/import）".to_string()),
    }

    let mut api_key: Option<String> = None;
    let mut name: Option<String> = None;
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "apiKey" => api_key = Some(v.trim().to_string()),
            "name" => name = Some(v.trim().to_string()),
            _ => {}
        }
    }

    let api_key = api_key.filter(|k| !k.is_empty()).ok_or_else(|| {
        "缺少 apiKey 参数".to_string()
    })?;

    Ok(AccountImportRequest {
        api_key,
        name: name.filter(|n| !n.is_empty()),
    })
}

/// 尝试以「账户导入」处理该深链接。
///
/// 返回 true 表示已接管（无论绑定信息是否合法，均已向前端发事件），调用方应立即 return；
/// 返回 false 表示这不是账户深链接，调用方继续走上游通用解析。
pub fn try_handle_account_deeplink(
    app: &tauri::AppHandle,
    url_str: &str,
    _focus_main_window: bool,
) -> bool {
    let Ok(url) = Url::parse(url_str) else {
        // 解析不了的 URL 交给上游报错（错误提示语与既有深链接一致，不在这里分叉）。
        return false;
    };
    if !is_account_deeplink(&url) {
        return false;
    }

    match parse_account_deeplink(&url) {
        Ok(request) => {
            // 不打印 key 本体：日志可能被用户贴到 issue 里。
            log::info!(
                "✓ [ccs] 账户导入深链接：name={:?}, key 长度={}",
                request.name,
                request.api_key.len()
            );
            if is_duplicate_delivery(&request.api_key) {
                // 同一 URL 的重复投递（macOS 上插件 on_event 与 RunEvent::Opened 会各送
                // 一次；用户连点两次按钮同理）。窗口照显，但不再 emit / 不覆盖 pending，
                // 否则前端会在成功提示之后紧跟一条「该 key 已绑定」，自相矛盾。
                log::info!("· [ccs] 同一 key 的重复投递，跳过本次派发");
                show_main_window(app);
                return true;
            }
            // 先写 pending 再 emit：冷启动/轻量模式唤醒时前端监听器还没挂上，emit 会空转
            // （Tauri 不重放事件），此时全靠 pending 让前端挂载后主动取走。
            set_pending(request.clone());
            if let Err(e) = app.emit(ACCOUNT_IMPORT_EVENT, &request) {
                log::error!("✗ [ccs] 发送 {ACCOUNT_IMPORT_EVENT} 失败: {e}");
            }
        }
        Err(e) => {
            log::error!("✗ [ccs] 账户导入深链接解析失败: {e}");
            if let Err(emit_err) = app.emit(ACCOUNT_ERROR_EVENT, serde_json::json!({ "error": e })) {
                log::error!("✗ [ccs] 发送 {ACCOUNT_ERROR_EVENT} 失败: {emit_err}");
            }
        }
    }

    // 无条件显示窗口，不看 focus_main_window：上游在 single_instance 路径传 false，因为
    // 它那条链路会弹 DeepLinkImportDialog，用户下次打开窗口仍能看到待确认项。我们这条是
    // 静默绑定，窗口不出现就等于零反馈——而托盘常驻正是 cc-switch 的主要用法。
    show_main_window(app);

    true
}

/// 显出并聚焦主窗口（深链接来自浏览器点击，必须给可见反馈）。
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        #[cfg(target_os = "linux")]
        {
            crate::linux_fix::nudge_main_window(window.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(raw: &str) -> Result<AccountImportRequest, String> {
        let url = Url::parse(raw).expect("URL 应可解析");
        assert!(is_account_deeplink(&url), "应被识别为账户深链接");
        parse_account_deeplink(&url)
    }

    #[test]
    fn recognizes_only_account_resource() {
        let provider = Url::parse("ccswitch://v1/import?resource=provider&app=claude").unwrap();
        assert!(!is_account_deeplink(&provider));
        let account = Url::parse("ccswitch://v1/import?resource=account&apiKey=sk-1").unwrap();
        assert!(is_account_deeplink(&account));
    }

    #[test]
    fn ignores_other_schemes_and_paths() {
        let other_scheme = Url::parse("dokng://v1/import?resource=account&apiKey=sk-1").unwrap();
        assert!(!is_account_deeplink(&other_scheme));
        let other_path = Url::parse("ccswitch://v1/export?resource=account&apiKey=sk-1").unwrap();
        assert!(!is_account_deeplink(&other_path));
    }

    #[test]
    fn parses_key_and_optional_name() {
        let req = parse("ccswitch://v1/import?resource=account&apiKey=sk-abc&name=My%20Key")
            .expect("应解析成功");
        assert_eq!(req.api_key, "sk-abc");
        assert_eq!(req.name.as_deref(), Some("My Key"));
    }

    #[test]
    fn name_is_optional() {
        let req = parse("ccswitch://v1/import?resource=account&apiKey=sk-abc").unwrap();
        assert_eq!(req.name, None);
    }

    #[test]
    fn blank_name_collapses_to_none() {
        let req = parse("ccswitch://v1/import?resource=account&apiKey=sk-abc&name=%20%20").unwrap();
        assert_eq!(req.name, None);
    }

    #[test]
    fn rejects_missing_or_blank_key() {
        assert!(parse("ccswitch://v1/import?resource=account").is_err());
        assert!(parse("ccswitch://v1/import?resource=account&apiKey=%20").is_err());
    }

    #[test]
    fn rejects_unknown_version() {
        assert!(parse("ccswitch://v2/import?resource=account&apiKey=sk-1").is_err());
    }
}
