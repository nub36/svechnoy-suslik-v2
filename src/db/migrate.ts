import { closeDb, getDb, migrate } from './index';
import { createLogger } from '../core/logger';

async function main(): Promise<void> {
  const log = createLogger('migrate');
  const db = getDb();
  await migrate(db);
  log.info('schema applied');
  await closeDb();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[migrate] failed:', err);
    process.exit(1);
  });
}
