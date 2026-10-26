//! CR/LF の相互変換。

use serde::{Deserialize, Serialize};

/// 送信時（キー入力のEnter = CR）の改行コード。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum TxNewline {
    /// 変換しない。
    #[default]
    Cr,
    Lf,
    CrLf,
}

/// 受信時の改行変換（表示用）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum RxNewline {
    /// 変換しない。
    #[default]
    Raw,
    /// LF を CRLF として表示する。
    LfToCrLf,
    /// CR を CRLF として表示する。
    CrToCrLf,
}

/// 送信データの改行を変換する。`CRLF` は1つの改行として扱う。
pub fn convert_outgoing(data: &[u8], mode: TxNewline) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    let mut i = 0;
    while i < data.len() {
        let b = data[i];
        let is_crlf = b == b'\r' && data.get(i + 1) == Some(&b'\n');
        if b == b'\r' || b == b'\n' {
            match mode {
                TxNewline::Cr => out.push(b'\r'),
                TxNewline::Lf => out.push(b'\n'),
                TxNewline::CrLf => out.extend_from_slice(b"\r\n"),
            }
            if is_crlf {
                i += 1;
            }
        } else {
            out.push(b);
        }
        i += 1;
    }
    out
}

/// 受信ストリームの改行変換。チャンク境界をまたぐ `CR`/`LF` も正しく扱う。
#[derive(Debug, Default)]
pub struct IncomingConverter {
    mode: RxNewline,
    prev: Option<u8>,
}

impl IncomingConverter {
    pub fn new(mode: RxNewline) -> Self {
        Self { mode, prev: None }
    }

    pub fn convert(&mut self, data: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(data.len());
        for &b in data {
            match (self.mode, b) {
                (RxNewline::LfToCrLf, b'\n') if self.prev != Some(b'\r') => {
                    out.extend_from_slice(b"\r\n");
                }
                (RxNewline::CrToCrLf, b'\r') => out.extend_from_slice(b"\r\n"),
                // CR を CRLF にした直後の LF は重複させない。
                (RxNewline::CrToCrLf, b'\n') if self.prev == Some(b'\r') => {}
                _ => out.push(b),
            }
            self.prev = Some(b);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outgoing_cr_mode_normalizes_all_newlines_to_cr() {
        assert_eq!(
            convert_outgoing(b"a\rb\nc\r\nd", TxNewline::Cr),
            b"a\rb\rc\rd"
        );
    }

    #[test]
    fn outgoing_lf_mode() {
        assert_eq!(convert_outgoing(b"ls\r", TxNewline::Lf), b"ls\n");
        assert_eq!(convert_outgoing(b"a\r\nb", TxNewline::Lf), b"a\nb");
    }

    #[test]
    fn outgoing_crlf_mode_does_not_double() {
        assert_eq!(convert_outgoing(b"ls\r", TxNewline::CrLf), b"ls\r\n");
        assert_eq!(
            convert_outgoing(b"a\r\nb\nc", TxNewline::CrLf),
            b"a\r\nb\r\nc"
        );
    }

    #[test]
    fn outgoing_keeps_other_bytes() {
        assert_eq!(
            convert_outgoing(&[0x1b, b'[', b'A', 0xff, 0x00], TxNewline::CrLf),
            [0x1b, b'[', b'A', 0xff, 0x00]
        );
    }

    #[test]
    fn incoming_raw_is_untouched() {
        let mut c = IncomingConverter::new(RxNewline::Raw);
        assert_eq!(c.convert(b"a\nb\rc"), b"a\nb\rc");
    }

    #[test]
    fn incoming_lf_to_crlf() {
        let mut c = IncomingConverter::new(RxNewline::LfToCrLf);
        assert_eq!(c.convert(b"a\nb\r\nc"), b"a\r\nb\r\nc");
    }

    #[test]
    fn incoming_lf_to_crlf_across_chunks() {
        let mut c = IncomingConverter::new(RxNewline::LfToCrLf);
        assert_eq!(c.convert(b"a\r"), b"a\r");
        assert_eq!(c.convert(b"\nb"), b"\nb");
    }

    #[test]
    fn incoming_cr_to_crlf() {
        let mut c = IncomingConverter::new(RxNewline::CrToCrLf);
        assert_eq!(c.convert(b"a\rb\r\nc"), b"a\r\nb\r\nc");
    }

    #[test]
    fn incoming_cr_to_crlf_across_chunks() {
        let mut c = IncomingConverter::new(RxNewline::CrToCrLf);
        assert_eq!(c.convert(b"a\r"), b"a\r\n");
        assert_eq!(c.convert(b"\nb"), b"b");
    }
}
