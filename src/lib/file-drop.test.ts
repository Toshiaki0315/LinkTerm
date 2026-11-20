import { afterEach, describe, expect, it } from "vitest";
import { claimFileDrops, filesDropClaimed, paneIdAt } from "./file-drop";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("claimFileDrops", () => {
  it("取り込み中は、ほかの画面（端末）が受け取らない。解除すると戻る", () => {
    expect(filesDropClaimed()).toBe(false);
    const release = claimFileDrops();
    expect(filesDropClaimed()).toBe(true);
    release();
    expect(filesDropClaimed()).toBe(false);
  });

  it("複数が取り込んでいても、全員が解除するまで続く。解除の重複は数えない", () => {
    const a = claimFileDrops();
    const b = claimFileDrops();
    a();
    a();
    expect(filesDropClaimed()).toBe(true);
    b();
    expect(filesDropClaimed()).toBe(false);
  });
});

describe("paneIdAt", () => {
  it("座標の下にあるペインの ID を返す。macOS の座標はウィンドウ内の論理座標（CSS ピクセル）で、拡大率では割らない", () => {
    document.body.innerHTML = `<div data-pane-id="p1"><span id="inner"></span></div>`;
    const inner = document.getElementById("inner")!;
    const seen: Array<[number, number]> = [];
    const find = (x: number, y: number) => (seen.push([x, y]), inner);
    expect(paneIdAt({ x: 200, y: 100 }, find)).toBe("p1");
    expect(seen).toEqual([[200, 100]]);
  });

  it("ペインの外なら null", () => {
    document.body.innerHTML = `<div id="outside"></div>`;
    const el = document.getElementById("outside");
    expect(paneIdAt({ x: 1, y: 1 }, () => el)).toBeNull();
    expect(paneIdAt({ x: 1, y: 1 }, () => null)).toBeNull();
  });
});
