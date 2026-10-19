import { checkEnv } from "./env.schema";

function fullValidEnv(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/ragdb",
    REDIS_URL: "redis://localhost:6379",
    ANTHROPIC_API_KEY: "sk-ant-test",
    LOCAL_RETRIEVAL_URL: "http://127.0.0.1:8001",
    TELEGRAM_BOT_TOKEN: "123:test-token",
    ADMIN_API_TOKEN: "admin-secret",
    RAG_BOT_SECRET: "docvault-secret",
  };
}

describe("checkEnv", () => {
  it("returns no errors and no warnings for a fully configured environment", () => {
    const result = checkEnv(fullValidEnv());
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("reports one error per missing required variable", () => {
    const env = fullValidEnv();
    delete env.ANTHROPIC_API_KEY;
    delete env.LOCAL_RETRIEVAL_URL;

    const result = checkEnv(env);

    expect(result.errors).toHaveLength(2);
    expect(result.errors.some((e) => e.startsWith("ANTHROPIC_API_KEY:"))).toBe(true);
    expect(result.errors.some((e) => e.startsWith("LOCAL_RETRIEVAL_URL:"))).toBe(true);
  });

  it("requires a valid local retrieval service URL", () => {
    const env = fullValidEnv();
    env.LOCAL_RETRIEVAL_URL = "not-a-url";

    const result = checkEnv(env);

    expect(
      result.errors.some((e) => e.startsWith("LOCAL_RETRIEVAL_URL:")),
    ).toBe(true);
  });

  it("rejects an interactive retrieval timeout above 30 seconds", () => {
    const env = fullValidEnv();
    env.LOCAL_RETRIEVAL_TIMEOUT_MS = "300001";

    const result = checkEnv(env);

    expect(
      result.errors.some((e) => e.startsWith("LOCAL_RETRIEVAL_TIMEOUT_MS:")),
    ).toBe(true);
  });

  it("treats an empty string the same as a missing required variable", () => {
    const env = fullValidEnv();
    env.TELEGRAM_BOT_TOKEN = "";

    const result = checkEnv(env);

    expect(result.errors.some((e) => e.startsWith("TELEGRAM_BOT_TOKEN:"))).toBe(true);
  });

  it("warns but does not error when ADMIN_API_TOKEN / RAG_BOT_SECRET are unset (fail-closed by design)", () => {
    const env = fullValidEnv();
    delete env.ADMIN_API_TOKEN;
    delete env.RAG_BOT_SECRET;

    const result = checkEnv(env);

    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.some((w) => w.includes("ADMIN_API_TOKEN"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("RAG_BOT_SECRET"))).toBe(true);
  });

  it("does not require optional variables (PORT, OWNER_TELEGRAM_ID, ALLOWED_TELEGRAM_IDS)", () => {
    const env = fullValidEnv();
    const result = checkEnv(env);
    expect(result.errors).toEqual([]);
  });
});
