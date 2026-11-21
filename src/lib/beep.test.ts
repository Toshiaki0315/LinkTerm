import { afterEach, describe, expect, it, vi } from "vitest";
import { playBeep } from "./beep";

afterEach(() => vi.unstubAllGlobals());

describe("playBeep", () => {
  it("音を鳴らせない環境（AudioContext がない）でも、例外にならない", () => {
    vi.stubGlobal("AudioContext", undefined);
    expect(() => playBeep(5)).not.toThrow();
  });

  it("種類ごとに、短い音を鳴らして止める", () => {
    const start = vi.fn();
    const stop = vi.fn();
    const osc = {
      connect: vi.fn(),
      start,
      stop,
      frequency: { value: 0 },
      type: "",
    };
    class FakeContext {
      currentTime = 0;
      destination = {};
      createOscillator = () => osc;
      createGain = () => ({ connect: vi.fn(), gain: { value: 0 } });
      close = vi.fn();
    }
    vi.stubGlobal("AudioContext", FakeContext);
    playBeep(0);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(osc.frequency.value).toBeGreaterThan(0);
  });

  it("範囲外の種類は、既定の音（5）にする", () => {
    expect(() => playBeep(99)).not.toThrow();
    expect(() => playBeep(-1)).not.toThrow();
  });
});
