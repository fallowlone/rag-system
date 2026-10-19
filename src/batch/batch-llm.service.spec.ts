import { BatchLlmService } from "./batch-llm.service";

describe("BatchLlmService.extractFacts", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, ANTHROPIC_API_KEY: "test-key" };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.restoreAllMocks();
  });

  function buildService(createMock: jest.Mock) {
    const service = new BatchLlmService();
    (
      service as unknown as {
        anthropic: { messages: { create: jest.Mock } };
      }
    ).anthropic = { messages: { create: createMock } };
    return service;
  }

  const summaries = [
    {
      summary: "User asked about Bürgergeld eligibility.",
      startedAt: new Date("2026-01-01T10:00:00Z"),
      endedAt: new Date("2026-01-01T10:05:00Z"),
      messageCount: 2,
    },
  ];

  it("does not include an <already_known> block when no existing facts are passed", async () => {
    const createMock = jest.fn().mockResolvedValue({
      content: [{ type: "text", text: "[]" }],
      usage: {},
    });
    const service = buildService(createMock);

    await service.extractFacts(summaries);

    // The base prompt mentions the tag name in prose (explaining what it is
    // for), but the actual <already_known>...</already_known> block is only
    // appended when there are existing facts to list.
    const call = createMock.mock.calls[0]![0] as { system: string };
    expect(call.system).not.toContain("</already_known>");
  });

  it("includes already-known facts in the system prompt to avoid re-extracting them", async () => {
    const createMock = jest.fn().mockResolvedValue({
      content: [{ type: "text", text: "[]" }],
      usage: {},
    });
    const service = buildService(createMock);

    await service.extractFacts(summaries, [
      "Nutzer hat Bürgergeld beantragt.",
      "Nutzer wohnt in Berlin.",
    ]);

    const call = createMock.mock.calls[0]![0] as { system: string };
    expect(call.system).toContain("<already_known>");
    expect(call.system).toContain("Nutzer hat Bürgergeld beantragt.");
    expect(call.system).toContain("Nutzer wohnt in Berlin.");
  });

  it("still parses and returns the extracted facts array", async () => {
    const createMock = jest.fn().mockResolvedValue({
      content: [{ type: "text", text: '["Neuer Fakt aus mehreren Nachrichten."]' }],
      usage: {},
    });
    const service = buildService(createMock);

    const facts = await service.extractFacts(summaries, ["Bekannter Fakt."]);

    expect(facts).toEqual(["Neuer Fakt aus mehreren Nachrichten."]);
  });

  it("caps the summaries and known facts sent to Sonnet on marathon days", async () => {
    const createMock = jest.fn().mockResolvedValue({
      content: [{ type: "text", text: "[]" }],
      usage: {},
    });
    const service = buildService(createMock);
    const many = Array.from({ length: 120 }, (_, i) => ({
      summary: `Summary ${i}.`,
      startedAt: new Date("2026-01-01T10:00:00Z"),
      endedAt: new Date("2026-01-01T10:05:00Z"),
      messageCount: 2,
    }));
    const known = Array.from({ length: 120 }, (_, i) => `Known fact ${i}.`);

    await service.extractFacts(many, known);

    const call = createMock.mock.calls[0]![0] as {
      system: string;
      messages: Array<{ content: string }>;
    };
    // Only the most recent 50 summaries must reach the model.
    expect(call.messages[0]!.content).toContain("Summary 119.");
    expect(call.messages[0]!.content).not.toContain("Summary 0.");
    // Only the most recent 50 known facts land in <already_known>.
    expect(call.system).toContain("Known fact 119.");
    expect(call.system).not.toContain("Known fact 0.");
  });
});

describe("BatchLlmService.writeDiary", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, ANTHROPIC_API_KEY: "test-key" };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.restoreAllMocks();
  });

  function buildService(createMock: jest.Mock) {
    const service = new BatchLlmService();
    (
      service as unknown as {
        anthropic: { messages: { create: jest.Mock } };
      }
    ).anthropic = { messages: { create: createMock } };
    return service;
  }

  const summaries = [
    {
      summary: "User asked about Bürgergeld eligibility.",
      startedAt: new Date("2026-01-01T10:00:00Z"),
      endedAt: new Date("2026-01-01T10:05:00Z"),
      messageCount: 2,
    },
  ];

  it("returns an empty string (never persisted) when the model refuses", async () => {
    const createMock = jest.fn().mockResolvedValue({
      stop_reason: "refusal",
      content: [{ type: "refusal", text: "I cannot help with that." }],
      usage: {},
    });
    const service = buildService(createMock);

    await expect(service.writeDiary(summaries)).resolves.toBe("");
  });

  it("truncates marathon-day input instead of blowing the context limit", async () => {
    const createMock = jest.fn().mockResolvedValue({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Tagebucheintrag" }],
      usage: {},
    });
    const service = buildService(createMock);
    const many = Array.from({ length: 120 }, (_, i) => ({
      summary: `Summary ${i}.`,
      startedAt: new Date("2026-01-01T10:00:00Z"),
      endedAt: new Date("2026-01-01T10:05:00Z"),
      messageCount: 2,
    }));

    await service.writeDiary(many);

    const call = createMock.mock.calls[0]![0] as {
      messages: Array<{ content: string }>;
    };
    expect(call.messages[0]!.content).toContain("Summary 119.");
    expect(call.messages[0]!.content).not.toContain("Summary 0.");
    expect(call.messages[0]!.content.length).toBeLessThanOrEqual(24_000);
  });
});
