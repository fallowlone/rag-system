/**
 * Side-by-side model comparison for document analysis (step 2).
 *
 * Runs the SAME extraction through DOCUMENT_ANALYSIS_MODEL (Sonnet, the
 * default) and DOCUMENT_ANALYSIS_MODEL_CANDIDATE (Haiku) and prints both
 * insight lists for human judgment. No DB involved — pure LLM calls.
 *
 * The extraction JSON is read from a file:
 *   { "title": "...", "category": "jobcenter", "docDate": "2026-09-01",
 *     "indexText": "..." }
 * (indexText = the sanitized buildIndexText output the server analyzes.)
 *
 * Run:
 *   ANTHROPIC_API_KEY=... npx ts-node scripts/doc-analysis-compare.ts <extraction.json>
 */
import "dotenv/config";
import * as fs from "fs";
import Anthropic from "@anthropic-ai/sdk";
import {
  DOCUMENT_ANALYSIS_MAX_TOKENS,
  DOCUMENT_ANALYSIS_MODEL,
  DOCUMENT_ANALYSIS_MODEL_CANDIDATE,
  DOCUMENT_ANALYSIS_SCHEMA,
  DocumentAnalysisSource,
  buildAnalysisPrompt,
  parseAnalysisResponse,
} from "../src/app-api/document-analysis.service";

async function analyzeWith(
  client: Anthropic,
  source: DocumentAnalysisSource,
  model: string,
): Promise<void> {
  console.log(`\n===== ${model} =====`);
  const started = Date.now();
  const response = await client.messages.create({
    model,
    max_tokens: DOCUMENT_ANALYSIS_MAX_TOKENS,
    system: buildAnalysisPrompt(source),
    messages: [
      {
        role: "user",
        content: `Analysiere dieses Dokument: ${source.title} (${source.category})`,
      },
    ],
    // NOTE: no `temperature` — claude-sonnet-5 rejects the parameter.
    output_config: {
      format: {
        type: "json_schema",
        schema: DOCUMENT_ANALYSIS_SCHEMA,
      },
    },
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const usage = response.usage;
  console.log(
    `(${elapsed}s, in=${usage.input_tokens} out=${usage.output_tokens})`,
  );

  if (response.stop_reason === "refusal") {
    console.log("REFUSED by safety classifier");
    return;
  }
  const rawText = response.content
    .filter((block) => block.type === "text")
    .map((block) => (block as { text: string }).text)
    .join("");
  if (!rawText) {
    console.log(
      `NO TEXT (stop_reason=${response.stop_reason ?? "unknown"}, blocks=${response.content.map((b) => b.type).join(",")})`,
    );
    return;
  }
  const insights = parseAnalysisResponse(rawText);
  for (const insight of insights) {
    console.log(
      `- [${insight.severity}/${insight.kind}] ${insight.title}\n  ${insight.body}`,
    );
  }
  if (insights.length === 0) console.log("(no insights)");
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: npx ts-node scripts/doc-analysis-compare.ts <extraction.json>");
    process.exit(1);
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  const source = JSON.parse(
    fs.readFileSync(file, "utf-8"),
  ) as DocumentAnalysisSource;
  if (!source.title || !source.category || !source.indexText) {
    throw new Error("extraction.json needs { title, category, indexText }");
  }

  const client = new Anthropic({ apiKey });
  await analyzeWith(client, source, DOCUMENT_ANALYSIS_MODEL);
  await analyzeWith(client, source, DOCUMENT_ANALYSIS_MODEL_CANDIDATE);
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
