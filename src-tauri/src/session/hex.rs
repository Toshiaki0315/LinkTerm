//! 受信バイト列の16進ダンプ表示（`hexdump -C` 形式）。
//!
//! ストリームで受け取るため、行の途中で表示が切れても、続きが来たら同じ行を `\r` で書き直す。

/// 1行あたりのバイト数。
pub const BYTES_PER_LINE: usize = 16;

#[derive(Debug, Default)]
pub struct HexDumper {
    /// 現在の行の先頭のオフセット。
    offset: u64,
    /// 現在の行に溜まっているバイト（最大 16）。
    line: Vec<u8>,
    /// 現在の行を既に画面へ描いているか（描いていれば、書き直しの前に `\r` を出す）。
    drawn: bool,
}

impl HexDumper {
    pub fn new() -> Self {
        Self::default()
    }

    /// 新しいデータを加えて、画面に出す文字列を返す。
    pub fn feed(&mut self, data: &[u8]) -> String {
        let mut out = String::new();
        for &byte in data {
            self.line.push(byte);
            if self.line.len() == BYTES_PER_LINE {
                // 行が埋まったら、（描きかけなら書き直して）確定し、次の行へ進む。
                self.draw(&mut out);
                out.push_str("\r\n");
                self.offset += BYTES_PER_LINE as u64;
                self.line.clear();
                self.drawn = false;
            }
        }
        if !data.is_empty() && !self.line.is_empty() {
            self.draw(&mut out);
        }
        out
    }

    /// 16進表示を終えるとき、描きかけの行があれば改行して閉じる。
    pub fn finish(&mut self) -> String {
        let closing = if self.drawn && !self.line.is_empty() {
            "\r\n"
        } else {
            ""
        };
        self.reset();
        closing.to_owned()
    }

    /// 現在の行を描く。既に描いた行は、先頭へ戻って書き直す。
    fn draw(&mut self, out: &mut String) {
        if self.drawn {
            out.push('\r');
        }
        out.push_str(&format_line(self.offset, &self.line));
        self.drawn = true;
    }

    /// 状態を初期化する（オフセットも 0 に戻す）。
    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

/// 1行分（1〜16バイト）の表示。16バイトに満たない行も、ASCII 欄の位置をそろえる。
pub fn format_line(offset: u64, bytes: &[u8]) -> String {
    let mut hex = String::with_capacity(BYTES_PER_LINE * 3 + 1);
    for i in 0..BYTES_PER_LINE {
        if i == BYTES_PER_LINE / 2 {
            hex.push(' ');
        }
        match bytes.get(i) {
            Some(b) => hex.push_str(&format!("{b:02x} ")),
            None => hex.push_str("   "),
        }
    }
    let ascii: String = bytes
        .iter()
        .map(|&b| {
            if (0x20..=0x7e).contains(&b) {
                b as char
            } else {
                '.'
            }
        })
        .collect();
    format!("{offset:08x}  {hex} |{ascii}|")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_line_matches_hexdump_c_format() {
        let bytes: Vec<u8> = (0x41..=0x50).collect(); // A..P
        assert_eq!(
            format_line(0, &bytes),
            "00000000  41 42 43 44 45 46 47 48  49 4a 4b 4c 4d 4e 4f 50  |ABCDEFGHIJKLMNOP|"
        );
    }

    #[test]
    fn partial_line_is_padded_so_the_ascii_column_stays_aligned() {
        let full = format_line(0, &[0u8; 16]);
        let partial = format_line(0, b"Hello");
        assert_eq!(
            partial,
            "00000000  48 65 6c 6c 6f                                    |Hello|"
        );
        // ASCII 欄の開始位置は行の長さによらず同じ。
        assert_eq!(full.find('|'), partial.find('|'));
    }

    #[test]
    fn offset_is_eight_lowercase_hex_digits() {
        assert!(format_line(0x1234abcd, b"x").starts_with("1234abcd  78 "));
    }

    #[test]
    fn non_printable_bytes_become_dots() {
        let line = format_line(0, &[0x00, 0x1f, 0x20, 0x7e, 0x7f, 0x80, 0xff]);
        assert!(line.ends_with("|.. ~...|"), "{line}");
    }

    #[test]
    fn empty_feed_prints_nothing() {
        assert_eq!(HexDumper::new().feed(&[]), "");
    }

    #[test]
    fn short_chunk_draws_a_partial_line() {
        let mut d = HexDumper::new();
        assert_eq!(d.feed(b"Hello"), format_line(0, b"Hello"));
    }

    #[test]
    fn continuing_a_partial_line_rewrites_it_from_the_start() {
        let mut d = HexDumper::new();
        d.feed(b"Hello");
        let out = d.feed(b" World");
        assert_eq!(out, format!("\r{}", format_line(0, b"Hello World")));
    }

    #[test]
    fn exactly_sixteen_bytes_completes_the_line_and_the_next_starts_fresh() {
        let mut d = HexDumper::new();
        let data: Vec<u8> = (0..16).collect();
        assert_eq!(d.feed(&data), format!("{}\r\n", format_line(0, &data)));
        // 次の行はオフセット 16 から、書き直しの `\r` なしで始まる。
        assert_eq!(d.feed(&[0xaa]), format_line(16, &[0xaa]));
    }

    #[test]
    fn a_long_chunk_emits_full_lines_then_a_partial_one() {
        let mut d = HexDumper::new();
        let data: Vec<u8> = (0..20).collect();
        let out = d.feed(&data);
        assert_eq!(
            out,
            format!(
                "{}\r\n{}",
                format_line(0, &data[..16]),
                format_line(16, &data[16..])
            )
        );
    }

    #[test]
    fn completing_a_drawn_partial_line_rewrites_it_then_starts_the_next() {
        let mut d = HexDumper::new();
        d.feed(&(0..10).collect::<Vec<u8>>());
        let out = d.feed(&(10..30).collect::<Vec<u8>>());
        let all: Vec<u8> = (0..30).collect();
        assert_eq!(
            out,
            format!(
                "\r{}\r\n{}",
                format_line(0, &all[..16]),
                format_line(16, &all[16..])
            )
        );
    }

    #[test]
    fn offsets_keep_counting_across_many_chunks() {
        let mut d = HexDumper::new();
        let mut screen = String::new();
        for chunk in vec![7usize, 9, 16, 1, 31].into_iter() {
            screen.push_str(&d.feed(&vec![0x61; chunk]));
        }
        // 合計 64 バイト = ちょうど 4 行。最終行のオフセットは 0x30。
        assert!(screen.contains("00000030  "), "{screen}");
        assert!(screen.ends_with("\r\n"));
    }

    #[test]
    fn finish_closes_a_drawn_partial_line_only() {
        let mut d = HexDumper::new();
        assert_eq!(d.finish(), "");
        d.feed(b"ab");
        assert_eq!(d.finish(), "\r\n");
        assert_eq!(d.finish(), "");
    }

    #[test]
    fn reset_restarts_the_offsets() {
        let mut d = HexDumper::new();
        d.feed(&[0u8; 20]);
        d.reset();
        assert_eq!(d.feed(b"x"), format_line(0, b"x"));
    }
}
