//! 端末の文字コードとUTF-8の相互変換。
//!
//! 受信したバイト列はセッション層で生のまま扱い、表示直前にここでUTF-8へ変換する。
//! 送信は入力されたUTF-8文字列を接続先の文字コードへ変換する。

use encoding_rs::{Decoder, Encoding};

use super::TerminalError;

/// UI に提示する、ASCII互換の文字コード。
pub const SUPPORTED_ENCODINGS: &[&str] = &[
    "UTF-8",
    "Shift_JIS",
    "EUC-JP",
    "GBK",
    "Big5",
    "EUC-KR",
    "windows-1252",
];

pub struct Codec {
    encoding: &'static Encoding,
    decoder: Decoder,
}

impl Codec {
    pub fn new(label: &str) -> Result<Self, TerminalError> {
        let encoding = Encoding::for_label(label.trim().as_bytes())
            .filter(|e| e.is_ascii_compatible())
            .ok_or_else(|| TerminalError::UnsupportedEncoding(label.to_owned()))?;
        Ok(Self::from_encoding(encoding))
    }

    pub fn utf8() -> Self {
        Self::from_encoding(encoding_rs::UTF_8)
    }

    fn from_encoding(encoding: &'static Encoding) -> Self {
        Self {
            encoding,
            // BOMは端末データの一部ではないため解釈しない。
            decoder: encoding.new_decoder_without_bom_handling(),
        }
    }

    pub fn name(&self) -> &'static str {
        self.encoding.name()
    }

    /// ストリームとして変換する。チャンク境界で分断されたマルチバイト文字は次回に持ち越す。
    pub fn decode(&mut self, bytes: &[u8]) -> String {
        let capacity = self
            .decoder
            .max_utf8_buffer_length(bytes.len())
            .unwrap_or(bytes.len() * 3 + 4);
        let mut out = String::with_capacity(capacity);
        // `decode_to_string` は不正バイトを U+FFFD に置換する。
        let (_result, _read, _had_errors) = self.decoder.decode_to_string(bytes, &mut out, false);
        out
    }

    /// 変換できない文字は `?` に置き換える。
    pub fn encode(&self, text: &str) -> Vec<u8> {
        let mut encoder = self.encoding.new_encoder();
        let mut out = Vec::with_capacity(text.len());
        let mut rest = text;
        while !rest.is_empty() {
            let max = encoder
                .max_buffer_length_from_utf8_without_replacement(rest.len())
                .unwrap_or(rest.len() * 4 + 8);
            let mut buf = vec![0u8; max];
            let (result, read, written) =
                encoder.encode_from_utf8_without_replacement(rest, &mut buf, true);
            out.extend_from_slice(&buf[..written]);
            rest = &rest[read..];
            if let encoding_rs::EncoderResult::Unmappable(_) = result {
                out.push(b'?');
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NIHONGO_SJIS: [u8; 6] = [0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea];
    const NIHONGO_EUC: [u8; 6] = [0xc6, 0xfc, 0xcb, 0xdc, 0xb8, 0xec];

    #[test]
    fn utf8_roundtrip() {
        let mut c = Codec::utf8();
        assert_eq!(c.decode("日本語 abc".as_bytes()), "日本語 abc");
        assert_eq!(c.encode("日本語"), "日本語".as_bytes());
        assert_eq!(c.name(), "UTF-8");
    }

    #[test]
    fn utf8_multibyte_split_across_chunks() {
        let mut c = Codec::utf8();
        let bytes = "日".as_bytes(); // 3バイト
        assert_eq!(c.decode(&bytes[..1]), "");
        assert_eq!(c.decode(&bytes[1..2]), "");
        assert_eq!(c.decode(&bytes[2..]), "日");
    }

    #[test]
    fn shift_jis_decode_and_encode() {
        let mut c = Codec::new("Shift_JIS").unwrap();
        assert_eq!(c.decode(&NIHONGO_SJIS), "日本語");
        assert_eq!(c.encode("日本語"), NIHONGO_SJIS);
        assert_eq!(c.name(), "Shift_JIS");
    }

    #[test]
    fn shift_jis_split_across_chunks() {
        let mut c = Codec::new("Shift_JIS").unwrap();
        assert_eq!(c.decode(&NIHONGO_SJIS[..1]), "");
        assert_eq!(c.decode(&NIHONGO_SJIS[1..]), "日本語");
    }

    #[test]
    fn euc_jp_roundtrip() {
        let mut c = Codec::new("EUC-JP").unwrap();
        assert_eq!(c.decode(&NIHONGO_EUC), "日本語");
        assert_eq!(c.encode("日本語"), NIHONGO_EUC);
    }

    #[test]
    fn labels_are_case_insensitive_and_aliases_work() {
        assert_eq!(Codec::new("shift_jis").unwrap().name(), "Shift_JIS");
        assert_eq!(Codec::new("sjis").unwrap().name(), "Shift_JIS");
        assert_eq!(Codec::new("utf8").unwrap().name(), "UTF-8");
    }

    #[test]
    fn ascii_is_unchanged_in_every_supported_encoding() {
        for label in SUPPORTED_ENCODINGS {
            let mut c = Codec::new(label).unwrap();
            assert_eq!(
                c.decode(b"ls -la\r\n\x1b[0m"),
                "ls -la\r\n\x1b[0m",
                "{label}"
            );
            assert_eq!(c.encode("ls\r"), b"ls\r", "{label}");
        }
    }

    #[test]
    fn unmappable_characters_become_question_marks() {
        let c = Codec::new("Shift_JIS").unwrap();
        assert_eq!(c.encode("a😀b"), b"a?b");
    }

    #[test]
    fn invalid_bytes_are_replaced_not_dropped_or_panicking() {
        let mut c = Codec::utf8();
        assert_eq!(c.decode(&[b'a', 0xff, b'b']), "a\u{fffd}b");
    }

    #[test]
    fn unknown_or_non_ascii_compatible_encodings_are_rejected() {
        assert!(matches!(
            Codec::new("no-such-encoding"),
            Err(TerminalError::UnsupportedEncoding(_))
        ));
        assert!(Codec::new("UTF-16LE").is_err());
        assert!(Codec::new("").is_err());
    }
}
