//! `~/.ssh/config` の読み込み。ホスト名の別名（`Host`）から、実際の接続先・ユーザー・ポート・
//! 鍵・踏み台（`ProxyJump`）を解決する。
//!
//! 対応するのは `Host` / `HostName` / `User` / `Port` / `IdentityFile` / `ProxyJump` と、
//! `Host` 行のワイルドカード（`*` `?`）・否定（`!`）。`Include`（ファイル名部分のワイルドカード可）と、`Match all` / `Match host` / `Match originalhost`
//! にも対応する。それ以外の `Match` 条件（`user` `exec` など）は評価できないので、どのホストにも当てはめない。
//! OpenSSH と同じく、同じ項目は先に見つかった値を優先し、`IdentityFile` は全部を集める。

use std::path::{Path, PathBuf};

use thiserror::Error;

use crate::session::{LocalForward, RemoteForward};

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
    /// `LocalForward`（`-L`）。設定の順。待ち受けは常に 127.0.0.1（`bind_address` は無視する）。
    pub local_forwards: Vec<LocalForward>,
    /// `DynamicForward`（`-D`）の待ち受けポート。設定の順。
    pub dynamic_forwards: Vec<u16>,
    /// `RemoteForward`（`-R`）。設定の順。サーバー側の待ち受けは常にループバック。
    pub remote_forwards: Vec<RemoteForward>,
}

/// `[bind_address:]port` のポート部分（`DynamicForward` の引数）。不正なら `None`。
fn parse_bind_port(value: &str) -> Option<u16> {
    let port = value.rsplit(':').next()?;
    parse_port(port)
}

/// `LocalForward [bind_address:]port host:hostport` を読む。IPv6 の `[...]` 表記や不正な値は読み飛ばす。
fn parse_local_forward(value: &str) -> Option<LocalForward> {
    let mut parts = value.split_whitespace();
    let bind = parse_bind_port(parts.next()?)?;
    let dest = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let (host, port) = dest.rsplit_once(':')?;
    if host.is_empty() || host.contains(['[', ']', ':']) {
        return None;
    }
    Some(LocalForward {
        bind_port: bind,
        dest_host: host.to_owned(),
        dest_port: parse_port(port)?,
    })
}

/// `RemoteForward [bind_address:]port host:hostport` を読む。IPv6 の待ち受けアドレスは `[::1]:9000` の形。
/// 不正な値（使えない文字を含む待ち受けアドレスなど）は読み飛ばす。
fn parse_remote_forward(value: &str) -> Option<RemoteForward> {
    let mut parts = value.split_whitespace();
    let bind_spec = parts.next()?;
    let forward = parse_local_forward(value)?;
    let bind_address = match bind_spec.rsplit_once(':') {
        Some((address, _)) => {
            let address = address.trim_start_matches('[').trim_end_matches(']');
            if address.is_empty()
                || !address
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | ':' | '-' | '_' | '*'))
            {
                return None;
            }
            Some(address.to_owned())
        }
        None => None,
    };
    Some(RemoteForward {
        bind_port: forward.bind_port,
        dest_host: forward.dest_host,
        dest_port: forward.dest_port,
        bind_address,
    })
}

/// 区画が当てはまる条件。すべての条件（AND）を満たしたときだけ適用する。
/// 条件が1つもなければ（先頭のグローバル設定・`Match all`）、全ホストに適用する。
#[derive(Debug, Default, Clone)]
struct Condition {
    /// ホスト名（別名）のパターン一覧。`Host` と、`Match host` / `Match originalhost`。
    hosts: Vec<Vec<String>>,
    /// ユーザー名のパターン一覧（`Match user`）。
    users: Vec<Vec<String>>,
    /// 評価できない条件（`exec` など）を含む。どのホストにも当てはまらない。
    never: bool,
}

impl Condition {
    fn applies(&self, host: &str, user: Option<&str>) -> bool {
        if self.never {
            return false;
        }
        if !self.hosts.iter().all(|p| patterns_match(p, host)) {
            return false;
        }
        // ユーザー名が分からないときは、user の条件には当てはまらない。
        self.users
            .iter()
            .all(|p| user.is_some_and(|u| patterns_match(p, u)))
    }
}

/// 設定の1区画（`Host` / `Match` 行から次の行まで）。先頭のグローバル設定は全ホストに適用する。
#[derive(Debug, Default)]
struct Block {
    cond: Condition,
    options: Vec<(Keyword, String)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Keyword {
    HostName,
    User,
    Port,
    IdentityFile,
    ProxyJump,
    LocalForward,
    DynamicForward,
    RemoteForward,
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

/// パターン一覧（`a,b,!c`）を分ける。
fn split_patterns(text: &str) -> Vec<String> {
    text.split(',')
        .filter(|p| !p.is_empty())
        .map(str::to_owned)
        .collect()
}

/// `Match` 行の条件を読む。対応するのは `all`、`host` / `originalhost`、`user`（複数並べると、すべてを満たす）。
/// それ以外（`exec` `localuser` `canonical` など）や、引数のない指定は評価できないので、
/// どのホストにも当てはまらないものとして扱う。
fn match_condition(args: &[String]) -> Condition {
    let mut cond = Condition::default();
    let mut i = 0;
    while i < args.len() {
        let key = args[i].to_ascii_lowercase();
        match key.as_str() {
            "all" => i += 1,
            "host" | "originalhost" | "user" => {
                let Some(value) = args.get(i + 1) else {
                    cond.never = true;
                    break;
                };
                let patterns = split_patterns(value);
                if patterns.is_empty() {
                    cond.never = true;
                    break;
                }
                if key == "user" {
                    cond.users.push(patterns);
                } else {
                    cond.hosts.push(patterns);
                }
                i += 2;
            }
            _ => {
                cond.never = true;
                break;
            }
        }
    }
    cond
}

/// `Include` の最大のたどり深さ。
const MAX_INCLUDE_DEPTH: usize = 8;

/// `text` 中の `Include` 行を、その位置にファイルの内容を差し込んで展開する。
/// 相対パスは `base`（設定ファイルのあるディレクトリ）から、`~` は `home` から解決する。
/// ファイル名部分のワイルドカード（`*` `?`）に対応し、名前順に差し込む。
/// 読めない／存在しないファイルは読み飛ばす。差し込む総量は `budget` を超えられない。
fn expand_includes(
    text: &str,
    base: &Path,
    home: Option<&Path>,
    depth: usize,
    budget: &mut u64,
    seen: &mut Vec<PathBuf>,
    origin: &Path,
) -> Result<String, SshConfigError> {
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        let args = match split_line(line) {
            Some((keyword, args)) if keyword == "include" && depth < MAX_INCLUDE_DEPTH => args,
            _ => {
                out.push_str(line);
                out.push('\n');
                continue;
            }
        };
        for arg in args {
            for file in include_targets(&arg, base, home) {
                let Ok(canonical) = file.canonicalize() else {
                    continue;
                };
                if seen.contains(&canonical) {
                    continue;
                }
                let Ok(metadata) = std::fs::metadata(&canonical) else {
                    continue;
                };
                if metadata.len() > *budget {
                    return Err(SshConfigError::TooLarge {
                        path: origin.display().to_string(),
                        limit: MAX_CONFIG_BYTES,
                    });
                }
                *budget -= metadata.len();
                let Ok(bytes) = std::fs::read(&canonical) else {
                    continue;
                };
                let included = String::from_utf8_lossy(&bytes);
                seen.push(canonical.clone());
                let expanded =
                    expand_includes(&included, base, home, depth + 1, budget, seen, origin)?;
                seen.pop();
                out.push_str(&expanded);
            }
        }
    }
    Ok(out)
}

/// `Include` の引数1つが指すファイルの一覧（ワイルドカード展開済み、名前順）。
fn include_targets(arg: &str, base: &Path, home: Option<&Path>) -> Vec<PathBuf> {
    let expanded = expand_tilde(arg, home);
    let path = if expanded.is_absolute() {
        expanded
    } else {
        base.join(expanded)
    };
    let (Some(dir), Some(name)) = (path.parent(), path.file_name().and_then(|n| n.to_str())) else {
        return Vec::new();
    };
    if !name.contains(['*', '?']) {
        return if path.is_file() {
            vec![path]
        } else {
            Vec::new()
        };
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| glob_match(name, n))
        })
        .collect();
    files.sort();
    files
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
        for line in text.lines() {
            let Some((keyword, args)) = split_line(line) else {
                continue;
            };
            match keyword.as_str() {
                "host" => {
                    blocks.push(Block {
                        cond: Condition {
                            hosts: vec![args],
                            ..Condition::default()
                        },
                        options: Vec::new(),
                    });
                }
                "match" => {
                    blocks.push(Block {
                        cond: match_condition(&args),
                        options: Vec::new(),
                    });
                }
                // `Include` は `load` が展開済み。`parse` に直接渡された分は無視する。
                "include" => {}
                key => {
                    let keyword = match key {
                        "hostname" => Keyword::HostName,
                        "user" => Keyword::User,
                        "port" => Keyword::Port,
                        "identityfile" => Keyword::IdentityFile,
                        "proxyjump" => Keyword::ProxyJump,
                        "localforward" => Keyword::LocalForward,
                        "dynamicforward" => Keyword::DynamicForward,
                        "remoteforward" => Keyword::RemoteForward,
                        _ => continue,
                    };
                    if let Some(value) = args.first() {
                        // ProxyJump だけは、カンマ区切りの途中に空白がない1つの値として扱う。
                        let value = if keyword == Keyword::ProxyJump {
                            args.join("")
                        } else if matches!(keyword, Keyword::LocalForward | Keyword::RemoteForward)
                        {
                            args.join(" ")
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
        let text = String::from_utf8_lossy(&bytes);
        let base = path.parent().unwrap_or_else(|| Path::new("."));
        let mut budget = MAX_CONFIG_BYTES - metadata.len();
        let mut seen: Vec<PathBuf> = path.canonicalize().into_iter().collect();
        let expanded = expand_includes(&text, base, home, 0, &mut budget, &mut seen, path)?;
        Ok(Self::parse(&expanded, home))
    }

    fn expand_path(&self, value: &str) -> PathBuf {
        expand_tilde(value, self.home.as_deref())
    }

    /// `host`（別名）を解決する。ユーザー名が分かっていない前提（`Match user` には当てはまらない）。
    pub fn resolve(&self, host: &str) -> ResolvedHost {
        self.resolve_for(host, None)
    }

    /// `host`（別名）を、接続するユーザー名 `requested_user`（ダイアログで指定したもの）を使って解決する。
    /// `Match user` は、指定したユーザー、なければそれより前の区画の `User` で判定する。
    pub fn resolve_for(&self, host: &str, requested_user: Option<&str>) -> ResolvedHost {
        let mut hostname: Option<String> = None;
        let mut user: Option<String> = None;
        let mut port: Option<u16> = None;
        let mut proxy_jump: Option<Vec<JumpSpec>> = None;
        let mut identity_files = Vec::new();
        let mut local_forwards = Vec::new();
        let mut dynamic_forwards = Vec::new();
        let mut remote_forwards = Vec::new();
        for block in &self.blocks {
            let known_user = requested_user.or(user.as_deref());
            if !block.cond.applies(host, known_user) {
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
                    Keyword::LocalForward => local_forwards.extend(parse_local_forward(value)),
                    Keyword::RemoteForward => {
                        remote_forwards.extend(parse_remote_forward(value));
                    }
                    Keyword::DynamicForward => dynamic_forwards.extend(parse_bind_port(value)),
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
            local_forwards,
            dynamic_forwards,
            remote_forwards,
        }
    }

    /// 具体的な別名（ワイルドカード・否定を含まない `Host`）の一覧。ファイル順、重複なし。
    pub fn host_aliases(&self) -> Vec<String> {
        let mut aliases: Vec<String> = Vec::new();
        for pattern in self
            .blocks
            .iter()
            .flat_map(|b| b.cond.hosts.iter().flatten())
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
    /// `~/.ssh/config` の `LocalForward`。
    pub local_forwards: Vec<LocalForward>,
    /// `~/.ssh/config` の `DynamicForward`。
    pub dynamic_forwards: Vec<u16>,
    /// `~/.ssh/config` の `RemoteForward`。
    pub remote_forwards: Vec<RemoteForward>,
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
    let typed_user = request.username.trim();
    let resolved = config.resolve_for(host, (!typed_user.is_empty()).then_some(typed_user));

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
        local_forwards: resolved.local_forwards,
        dynamic_forwards: resolved.dynamic_forwards,
        remote_forwards: resolved.remote_forwards,
    })
}

pub const DEFAULT_SSH_PORT: u16 = 22;

/// リモートフォワードを合わせる。ダイアログの指定が先で、同じサーバー側ポートの設定ファイル側は捨てる。
pub fn merge_remote_forwards(
    dialog: Vec<RemoteForward>,
    config: Vec<RemoteForward>,
) -> Vec<RemoteForward> {
    let mut merged = dialog;
    for f in config {
        if f.bind_port == 0 || !merged.iter().any(|m| m.bind_port == f.bind_port) {
            merged.push(f);
        }
    }
    merged
}

/// ダイアログで指定したポートフォワードと、設定ファイルのものを合わせる。
/// ダイアログの指定を先に並べ、同じローカルポートを待ち受ける設定ファイル側の項目は捨てる
/// （同じポートを二重に待ち受けて接続が失敗するのを防ぐ）。
pub fn merge_forwards(
    dialog_local: Vec<LocalForward>,
    dialog_dynamic: Vec<u16>,
    config_local: Vec<LocalForward>,
    config_dynamic: Vec<u16>,
) -> (Vec<LocalForward>, Vec<u16>) {
    let mut used: Vec<u16> = dialog_local
        .iter()
        .map(|f| f.bind_port)
        .chain(dialog_dynamic.iter().copied())
        .filter(|p| *p != 0)
        .collect();
    let mut local = dialog_local;
    let mut dynamic = dialog_dynamic;
    for f in config_local {
        if !used.contains(&f.bind_port) {
            used.push(f.bind_port);
            local.push(f);
        }
    }
    for p in config_dynamic {
        if !used.contains(&p) {
            used.push(p);
            dynamic.push(p);
        }
    }
    (local, dynamic)
}

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
                local_forwards: vec![],
                dynamic_forwards: vec![],
                remote_forwards: vec![],
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
    fn match_host_applies_to_matching_hosts_only() {
        let c = cfg("Match host foo,bar*\n  User matched\nHost a\n  User real\n");
        assert_eq!(c.resolve("foo").user.as_deref(), Some("matched"));
        assert_eq!(c.resolve("barista").user.as_deref(), Some("matched"));
        assert_eq!(c.resolve("a").user.as_deref(), Some("real"));
        assert_eq!(c.resolve("zzz").user, None);
    }

    #[test]
    fn match_host_supports_negation_and_originalhost() {
        let c = cfg("Match originalhost web*,!web2\n  Port 2200\n");
        assert_eq!(c.resolve("web1").port, Some(2200));
        assert_eq!(c.resolve("web2").port, None);
    }

    #[test]
    fn match_all_applies_to_every_host() {
        let c = cfg("Match all\n  User everyone\n");
        assert_eq!(c.resolve("x").user.as_deref(), Some("everyone"));
    }

    #[test]
    fn unsupported_match_criteria_never_match() {
        let c = cfg(
            "Match user root\n  Port 1\nMatch host a user b\n  Port 2\nMatch exec \"true\"\n  Port 3\nHost a\n  User real\n",
        );
        let r = c.resolve("a");
        assert_eq!(r.port, None);
        assert_eq!(r.user.as_deref(), Some("real"));
    }

    #[test]
    fn match_does_not_leak_into_following_host_blocks() {
        let c = cfg("Match host a\n  User m\nHost b\n  Port 5\n");
        assert_eq!(c.resolve("b").user, None);
        assert_eq!(c.resolve("b").port, Some(5));
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("linkterm-sshcfg-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn include_splices_files_relative_to_the_config_directory() {
        let dir = temp_dir("inc");
        std::fs::write(dir.join("extra"), "Host inc\n  User from_include\n").unwrap();
        std::fs::write(dir.join("config"), "Include extra\nHost a\n  User u\n").unwrap();
        let c = SshConfig::load(&dir.join("config"), None).unwrap();
        assert_eq!(c.resolve("inc").user.as_deref(), Some("from_include"));
        assert_eq!(c.resolve("a").user.as_deref(), Some("u"));
        assert_eq!(c.host_aliases(), vec!["inc", "a"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn include_supports_wildcards_in_the_file_name_in_sorted_order() {
        let dir = temp_dir("glob");
        std::fs::create_dir_all(dir.join("conf.d")).unwrap();
        std::fs::write(dir.join("conf.d/20-b"), "Host b\n  User b\n").unwrap();
        std::fs::write(dir.join("conf.d/10-a"), "Host a\n  User a\n").unwrap();
        std::fs::write(dir.join("config"), "Include conf.d/*\n").unwrap();
        let c = SshConfig::load(&dir.join("config"), None).unwrap();
        assert_eq!(c.host_aliases(), vec!["a", "b"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn include_accepts_absolute_and_tilde_paths() {
        let dir = temp_dir("abs");
        std::fs::write(dir.join("extra"), "Host t\n  Port 7\n").unwrap();
        std::fs::write(
            dir.join("config"),
            format!("Include {}\nInclude ~/extra\n", dir.join("extra").display()),
        )
        .unwrap();
        let c = SshConfig::load(&dir.join("config"), Some(&dir)).unwrap();
        assert_eq!(c.resolve("t").port, Some(7));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn include_cycles_and_missing_files_are_harmless() {
        let dir = temp_dir("cycle");
        std::fs::write(
            dir.join("config"),
            "Include config\nInclude nothing\nHost a\n  User u\n",
        )
        .unwrap();
        let c = SshConfig::load(&dir.join("config"), None).unwrap();
        assert_eq!(c.resolve("a").user.as_deref(), Some("u"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn include_inside_a_host_block_stays_in_that_block() {
        let dir = temp_dir("inblock");
        std::fs::write(dir.join("opts"), "User inner\n").unwrap();
        std::fs::write(
            dir.join("config"),
            "Host a\n  Include opts\nHost b\n  Port 1\n",
        )
        .unwrap();
        let c = SshConfig::load(&dir.join("config"), None).unwrap();
        assert_eq!(c.resolve("a").user.as_deref(), Some("inner"));
        assert_eq!(c.resolve("b").user, None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn include_total_size_is_limited() {
        let dir = temp_dir("size");
        let line = format!("# {}\n", "x".repeat(60_000));
        std::fs::write(dir.join("big"), line.repeat(10)).unwrap();
        let incs = "Include big\n".repeat(30);
        std::fs::write(dir.join("config"), incs).unwrap();
        assert!(matches!(
            SshConfig::load(&dir.join("config"), None),
            Err(SshConfigError::TooLarge { .. })
        ));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn local_and_dynamic_forwards_accumulate_in_order() {
        let c = cfg(
            "Host a\n  LocalForward 8080 db.internal:5432\n  LocalForward 127.0.0.1:9000 localhost:80\n  DynamicForward 1080\n  DynamicForward localhost:1081\nHost *\n  LocalForward 7000 x:7\n",
        );
        let r = c.resolve("a");
        assert_eq!(
            r.local_forwards,
            vec![
                LocalForward {
                    bind_port: 8080,
                    dest_host: "db.internal".into(),
                    dest_port: 5432
                },
                LocalForward {
                    bind_port: 9000,
                    dest_host: "localhost".into(),
                    dest_port: 80
                },
                LocalForward {
                    bind_port: 7000,
                    dest_host: "x".into(),
                    dest_port: 7
                },
            ]
        );
        assert_eq!(r.dynamic_forwards, vec![1080, 1081]);
        assert!(c.resolve("other").dynamic_forwards.is_empty());
    }

    #[test]
    fn invalid_forward_values_are_skipped() {
        let c = cfg(
            "Host a\n  LocalForward 80\n  LocalForward x host:1\n  LocalForward 1 host\n  LocalForward 1 host:99999\n  LocalForward 1 [::1]:80\n  LocalForward 1 h:2 extra\n  DynamicForward abc\n  DynamicForward 0\n",
        );
        let r = c.resolve("a");
        assert!(r.local_forwards.is_empty(), "{:?}", r.local_forwards);
        assert!(r.dynamic_forwards.is_empty());
    }

    #[test]
    fn resolve_target_carries_the_configured_forwards() {
        let c = cfg("Host a\n  User u\n  LocalForward 1 h:2\n  DynamicForward 3\n");
        let t = resolve_target(&c, &request("a", 22, "", "")).unwrap();
        assert_eq!(t.local_forwards.len(), 1);
        assert_eq!(t.dynamic_forwards, vec![3]);
    }

    fn fwd(bind_port: u16) -> LocalForward {
        LocalForward {
            bind_port,
            dest_host: "h".into(),
            dest_port: 1,
        }
    }

    #[test]
    fn remote_forward_is_read_and_merged_with_dialog_first() {
        let c = cfg(
            "Host a\n  RemoteForward 9000 localhost:3000\n  RemoteForward 9001 h:1\n  RemoteForward bad\n",
        );
        let r = c.resolve("a");
        assert_eq!(r.remote_forwards.len(), 2);
        assert_eq!(r.remote_forwards[0].bind_port, 9000);
        assert_eq!(r.remote_forwards[0].dest_host, "localhost");
        assert!(r.local_forwards.is_empty());
        let dialog = vec![RemoteForward {
            bind_port: 9000,
            dest_host: "x".into(),
            dest_port: 1,
            bind_address: None,
        }];
        let merged = merge_remote_forwards(dialog, r.remote_forwards);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].dest_host, "x");
        assert_eq!(merged[1].bind_port, 9001);
    }

    #[test]
    fn remote_forward_bind_address_is_read() {
        let c = cfg(
            "Host a\n  RemoteForward 0.0.0.0:9000 localhost:3000\n  RemoteForward *:9001 h:1\n  RemoteForward [::1]:9002 h:2\n  RemoteForward localhost:9003 h:3\n  RemoteForward 9004 h:4\n  RemoteForward bad host:9005 h:5\n  RemoteForward a;b:9006 h:6\n",
        );
        let r = c.resolve("a");
        let got: Vec<(Option<&str>, u16)> = r
            .remote_forwards
            .iter()
            .map(|f| (f.bind_address.as_deref(), f.bind_port))
            .collect();
        assert_eq!(
            got,
            [
                (Some("0.0.0.0"), 9000),
                (Some("*"), 9001),
                (Some("::1"), 9002),
                (Some("localhost"), 9003),
                (None, 9004),
            ]
        );
    }

    #[test]
    fn merge_puts_dialog_forwards_first_and_drops_duplicate_ports() {
        let (local, dynamic) = merge_forwards(
            vec![fwd(8080)],
            vec![1080],
            vec![fwd(8080), fwd(9000)],
            vec![1080, 1081],
        );
        assert_eq!(local, vec![fwd(8080), fwd(9000)]);
        assert_eq!(dynamic, vec![1080, 1081]);
        // 設定ファイル内の重複も1つにする。
        let (local, _) = merge_forwards(vec![], vec![], vec![fwd(5), fwd(5)], vec![]);
        assert_eq!(local, vec![fwd(5)]);
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

    #[test]
    fn match_user_uses_the_requested_user_or_an_earlier_user_directive() {
        let c = cfg(
            "Match user alice\n  Port 2201\nMatch user bob,carol\n  Port 2202\nMatch user *,!root\n  IdentityFile /k/notroot\n",
        );
        // 指定したユーザーで当てはまる。
        assert_eq!(c.resolve_for("h", Some("alice")).port, Some(2201));
        assert_eq!(c.resolve_for("h", Some("carol")).port, Some(2202));
        assert_eq!(c.resolve_for("h", Some("root")).port, None);
        assert!(c.resolve_for("h", Some("root")).identity_files.is_empty());
        assert_eq!(c.resolve_for("h", Some("dave")).identity_files.len(), 1);
        // ユーザーが分からなければ、user の条件には当てはまらない。
        assert_eq!(c.resolve("h").port, None);
        assert!(c.resolve("h").identity_files.is_empty());
        // 前の User の指定（ホスト別）が、あとの Match user の判定に使われる。
        let c = cfg("Host h\n  User alice\nMatch user alice\n  Port 2201\n");
        assert_eq!(c.resolve("h").port, Some(2201));
        assert_eq!(c.resolve("other").port, None);
    }

    #[test]
    fn match_with_several_criteria_requires_all_of_them() {
        let c = cfg(
            "Match host web*,db* user alice\n  Port 2201\nMatch originalhost web1 user bob\n  Port 2202\nMatch host web*,!web9\n  IdentityFile /k/web\n",
        );
        assert_eq!(c.resolve_for("web1", Some("alice")).port, Some(2201));
        assert_eq!(c.resolve_for("web1", Some("bob")).port, Some(2202));
        assert_eq!(c.resolve_for("web1", Some("carol")).port, None);
        assert_eq!(c.resolve_for("app", Some("alice")).port, None);
        assert_eq!(c.resolve_for("web1", None).port, None);
        assert_eq!(c.resolve_for("web1", Some("x")).identity_files.len(), 1);
        assert!(c.resolve_for("web9", Some("x")).identity_files.is_empty());
    }

    #[test]
    fn match_with_unsupported_criteria_never_applies() {
        let c = cfg(
            "Match exec \"true\"\n  Port 1\nMatch host h localuser me\n  Port 2\nMatch canonical\n  Port 3\nMatch host\n  Port 4\nMatch user alice exec \"x\"\n  Port 5\n",
        );
        assert_eq!(c.resolve_for("h", Some("alice")).port, None);
    }

    #[test]
    fn resolve_target_matches_user_against_the_typed_user() {
        let c = cfg("Match user alice\n  Port 2201\n  HostName a.example\n");
        let req = |user: &str| RequestedTarget {
            host: "h".into(),
            port: DEFAULT_SSH_PORT,
            username: user.into(),
            jump_hosts: String::new(),
        };
        let t = resolve_target(&c, &req("alice")).unwrap();
        assert_eq!((t.port, t.hostname.as_str()), (2201, "a.example"));
        let t = resolve_target(&c, &req("bob")).unwrap();
        assert_eq!((t.port, t.hostname.as_str()), (22, "h"));
    }
}
