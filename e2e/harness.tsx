// 本物の画面（App）を、Tauri のバックエンドなしでブラウザーに載せるための入口。
// 先に偽のバックエンドを入れてから、通常の入口（main.tsx）と同じように描画する。
// 製品版（ビルド後）には React の StrictMode の二重実行が無いので、ここでも使わない
// （開発時の二重実行は、自動ログインの手順などを途中で止めてしまうため）。
import "./fake-backend";
import ReactDOM from "react-dom/client";
import App from "../src/App";
import "../src/index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);
