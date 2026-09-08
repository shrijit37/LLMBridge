import { exec } from 'node:child_process';
import type { Provider } from '../config/types.js';

/**
 * Runs a provider's configured quota command using `sh -lc` with a 15-second timeout,
 * passing provider context as environment variables:
 * - `_API_KEY`: resolved API key
 * - `_BASE_URL`: provider base URL
 * - `_PROVIDER`: provider ID
 */
export function runQuotaCommand(
  command: string,
  provider: Provider,
  apiKey: string,
  timeoutMs = 15000
): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();

  const env = {
    ...process.env,
    _API_KEY: apiKey,
    _BASE_URL: provider.baseUrl,
    _PROVIDER: provider.id,
  };

  exec(
    command,
    {
      shell: '/bin/sh',
      timeout: timeoutMs,
      env,
      maxBuffer: 1024 * 1024,
    },
    (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Quota command failed: ${error.message} ${stderr}`));
        return;
      }
      resolve(stdout.trim());
    }
  );

  return promise;
}
