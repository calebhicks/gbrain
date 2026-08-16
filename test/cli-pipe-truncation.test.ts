/**
 * v0.43 (#2084) — real-CLI pipe completeness pin (the incident #1959 class).
 *
 * The synthetic flush-mechanism coverage lives in
 * test/flush-then-exit-harness.test.ts (4MB late-reader byte-complete pin).
 * This file keeps the IMPLEMENTATION-AGNOSTIC check: the actual CLI, run the
 * way agents run it (piped stdout), produces complete, parseable, byte-stable
 * output and exits deliberately — well under the teardown backstop.
 */

import { describe, test, expect } from 'bun:test';
import { spawn, spawnSync } from 'child_process';
import { join, resolve } from 'path';

const REPO = resolve(import.meta.dir, '..');
const CLI = join(REPO, 'src', 'cli.ts');
const SLOW_CONSUMER = join(REPO, 'test', 'fixtures', 'slow-json-pipe-consumer.ts');

function runSlowPipeline(): Promise<{
  producerCode: number | null;
  consumerCode: number | null;
  stderr: string;
  receipt: { bytes: number; valid: boolean };
}> {
  return new Promise((resolveOut, reject) => {
    // bash constructs the producer→consumer pipe directly. Wiring the two
    // children through Node's readable.pipe() adds a parent-side buffer that
    // masks the kernel-pipe backpressure this regression exists to exercise.
    const pipeline = spawn('bash', [
      '-o',
      'pipefail',
      '-c',
      '"$1" "$2" --tools-json | "$1" "$3"; codes=("${PIPESTATUS[@]}"); printf "PIPESTATUS:%s,%s\\n" "${codes[0]}" "${codes[1]}" >&2; exit "${codes[1]}"',
      '--',
      'bun',
      CLI,
      SLOW_CONSUMER,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SLOW_PIPE_INITIAL_DELAY_MS: '750',
        SLOW_PIPE_DELAY_MS: '40',
        GBRAIN_SKIP_STARTUP_HOOKS: '1',
        GBRAIN_FLUSH_GRACE_MS: '250',
      },
    });

    let stderr = '';
    let receiptText = '';
    pipeline.stderr.setEncoding('utf-8');
    pipeline.stdout.setEncoding('utf-8');
    pipeline.stderr.on('data', (chunk: string) => (stderr += chunk));
    pipeline.stdout.on('data', (chunk: string) => (receiptText += chunk));

    const timeout = setTimeout(() => {
      pipeline.kill('SIGKILL');
      reject(new Error('slow CLI pipeline did not exit within 60s'));
    }, 60_000);

    pipeline.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    pipeline.on('close', () => {
      clearTimeout(timeout);
      try {
        const receipt = JSON.parse(receiptText.trim()) as { bytes: number; valid: boolean };
        const status = stderr.match(/PIPESTATUS:(\d+),(\d+)/);
        if (!status) throw new Error('missing PIPESTATUS receipt');
        resolveOut({ producerCode: Number(status[1]), consumerCode: Number(status[2]), stderr, receipt });
      } catch (error) {
        reject(new Error(`slow consumer emitted an invalid receipt: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
}

describe('cli pipe completeness — deliberate exit never truncates piped stdout (#2084)', () => {
  test('real CLI: --tools-json over a pipe is complete, parseable, byte-stable, and prompt', () => {
    const run = () => {
      const t0 = Date.now();
      const res = spawnSync('bun', [CLI, '--tools-json'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf-8',
        timeout: 60_000,
        env: { ...process.env, GBRAIN_SKIP_STARTUP_HOOKS: '1' },
        maxBuffer: 64 * 1024 * 1024,
      });
      return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status, ms: Date.now() - t0 };
    };
    const first = run();
    expect(first.status).toBe(0);
    expect(Buffer.byteLength(first.stdout, 'utf-8')).toBeGreaterThan(16 * 1024);
    // Truncated JSON does not parse — the strongest single-run completeness check.
    const parsed = JSON.parse(first.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    // Deliberate exit, not the teardown backstop. A wall-clock bound is flaky
    // on cold CI (bun parse alone runs 10-20s there) — the backstop's banner
    // is the truthful signal, same assertion the pgbouncer e2e uses.
    expect(first.stderr).not.toContain('force-exiting');
    expect(first.stderr).not.toContain('did not return within');

    const second = run();
    expect(second.status).toBe(0);
    expect(second.stdout).toBe(first.stdout);
  }, 180_000);

  test('real CLI: a backpressured JSON consumer receives the complete document (#3423)', async () => {
    const control = spawnSync('bun', [CLI, '--tools-json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: 60_000,
      env: { ...process.env, GBRAIN_SKIP_STARTUP_HOOKS: '1' },
      maxBuffer: 64 * 1024 * 1024,
    });
    const result = await runSlowPipeline();
    expect(control.status, control.stderr).toBe(0);
    expect(result.producerCode, result.stderr).toBe(0);
    expect(result.consumerCode, result.stderr).toBe(0);
    expect(result.receipt.bytes).toBe(Buffer.byteLength(control.stdout, 'utf-8'));
    expect(result.receipt.valid).toBe(true);
  }, 90_000);
});
