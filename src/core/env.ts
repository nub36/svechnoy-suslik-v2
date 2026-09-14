/**
 * Minimal .env loader (no dependency).
 *
 * Next.js loads .env itself; plain Node workers and CLI scripts do not, so this
 * module is imported first by config.ts to keep behaviour identical everywhere.
 * Real environment variables always win over the file.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

let loaded = false;

export function loadEnvFile(dir: string = process.cwd()): void {
  if (loaded) return;
  loaded = true;

  for (const name of ['.env.local', '.env']) {
    const p = join(dir, name);
    if (!existsSync(p)) continue;
    let content: string;
    try {
      content = readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      // strip matching quotes
      if (
        (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
        (value.startsWith("'") && value.endsWith("'") && value.length > 1)
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}
