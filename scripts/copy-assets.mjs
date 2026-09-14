/** Copy non-TS runtime assets (schema.sql) into dist/. */
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

mkdirSync(join('dist', 'db'), { recursive: true });
copyFileSync(join('src', 'db', 'schema.sql'), join('dist', 'db', 'schema.sql'));
console.log('[assets] copied src/db/schema.sql -> dist/db/schema.sql');
