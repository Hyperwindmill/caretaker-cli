import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { Tool } from '../types.js';
import { attachmentsDir } from '../../../session/store.js';
import { activeParsers, MAX_OUTPUT_CHARS, extractPdfWithFallback } from './read_document.js';

export const readAttachmentTool: Tool = {
  name: 'read_attachment',
  description:
    'Read the content of a file attached to the current conversation (such as a PDF, Word document, Excel spreadsheet, image, or text file) by specifying its filename ID (e.g. uuid.pdf, uuid.png).',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The filename ID of the attachment (e.g. "uuid.pdf", "uuid.png") as shown in the conversation logs.',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const a = args as { id?: unknown };
    if (typeof a.id !== 'string' || !a.id.trim()) {
      return { content: 'Error: id must be a non-empty string' };
    }
    if (!ctx.sessionId) {
      return { content: 'Error: no active session context' };
    }

    const id = path.basename(a.id); // Prevent path traversal
    const dir = attachmentsDir(ctx.sessionId);
    const filePath = path.join(dir, id);

    let st;
    try {
      st = await stat(filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { content: `Error: attachment not found: ${id}` };
      if (code === 'EACCES') return { content: `Error: permission denied reading attachment: ${id}` };
      return { content: `Error: ${err instanceof Error ? err.message : String(err)}` };
    }

    if (st.isDirectory()) {
      return { content: `Error: attachment ID resolved to a directory: ${id}` };
    }

    const ext = path.extname(filePath).toLowerCase();

    // Route image formats
    if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) {
      let mime = 'image/png';
      if (ext === '.jpg' || ext === '.jpeg') mime = 'image/jpeg';
      else if (ext === '.webp') mime = 'image/webp';
      else if (ext === '.gif') mime = 'image/gif';

      try {
        const buffer = await readFile(filePath);
        ctx.readPaths.add(filePath);
        return {
          content: `Loaded image attachment ${id} (${buffer.length} bytes)`,
          attachments: [
            {
              mime,
              data: buffer,
            },
          ],
        };
      } catch (err) {
        return { content: `Error reading image attachment: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    try {
      const buffer = await readFile(filePath);
      ctx.readPaths.add(filePath);

      let textResult = '';
      const textExtensions = new Set([
        '.txt', '.md', '.markdown', '.csv', '.json', '.js', '.ts', '.tsx', '.jsx',
        '.html', '.css', '.py', '.sh', '.yaml', '.yml', '.xml', '.ini', '.cfg', '.conf'
      ]);

      if (ext === '.pdf') {
        textResult = await extractPdfWithFallback(buffer, filePath, ctx.signal);
      } else if (ext === '.docx') {
        textResult = await activeParsers.extractDocx(buffer);
      } else if (ext === '.xlsx') {
        textResult = await activeParsers.extractXlsx(buffer);
      } else if (textExtensions.has(ext)) {
        textResult = buffer.toString('utf8');
      } else {
        // Fallback to Pandoc if installed
        const isPandoc = await activeParsers.checkPandoc();
        if (isPandoc) {
          const pandocRes = await activeParsers.runPandoc(filePath, ctx.signal);
          if (pandocRes.error) {
            return { content: `Error: pandoc conversion failed: ${pandocRes.error}` };
          }
          textResult = pandocRes.content;
        } else {
          // If no Pandoc, check if it's UTF-8 readable text
          const text = buffer.toString('utf8');
          const isBinary = /[\x00-\x08\x0E-\x1F]/.test(text.slice(0, 1024));
          if (isBinary) {
            return {
              content:
                `Error: unsupported attachment format '${ext}' and pandoc is not installed on this system.\n` +
                `Supported formats: .pdf, .docx, .xlsx, plain text, and common code extensions.\n` +
                `Install pandoc (e.g. 'apt install pandoc') to read other formats.`,
            };
          }
          textResult = text;
        }
      }

      let formatted = textResult;
      if (formatted.length > MAX_OUTPUT_CHARS) {
        formatted =
          formatted.slice(0, MAX_OUTPUT_CHARS) +
          `\n\n[...Output truncated to first ${MAX_OUTPUT_CHARS} characters to fit context limit...]`;
      }

      return { content: formatted };
    } catch (err) {
      return { content: `Error parsing attachment: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};
