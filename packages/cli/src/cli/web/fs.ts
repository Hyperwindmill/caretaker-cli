import { Hono } from 'hono';
import { readdir } from 'node:fs/promises';
import { join, normalize, resolve } from 'node:path';

export const fsRouter = new Hono();

fsRouter.get('/ls', async (c) => {
  try {
    const rawPath = c.req.query('path');

    // Default to root (/) or primary Windows drive (C:\) if path is omitted
    let targetPath = rawPath ? resolve(normalize(rawPath)) : '/';

    if (!rawPath && process.platform === 'win32') {
      targetPath = 'C:\\';
    }

    const entries = await readdir(targetPath, { withFileTypes: true });
    const directories: { name: string; path: string }[] = [];

    for (const entry of entries) {
      // Skip hidden folders starting with "." (e.g. .git, .vscode, .atl)
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        directories.push({
          name: entry.name,
          path: join(targetPath, entry.name),
        });
      }
    }

    // Sort folders alphabetically for better UX
    directories.sort((a, b) => a.name.localeCompare(b.name));

    return c.json({
      currentPath: targetPath,
      directories,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg, directories: [], currentPath: null }, 400);
  }
});
