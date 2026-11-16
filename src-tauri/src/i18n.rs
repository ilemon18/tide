//! The little bit of native-side copy (Dock menu, tray menu, etc.).
//!
//! Only menus drawn by the system himself need this table; in-WebView UI copy uses the frontend glossary.
//! The locale comes from `settings.json`'s `locale`, the same value the frontend settings page uses.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Locale {
    En,
    ZhCn,
    ZhTw,
    Ja,
    Ko,
    Es,
}

impl Locale {
    pub fn from_tag(tag: &str) -> Self {
        match tag {
            "zh-CN" => Locale::ZhCn,
            "zh-TW" => Locale::ZhTw,
            "ja" => Locale::Ja,
            "ko" => Locale::Ko,
            "es" => Locale::Es,
            _ => Locale::En,
        }
    }
}

pub struct Strings {
    /// Dock menu: "Opened" section header
    pub opened: &'static str,
    /// Dock menu: "Recent" section header
    pub recent: &'static str,
    pub new_window: &'static str,
    /// Placeholder item shown when both lists are empty
    pub empty: &'static str,
}

pub fn strings(locale: Locale) -> &'static Strings {
    match locale {
        Locale::En => &EN,
        Locale::ZhCn => &ZH_CN,
        Locale::ZhTw => &ZH_TW,
        Locale::Ja => &JA,
        Locale::Ko => &KO,
        Locale::Es => &ES,
    }
}

static EN: Strings = Strings {
    opened: "Open",
    recent: "Recent",
    new_window: "New Window",
    empty: "No recent projects",
};

static ZH_CN: Strings = Strings {
    opened: "已打开",
    recent: "最近打开",
    new_window: "新建窗口",
    empty: "最近没有打开过项目",
};

static ZH_TW: Strings = Strings {
    opened: "已開啟",
    recent: "最近開啟",
    new_window: "新增視窗",
    empty: "最近沒有開啟過專案",
};

static JA: Strings = Strings {
    opened: "開いている",
    recent: "最近使った項目",
    new_window: "新しいウィンドウ",
    empty: "最近使ったプロジェクトはありません",
};

static KO: Strings = Strings {
    opened: "열린 프로젝트",
    recent: "최근 항목",
    new_window: "새 창",
    empty: "최근에 연 프로젝트가 없습니다",
};

static ES: Strings = Strings {
    opened: "Abiertos",
    recent: "Recientes",
    new_window: "Nueva ventana",
    empty: "No hay proyectos recientes",
};