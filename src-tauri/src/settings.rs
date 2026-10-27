//! アプリ設定（フォント・スクロールバック・起動時に開くターミナルなど）。
//!
//! 値の検証はここが正とする。フロントエンドの入力フォームも同じ範囲で検証するが、
//! 保存ファイルの手編集や古い版との差異に備え、読み込み・保存の両方で検証する。

use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const DEFAULT_FONT_FAMILY: &str = r#"Menlo, Monaco, "Courier New", monospace"#;
pub const FONT_SIZE_RANGE: std::ops::RangeInclusive<u16> = 8..=72;
pub const MAX_SCROLLBACK: u32 = 100_000;
pub const MAX_FONT_FAMILY_CHARS: usize = 200;
pub const MAX_PROFILE_ID_CHARS: usize = 100;

#[derive(Debug, Error)]
pub enum SettingsError {
    #[error("設定が不正です: {0}")]
    Invalid(String),
    #[error("設定ファイルを操作できません ({context}): {source}")]
    Io {
        context: String,
        #[source]
        source: std::io::Error,
    },
    #[error("設定ファイル {path} を解析できません: {source}")]
    Parse {
        path: String,
        #[source]
        source: serde_json::Error,
    },
}

/// 起動時に開くターミナル。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Startup {
    /// 何も開かない。
    #[default]
    None,
    /// ローカルシェルを開く。
    Local,
    /// 保存済みの接続を開く。
    Profile { profile_id: String },
}

/// ターミナルの配色テーマ。色の定義はフロントエンド側にある。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum Theme {
    #[default]
    Dark,
    Light,
    SolarizedDark,
    SolarizedLight,
    Dracula,
    Monokai,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub font_family: String,
    pub font_size: u16,
    pub scrollback: u32,
    pub cursor_blink: bool,
    pub theme: Theme,
    pub startup: Startup,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            font_family: DEFAULT_FONT_FAMILY.into(),
            font_size: 13,
            scrollback: 10_000,
            cursor_blink: true,
            theme: Theme::default(),
            startup: Startup::None,
        }
    }
}

impl Settings {
    /// 検証し、正規化（前後の空白除去）した値を返す。
    pub fn validated(mut self) -> Result<Self, SettingsError> {
        let family = self.font_family.trim();
        if family.is_empty() {
            return Err(SettingsError::Invalid("フォントを指定してください".into()));
        }
        if family.chars().count() > MAX_FONT_FAMILY_CHARS {
            return Err(SettingsError::Invalid(format!(
                "フォント指定は{MAX_FONT_FAMILY_CHARS}文字以内にしてください"
            )));
        }
        // CSS の font-family にそのまま使われるため、宣言を区切る・壊す文字は受け付けない。
        if family
            .chars()
            .any(|c| c.is_control() || matches!(c, ';' | '{' | '}' | '<' | '>' | '\\'))
        {
            return Err(SettingsError::Invalid(
                "フォント指定に使えない文字が含まれています".into(),
            ));
        }
        self.font_family = family.to_owned();
        if !FONT_SIZE_RANGE.contains(&self.font_size) {
            return Err(SettingsError::Invalid(format!(
                "フォントサイズは{}〜{}で指定してください",
                FONT_SIZE_RANGE.start(),
                FONT_SIZE_RANGE.end()
            )));
        }
        if self.scrollback > MAX_SCROLLBACK {
            return Err(SettingsError::Invalid(format!(
                "スクロールバックは{MAX_SCROLLBACK}行以内にしてください"
            )));
        }
        if let Startup::Profile { profile_id } = &self.startup {
            let id = profile_id.trim();
            if id.is_empty() || id.chars().count() > MAX_PROFILE_ID_CHARS {
                return Err(SettingsError::Invalid(
                    "起動時に開く保存済みの接続が不正です".into(),
                ));
            }
        }
        Ok(self)
    }
}

#[derive(Debug)]
pub struct SettingsStore {
    path: PathBuf,
    lock: Mutex<()>,
    counter: AtomicU64,
}

impl SettingsStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            lock: Mutex::new(()),
            counter: AtomicU64::new(0),
        }
    }

    /// 保存済みの設定。ファイルがなければ既定値。壊れていればエラー。
    pub fn load(&self) -> Result<Settings, SettingsError> {
        let _guard = self.guard();
        match std::fs::read_to_string(&self.path) {
            Ok(text) => serde_json::from_str::<Settings>(&text)
                .map_err(|source| SettingsError::Parse {
                    path: self.path.display().to_string(),
                    source,
                })?
                .validated(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
            Err(e) => Err(SettingsError::Io {
                context: format!("{} の読み込み", self.path.display()),
                source: e,
            }),
        }
    }

    /// 検証して保存し、保存した（正規化済みの）値を返す。
    pub fn save(&self, settings: Settings) -> Result<Settings, SettingsError> {
        let settings = settings.validated()?;
        let text = serde_json::to_string_pretty(&settings).map_err(|e| SettingsError::Io {
            context: "シリアライズ".into(),
            source: std::io::Error::other(e),
        })?;
        let _guard = self.guard();
        let unique = self.counter.fetch_add(1, Ordering::Relaxed);
        crate::atomic_file::write_private(&self.path, text.as_bytes(), unique).map_err(|e| {
            SettingsError::Io {
                context: format!("{} の書き込み", self.path.display()),
                source: e,
            }
        })?;
        Ok(settings)
    }

    // ロックの毒化は保護対象のデータを持たないため無視してよい。
    fn guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use serde_json::json;

    use super::*;

    fn store(name: &str) -> (SettingsStore, PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("linkterm-set-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("sub").join("settings.json");
        (SettingsStore::new(&path), path, dir)
    }

    #[test]
    fn defaults_are_sensible() {
        let d = Settings::default();
        assert!(d.font_family.contains("monospace"));
        assert_eq!(d.font_size, 13);
        assert_eq!(d.scrollback, 10_000);
        assert!(d.cursor_blink);
        assert_eq!(d.startup, Startup::None);
        assert!(d.clone().validated().is_ok());
    }

    #[test]
    fn missing_file_loads_defaults() {
        let (s, _, dir) = store("missing");
        assert_eq!(s.load().unwrap(), Settings::default());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn save_then_load_roundtrips_with_private_permissions() {
        let (s, path, dir) = store("roundtrip");
        let custom = Settings {
            font_family: "Osaka-Mono, monospace".into(),
            font_size: 16,
            scrollback: 50_000,
            cursor_blink: false,
            theme: Theme::Monokai,
            startup: Startup::Profile {
                profile_id: "profile-1".into(),
            },
        };
        assert_eq!(s.save(custom.clone()).unwrap(), custom);
        assert_eq!(SettingsStore::new(&path).load().unwrap(), custom);
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn partial_file_fills_missing_fields_with_defaults() {
        let (s, path, dir) = store("partial");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, r#"{"fontSize": 20}"#).unwrap();
        let loaded = s.load().unwrap();
        assert_eq!(loaded.font_size, 20);
        assert_eq!(loaded.scrollback, Settings::default().scrollback);
        assert_eq!(loaded.startup, Startup::None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn corrupt_or_invalid_file_is_an_error_and_is_not_overwritten() {
        let (s, path, dir) = store("corrupt");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{ nope").unwrap();
        assert!(matches!(s.load(), Err(SettingsError::Parse { .. })));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ nope");
        // 範囲外の値も、手編集で入り込んだら読み込み時に弾く。
        std::fs::write(&path, r#"{"fontSize": 9999}"#).unwrap();
        assert!(matches!(s.load(), Err(SettingsError::Invalid(_))));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn font_size_is_range_checked() {
        for ok in [8, 13, 72] {
            let s = Settings {
                font_size: ok,
                ..Default::default()
            };
            assert!(s.validated().is_ok(), "{ok}");
        }
        for bad in [0, 7, 73, 1000] {
            let s = Settings {
                font_size: bad,
                ..Default::default()
            };
            assert!(
                matches!(s.validated(), Err(SettingsError::Invalid(_))),
                "{bad}"
            );
        }
    }

    #[test]
    fn scrollback_is_range_checked() {
        assert!(
            Settings {
                scrollback: 0,
                ..Default::default()
            }
            .validated()
            .is_ok()
        );
        assert!(
            Settings {
                scrollback: MAX_SCROLLBACK,
                ..Default::default()
            }
            .validated()
            .is_ok()
        );
        assert!(
            Settings {
                scrollback: MAX_SCROLLBACK + 1,
                ..Default::default()
            }
            .validated()
            .is_err()
        );
    }

    #[test]
    fn font_family_is_validated_and_trimmed() {
        let s = Settings {
            font_family: "  SF Mono, Menlo  ".into(),
            ..Default::default()
        };
        assert_eq!(s.validated().unwrap().font_family, "SF Mono, Menlo");
        for bad in [
            "".to_string(),
            "   ".to_string(),
            "a".repeat(MAX_FONT_FAMILY_CHARS + 1),
            "Menlo; color: red".to_string(),
            "Menlo}\n body {".to_string(),
            "Menlo\u{0}".to_string(),
            "<script>".to_string(),
        ] {
            let s = Settings {
                font_family: bad.clone(),
                ..Default::default()
            };
            assert!(
                matches!(s.validated(), Err(SettingsError::Invalid(_))),
                "{bad:?}"
            );
        }
        // 日本語のフォント名・引用符つきの指定は許可する。
        for ok in [
            "ヒラギノ角ゴ ProN, monospace",
            r#""Courier New", monospace"#,
            "Osaka-Mono",
        ] {
            let s = Settings {
                font_family: ok.into(),
                ..Default::default()
            };
            assert!(s.validated().is_ok(), "{ok}");
        }
    }

    #[test]
    fn startup_profile_id_must_not_be_blank_or_huge() {
        let blank = Settings {
            startup: Startup::Profile {
                profile_id: "  ".into(),
            },
            ..Default::default()
        };
        assert!(blank.validated().is_err());
        let huge = Settings {
            startup: Startup::Profile {
                profile_id: "x".repeat(MAX_PROFILE_ID_CHARS + 1),
            },
            ..Default::default()
        };
        assert!(huge.validated().is_err());
    }

    #[test]
    fn invalid_settings_are_not_saved() {
        let (s, path, dir) = store("invalid-save");
        let bad = Settings {
            font_size: 1,
            ..Default::default()
        };
        assert!(s.save(bad).is_err());
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn json_shape_matches_the_frontend_contract() {
        let v = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(v["fontSize"], 13);
        assert_eq!(v["cursorBlink"], true);
        assert_eq!(v["startup"], json!({"kind": "none"}));
        let p = serde_json::to_value(Startup::Profile {
            profile_id: "p".into(),
        })
        .unwrap();
        assert_eq!(p, json!({"kind": "profile", "profileId": "p"}));
        let back: Startup = serde_json::from_value(json!({"kind": "local"})).unwrap();
        assert_eq!(back, Startup::Local);
    }

    #[test]
    fn concurrent_saves_leave_a_valid_file() {
        let (s, path, dir) = store("concurrent");
        let s = std::sync::Arc::new(s);
        let handles: Vec<_> = (0..16u16)
            .map(|i| {
                let s = s.clone();
                std::thread::spawn(move || {
                    s.save(Settings {
                        font_size: 8 + i,
                        ..Default::default()
                    })
                    .unwrap();
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        assert!(FONT_SIZE_RANGE.contains(&s.load().unwrap().font_size));
        let names: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["settings.json".to_string()]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn theme_defaults_to_dark_and_roundtrips_in_kebab_case() {
        assert_eq!(Settings::default().theme, Theme::Dark);
        let v = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(v["theme"], "dark");
        for (theme, name) in [
            (Theme::Light, "light"),
            (Theme::SolarizedDark, "solarized-dark"),
            (Theme::SolarizedLight, "solarized-light"),
            (Theme::Dracula, "dracula"),
            (Theme::Monokai, "monokai"),
        ] {
            assert_eq!(serde_json::to_value(theme).unwrap(), json!(name));
            let back: Theme = serde_json::from_value(json!(name)).unwrap();
            assert_eq!(back, theme);
        }
    }

    #[test]
    fn theme_is_saved_and_loaded() {
        let (s, path, dir) = store("theme");
        let saved = s
            .save(Settings {
                theme: Theme::Dracula,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(saved.theme, Theme::Dracula);
        assert_eq!(
            SettingsStore::new(&path).load().unwrap().theme,
            Theme::Dracula
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn file_without_a_theme_uses_the_default_and_unknown_themes_are_rejected() {
        let (s, path, dir) = store("theme-file");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, r#"{"fontSize": 14}"#).unwrap();
        assert_eq!(s.load().unwrap().theme, Theme::Dark);
        std::fs::write(&path, r#"{"theme": "neon-pink"}"#).unwrap();
        assert!(matches!(s.load(), Err(SettingsError::Parse { .. })));
        let _ = std::fs::remove_dir_all(dir);
    }
}
