import { describe, expect, it } from "vitest";

import {
  classifyDefinitionWinnerCategory,
  CONSERVATIVE_DEFINITION_IMPLEMENTATION_POLICY,
  getDefinitionImplementationBonus,
  getDefinitionImplementationPenalty,
  hasExactSymbolEvidence,
  isImplementationSeekingDefinitionQuery,
} from "../src/indexer/definition-implementation-policy.js";

describe("definition implementation policy", () => {
  it("detects implementation-seeking definition queries", () => {
    expect(isImplementationSeekingDefinitionQuery("where is the helper that wraps responses defined")).toBe(true);
    expect(isImplementationSeekingDefinitionQuery("which config file sets the default provider")).toBe(false);
  });

  it("classifies wrapper exports and options shapes separately", () => {
    expect(classifyDefinitionWinnerCategory(
      "/repo/src/init.ts",
      "module",
      "export{TRPCBuilder}"
    )).toBe("wrapper-export");

    expect(classifyDefinitionWinnerCategory(
      "/repo/src/http/types.ts",
      "interface",
      "WebSocketLinkOptions"
    )).toBe("options-shape");

    expect(classifyDefinitionWinnerCategory(
      "/repo/src/http/types.ts",
      "interface",
      "TRPCRequestInfo"
    )).toBe("type-interface");
  });

  it("protects exact-symbol evidence from implementation demotion", () => {
    expect(hasExactSymbolEvidence([
      { reason: "identifierQuality=exact-symbol; matchedHints=resolveresponse:exact-name" },
    ])).toBe(true);

    expect(getDefinitionImplementationPenalty({
      query: "where is the helper that wraps responses defined",
      filePath: "/repo/src/http/types.ts",
      chunkType: "interface",
      name: "TRPCRequestInfo",
      stages: [
        { reason: "identifierQuality=exact-symbol; matchedHints=trpcrequestinfo:exact-name" },
      ],
    }, CONSERVATIVE_DEFINITION_IMPLEMENTATION_POLICY)).toBe(0);
  });

  it("applies conservative penalties only to shape and wrapper categories", () => {
    expect(getDefinitionImplementationPenalty({
      query: "where is the helper that wraps responses defined",
      filePath: "/repo/src/init.ts",
      chunkType: "module",
      name: "export{TRPCBuilder}",
      stages: [],
    }, CONSERVATIVE_DEFINITION_IMPLEMENTATION_POLICY)).toBe(0.05);

    expect(getDefinitionImplementationPenalty({
      query: "where is the async routine that builds request info defined",
      filePath: "/repo/src/http/types.ts",
      chunkType: "interface",
      name: "TRPCRequestInfo",
      stages: [],
    }, CONSERVATIVE_DEFINITION_IMPLEMENTATION_POLICY)).toBe(0.06);

    expect(getDefinitionImplementationPenalty({
      query: "where is the helper that wraps responses defined",
      filePath: "/repo/src/http/client.ts",
      chunkType: "function",
      name: "parseTRPCMessage",
      stages: [],
    }, CONSERVATIVE_DEFINITION_IMPLEMENTATION_POLICY)).toBe(0);
  });

  it("adds a conservative bonus to real implementation chunks", () => {
    expect(getDefinitionImplementationBonus({
      query: "where is the helper that wraps responses defined",
      filePath: "/repo/src/http/client.ts",
      chunkType: "function",
      name: "parseTRPCMessage",
      stages: [],
    }, CONSERVATIVE_DEFINITION_IMPLEMENTATION_POLICY)).toBe(0.035);

    expect(getDefinitionImplementationBonus({
      query: "where is the helper that wraps responses defined",
      filePath: "/repo/src/http/client.ts",
      chunkType: "function",
      name: "parseTRPCMessage",
      stages: [],
      expectedFilePath: "/repo/src/http/client.ts",
    }, CONSERVATIVE_DEFINITION_IMPLEMENTATION_POLICY)).toBeCloseTo(0.06);
  });

  it("does not add an implementation bonus to exact-symbol or shape winners", () => {
    expect(getDefinitionImplementationBonus({
      query: "where is the helper that wraps responses defined",
      filePath: "/repo/src/http/types.ts",
      chunkType: "interface",
      name: "TRPCRequestInfo",
      stages: [],
    }, CONSERVATIVE_DEFINITION_IMPLEMENTATION_POLICY)).toBe(0);

    expect(getDefinitionImplementationBonus({
      query: "where is the helper that wraps responses defined",
      filePath: "/repo/src/http/client.ts",
      chunkType: "function",
      name: "parseTRPCMessage",
      stages: [
        { reason: "identifierQuality=exact-symbol; matchedHints=parsetrpcmessage:exact-name" },
      ],
    }, CONSERVATIVE_DEFINITION_IMPLEMENTATION_POLICY)).toBe(0);
  });
});
