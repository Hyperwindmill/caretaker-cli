import { readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import type { Tool } from '../types.js';
import { assertWithinRoot, OutsideRootError } from '../sandbox.js';
import { extractText, getDocumentProxy } from 'unpdf';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';

export const MAX_OUTPUT_CHARS = 150_000; // soft limit (~150 KB of text)

export interface DocumentParsers {
  extractPdf(buffer: Buffer): Promise<string>;
  extractDocx(buffer: Buffer): Promise<string>;
  extractXlsx(buffer: Buffer): Promise<string>;
  checkPandoc(): Promise<boolean>;
  runPandoc(filePath: string, signal?: AbortSignal): Promise<{ content: string; error?: string }>;
  runPdftotext(
    filePath: string,
    signal?: AbortSignal,
  ): Promise<{ content: string; error?: string; notInstalled?: boolean }>;
}

/**
 * unpdf's bundled pdfjs runs `globalThis.navigator ??= {}` at import time.
 * In plain Node the built-in navigator getter returns a real object so the
 * assignment is skipped, but some hosts (VSCode extension host) expose
 * `navigator` as a getter-only property that yields undefined — the strict-mode
 * assignment then throws "Cannot set property navigator ... only a getter".
 * Redefine it as a writable data property before unpdf loads.
 */
export function ensureWritableNavigator(): void {
  if (globalThis.navigator != null) return;
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  if (!desc || desc.set || desc.writable) return; // absent or assignable — unpdf's shim will work
  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: {},
      writable: true,
      configurable: true,
    });
  } catch {
    // Not configurable: nothing we can do; unpdf will surface its own error.
  }
}

const realParsers: DocumentParsers = {
  async extractPdf(buffer: Buffer) {
    ensureWritableNavigator();
    const doc = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(doc, { mergePages: true });
    return text;
  },
  async extractDocx(buffer: Buffer) {
    const { value } = await mammoth.extractRawText({ buffer });
    return value;
  },
  async extractXlsx(buffer: Buffer) {
    const workbook = new ExcelJS.Workbook();
    // ponytail: cast bridges @types/node's Buffer<ArrayBufferLike> vs exceljs's plain Buffer typedef
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    let output = '';
    for (const worksheet of workbook.worksheets) {
      const maxCols = worksheet.columnCount;
      const rowCount = worksheet.rowCount;
      if (maxCols === 0 || rowCount === 0) continue;
      output += `## Sheet: ${worksheet.name}\n\n`;

      // Header row (first row; `cell.text` flattens formulas/dates/rich text to display text)
      const headerRow = worksheet.getRow(1);
      const headers = Array.from({ length: maxCols }, (_, i) => {
        const val = headerRow.getCell(i + 1).text.trim();
        return val !== '' ? val : `Column ${i + 1}`;
      });
      output += `| ${headers.join(' | ')} |\n`;
      output += `| ${headers.map(() => '---').join(' | ')} |\n`;

      // Body rows
      for (let r = 2; r <= rowCount; r++) {
        const row = worksheet.getRow(r);
        const cells = Array.from({ length: maxCols }, (_, i) =>
          row.getCell(i + 1).text.replace(/\r?\n/g, ' ').trim(),
        );
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
    return runCommand('pandoc', ['-t', 'markdown', filePath], signal);
  },
  runPdftotext(
    filePath: string,
    signal?: AbortSignal,
  ): Promise<{ content: string; error?: string; notInstalled?: boolean }> {
    return runCommand('pdftotext', [filePath, '-'], signal);
  },
};

function runCommand(
  cmd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ content: string; error?: string; notInstalled?: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
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
      resolve({
        content: '',
        error: err.message,
        notInstalled: (err as NodeJS.ErrnoException).code === 'ENOENT',
      });
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
}

/**
 * Try unpdf first; if it throws on a PDF the bundled pdfjs cannot handle,
 * fall back to pdftotext (poppler) if installed. Pandoc is not an option
 * here: it can only write PDFs, not read them.
 */
export async function extractPdfWithFallback(
  buffer: Buffer,
  filePath: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    return await activeParsers.extractPdf(buffer);
  } catch (unpdfErr) {
    const res = await activeParsers.runPdftotext(filePath, signal);
    if (!res.error) return res.content;
    if (res.notInstalled) throw unpdfErr;
    throw new Error(
      `unpdf failed (${unpdfErr instanceof Error ? unpdfErr.message : String(unpdfErr)})` +
        ` and pdftotext fallback also failed: ${res.error}`,
    );
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
    'For PDFs, falls back to the system pdftotext (poppler) if the native parser (unpdf/pdfjs) fails. ' +
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
      } else if (ext === '.xlsx') {
        const buffer = await readFile(abs);
        textResult = await activeParsers.extractXlsx(buffer);
      } else {
        // Fallback to Pandoc
        const isPandoc = await activeParsers.checkPandoc();
        if (!isPandoc) {
          return {
            content:
              `Error: unsupported format '${ext}' and pandoc is not installed on this system.\n` +
              `Supported formats out-of-the-box: .pdf, .docx, .xlsx.\n` +
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
