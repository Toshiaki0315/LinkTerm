import { z } from "zod";

// Zod は、スキーマを作るときに `Function("")` で eval の可否を試す。CSP（script-src に 'unsafe-eval' なし）の
// 下では違反として記録されるので、最初から eval を使わない設定にする。
// スキーマを作るモジュールより先に読み込まれるよう、エントリー（main.tsx）の先頭で import すること。
z.config({ jitless: true });
