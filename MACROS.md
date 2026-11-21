# マクロ（Tera Term の TTL 互換）

タブバーの⚡メニュー「マクロを管理…」で、マクロを追加・編集できます。Tera Term の `.ttl` ファイルは「ファイルから読み込む…」で取り込めます（UTF-8 / Shift_JIS）。実行は、⚡メニューの「マクロ: 名前」、コマンドパレット（⌘⇧P →「マクロを実行」）、管理画面の「実行」から、操作中のペインで行います。実行中は画面の下に「マクロ実行中」と停止ボタンが出ます。

```
; 例: ログインして、結果を確認する
timeout = 30
wait 'login:'
sendln 'admin'
wait 'Password:'
passwordbox 'パスワード' 'ログイン'    ; 実行時に入力（保存されない・画面に出ない）
sendln inputstr
wait '#' 'incorrect'
if result = 2 then
  messagebox 'パスワードが違います' 'ログイン'
  end
endif
sendln 'show version'
```

## 書き方（Tera Term と同じ）

- 1行に1つの文。`;` から行末まではコメント。ラベルは `:name`。
- 文字列は `'…'` か `"…"`、文字コードは `#13`、16進数は `$FF`。`'ab'#13#10` のように、空白なしで続けると1つの文字列。
- 整数は 32 ビット符号つき。演算子の優先順位は Tera Term と同じ（`* / %` → `+ -` → シフト → `&` `and` → `^` `xor` → `|` `or` → 比較 → `=` `<>` → `&&` → `||`）。文字列は `+` で連結、比較もできる。
- 変数名は大文字小文字を区別しない。値のない変数を読むと、行番号つきのエラー。
- システム変数: `result`、`timeout`（秒。0 は無期限）、`mtimeout`（ミリ秒）、`inputstr`、`matchstr`、`groupmatchstr1`〜`9`。

## 使える命令

| 種類         | 命令                                                                                                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 流れ         | `if`/`elseif`/`else`/`endif`（1行の `if … then 命令` も）、`while`/`endwhile`、`until`/`enduntil`、`do [while\|until]`/`loop [while\|until]`、`for`/`next`、`break`、`continue`、`goto`、`call`/`return`、`end`、`exit`         |
| 代入         | `a = 式`、`+=` `-=` `*=` `/=` `%=`、`inc`、`dec`                                                                                                                                                                                |
| 送信         | `send`、`sendln`（整数は文字コードとして送る）、`sendbreak`（シリアルのみ）                                                                                                                                                     |
| 受信         | `wait`、`waitln`、`waitregex`、`recvln`、`flushrecv`（画面制御用の文字は取り除いて照合します）                                                                                                                                  |
| 時間         | `pause`（秒）、`mpause`（ミリ秒）                                                                                                                                                                                               |
| ダイアログ   | `messagebox`、`yesnobox`、`inputbox`、`passwordbox`                                                                                                                                                                             |
| 文字列・数値 | `strlen`、`strcompare`、`strconcat`、`strcopy`、`strinsert`、`strremove`、`strreplace`、`strscan`、`strmatch`、`strtrim`、`strspecial`、`str2int`、`int2str`、`tolower`、`toupper`、`code2str`、`str2code`、`sprintf`、`random` |
| 日時         | `getdate`、`gettime`（`%Y %y %m %d %H %M %S` の書式）                                                                                                                                                                           |
| 接続・表示   | `testlink`、`disconnect`、`closett`、`dispstr`（画面にだけ出す）                                                                                                                                                                |
| 読み飛ばし   | `bringupbox`、`showtt`、`setdlgpos`、`setsync`、`setexitcode`                                                                                                                                                                   |

## 使えないもの（Tera Term との違い）

- **安全のため使えない**: ファイル操作（`fileopen` など）、外部コマンド（`exec`）、`include`、環境変数、`connect`（接続の新規作成）、ログの操作（`logopen` など。ログは画面の「ログ記録」を使う）、クリップボード、パスワードの保存。使うと、行番号つきで「このアプリでは使えません」と表示します。
- **未対応**: 配列（`intdim`/`strdim`）、`listbox`、`sendfile`、`waitevent`、`strjoin`/`strsplit`、`rotateleft` など。使うと「未対応の命令」と表示します。
- **細かい違い**: `waitln` は、1行の中で照合します（行をまたいだ文字列には一致しません）。`strlen` は文字数（UTF-16）で、バイト数ではありません。正規表現は JavaScript のもの（Tera Term は Oniguruma）。受信の保持量は 64KB まで。実行する命令は 200 万回まで。

## 安全面

- マクロが送る文字は、画面（ローカルエコー）には出ません。
- `passwordbox` で入力した値は、保存されず、画面に出ません。
- スクリプトは `macros.json`（権限 0600）に平文で保存されます。パスワードは書かないでください。
