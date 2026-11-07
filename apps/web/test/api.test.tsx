import { afterEach, describe, expect, it, vi } from "vitest";
import { requestKey } from "../src/api";

describe("requestKey", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("falls back to getRandomValues when randomUUID is unavailable", () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.forEach((_, index) => {
        bytes[index] = index;
      });
      return bytes;
    });
    vi.stubGlobal("crypto", { getRandomValues });

    const key = requestKey();

    expect(getRandomValues).toHaveBeenCalledOnce();
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(key.slice(12, 14)).toBe("46");
    expect(key.slice(16, 18)).toBe("88");
  });
});
