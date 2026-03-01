/**
 * Step: codex-login — Interactive device auth for Codex CLI.
 */
import { execSync } from 'child_process';

import { logger } from '../src/logger.js';
import { commandExists } from './platform.js';
import { emitStatus } from './status.js';

export async function run(_args: string[]): Promise<void> {
  logger.info('Starting Codex login');

  if (!commandExists('codex')) {
    emitStatus('CODEX_LOGIN', {
      STATUS: 'failed',
      ERROR: 'codex_cli_not_found',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  try {
    execSync('codex login --device-auth', { stdio: 'inherit' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitStatus('CODEX_LOGIN', {
      STATUS: 'failed',
      ERROR: message,
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  try {
    execSync('codex login status', { stdio: 'ignore' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitStatus('CODEX_LOGIN', {
      STATUS: 'failed',
      ERROR: message,
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  emitStatus('CODEX_LOGIN', {
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
