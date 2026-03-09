import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const relayUrl = process.env.RELAY_URL ?? 'ws://127.0.0.1:7777';
const testFileDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testFileDir, '..');

function runCompose(args: string[]): void {
  execFileSync('docker', ['compose', ...args], {
    cwd: projectRoot,
    stdio: 'inherit'
  });
}

function connectOnce(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);

    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`Timed out connecting to relay at ${url}`));
    }, 8_000);

    ws.once('open', () => {
      clearTimeout(timer);
      ws.close();
      resolve();
    });

    ws.once('error', (error) => {
      clearTimeout(timer);
      ws.terminate();
      reject(error);
    });
  });
}

async function waitForRelay(url: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await connectOnce(url);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  throw lastError ?? new Error(`Relay did not become reachable at ${url}`);
}

describe('strfry relay', () => {
  beforeEach(async () => {
    runCompose(['down', '-v', '--remove-orphans']);
    runCompose(['up', '-d', '--force-recreate']);
    await waitForRelay(relayUrl);
  });

  afterEach(() => {
    runCompose(['down', '-v', '--remove-orphans']);
  });

  it('accepts websocket connections', async () => {
    await expect(connectOnce(relayUrl)).resolves.toBeUndefined();
  });
});
