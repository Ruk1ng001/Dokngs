//! Dokng 账户的托盘扩展；上游 tray.rs 只保留调用锚点。

use super::TrayEntry;
use tauri::Emitter;

const ACCOUNT_ID: &str = "open_account";

// 不扩展上游 TrayTexts；上游新增语言时回退英文。
fn account_text(language: &str) -> &'static str {
    match language {
        "zh" => "我的账户",
        "zh-TW" => "我的帳戶",
        "ja" => "マイアカウント",
        "ko" => "내 계정",
        "de" => "Mein Konto",
        "ru" => "Моя учётная запись",
        "tr" => "Hesabım",
        _ => "My Account",
    }
}

/// 在窗口操作区末尾加入账户入口，保留上游菜单项的相对位置。
/// 上游新增重启更新等操作时，不需要修改本模块或补丁上下文。
pub(super) fn extend_menu(menu: &mut Vec<TrayEntry>, language: &str) {
    if menu
        .iter()
        .any(|entry| matches!(entry, TrayEntry::Item { id, .. } if id == ACCOUNT_ID))
    {
        return;
    }
    let Some(window_start) = menu
        .iter()
        .position(|entry| matches!(entry, TrayEntry::Item { id, .. } if id == "show_main"))
    else {
        log::warn!("账户托盘入口未添加：上游菜单缺少 show_main 操作");
        return;
    };
    let section_end = menu[window_start..]
        .iter()
        .position(|entry| matches!(entry, TrayEntry::Separator))
        .map_or(menu.len(), |offset| window_start + offset);
    menu.insert(section_end, TrayEntry::item(ACCOUNT_ID, account_text(language)));
}

/// 仅接管账户事件；其余事件由上游继续处理。
pub(super) fn handle_event(app: &tauri::AppHandle, event_id: &str) -> bool {
    if event_id != ACCOUNT_ID {
        return false;
    }
    super::show_main_window(app);
    if let Err(error) = app.emit("ccs-open-account", ()) {
        log::error!("发送打开账户面板事件失败: {error}");
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upstream_menu_builder_includes_account_entry() {
        let menu = super::super::build_menu_model(
            &super::super::TrayTexts::from_language("en"),
            &super::super::MenuStatus::default(),
            &[],
            false,
            chrono::Local::now(),
        );
        let main = menu
            .iter()
            .position(|entry| matches!(entry, TrayEntry::Item { id, .. } if id == "show_main"))
            .expect("上游主窗口操作仍存在");
        let account = menu
            .iter()
            .position(|entry| matches!(entry, TrayEntry::Item { id, .. } if id == ACCOUNT_ID))
            .expect("菜单构建锚点应调用账户扩展");
        assert!(account > main);
        assert!(matches!(menu[account + 1], TrayEntry::Separator));
    }

    #[test]
    fn preserves_upstream_actions_and_inserts_before_window_separator() {
        let original = vec![
            TrayEntry::item("nav:settings:routing", "修复路由"),
            TrayEntry::Separator,
            TrayEntry::item("show_main", "打开 CC Switch"),
            TrayEntry::item("app_update:install", "重启更新"),
            TrayEntry::item("future_window_action", "未来的窗口操作"),
            TrayEntry::Separator,
            TrayEntry::item("quit", "退出"),
        ];
        let mut menu = original.clone();
        extend_menu(&mut menu, "zh");
        assert_eq!(menu[5], TrayEntry::item(ACCOUNT_ID, "我的账户"));
        assert_eq!(menu[3], original[3], "保留上游重启更新项的优先级");
        menu.remove(5);
        assert_eq!(menu, original, "其它菜单项及分隔符不变");
    }

    #[test]
    fn handles_older_upstream_and_does_not_duplicate_account_entry() {
        let mut menu = vec![
            TrayEntry::item("show_main", "Open CC Switch"),
            TrayEntry::Separator,
        ];
        extend_menu(&mut menu, "future-language");
        extend_menu(&mut menu, "future-language");
        assert_eq!(menu.len(), 3);
        assert_eq!(menu[1], TrayEntry::item(ACCOUNT_ID, "My Account"));
        assert_eq!(account_text("zh-TW"), "我的帳戶");
        assert_eq!(account_text("ja"), "マイアカウント");
    }
}
