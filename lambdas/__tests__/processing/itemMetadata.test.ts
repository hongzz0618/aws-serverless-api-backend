import { describe, expect, it } from "vitest";
import { createCreationMetadata } from "../../src/processing/itemMetadata.js";

describe("createCreationMetadata", () => {
  it("normalizes lowercase English names", () => {
    expect(createCreationMetadata("Example Item")).toEqual({
      normalizedName: "example item",
      nameLength: 12,
    });
  });

  it("applies Unicode NFKC normalization before lowercasing", () => {
    expect(createCreationMetadata("ＡＢＣ")).toEqual({
      normalizedName: "abc",
      nameLength: 3,
    });
  });

  it("counts Unicode code points instead of UTF-16 code units", () => {
    expect(createCreationMetadata("A😀")).toEqual({
      normalizedName: "a😀",
      nameLength: 2,
    });
  });

  it("returns the same result for the same input", () => {
    const first = createCreationMetadata("Résumé");
    const second = createCreationMetadata("Résumé");

    expect(second).toEqual(first);
  });
});
