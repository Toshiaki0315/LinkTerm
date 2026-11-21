/** `beep` の種類ごとの音の高さ（Hz）。0 は標準のビープ音、1〜5 は通知の種類。 */
const FREQUENCIES: Record<number, number> = {
  0: 880,
  1: 660,
  2: 740,
  3: 330,
  4: 590,
  5: 800,
};

/** 短い音を鳴らす。音を出せない環境でも、例外にしない。 */
export function playBeep(kind: number): void {
  try {
    const Context = (globalThis as { AudioContext?: typeof AudioContext })
      .AudioContext;
    if (!Context) return;
    const hz = FREQUENCIES[kind] ?? FREQUENCIES[5];
    const ctx = new Context();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = hz;
    gain.gain.value = 0.1;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.12);
    setTimeout(() => void ctx.close?.(), 300);
  } catch (e) {
    console.error("音を鳴らせません:", e);
  }
}
