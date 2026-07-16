import { readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import type { Tool } from '../types.js';
import { assertWithinRoot, OutsideRootError } from '../sandbox.js';
import { extractText, getDocumentProxy } from 'unpdf';
import mammoth from 'mammoth';
import { read as readXlsx, utils as xlsxUtils } from 'xlsx/xlsx.mjs';

export const MAX_OUTPUT_CHARS = 150_000; // soft limit (~150 KB of text)

export interface DocumentParsers {
  extractPdf(buffer: Buffer): Promise<string>;
  extractDocx(buffer: Buffer): Promise<string>;
  extractXlsx(buffer: Buffer): Promise<string>;
  checkPandoc(): Promise<boolean>;
  runPandoc(filePath: string, signal?: AbortSignal): Promise<{ content: string; error?: string }>;
}

const realParsers: DocumentParsers = {
  async extractPdf(buffer: Buffer) {
    const doc = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(doc, { mergePages: true });
    return text;
  },
  async extractDocx(buffer: Buffer) {
    const { value } = await mammoth.extractRawText({ buffer });
    return value;
  },
  async extractXlsx(buffer: Buffer) {
    const workbook = readXlsx(buffer);
    let output = '';
    for (const sheetName of workbook.SheetNames) {
      const worksheet = workbook.Sheets[sheetName];
      if (!worksheet) continue;
      const rows = xlsxUtils.sheet_to_json<unknown[]>(worksheet, { header: 1 });
      if (rows.length === 0) continue;
      output += `## Sheet: ${sheetName}\n\n`;

      // Construct Markdown Table
      const maxCols = Math.max(...rows.map((r) => (r ? r.length : 0)));
      if (maxCols === 0) continue;

      // Header row (using the first row, pad if needed)
      const firstRow = rows[0] || [];
      const headers = Array.from({ length: maxCols }, (_, i) => {
        const val = firstRow[i];
        return val !== undefined && val !== null ? String(val).trim() : `Column ${i + 1}`;
      });
      output += `| ${headers.join(' | ')} |\n`;
      output += `| ${headers.map(() => '---').join(' | ')} |\n`;

      // Body rows
      for (let r = 1; r < rows.length; r++) {
        const row = rows[r] || [];
        const cells = Array.from({ length: maxCols }, (_, i) => {
          const val = row[i];
          return val !== undefined && val !== null
            ? String(val).replace(/\r?\n/g, ' ').trim()
            : '';
        });
        output += `| ${cells.join(' | ')} |\n`;
      }
      output += '\n';
    }
    return output;
  },
  checkPandoc(): Promise<boolean> {
    return new Promise((resolve) => {
      const p = spawn('pandoc', ['--version']);
      p.on('error', () => resolve(false));
      p.on('close', (code) => resolve(code === 0));
    });
  },
  runPandoc(filePath: string, signal?: AbortSignal): Promise<{ content: string; error?: string }> {
    return new Promise((resolve) => {
      const child = spawn('pandoc', ['-t', 'markdown', filePath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      const onAbort = () => {
        child.kill('SIGTERM');
      };
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      child.on('error', (err) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve({ content: '', error: err.message });
      });

      child.on('close', (code) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        if (code === 0) {
          resolve({ content: stdout });
        } else {
          resolve({ content: '', error: stderr.trim() || `Exit code ${code}` });
        }
      });
    });
  },
};

/**
 * Try unpdf first; if it throws on a PDF the bundled pdfjs cannot handle,
 * fall back to pandoc if installed. Requires the file path for pandoc invocation.
 */
export async function extractPdfWithFallback(
  buffer: Buffer,
  filePath: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    return await activeParsers.extractPdf(buffer);
  } catch (unpdfErr) {
    const isPandoc = await activeParsers.checkPandoc();
    if (isPandoc) {
      const pandocRes = await activeParsers.runPandoc(filePath, signal);
      if (pandocRes.error) {
        throw new Error(
          `unpdf failed (${unpdfErr instanceof Error ? unpdfErr.message : String(unpdfErr)})` +
            ` and pandoc fallback also failed: ${pandocRes.error}`,
        );
      }
      return pandocRes.content;
    }
    throw unpdfErr;
  }
}

export let activeParsers: DocumentParsers = realParsers;

/** Testing seam: inject mock document parsers. Pass `null` to restore real implementations. */
export function __setDocumentParsers(impl: DocumentParsers | null): void {
  activeParsers = impl ?? realParsers;
}

export const readDocumentTool: Tool = {
  name: 'read_document',
  description:
    'Read a PDF, DOCX (Word), or XLSX/XLS (Excel) file natively, extracting its text content. ' +
    'For PDFs, falls back to pandoc if the native parser (unpdf/pdfjs) fails. ' +
    'For other document formats (e.g. EPUB, ODT, RTF), it will try to use the system pandoc command if installed.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path within the working directory.' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const a = args as { path?: unknown };
    if (typeof a.path !== 'string' || !a.path.trim()) {
      return { content: 'Error: path must be a non-empty string' };
    }

    let abs: string;
    try {
      abs = assertWithinRoot(ctx.workingDir, a.path);
    } catch (err) {
      if (err instanceof OutsideRootError) return { content: `Error: ${err.message}` };
      throw err;
    }

    let st;
    try {
      st = await stat(abs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { content: `Error: file not found: ${a.path}` };
      if (code === 'EACCES') return { content: `Error: permission denied: ${a.path}` };
      return { content: `Error: ${err instanceof Error ? err.message : String(err)}` };
    }

    if (st.isDirectory()) {
      return { content: `Error: path is a directory: ${a.path}` };
    }

    const ext = path.extname(abs).toLowerCase();
    let textResult = '';

    try {
      if (ext === '.pdf') {
        const buffer = await readFile(abs);
        textResult = await extractPdfWithFallback(buffer, abs, ctx.signal);
      } else if (ext === '.docx') {
        const buffer = await readFile(abs);
        textResult = await activeParsers.extractDocx(buffer);
      } else if (ext === '.xlsx' || ext === '.xls') {
        const buffer = await readFile(abs);
        textResult = await activeParsers.extractXlsx(buffer);
      } else {
        // Fallback to Pandoc
        const isPandoc = await activeParsers.checkPandoc();
        if (!isPandoc) {
          return {
            content:
              `Error: unsupported format '${ext}' and pandoc is not installed on this system.\n` +
              `Supported formats out-of-the-box: .pdf, .docx, .xlsx, .xls.\n` +
              `Please install pandoc (e.g. 'sudo apt install pandoc' or 'brew install pandoc') to read '${ext}' files.`,
          };
        }

        const pandocRes = await activeParsers.runPandoc(abs, ctx.signal);
        if (pandocRes.error) {
          return { content: `Error: pandoc conversion failed: ${pandocRes.error}` };
        }
        textResult = pandocRes.content;
      }
    } catch (err) {
      return { content: `Error parsing document: ${err instanceof Error ? err.message : String(err)}` };
    }

    ctx.readPaths.add(abs);

    let formatted = textResult;
    if (formatted.length > MAX_OUTPUT_CHARS) {
      formatted =
        formatted.slice(0, MAX_OUTPUT_CHARS) +
        `\n\n[...Output truncated to first ${MAX_OUTPUT_CHARS} characters to fit context limit...]`;
    }

    return { content: formatted };
  },
};
