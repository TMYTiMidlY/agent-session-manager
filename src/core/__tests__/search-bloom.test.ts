import { describe, expect, it } from "vitest";
import { BLOOM_BYTES, bloomMayContain, buildSearchBloom } from "../search-bloom.js";

describe("conservative UTF16 trigram filter", () => {
  it("never excludes substrings across case folding, escapes, emoji or lone surrogates", () => {
    const texts = ['Hello\n世界🙂 "quoted" \\ tabs\t', "İΣßABC", "lone\ud800 surrogate\udfff"].map(text => text.toLowerCase());
    const bits = buildSearchBloom(texts);
    expect(bits).toHaveLength(BLOOM_BYTES);
    for (const text of texts) for (let start = 0; start < text.length; start++) {
      for (let end = start + 1; end <= text.length; end++) expect(bloomMayContain(bits, text.slice(start, end))).toBe(true);
    }
  });

  it("is conservative for short queries/invalid filters and excludes absent trigrams", () => {
    const empty = buildSearchBloom([]);
    for (const query of ["a", "世界"]) expect(bloomMayContain(empty, query)).toBe(true);
    expect(bloomMayContain(empty, "absent")).toBe(false);
    expect(bloomMayContain(Buffer.alloc(1), "absent")).toBe(true);
    expect(bloomMayContain(buildSearchBloom(["common ascii text"]), "不存在的中文查询")).toBe(false);
  });
});
