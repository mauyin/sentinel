import { describe, it, expect, vi } from "vitest";
import { parseTradeDecision } from "./parser.js";

vi.mock("../infra/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  initLogger: vi.fn(),
}));

const VALID_DECISION = {
  action: "buy",
  market: "ETH-USDC-BASE",
  size: 50,
  confidence: 72,
  reasoning: "Strong momentum with rising volume.",
  timeHorizon: "swing",
  riskLevel: "medium",
};

describe("parseTradeDecision", () => {
  it("parses valid direct JSON", () => {
    const result = parseTradeDecision(JSON.stringify(VALID_DECISION));
    expect(result).not.toBeNull();
    expect(result!.action).toBe("buy");
    expect(result!.market).toBe("ETH-USDC-BASE");
    expect(result!.size).toBe(50);
    expect(result!.confidence).toBe(72);
  });

  it("parses JSON inside markdown fences", () => {
    const raw = "```json\n" + JSON.stringify(VALID_DECISION) + "\n```";
    const result = parseTradeDecision(raw);
    expect(result).not.toBeNull();
    expect(result!.action).toBe("buy");
  });

  it("extracts JSON from surrounding text", () => {
    const raw = "Here is my analysis:\n" + JSON.stringify(VALID_DECISION) + "\nEnd.";
    const result = parseTradeDecision(raw);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(72);
  });

  it("parses hold decision with null size", () => {
    const hold = { ...VALID_DECISION, action: "hold", size: null };
    const result = parseTradeDecision(JSON.stringify(hold));
    expect(result).not.toBeNull();
    expect(result!.action).toBe("hold");
    expect(result!.size).toBeUndefined();
  });

  it("parses sell action", () => {
    const sell = { ...VALID_DECISION, action: "sell" };
    const result = parseTradeDecision(JSON.stringify(sell));
    expect(result).not.toBeNull();
    expect(result!.action).toBe("sell");
  });

  it("accepts missing optional fields (timeHorizon, riskLevel)", () => {
    const minimal = {
      action: "buy",
      market: "ETH-USDC-BASE",
      size: 50,
      confidence: 72,
      reasoning: "Some reasoning.",
    };
    const result = parseTradeDecision(JSON.stringify(minimal));
    expect(result).not.toBeNull();
    expect(result!.timeHorizon).toBeUndefined();
    expect(result!.riskLevel).toBeUndefined();
  });

  it("rejects invalid action", () => {
    const invalid = { ...VALID_DECISION, action: "short" };
    const result = parseTradeDecision(JSON.stringify(invalid));
    expect(result).toBeNull();
  });

  it("rejects missing required fields", () => {
    const noAction = { market: "ETH", confidence: 50, reasoning: "test" };
    expect(parseTradeDecision(JSON.stringify(noAction))).toBeNull();
  });

  it("rejects malformed JSON", () => {
    expect(parseTradeDecision("{bad json")).toBeNull();
  });

  it("rejects empty string", () => {
    expect(parseTradeDecision("")).toBeNull();
  });

  it("accepts confidence = 0", () => {
    const d = { ...VALID_DECISION, confidence: 0 };
    const result = parseTradeDecision(JSON.stringify(d));
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0);
  });

  it("accepts confidence = 100", () => {
    const d = { ...VALID_DECISION, confidence: 100 };
    const result = parseTradeDecision(JSON.stringify(d));
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(100);
  });

  it("rejects confidence > 100", () => {
    const d = { ...VALID_DECISION, confidence: 101 };
    expect(parseTradeDecision(JSON.stringify(d))).toBeNull();
  });
});
