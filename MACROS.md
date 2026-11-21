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

Tera Term のマクロのコマンドリファレンス（4.x）にある命令のうち、このアプリで意味のあるものは、すべて対応しています。

| 種類       | 命令                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 流れ       | `if`/`elseif`/`else`/`endif`（1行の `if … then 命令` も）、`while`/`endwhile`、`until`/`enduntil`、`do [while\|until]`/`loop [while\|until]`、`for`/`next`、`break`、`continue`、`goto`、`call`/`return`、`end`、`exit`、`pause`（秒）、`mpause`（ミリ秒）                                                                                                                                                                                                                                                                              |
| 代入       | `a = 式`、`+=` `-=` `*=` `/=` `%=`、`inc`、`dec`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 送信       | `send`、`sendln`（整数は文字コードとして送る）、`sendbreak`（シリアルのみ）、`sendbroadcast`、`sendlnbroadcast`（すべてのペインへ）                                                                                                                                                                                                                                                                                                                                                                                                     |
| 受信       | `wait`（空の文字列は、どの1文字にも一致）、`wait4all`（このペインだけを待つ）、`waitln`（改行までそろった行を照合し、行を `inputstr` へ）、`waitregex`（行ごとに、複数の正規表現のどれかで照合）、`waitn`、`waitrecv`、`recvln`、`flushrecv`。画面制御用の文字は取り除いて照合します                                                                                                                                                                                                                                                    |
| ダイアログ | `messagebox`、`yesnobox`、`inputbox`、`passwordbox`、`listbox`、`statusbox`/`closesbox`（実行中の表示にメッセージを出す・消す）。`special`（メッセージの `\n` `\t` を文字にする）にも対応                                                                                                                                                                                                                                                                                                                                               |
| 配列       | `intdim`、`strdim`（要素数 1〜10000。添字は 0 から。`a[i] = …`、`a[i] += …`、命令の出力先にも使える）                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 文字列     | `strlen`、`strcompare`、`strconcat`、`strcopy`、`strinsert`、`strremove`、`strreplace`（result: 1 置換 / 0 なし / -1 不正）、`strscan`、`strmatch`（`matchstr`・`groupmatchstr1〜9` に結果）、`strtrim`、`strspecial`、`strsplit`/`strjoin`（`groupmatchstr1〜9` を使う）、`str2int`（10進・`0x`・`$` の16進、先頭の数字だけでもよい）、`int2str`、`tolower`、`toupper`、`code2str`、`str2code`、`sprintf`（結果は `inputstr`）、`sprintf2`（`c d i o u x X s`、旗・幅・精度）、`regexoption`（`IGNORECASE` `MULTILINE` `ASIS` が効く） |
| 数値       | `random`（0 以上 max 以下）、`checksum8/16/32`、`crc16`、`crc32`、`rotateleft`、`rotateright`                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 日時       | `getdate`、`gettime`（`%a %A %b %B %d %e %H %I %j %m %M %p %S %u %w %y %Y %z %Z %F %T %D %R %%`、時間帯の指定も可）                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 情報       | `getver`（4.108 と名乗る）、`ifdefined`、`uptime`、`gethostname`、`testlink`、`gettitle`                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 端末・タブ | `settitle`（タブの名前）、`clearscreen`（0: 画面、1: スクロールバックも）、`setecho`（ローカルエコー）、`setdtr`/`setrts`（シリアル）、`enablekeyb`（マクロの実行中だけ、ユーザーのキー入力を止める）、`beep`、`disconnect`、`closett`、`dispstr`（画面にだけ出す）                                                                                                                                                                                                                                                                     |
| 読み飛ばし | `bringupbox`、`showtt`、`show`、`setdlgpos`、`setsync`、`setexitcode`                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## 使えないもの（Tera Term との違い）

次の命令は、使うと、行番号つきで「このアプリでは使えません」と表示します。

- **ファイル・外部コマンド・環境**: `fileopen` などのファイル操作、`filestat`、`findfirst` など、`exec`、`execcmnd`、`include`、`getenv`、`setenv`、`expandenv`、`getdir` など、`*file` つきのチェックサム・CRC、クリップボード（`clipb2var`、`var2clipb`）、パスワードの保存（`getpassword` など）、`dirnamebox`、`filenamebox`
- **接続・設定の変更**: `connect`、`cygconnect`、`unlink`、`setbaud`、`setspeed`、`setflowctrl`、`getmodemstatus`、`loadkeymap`、`restoresetup`、`callmenu`、`changedir`、`setdebug`、`setdate`、`settime`、`getipv4addr`、`getipv6addr`
- **ログ・転送**: `logopen` などのログの操作（ログは画面の「ログ記録」を使う）、`sendfile`、`sendkcode`、`kmt*`、`xmodem*`、`ymodem*`、`zmodem*`、`bplus*`、`quickvan*`、`scp*`
- **複数の窓**: `sendmulticast`、`sendlnmulticast`、`setmulticastname`（このアプリは1つの窓です。`sendbroadcast` は、すべてのペインへ送ります）

そのほかの細かい違いは、次のとおりです。

- 時間切れは、`timeout`（秒）か `mtimeout`（ミリ秒）のどちらかが 0 より大きいときに働きます。
- `wait4all` は、このペインの出力だけを待ちます。`waitregex` の行は 511 文字までを照合します。
- `strlen` は文字数（UTF-16）で、バイト数ではありません。`checksum*`・`crc*` は、UTF-8 のバイト列で計算します。
- 正規表現は JavaScript のものです（Tera Term は Oniguruma）。`regexoption` の文字コード・文法の指定は受け付けますが、動きは変わりません。
- `strjoin` は、後ろの空の `groupmatchstr` をつなげません。`waitn` の時間切れは、受信が途中でも `result` が 0 です（個別のページの書き方が曖昧なため、要確認）。
- 受信の保持量は 64KB まで。実行する命令は 200 万回までです。

## 安全面

- マクロが送る文字は、画面（ローカルエコー）には出ません。
- `passwordbox` で入力した値は、保存されず、画面に出ません。
- スクリプトは `macros.json`（権限 0600）に平文で保存されます。パスワードは書かないでください。
