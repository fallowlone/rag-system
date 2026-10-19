import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { spawn } from "child_process";
import { writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import pLimit from "p-limit";

const SCRIPT_PATH = join(tmpdir(), "rag_pdf_gen.py");
const PDF_GENERATION_TIMEOUT_MS = 30_000;
// The boot-time dependency probe must never wedge startup: a hung python
// (broken venv, FUSE stall) would otherwise leave onModuleInit pending.
const PDF_CHECK_TIMEOUT_MS = 10_000;
// One reportlab render is CPU-bound single-core work; cap concurrent
// generations so N simultaneous downloads degrade gracefully (queue) instead
// of stampeding N python processes into cascading 30s timeouts.
const PDF_MAX_CONCURRENT = 2;

const PYTHON_SCRIPT = `
import sys
import io
import os
import re
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import cm
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, HRFlowable
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

# Helvetica (a PDF base-14 font) has no Cyrillic glyphs: Cyrillic paragraphs
# rendered through it come out as WinAnsi digit soup. Prefer DejaVuSans when
# the image ships it (see Dockerfile: ttf-dejavu); otherwise fall back to
# Helvetica so ASCII letters keep rendering exactly as before.
REGULAR = 'Helvetica'
BOLD = 'Helvetica-Bold'
for _dir in ('/usr/share/fonts/dejavu', '/usr/share/fonts/ttf-dejavu', '/usr/share/fonts/truetype/dejavu'):
    _regular = os.path.join(_dir, 'DejaVuSans.ttf')
    _bold = os.path.join(_dir, 'DejaVuSans-Bold.ttf')
    if os.path.exists(_regular) and os.path.exists(_bold):
        pdfmetrics.registerFont(TTFont('DejaVu', _regular))
        pdfmetrics.registerFont(TTFont('DejaVu-Bold', _bold))
        REGULAR = 'DejaVu'
        BOLD = 'DejaVu-Bold'
        break

_CYRILLIC = re.compile(r'[\\u0400-\\u04ff]')

def pick(base, cyr, line):
    return cyr if (REGULAR == 'DejaVu' and _CYRILLIC.search(line)) else base

def strip_html(text):
    text = re.sub(r'<[^>]+>', '', text)
    text = text.replace('&lt;', '<').replace('&gt;', '>').replace('&amp;', '&').replace('&quot;', '"')
    return text

def build_pdf(raw_text):
    text = strip_html(raw_text)
    # Remove any stray markers
    text = text.replace('[LETTER_FORMAT_CHOICE]', '').replace('[LETTER_STYLE_CHOICE]', '')

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=2.5 * cm,
        rightMargin=2.5 * cm,
        topMargin=2.5 * cm,
        bottomMargin=2.5 * cm,
    )

    normal = ParagraphStyle(
        'N', fontName='Helvetica', fontSize=11, leading=16, spaceAfter=4
    )
    bold_s = ParagraphStyle(
        'B', fontName='Helvetica-Bold', fontSize=11, leading=16, spaceAfter=4
    )
    small_grey = ParagraphStyle(
        'S', fontName='Helvetica', fontSize=9, leading=13,
        textColor=colors.grey, spaceAfter=3
    )
    normal_cyr = ParagraphStyle(
        'NC', fontName='DejaVu', fontSize=11, leading=16, spaceAfter=4
    )
    bold_cyr = ParagraphStyle(
        'BC', fontName='DejaVu-Bold', fontSize=11, leading=16, spaceAfter=4
    )
    small_cyr = ParagraphStyle(
        'SC', fontName='DejaVu', fontSize=9, leading=13,
        textColor=colors.grey, spaceAfter=3
    )

    lines = text.strip().splitlines()
    story = []
    in_anlagen = False
    added_sig = False

    for line in lines:
        s = line.rstrip()
        sl = s.lower().strip()

        if not s.strip():
            story.append(Spacer(1, 8))
            continue

        if sl.startswith('anlagen') and not in_anlagen:
            in_anlagen = True
            story.append(Spacer(1, 12))
            story.append(HRFlowable(
                width='100%', thickness=0.5, color=colors.grey, spaceAfter=8
            ))
            story.append(Paragraph(s.strip(), pick(bold_s, bold_cyr, s)))
            continue

        if in_anlagen:
            story.append(Paragraph(s.strip(), pick(small_grey, small_cyr, s)))
            continue

        if sl.startswith('betreff'):
            story.append(Paragraph(s.strip(), pick(bold_s, bold_cyr, s)))
            continue

        story.append(Paragraph(s.strip(), pick(normal, normal_cyr, s)))

    if not added_sig:
        story.append(Spacer(1, 24))
        story.append(HRFlowable(
            width='40%', thickness=0.5, color=colors.black,
            hAlign='LEFT', spaceAfter=4
        ))
        sig_name = os.environ.get('PDF_SIGNATURE_NAME', '—')
        story.append(Paragraph(sig_name.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'), normal))

    doc.build(story)
    sys.stdout.buffer.write(buf.getvalue())

build_pdf(sys.stdin.read())
`.trimStart();

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"');
}

@Injectable()
export class PdfService implements OnModuleInit {
  private readonly logger = new Logger(PdfService.name);
  private readonly pdfLimit = pLimit(PDF_MAX_CONCURRENT);
  private available = false;

  async onModuleInit(): Promise<void> {
    try {
      writeFileSync(SCRIPT_PATH, PYTHON_SCRIPT, "utf8");
      await this.checkDependencies();
      this.available = true;
      this.logger.log("PDF generation available (python3 + reportlab)");
    } catch (err) {
      this.logger.warn(
        `PDF generation unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private checkDependencies(): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn("python3", ["-c", "import reportlab; print('ok')"]);
      let stderr = "";
      let settled = false;
      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        proc.kill("SIGKILL");
        reject(new Error("python3/reportlab check timed out"));
      }, PDF_CHECK_TIMEOUT_MS);
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        fn();
      };
      proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      proc.on("close", (code) => {
        settle(() => {
          if (code === 0) resolve();
          else reject(new Error(`python3/reportlab check failed: ${stderr}`));
        });
      });
      proc.on("error", (err: Error) => {
        settle(() => reject(err));
      });
    });
  }

  async generateLetterPdf(letterText: string): Promise<Buffer> {
    const plainText = stripHtml(letterText);
    return this.pdfLimit(() => this.spawnPdfGeneration(plainText));
  }

  private spawnPdfGeneration(plainText: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const proc = spawn("python3", [SCRIPT_PATH]);
      const chunks: Buffer[] = [];
      let stderr = "";
      let settled = false;

      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        proc.kill("SIGKILL");
        reject(new Error("PDF generation timed out"));
      }, PDF_GENERATION_TIMEOUT_MS);

      proc.stdout.on("data", (d: Buffer) => chunks.push(d));
      proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      proc.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        if (code === 0) {
          resolve(Buffer.concat(chunks));
        } else {
          reject(new Error(`PDF generation failed: ${stderr}`));
        }
      });
      proc.on("error", (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        reject(new Error(`PDF generation failed: ${err.message}`));
      });

      proc.stdin.write(plainText, "utf8");
      proc.stdin.end();
    });
  }

  isAvailable(): boolean {
    return this.available;
  }
}
