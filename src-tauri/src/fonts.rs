//! インストール済みのフォントファミリーの一覧（設定画面の選択肢用）。

use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontFamily {
    pub name: String,
    /// 等幅フォントか（ターミナルに向いているか）。
    pub monospace: bool,
}

#[derive(Debug, Error)]
pub enum FontError {
    #[error("フォント一覧を取得できませんでした: {0}")]
    Unavailable(String),
}

/// 一覧を整える: 前後の空白除去、空・隠しフォント（`.` 始まり）・CSS に使えない名前の除外、
/// 重複の統合、大文字小文字を区別しない並べ替え。
pub fn normalize(raw: Vec<(String, bool)>) -> Vec<FontFamily> {
    let mut merged: std::collections::HashMap<String, bool> = std::collections::HashMap::new();
    for (name, monospace) in raw {
        let name = name.trim();
        if !is_usable_name(name) {
            continue;
        }
        *merged.entry(name.to_owned()).or_insert(false) |= monospace;
    }
    let mut list: Vec<FontFamily> = merged
        .into_iter()
        .map(|(name, monospace)| FontFamily { name, monospace })
        .collect();
    list.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.name.cmp(&b.name))
    });
    list
}

/// 設定の font-family（CSS）にそのまま使えるか。`settings.rs` の検証と整合させる。
fn is_usable_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && !name
            .chars()
            .any(|c| c.is_control() || matches!(c, '"' | '\'' | ';' | '{' | '}' | '<' | '>' | '\\'))
}

/// インストール済みのフォントファミリー。
#[cfg(target_os = "macos")]
pub fn installed_families() -> Result<Vec<FontFamily>, FontError> {
    use core_text::font::new_from_name;
    use core_text::font_collection::get_family_names;
    use core_text::font_descriptor::SymbolicTraitAccessors;

    let raw = get_family_names()
        .iter()
        .map(|family| {
            let name = family.to_string();
            let monospace = new_from_name(&name, 12.0)
                .map(|font| font.symbolic_traits().is_monospace())
                .unwrap_or(false);
            (name, monospace)
        })
        .collect();
    Ok(normalize(raw))
}

#[cfg(not(target_os = "macos"))]
pub fn installed_families() -> Result<Vec<FontFamily>, FontError> {
    Err(FontError::Unavailable(
        "この環境ではフォント一覧を取得できません".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(items: &[(&str, bool)]) -> Vec<(String, bool)> {
        items.iter().map(|(n, m)| (n.to_string(), *m)).collect()
    }

    fn names(list: &[FontFamily]) -> Vec<&str> {
        list.iter().map(|f| f.name.as_str()).collect()
    }

    #[test]
    fn sorted_case_insensitively() {
        let list = normalize(raw(&[
            ("monaco", true),
            ("Menlo", true),
            ("Arial", false),
            ("andale Mono", true),
        ]));
        assert_eq!(
            names(&list),
            vec!["andale Mono", "Arial", "Menlo", "monaco"]
        );
    }

    #[test]
    fn duplicates_are_merged_and_monospace_is_kept_if_any_says_so() {
        let list = normalize(raw(&[("Menlo", false), ("Menlo", true), ("Menlo", false)]));
        assert_eq!(
            list,
            vec![FontFamily {
                name: "Menlo".into(),
                monospace: true
            }]
        );
    }

    #[test]
    fn names_are_trimmed_and_blank_ones_dropped() {
        let list = normalize(raw(&[("  Menlo  ", true), ("", false), ("   ", true)]));
        assert_eq!(names(&list), vec!["Menlo"]);
    }

    #[test]
    fn hidden_system_fonts_are_dropped() {
        let list = normalize(raw(&[
            (".SF NS", false),
            (".AppleSystemUIFont", false),
            ("Menlo", true),
        ]));
        assert_eq!(names(&list), vec!["Menlo"]);
    }

    #[test]
    fn names_that_would_break_css_are_dropped() {
        let list = normalize(raw(&[
            ("Bad\"Quote", false),
            ("Semi;colon", false),
            ("Brace{", false),
            ("Back\\slash", false),
            ("Ctrl\u{7}", false),
            ("<tag>", false),
            ("ヒラギノ角ゴシック", false),
            ("Courier New", true),
        ]));
        assert_eq!(names(&list), vec!["Courier New", "ヒラギノ角ゴシック"]);
    }

    #[test]
    fn json_shape_matches_the_frontend_contract() {
        let v = serde_json::to_value(FontFamily {
            name: "Menlo".into(),
            monospace: true,
        })
        .unwrap();
        assert_eq!(v, serde_json::json!({"name": "Menlo", "monospace": true}));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_lists_menlo_as_monospace_and_helvetica_as_proportional() {
        let list = installed_families().unwrap();
        assert!(list.len() > 10, "フォントが少なすぎる: {}", list.len());
        let find = |n: &str| list.iter().find(|f| f.name == n);
        assert_eq!(find("Menlo").map(|f| f.monospace), Some(true));
        assert_eq!(find("Helvetica").map(|f| f.monospace), Some(false));
        assert!(list.iter().all(|f| !f.name.starts_with('.')));
        // 並び順と重複なし
        let mut sorted = names(&list)
            .iter()
            .map(|s| s.to_lowercase())
            .collect::<Vec<_>>();
        let original = sorted.clone();
        sorted.sort();
        assert_eq!(original, sorted);
        sorted.dedup();
        assert_eq!(sorted.len(), list.len());
    }
}
