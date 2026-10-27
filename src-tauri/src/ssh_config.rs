//! `~/.ssh/config` の読み込み。ホスト名の別名（`Host`）から、実際の接続先・ユーザー・ポート・
//! 鍵・踏み台（`ProxyJump`）を解決する。
//!
//! 対応するのは `Host` / `HostName` / `User` / `Port` / `IdentityFile` / `ProxyJump` と、
//! `Host` 行のワイルドカード（`*` `?`）・否定（`!`）。`Match` と `Include` は対応しない（読み飛ばす）。
//! OpenSSH と同じく、同じ項目は先に見つかった値を優先し、`IdentityFile` は全部を集める。

use std::path::{Path, PathBuf};

use thiserror::Error;

/// 読み込む設定ファイルの大きさの上限（異常に大きなファイルでメモリを使い切らないため）。
pub const MAX_CONFIG_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Error)]
pub enum SshConfigError {
    #[error("SSH設定ファイル {path} を読み込めません: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("SSH設定ファイル {path} が大きすぎます（上限 {limit} バイト）")]
    TooLarge { path: String, limit: u64 },
    #[error("踏み台の指定が不正です: {0}")]
    InvalidJump(String),
    #[error("接続先が不正です: {0}")]
    InvalidTarget(String),
}

/// 踏み台（ProxyJump）の1段分。`[user@]host[:port]`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JumpSpec {
    pub user: Option<String>,
    pub host: String,
    pub port: Option<u16>,
}

/// `ProxyJump` の値（カンマ区切り）を解析する。`none` は空。
pub fn parse_jump_list(spec: &str) -> Result<Vec<JumpSpec>, SshConfigError> {
    let spec = spec.trim();
    if spec.is_empty() || spec.eq_ignore_ascii_case("none") {
        return Ok(Vec::new());
    }
    spec.split(',')
        .map(|part| parse_jump(part.trim()))
        .collect()
}

fn parse_jump(part: &str) -> Result<JumpSpec, SshConfigError> {
    let invalid = || SshConfigError::InvalidJump(part.to_owned());
    if part.is_empty() || part.chars().any(char::is_whitespace) {
        return Err(invalid());
    }
    let (user, rest) = match part.split_once('@') {
        Some((user, rest)) if !user.is_empty() => (Some(user.to_owned()), rest),
        Some(_) => return Err(invalid()),
        None => (None, part),
    };
    let (host, port) = if let Some(bracketed) = rest.strip_prefix('[') {
        // IPv6: `[::1]` または `[::1]:22`
        let (host, after) = bracketed.split_once(']').ok_or_else(invalid)?;
        let port = match after {
            "" => None,
            after => Some(after.strip_prefix(':').ok_or_else(invalid)?),
        };
        (host, port)
    } else {
        match rest.split_once(':') {
            Some((_, port)) if port.contains(':') => return Err(invalid()),
            Some((host, port)) => (host, Some(port)),
            None => (rest, None),
        }
    };
    if host.is_empty() {
        return Err(invalid());
    }
    let port = match port {
        None => None,
        Some(p) => Some(parse_port(p).ok_or_else(invalid)?),
    };
    Ok(JumpSpec {
        user,
        host: host.to_owned(),
        port,
    })
}

fn parse_port(text: &str) -> Option<u16> {
    text.parse::<u16>().ok().filter(|&p| p != 0)
}

/// 別名を解決した結果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedHost {
    /// 実際に接続するホスト名（`HostName`。なければ別名そのもの）。
    pub hostname: String,
    pub user: Option<String>,
    pub port: Option<u16>,
    /// 試す秘密鍵（`~` は展開済み）。設定の順。
    pub identity_files: Vec<PathBuf>,
    pub proxy_jump: Vec<JumpSpec>,
}

/// 設定の1区画（`Host` 行から次の `Host` 行まで）。先頭のグローバル設定は全ホストに適用する。
#[derive(Debug, Default)]
struct Block {
    /// `None` はグローバル（全ホスト）。
    patterns: Option<Vec<String>>,
    options: Vec<(Keyword, String)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Keyword {
    HostName,
    User,
    Port,
    IdentityFile,
    ProxyJump,
}

#[derive(Debug, Default)]
pub struct SshConfig {
    blocks: Vec<Block>,
    home: Option<PathBuf>,
}

/// 行を、キーワードと引数（引用符・コメントを処理済み）に分ける。
fn split_line(line: &str) -> Option<(String, Vec<String>)> {
    let line = line.trim_start_matches('\u{feff}').trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let key_end = line
        .find(|c: char| c.is_whitespace() || c == '=')
        .unwrap_or(line.len());
    let keyword = line[..key_end].to_ascii_lowercase();
    if keyword.is_empty() {
        return None;
    }
    let rest = line[key_end..]
        .trim_start_matches(|c: char| c.is_whitespace())
        .trim_start_matches('=');
    Some((keyword, tokenize(rest.trim_start())))
}

/// 空白区切りで分け、`"..."` の中の空白を保つ。引用符の外の `#` 以降はコメント。
fn tokenize(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_token = false;
    let mut quoted = false;
    for c in text.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                in_token = true;
            }
            '#' if !quoted && !in_token => break,
            c if c.is_whitespace() && !quoted => {
                if in_token {
                    tokens.push(std::mem::take(&mut current));
                    in_token = false;
                }
            }
            c => {
                current.push(c);
                in_token = true;
            }
        }
    }
    if in_token {
        tokens.push(current);
    }
    tokens
}

/// `*` と `?` だけを使うワイルドカード照合（大文字小文字は区別しない）。
fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let t: Vec<char> = text.to_lowercase().chars().collect();
    let (mut pi, mut ti) = (0, 0);
    let (mut star, mut mark) = (None, 0);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// `Host` 行のパターン一覧が `host` に当てはまるか。否定（`!`）に当たれば全体が不一致。
fn patterns_match(patterns: &[String], host: &str) -> bool {
    let mut matched = false;
    for pattern in patterns {
        match pattern.strip_prefix('!') {
            Some(negated) => {
                if glob_match(negated, host) {
                    return false;
                }
            }
            None => matched |= glob_match(pattern, host),
        }
    }
    matched
}

impl SshConfig {
    /// 設定ファイルの内容を解析する。解釈できない行は読み飛ばす。`home` は `~` の展開に使う。
    pub fn parse(text: &str, home: Option<&Path>) -> Self {
        let mut blocks = vec![Block::default()];
        // `Match` 区画の設定は対応しないので、次の `Host` まで読み飛ばす。
        let mut skipping = false;
        for line in text.lines() {
            let Some((keyword, args)) = split_line(line) else {
                continue;
            };
            match keyword.as_str() {
                "host" => {
                    skipping = false;
                    blocks.push(Block {
                        patterns: Some(args),
                        options: Vec::new(),
                    });
                }
                "match" => skipping = true,
                _ if skipping => {}
                key => {
                    let keyword = match key {
                        "hostname" => Keyword::HostName,
                        "user" => Keyword::User,
                        "port" => Keyword::Port,
                        "identityfile" => Keyword::IdentityFile,
                        "proxyjump" => Keyword::ProxyJump,
                        _ => continue,
                    };
                    if let Some(value) = args.first() {
                        // ProxyJump だけは、カンマ区切りの途中に空白がない1つの値として扱う。
                        let value = if keyword == Keyword::ProxyJump {
                            args.join("")
                        } else {
                            value.clone()
                        };
                        if let Some(block) = blocks.last_mut() {
                            block.options.push((keyword, value));
                        }
                    }
                }
            }
        }
        Self {
            blocks,
            home: home.map(Path::to_path_buf),
        }
    }

    /// ファイルから読み込む。ファイルがなければ空の設定。
    pub fn load(path: &Path, home: Option<&Path>) -> Result<Self, SshConfigError> {
        let io = |source| SshConfigError::Io {
            path: path.display().to_string(),
            source,
        };
        let metadata = match std::fs::metadata(path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(e) => return Err(io(e)),
        };
        if metadata.len() > MAX_CONFIG_BYTES {
            return Err(SshConfigError::TooLarge {
                path: path.display().to_string(),
                limit: MAX_CONFIG_BYTES,
            });
        }
        let bytes = std::fs::read(path).map_err(io)?;
        Ok(Self::parse(&String::from_utf8_lossy(&bytes), home))
    }

    fn expand_path(&self, value: &str) -> PathBuf {
        expand_tilde(value, self.home.as_deref())
    }

    /// `host`（別名）を解決する。
    pub fn resolve(&self, host: &str) -> ResolvedHost {
        let mut hostname: Option<String> = None;
        let mut user: Option<String> = None;
        let mut port: Option<u16> = None;
        let mut proxy_jump: Option<Vec<JumpSpec>> = None;
        let mut identity_files = Vec::new();
        for block in &self.blocks {
            let applies = block
                .patterns
                .as_ref()
                .is_none_or(|patterns| patterns_match(patterns, host));
            if !applies {
                continue;
            }
            for (keyword, value) in &block.options {
                match keyword {
                    Keyword::HostName => {
                        hostname
                            .get_or_insert_with(|| value.replace("%h", host).replace("%%", "%"));
                    }
                    Keyword::User => {
                        user.get_or_insert_with(|| value.clone());
                    }
                    Keyword::Port => {
                        if port.is_none() {
                            port = parse_port(value);
                        }
                    }
                    Keyword::IdentityFile => identity_files.push(self.expand_path(value)),
                    Keyword::ProxyJump => {
                        if proxy_jump.is_none() {
                            proxy_jump = parse_jump_list(value).ok();
                        }
                    }
                }
            }
        }
        ResolvedHost {
            hostname: hostname.unwrap_or_else(|| host.to_owned()),
            user,
            port,
            identity_files,
            proxy_jump: proxy_jump.unwrap_or_default(),
        }
    }

    /// 具体的な別名（ワイルドカード・否定を含まない `Host`）の一覧。ファイル順、重複なし。
    pub fn host_aliases(&self) -> Vec<String> {
        let mut aliases: Vec<String> = Vec::new();
        for pattern in self
            .blocks
            .iter()
            .filter_map(|b| b.patterns.as_ref())
            .flatten()
        {
            let concrete = !pattern.is_empty()
                && !pattern.contains(['*', '?', '!'])
                && !aliases.contains(pattern);
            if concrete {
                aliases.push(pattern.clone());
            }
        }
        aliases
    }
}

/// 接続ダイアログで指定された接続先。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestedTarget {
    /// 入力されたホスト名。`~/.ssh/config` の別名でもよい。
    pub host: String,
    /// 入力されたポート。ダイアログの既定値（22）のときは、設定ファイルの `Port` を優先する。
    pub port: u16,
    /// 空なら、設定ファイルの `User` を使う。
    pub username: String,
    /// ダイアログで指定された踏み台（`ProxyJump` の書式）。空なら、設定ファイルの値を使う。
    pub jump_hosts: String,
}

/// 実際に接続する先。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectiveTarget {
    pub hostname: String,
    pub port: u16,
    pub username: String,
    /// 設定ファイルの `IdentityFile`（鍵のパスが未指定のときの候補）。
    pub identity_files: Vec<PathBuf>,
    /// 経由する踏み台。先頭から順に接続する。
    pub jumps: Vec<JumpSpec>,
}

/// ダイアログの指定と設定ファイルから、実際の接続先を決める。
///
/// 優先順位: ダイアログで明示した値 > `~/.ssh/config`。ユーザー名が決まらなければエラー。
pub fn resolve_target(
    config: &SshConfig,
    request: &RequestedTarget,
) -> Result<EffectiveTarget, SshConfigError> {
    let host = request.host.trim();
    if host.is_empty() || host.chars().any(char::is_whitespace) {
        return Err(SshConfigError::InvalidTarget(
            "ホスト名を指定してください".into(),
        ));
    }
    let resolved = config.resolve(host);

    let typed_user = request.username.trim();
    let username = if typed_user.is_empty() {
        resolved.user.clone().ok_or_else(|| {
            SshConfigError::InvalidTarget(format!(
                "{host} のユーザー名が指定されていません（~/.ssh/config にも User がありません）"
            ))
        })?
    } else {
        typed_user.to_owned()
    };

    // ダイアログの既定値（22）のままなら、設定ファイルの Port を使う。
    let port = if request.port == DEFAULT_SSH_PORT {
        resolved.port.unwrap_or(DEFAULT_SSH_PORT)
    } else {
        request.port
    };

    // ダイアログで踏み台を指定していれば、それを優先する（`none` で設定ファイルの踏み台を無効にできる）。
    let jumps = if request.jump_hosts.trim().is_empty() {
        resolved.proxy_jump
    } else {
        parse_jump_list(&request.jump_hosts)?
    };

    Ok(EffectiveTarget {
        hostname: resolved.hostname,
        port,
        username,
        identity_files: resolved.identity_files,
        jumps,
    })
}

pub const DEFAULT_SSH_PORT: u16 = 22;

/// 踏み台の指定（`[user@]host[:port]`）を、接続に使う踏み台へ解決する。
///
/// ホスト名は設定ファイルの別名として解決する。ユーザー名・ポートは、指定 > 設定ファイル の順。
/// どちらにもユーザー名がなければ `default_user`（目的のホストのユーザー名）を使う。
pub fn build_jump_hosts(
    config: &SshConfig,
    specs: &[JumpSpec],
    default_user: &str,
) -> Vec<crate::session::JumpHost> {
    specs
        .iter()
        .map(|spec| {
            let resolved = config.resolve(&spec.host);
            crate::session::JumpHost {
                host: resolved.hostname,
                port: spec.port.or(resolved.port).unwrap_or(DEFAULT_SSH_PORT),
                username: spec
                    .user
                    .clone()
                    .or(resolved.user)
                    .unwrap_or_else(|| default_user.to_owned()),
                identity_files: resolved.identity_files,
            }
        })
        .collect()
}

/// 鍵のパスを決める。指定があればそれ（`~` は展開）、空なら設定ファイルの `IdentityFile` のうち
/// 最初に存在するもの。
pub fn pick_identity_file(
    typed: &Path,
    candidates: &[PathBuf],
    home: Option<&Path>,
) -> Result<PathBuf, SshConfigError> {
    let typed_text = typed.to_string_lossy();
    let typed_text = typed_text.trim();
    if !typed_text.is_empty() {
        return Ok(expand_tilde(typed_text, home));
    }
    candidates
        .iter()
        .find(|p| p.exists())
        .cloned()
        .ok_or_else(|| {
            SshConfigError::InvalidTarget(
                "秘密鍵のパスが指定されておらず、~/.ssh/config の IdentityFile にも使える鍵がありません"
                    .into(),
            )
        })
}

/// `~/` で始まるパスをホームディレクトリへ展開する。ホームが不明ならそのまま。
fn expand_tilde(value: &str, home: Option<&Path>) -> PathBuf {
    match (home, value.strip_prefix("~/"), value) {
        (Some(home), Some(rest), _) => home.join(rest),
        (Some(home), None, "~") => home.to_path_buf(),
        _ => PathBuf::from(value),
    }
}

/// 設定ファイルの既定の場所（`~/.ssh/config`）。
pub fn default_config_path(home: &Path) -> PathBuf {
    home.join(".ssh").join("config")
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOME: &str = "/Users/alice";

    fn cfg(text: &str) -> SshConfig {
        SshConfig::parse(text, Some(Path::new(HOME)))
    }

    #[test]
    fn resolves_hostname_user_port_and_identity() {
        let c = cfg(
            "Host prod\n  HostName prod.example.com\n  User deploy\n  Port 2222\n  IdentityFile ~/.ssh/prod_key\n",
        );
        let r = c.resolve("prod");
        assert_eq!(r.hostname, "prod.example.com");
        assert_eq!(r.user.as_deref(), Some("deploy"));
        assert_eq!(r.port, Some(2222));
        assert_eq!(
            r.identity_files,
            vec![PathBuf::from("/Users/alice/.ssh/prod_key")]
        );
        assert!(r.proxy_jump.is_empty());
    }

    #[test]
    fn unknown_hosts_resolve_to_themselves_with_no_options() {
        let r = cfg("Host prod\n  User deploy\n").resolve("other");
        assert_eq!(
            r,
            ResolvedHost {
                hostname: "other".into(),
                user: None,
                port: None,
                identity_files: vec![],
                proxy_jump: vec![],
            }
        );
    }

    #[test]
    fn keywords_are_case_insensitive_and_accept_equals_and_tabs() {
        let c = cfg("host\tweb\n\thostname=web.example.com\n  USER = bob\n  port=2200\n");
        let r = c.resolve("web");
        assert_eq!(r.hostname, "web.example.com");
        assert_eq!(r.user.as_deref(), Some("bob"));
        assert_eq!(r.port, Some(2200));
    }

    #[test]
    fn comments_blank_lines_and_crlf_are_ignored() {
        let c = cfg(
            "# comment\r\n\r\nHost a # trailing comment\r\n  HostName a.example.com # more\r\n",
        );
        assert_eq!(c.resolve("a").hostname, "a.example.com");
    }

    #[test]
    fn quoted_values_may_contain_spaces() {
        let c = cfg("Host q\n  IdentityFile \"/path with space/key\"\n  User \"bob\"\n");
        let r = c.resolve("q");
        assert_eq!(
            r.identity_files,
            vec![PathBuf::from("/path with space/key")]
        );
        assert_eq!(r.user.as_deref(), Some("bob"));
    }

    #[test]
    fn first_value_wins_across_matching_blocks_and_global_options_apply_to_all() {
        let c = cfg(
            "User globaluser\n\nHost web\n  User webuser\n  Port 2200\n\nHost *\n  User wildcard\n  Port 22\n  HostName never-used\n",
        );
        // 先頭（Host の前）のグローバル設定が最優先。
        assert_eq!(c.resolve("web").user.as_deref(), Some("globaluser"));
        assert_eq!(c.resolve("web").port, Some(2200));
        // HostName は最初に見つかった（ワイルドカードの）値が使われる。
        assert_eq!(c.resolve("web").hostname, "never-used");
    }

    #[test]
    fn specific_block_before_wildcard_wins() {
        let c = cfg("Host web\n  User webuser\nHost *\n  User wildcard\n  Port 2022\n");
        let r = c.resolve("web");
        assert_eq!(r.user.as_deref(), Some("webuser"));
        assert_eq!(r.port, Some(2022));
        assert_eq!(c.resolve("other").user.as_deref(), Some("wildcard"));
    }

    #[test]
    fn identity_files_accumulate_in_order() {
        let c = cfg(
            "Host a\n  IdentityFile ~/.ssh/one\nHost *\n  IdentityFile ~/.ssh/two\n  IdentityFile /abs/three\n",
        );
        assert_eq!(
            c.resolve("a").identity_files,
            vec![
                PathBuf::from("/Users/alice/.ssh/one"),
                PathBuf::from("/Users/alice/.ssh/two"),
                PathBuf::from("/abs/three"),
            ]
        );
    }

    #[test]
    fn patterns_support_wildcards_lists_and_negation() {
        let c = cfg(
            "Host *.example.com !internal.example.com\n  User corp\nHost web-?? db-*\n  Port 2200\nHost a b c\n  User multi\n",
        );
        assert_eq!(c.resolve("www.example.com").user.as_deref(), Some("corp"));
        assert_eq!(c.resolve("internal.example.com").user, None);
        assert_eq!(c.resolve("web-01").port, Some(2200));
        assert_eq!(c.resolve("web-1").port, None);
        assert_eq!(c.resolve("db-primary").port, Some(2200));
        for h in ["a", "b", "c"] {
            assert_eq!(c.resolve(h).user.as_deref(), Some("multi"));
        }
        assert_eq!(c.resolve("d").user, None);
    }

    #[test]
    fn host_matching_is_case_insensitive() {
        let c = cfg("Host Prod\n  User u\n");
        assert_eq!(c.resolve("prod").user.as_deref(), Some("u"));
        assert_eq!(c.resolve("PROD").user.as_deref(), Some("u"));
    }

    #[test]
    fn hostname_percent_h_expands_to_the_alias() {
        let c = cfg("Host web\n  HostName %h.internal.example.com\n");
        assert_eq!(c.resolve("web").hostname, "web.internal.example.com");
    }

    #[test]
    fn proxy_jump_is_parsed_and_none_disables_it() {
        let c = cfg(
            "Host inner\n  ProxyJump alice@bastion:2222,gate\nHost direct\n  ProxyJump none\nHost *\n  ProxyJump default-gw\n",
        );
        assert_eq!(
            c.resolve("inner").proxy_jump,
            vec![
                JumpSpec {
                    user: Some("alice".into()),
                    host: "bastion".into(),
                    port: Some(2222)
                },
                JumpSpec {
                    user: None,
                    host: "gate".into(),
                    port: None
                },
            ]
        );
        assert!(c.resolve("direct").proxy_jump.is_empty());
        assert_eq!(c.resolve("other").proxy_jump[0].host, "default-gw");
    }

    #[test]
    fn invalid_values_are_skipped_not_fatal() {
        let c =
            cfg("Host a\n  Port notanumber\n  Port 99999\n  Port 22\n  ProxyJump :::\n  User ok\n");
        let r = c.resolve("a");
        // 不正なポートは無視され、次の有効な値が使われる。
        assert_eq!(r.port, Some(22));
        assert_eq!(r.user.as_deref(), Some("ok"));
        assert!(r.proxy_jump.is_empty());
    }

    #[test]
    fn match_and_include_are_ignored_without_breaking_following_blocks() {
        let c = cfg("Include ~/.ssh/other\nMatch host foo\n  User matched\nHost a\n  User real\n");
        assert_eq!(c.resolve("a").user.as_deref(), Some("real"));
        assert_eq!(c.resolve("foo").user, None);
    }

    #[test]
    fn garbage_lines_do_not_panic() {
        let c = cfg("\u{0}\u{1}\n=\n Host\nHost\n  \nHostName\nUser\n\"\"\"\n");
        let _ = c.resolve("x");
        let _ = c.host_aliases();
    }

    #[test]
    fn host_aliases_lists_concrete_names_only_in_order_without_duplicates() {
        let c = cfg(
            "Host prod staging\nHost *.example.com\nHost !skip dev\nHost prod\nHost web-??\nHost *\n",
        );
        assert_eq!(c.host_aliases(), vec!["prod", "staging", "dev"]);
    }

    #[test]
    fn tilde_is_left_alone_when_home_is_unknown() {
        let c = SshConfig::parse("Host a\n  IdentityFile ~/.ssh/k\n", None);
        assert_eq!(
            c.resolve("a").identity_files,
            vec![PathBuf::from("~/.ssh/k")]
        );
    }

    #[test]
    fn jump_list_parsing() {
        assert_eq!(parse_jump_list("none").unwrap(), vec![]);
        assert_eq!(parse_jump_list("").unwrap(), vec![]);
        assert_eq!(
            parse_jump_list("a@h1:22, h2 ,u@[::1]:2200").unwrap(),
            vec![
                JumpSpec {
                    user: Some("a".into()),
                    host: "h1".into(),
                    port: Some(22)
                },
                JumpSpec {
                    user: None,
                    host: "h2".into(),
                    port: None
                },
                JumpSpec {
                    user: Some("u".into()),
                    host: "::1".into(),
                    port: Some(2200)
                },
            ]
        );
        for bad in ["@h", "h:", "h:99999", "h:abc", "a@", ",", "h1,,h2", "a b"] {
            assert!(
                matches!(parse_jump_list(bad), Err(SshConfigError::InvalidJump(_))),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn load_returns_empty_config_when_file_is_missing() {
        let c = SshConfig::load(Path::new("/nonexistent/ssh/config"), None).unwrap();
        assert!(c.host_aliases().is_empty());
    }

    #[test]
    fn load_reads_a_file_and_rejects_oversized_ones() {
        let dir = std::env::temp_dir().join(format!("linkterm-sshcfg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config");
        std::fs::write(&path, "Host a\n  User u\n").unwrap();
        assert_eq!(
            SshConfig::load(&path, None)
                .unwrap()
                .resolve("a")
                .user
                .as_deref(),
            Some("u")
        );
        let big = dir.join("big");
        std::fs::write(&big, vec![b'#'; (MAX_CONFIG_BYTES + 1) as usize]).unwrap();
        assert!(matches!(
            SshConfig::load(&big, None),
            Err(SshConfigError::TooLarge { .. })
        ));
        let _ = std::fs::remove_dir_all(dir);
    }

    fn request(host: &str, port: u16, username: &str, jumps: &str) -> RequestedTarget {
        RequestedTarget {
            host: host.into(),
            port,
            username: username.into(),
            jump_hosts: jumps.into(),
        }
    }

    #[test]
    fn alias_supplies_hostname_user_port_identity_and_jump() {
        let c = cfg(
            "Host prod\n  HostName prod.example.com\n  User deploy\n  Port 2222\n  IdentityFile ~/.ssh/prod\n  ProxyJump bastion\n",
        );
        let t = resolve_target(&c, &request("prod", 22, "", "")).unwrap();
        assert_eq!(t.hostname, "prod.example.com");
        assert_eq!(t.port, 2222);
        assert_eq!(t.username, "deploy");
        assert_eq!(
            t.identity_files,
            vec![PathBuf::from("/Users/alice/.ssh/prod")]
        );
        assert_eq!(
            t.jumps,
            vec![JumpSpec {
                user: None,
                host: "bastion".into(),
                port: None
            }]
        );
    }

    #[test]
    fn values_typed_in_the_dialog_win_over_the_config() {
        let c = cfg(
            "Host prod\n  HostName prod.example.com\n  User deploy\n  Port 2222\n  ProxyJump bastion\n",
        );
        let t = resolve_target(&c, &request("prod", 2200, "bob", "gate:2022")).unwrap();
        assert_eq!(t.username, "bob");
        assert_eq!(t.port, 2200);
        assert_eq!(
            t.jumps,
            vec![JumpSpec {
                user: None,
                host: "gate".into(),
                port: Some(2022)
            }]
        );
        // HostName は別名の解決なので、ダイアログで別名を入力した場合は設定ファイルが使われる。
        assert_eq!(t.hostname, "prod.example.com");
    }

    #[test]
    fn port_defaults_to_22_when_neither_specifies_one() {
        let t = resolve_target(&cfg(""), &request("host.example.com", 22, "u", "")).unwrap();
        assert_eq!(t.port, 22);
        assert_eq!(t.hostname, "host.example.com");
    }

    #[test]
    fn explicit_jump_none_disables_the_configured_jump() {
        let c = cfg("Host *\n  ProxyJump bastion\n");
        let t = resolve_target(&c, &request("h", 22, "u", "none")).unwrap();
        assert!(t.jumps.is_empty());
    }

    #[test]
    fn missing_username_is_an_error_that_mentions_the_config() {
        let err = resolve_target(
            &cfg("Host a\n  HostName a.example.com\n"),
            &request("a", 22, "  ", ""),
        )
        .unwrap_err();
        assert!(err.to_string().contains("ユーザー名"), "{err}");
        assert!(err.to_string().contains("~/.ssh/config"), "{err}");
    }

    #[test]
    fn blank_host_is_rejected() {
        assert!(resolve_target(&cfg(""), &request("  ", 22, "u", "")).is_err());
    }

    #[test]
    fn invalid_dialog_jump_spec_is_reported() {
        let err = resolve_target(&cfg(""), &request("h", 22, "u", "a b")).unwrap_err();
        assert!(matches!(err, SshConfigError::InvalidJump(_)));
    }

    #[test]
    fn default_config_path_is_dot_ssh_config() {
        assert_eq!(
            default_config_path(Path::new("/Users/a")),
            PathBuf::from("/Users/a/.ssh/config")
        );
    }

    #[test]
    fn jump_hosts_resolve_aliases_with_explicit_values_taking_priority() {
        let c = cfg(
            "Host bastion\n  HostName gw.example.com\n  User gwuser\n  Port 2200\n  IdentityFile ~/.ssh/gw\n",
        );
        let spec = |user: Option<&str>, host: &str, port: Option<u16>| JumpSpec {
            user: user.map(String::from),
            host: host.into(),
            port,
        };
        let jumps = build_jump_hosts(
            &c,
            &[
                spec(None, "bastion", None),
                spec(Some("me"), "bastion", Some(2022)),
                spec(None, "plain.example.com", None),
            ],
            "target-user",
        );
        assert_eq!(jumps.len(), 3);
        assert_eq!(
            (
                jumps[0].host.as_str(),
                jumps[0].port,
                jumps[0].username.as_str()
            ),
            ("gw.example.com", 2200, "gwuser")
        );
        assert_eq!(
            jumps[0].identity_files,
            vec![PathBuf::from("/Users/alice/.ssh/gw")]
        );
        assert_eq!(
            (
                jumps[1].host.as_str(),
                jumps[1].port,
                jumps[1].username.as_str()
            ),
            ("gw.example.com", 2022, "me")
        );
        // 設定ファイルにない踏み台は、そのまま・22番・目的のホストのユーザー名。
        assert_eq!(
            (
                jumps[2].host.as_str(),
                jumps[2].port,
                jumps[2].username.as_str()
            ),
            ("plain.example.com", 22, "target-user")
        );
        assert!(jumps[2].identity_files.is_empty());
    }

    #[test]
    fn no_jump_specs_means_no_jump_hosts() {
        assert!(build_jump_hosts(&cfg(""), &[], "u").is_empty());
    }

    #[test]
    fn identity_file_typed_in_the_dialog_wins_and_expands_tilde() {
        let candidates = vec![PathBuf::from("/from/config")];
        assert_eq!(
            pick_identity_file(Path::new("/typed/key"), &candidates, Some(Path::new(HOME)))
                .unwrap(),
            PathBuf::from("/typed/key")
        );
        assert_eq!(
            pick_identity_file(
                Path::new("~/.ssh/typed"),
                &candidates,
                Some(Path::new(HOME))
            )
            .unwrap(),
            PathBuf::from("/Users/alice/.ssh/typed")
        );
    }

    #[test]
    fn empty_identity_file_uses_the_first_existing_one_from_the_config() {
        let dir = std::env::temp_dir().join(format!("linkterm-idfile-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let existing = dir.join("id_ok");
        std::fs::write(&existing, "k").unwrap();
        let candidates = vec![
            dir.join("missing"),
            existing.clone(),
            dir.join("also-missing"),
        ];
        assert_eq!(
            pick_identity_file(Path::new(""), &candidates, None).unwrap(),
            existing
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn empty_identity_file_without_any_existing_candidate_is_an_error() {
        let err = pick_identity_file(Path::new("  "), &[PathBuf::from("/nonexistent/key")], None)
            .unwrap_err();
        assert!(err.to_string().contains("IdentityFile"), "{err}");
        assert!(pick_identity_file(Path::new(""), &[], None).is_err());
    }
}
