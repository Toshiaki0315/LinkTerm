// 本物の画面（App）を、Tauri のバックエンドなしでブラウザーに載せるための入口。
// 先に偽のバックエンドを入れてから、通常の入口（main.tsx）を読み込む。
import "./fake-backend";
import "../src/main";
