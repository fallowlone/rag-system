import * as pdfParseModule from "pdf-parse";

const pdfParse = ((pdfParseModule as unknown as { default?: unknown }).default ??
  pdfParseModule) as (buffer: Buffer) => Promise<{ text: string; numpages: number }>;

export default async function parsePdf(
  buffer: Buffer,
): Promise<{ text: string; numpages: number }> {
  const parsed = await pdfParse(buffer);
  return { text: parsed.text ?? "", numpages: parsed.numpages ?? 1 };
}
