import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../infra/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

// Mock OpenAI before importing provider
const mockCreate = vi.fn();
vi.mock("openai", () => ({
  default: class MockOpenAI {
    chat = {
      completions: {
        create: mockCreate,
      },
    };
  },
}));

// Import after mocks are set up
const { chat, initLlm } = await import("./provider.js");

const LLM_CONFIG = {
  baseUrl: "https://api.venice.ai/api/v1",
  apiKey: "test-key",
  model: "test-model",
};

describe("LLM retry logic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the singleton client
    initLlm(LLM_CONFIG);
  });

  it("returns response on first attempt success", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"action":"hold"}' } }],
      usage: { total_tokens: 100, prompt_tokens: 80, completion_tokens: 20 },
    });

    const result = await chat(LLM_CONFIG, "system", "user");
    expect(result).toBe('{"action":"hold"}');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("retries once on failure then succeeds", async () => {
    mockCreate
      .mockRejectedValueOnce(new Error("network timeout"))
      .mockResolvedValueOnce({
        choices: [{ message: { content: '{"action":"buy"}' } }],
        usage: { total_tokens: 100 },
      });

    const result = await chat(LLM_CONFIG, "system", "user");
    expect(result).toBe('{"action":"buy"}');
    expect(mockCreate).toHaveBeenCalledTimes(2);
  }, 15_000);

  it("throws after all retries exhausted", async () => {
    mockCreate
      .mockRejectedValueOnce(new Error("timeout 1"))
      .mockRejectedValueOnce(new Error("timeout 2"));

    await expect(chat(LLM_CONFIG, "system", "user")).rejects.toThrow("timeout 2");
    expect(mockCreate).toHaveBeenCalledTimes(2); // initial + 1 retry
  }, 15_000);

  it("handles empty response gracefully", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: null } }],
      usage: {},
    });

    const result = await chat(LLM_CONFIG, "system", "user");
    expect(result).toBe("");
  });
});
