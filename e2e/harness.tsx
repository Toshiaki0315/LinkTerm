// 本物の画面（App）を、Tauri のバックエンドなしでブラウザーに載せるための入口。
// 先に偽のバックエンドを入れてから、通常の入口（main.tsx）と同じように描画する。
// 製品版（ビルド後）には React の StrictMode の二重実行が無いので、ここでも使わない。
// （StrictMode での動作は、`strict-mode.spec.ts` が別に確かめる。）
import "./fake-backend";
import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import App from "../src/App";
import "../src/index.css";

const strict = new URLSearchParams(location.search).has("strict");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  strict ? (
    <StrictMode>
      <App />
    </StrictMode>
  ) : (
    <App />
  ),
);
