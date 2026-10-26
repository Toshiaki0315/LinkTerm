//! Telnet のIAC解析・交渉。ネットワークに依存しない純粋なロジック。

pub const IAC: u8 = 255;
pub const DONT: u8 = 254;
pub const DO: u8 = 253;
pub const WONT: u8 = 252;
pub const WILL: u8 = 251;
pub const SB: u8 = 250;
pub const SE: u8 = 240;

pub const OPT_ECHO: u8 = 1;
pub const OPT_SGA: u8 = 3;
pub const OPT_TTYPE: u8 = 24;
pub const OPT_NAWS: u8 = 31;

const TTYPE_IS: u8 = 0;
const TTYPE_SEND: u8 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verb {
    Will,
    Wont,
    Do,
    Dont,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TelnetEvent {
    /// アプリケーションデータ（IACエスケープ解除済み）。
    Data(Vec<u8>),
    Negotiate {
        verb: Verb,
        option: u8,
    },
    Subnegotiation {
        option: u8,
        data: Vec<u8>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Data,
    /// 直前が CR。次の NUL は捨てる（NVTの `CR NUL` = CR）。
    AfterCr,
    Iac,
    Verb(Verb),
    SbOption,
    SbData,
    SbIac,
}

/// 受信バイト列からTelnetイベントを取り出すパーサー。チャンク分割に耐える。
#[derive(Debug)]
pub struct TelnetParser {
    state: State,
    sb_option: u8,
    sb_data: Vec<u8>,
}

impl Default for TelnetParser {
    fn default() -> Self {
        Self::new()
    }
}

impl TelnetParser {
    pub fn new() -> Self {
        Self {
            state: State::Data,
            sb_option: 0,
            sb_data: Vec::new(),
        }
    }

    pub fn feed(&mut self, input: &[u8]) -> Vec<TelnetEvent> {
        let mut events = Vec::new();
        let mut data = Vec::new();
        let flush = |data: &mut Vec<u8>, events: &mut Vec<TelnetEvent>| {
            if !data.is_empty() {
                events.push(TelnetEvent::Data(std::mem::take(data)));
            }
        };
        for &b in input {
            match self.state {
                State::Data | State::AfterCr => {
                    if self.state == State::AfterCr {
                        self.state = State::Data;
                        if b == 0 {
                            continue;
                        }
                    }
                    match b {
                        IAC => self.state = State::Iac,
                        b'\r' => {
                            data.push(b);
                            self.state = State::AfterCr;
                        }
                        _ => data.push(b),
                    }
                }
                State::Iac => match b {
                    IAC => {
                        data.push(IAC);
                        self.state = State::Data;
                    }
                    WILL => self.state = State::Verb(Verb::Will),
                    WONT => self.state = State::Verb(Verb::Wont),
                    DO => self.state = State::Verb(Verb::Do),
                    DONT => self.state = State::Verb(Verb::Dont),
                    SB => {
                        flush(&mut data, &mut events);
                        self.state = State::SbOption;
                    }
                    // NOP, GA など未対応のコマンドは無視する。
                    _ => self.state = State::Data,
                },
                State::Verb(verb) => {
                    flush(&mut data, &mut events);
                    events.push(TelnetEvent::Negotiate { verb, option: b });
                    self.state = State::Data;
                }
                State::SbOption => {
                    self.sb_option = b;
                    self.sb_data.clear();
                    self.state = State::SbData;
                }
                State::SbData => {
                    if b == IAC {
                        self.state = State::SbIac;
                    } else {
                        self.sb_data.push(b);
                    }
                }
                State::SbIac => match b {
                    IAC => {
                        self.sb_data.push(IAC);
                        self.state = State::SbData;
                    }
                    SE => {
                        events.push(TelnetEvent::Subnegotiation {
                            option: self.sb_option,
                            data: std::mem::take(&mut self.sb_data),
                        });
                        self.state = State::Data;
                    }
                    // 不正な並びは副交渉を破棄してデータに戻る。
                    _ => {
                        self.sb_data.clear();
                        self.state = State::Data;
                    }
                },
            }
        }
        flush(&mut data, &mut events);
        events
    }
}

/// 送信データ中の `IAC` (0xFF) を `IAC IAC` にエスケープする。
pub fn escape_iac(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    for &b in data {
        out.push(b);
        if b == IAC {
            out.push(IAC);
        }
    }
    out
}

/// `IAC SB NAWS <cols> <rows> IAC SE` を生成する。
pub fn build_naws(cols: u16, rows: u16) -> Vec<u8> {
    let mut out = vec![IAC, SB, OPT_NAWS];
    out.extend(escape_iac(&cols.to_be_bytes()));
    out.extend(escape_iac(&rows.to_be_bytes()));
    out.extend([IAC, SE]);
    out
}

/// オプション交渉の応答を決める。
///
/// 対応: NAWS、TERMINAL-TYPE、SGA、ECHO（サーバー側）。それ以外は拒否する。
/// 同じ状態への再要求には応答しない（交渉ループ防止）。
#[derive(Debug)]
pub struct Negotiator {
    term: String,
    cols: u16,
    rows: u16,
    naws: bool,
    ttype: bool,
    sga: bool,
    echo: bool,
}

impl Negotiator {
    pub fn new(term: &str, cols: u16, rows: u16) -> Self {
        Self {
            term: term.to_owned(),
            cols,
            rows,
            naws: false,
            ttype: false,
            sga: false,
            echo: false,
        }
    }

    /// イベントに対して送信すべきバイト列を返す。
    pub fn handle(&mut self, event: &TelnetEvent) -> Vec<u8> {
        match event {
            TelnetEvent::Data(_) => Vec::new(),
            TelnetEvent::Negotiate { verb, option } => self.negotiate(*verb, *option),
            TelnetEvent::Subnegotiation { option, data } => {
                if *option == OPT_TTYPE && data.first() == Some(&TTYPE_SEND) {
                    let mut out = vec![IAC, SB, OPT_TTYPE, TTYPE_IS];
                    out.extend(escape_iac(self.term.as_bytes()));
                    out.extend([IAC, SE]);
                    out
                } else {
                    Vec::new()
                }
            }
        }
    }

    fn negotiate(&mut self, verb: Verb, option: u8) -> Vec<u8> {
        match (verb, option) {
            // こちらが機能を提供する側（DO を受ける）
            (Verb::Do, OPT_NAWS) => {
                if std::mem::replace(&mut self.naws, true) {
                    return Vec::new();
                }
                let mut out = vec![IAC, WILL, OPT_NAWS];
                out.extend(build_naws(self.cols, self.rows));
                out
            }
            (Verb::Do, OPT_TTYPE) => {
                if std::mem::replace(&mut self.ttype, true) {
                    Vec::new()
                } else {
                    vec![IAC, WILL, OPT_TTYPE]
                }
            }
            (Verb::Do, OPT_SGA) => vec![IAC, WILL, OPT_SGA],
            (Verb::Do, opt) => vec![IAC, WONT, opt],
            // サーバーが機能を提供する側（WILL を受ける）
            (Verb::Will, OPT_ECHO) => {
                if std::mem::replace(&mut self.echo, true) {
                    Vec::new()
                } else {
                    vec![IAC, DO, OPT_ECHO]
                }
            }
            (Verb::Will, OPT_SGA) => {
                if std::mem::replace(&mut self.sga, true) {
                    Vec::new()
                } else {
                    vec![IAC, DO, OPT_SGA]
                }
            }
            (Verb::Will, opt) => vec![IAC, DONT, opt],
            (Verb::Wont, OPT_ECHO) => {
                if std::mem::replace(&mut self.echo, false) {
                    vec![IAC, DONT, OPT_ECHO]
                } else {
                    Vec::new()
                }
            }
            (Verb::Wont, OPT_SGA) => {
                if std::mem::replace(&mut self.sga, false) {
                    vec![IAC, DONT, OPT_SGA]
                } else {
                    Vec::new()
                }
            }
            (Verb::Dont, OPT_NAWS) => {
                self.naws = false;
                Vec::new()
            }
            (Verb::Dont, OPT_TTYPE) => {
                self.ttype = false;
                Vec::new()
            }
            // 拒否済みオプションへの WONT/DONT には応答しない。
            (Verb::Wont | Verb::Dont, _) => Vec::new(),
        }
    }

    /// サーバーが ECHO を担当している（ローカルエコー不要）か。
    pub fn remote_echo(&self) -> bool {
        self.echo
    }

    /// 端末サイズを記録し、NAWS が有効なら通知を返す。
    pub fn resize(&mut self, cols: u16, rows: u16) -> Option<Vec<u8>> {
        self.cols = cols;
        self.rows = rows;
        self.naws.then(|| build_naws(cols, rows))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data(b: &[u8]) -> TelnetEvent {
        TelnetEvent::Data(b.to_vec())
    }

    #[test]
    fn plain_data_passes_through() {
        let mut p = TelnetParser::new();
        assert_eq!(p.feed(b"hello"), vec![data(b"hello")]);
    }

    #[test]
    fn iac_iac_is_literal_ff() {
        let mut p = TelnetParser::new();
        assert_eq!(
            p.feed(&[b'a', IAC, IAC, b'b']),
            vec![data(&[b'a', 0xff, b'b'])]
        );
    }

    #[test]
    fn negotiation_commands_are_parsed() {
        let mut p = TelnetParser::new();
        let ev = p.feed(&[
            IAC, DO, OPT_NAWS, IAC, WILL, OPT_ECHO, IAC, DONT, 9, IAC, WONT, 9,
        ]);
        assert_eq!(
            ev,
            vec![
                TelnetEvent::Negotiate {
                    verb: Verb::Do,
                    option: OPT_NAWS
                },
                TelnetEvent::Negotiate {
                    verb: Verb::Will,
                    option: OPT_ECHO
                },
                TelnetEvent::Negotiate {
                    verb: Verb::Dont,
                    option: 9
                },
                TelnetEvent::Negotiate {
                    verb: Verb::Wont,
                    option: 9
                },
            ]
        );
    }

    #[test]
    fn data_around_commands_is_preserved_in_order() {
        let mut p = TelnetParser::new();
        let ev = p.feed(&[b'a', IAC, DO, OPT_SGA, b'b']);
        assert_eq!(
            ev,
            vec![
                data(b"a"),
                TelnetEvent::Negotiate {
                    verb: Verb::Do,
                    option: OPT_SGA
                },
                data(b"b"),
            ]
        );
    }

    #[test]
    fn commands_split_across_chunks() {
        let mut p = TelnetParser::new();
        assert_eq!(p.feed(&[b'x', IAC]), vec![data(b"x")]);
        assert_eq!(p.feed(&[DO]), vec![]);
        assert_eq!(
            p.feed(&[OPT_NAWS, b'y']),
            vec![
                TelnetEvent::Negotiate {
                    verb: Verb::Do,
                    option: OPT_NAWS
                },
                data(b"y"),
            ]
        );
    }

    #[test]
    fn subnegotiation_with_escaped_iac() {
        let mut p = TelnetParser::new();
        let ev = p.feed(&[IAC, SB, OPT_TTYPE, TTYPE_SEND, IAC, IAC, IAC, SE]);
        assert_eq!(
            ev,
            vec![TelnetEvent::Subnegotiation {
                option: OPT_TTYPE,
                data: vec![TTYPE_SEND, 0xff]
            }]
        );
    }

    #[test]
    fn other_iac_commands_are_ignored() {
        let mut p = TelnetParser::new();
        // IAC NOP (241), IAC GA (249)
        assert_eq!(p.feed(&[b'a', IAC, 241, IAC, 249, b'b']), vec![data(b"ab")]);
    }

    #[test]
    fn cr_nul_is_decoded_as_cr() {
        let mut p = TelnetParser::new();
        assert_eq!(p.feed(&[b'a', b'\r', 0, b'b']), vec![data(b"a\rb")]);
        // チャンク境界をまたぐ場合
        assert_eq!(p.feed(b"\r"), vec![data(b"\r")]);
        assert_eq!(p.feed(&[0, b'c']), vec![data(b"c")]);
        // CR LF はそのまま
        assert_eq!(p.feed(b"\r\n"), vec![data(b"\r\n")]);
    }

    #[test]
    fn escape_iac_doubles_ff() {
        assert_eq!(escape_iac(&[1, 0xff, 2]), vec![1, 0xff, 0xff, 2]);
        assert_eq!(escape_iac(b"abc"), b"abc");
    }

    #[test]
    fn naws_encoding() {
        assert_eq!(
            build_naws(80, 24),
            vec![IAC, SB, OPT_NAWS, 0, 80, 0, 24, IAC, SE]
        );
        // 255 はエスケープされる
        assert_eq!(
            build_naws(255, 1),
            vec![IAC, SB, OPT_NAWS, 0, 0xff, 0xff, 0, 1, IAC, SE]
        );
        // 上位バイト
        assert_eq!(
            build_naws(300, 100),
            vec![IAC, SB, OPT_NAWS, 1, 44, 0, 100, IAC, SE]
        );
    }

    #[test]
    fn negotiator_enables_naws_and_reports_size() {
        let mut n = Negotiator::new("xterm", 80, 24);
        let reply = n.handle(&TelnetEvent::Negotiate {
            verb: Verb::Do,
            option: OPT_NAWS,
        });
        let mut expected = vec![IAC, WILL, OPT_NAWS];
        expected.extend(build_naws(80, 24));
        assert_eq!(reply, expected);
        // 重複したDOには応答しない（ループ防止）
        assert!(
            n.handle(&TelnetEvent::Negotiate {
                verb: Verb::Do,
                option: OPT_NAWS
            })
            .is_empty()
        );
        assert_eq!(n.resize(100, 30), Some(build_naws(100, 30)));
    }

    #[test]
    fn resize_without_naws_returns_none() {
        let mut n = Negotiator::new("xterm", 80, 24);
        assert_eq!(n.resize(100, 30), None);
    }

    #[test]
    fn negotiator_accepts_sga_and_server_echo() {
        let mut n = Negotiator::new("xterm", 80, 24);
        assert!(!n.remote_echo());
        assert_eq!(
            n.handle(&TelnetEvent::Negotiate {
                verb: Verb::Will,
                option: OPT_ECHO
            }),
            vec![IAC, DO, OPT_ECHO]
        );
        assert!(n.remote_echo());
        assert_eq!(
            n.handle(&TelnetEvent::Negotiate {
                verb: Verb::Will,
                option: OPT_SGA
            }),
            vec![IAC, DO, OPT_SGA]
        );
        assert_eq!(
            n.handle(&TelnetEvent::Negotiate {
                verb: Verb::Wont,
                option: OPT_ECHO
            }),
            vec![IAC, DONT, OPT_ECHO]
        );
        assert!(!n.remote_echo());
    }

    #[test]
    fn negotiator_refuses_unknown_options() {
        let mut n = Negotiator::new("xterm", 80, 24);
        assert_eq!(
            n.handle(&TelnetEvent::Negotiate {
                verb: Verb::Do,
                option: 99
            }),
            vec![IAC, WONT, 99]
        );
        assert_eq!(
            n.handle(&TelnetEvent::Negotiate {
                verb: Verb::Will,
                option: 99
            }),
            vec![IAC, DONT, 99]
        );
        // WONT/DONT には応答しない
        assert!(
            n.handle(&TelnetEvent::Negotiate {
                verb: Verb::Dont,
                option: 99
            })
            .is_empty()
        );
    }

    #[test]
    fn negotiator_answers_terminal_type() {
        let mut n = Negotiator::new("xterm-256color", 80, 24);
        assert_eq!(
            n.handle(&TelnetEvent::Negotiate {
                verb: Verb::Do,
                option: OPT_TTYPE
            }),
            vec![IAC, WILL, OPT_TTYPE]
        );
        let reply = n.handle(&TelnetEvent::Subnegotiation {
            option: OPT_TTYPE,
            data: vec![TTYPE_SEND],
        });
        let mut expected = vec![IAC, SB, OPT_TTYPE, TTYPE_IS];
        expected.extend(b"xterm-256color");
        expected.extend([IAC, SE]);
        assert_eq!(reply, expected);
    }
}
