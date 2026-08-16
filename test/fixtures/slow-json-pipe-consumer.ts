/**
 * Content-free slow pipe consumer for cli-pipe-truncation.test.ts.
 *
 * Reads stdin slowly enough to keep the producer's stdout backpressured, then
 * reports only byte count + JSON validity. Never echoes the payload.
 */

export {};

const delayMs = Math.max(0, Number(process.env.SLOW_PIPE_DELAY_MS ?? 40));
const initialDelayMs = Math.max(0, Number(process.env.SLOW_PIPE_INITIAL_DELAY_MS ?? 0));
const chunks: Buffer[] = [];

let first = true;
for await (const chunk of Bun.stdin.stream()) {
  chunks.push(Buffer.from(chunk));
  if (first && initialDelayMs > 0) {
    first = false;
    await Bun.sleep(initialDelayMs);
  }
  if (delayMs > 0) await Bun.sleep(delayMs);
}

const body = Buffer.concat(chunks);
let valid = false;
try {
  JSON.parse(body.toString('utf-8'));
  valid = true;
} catch {
  // The receipt below is the entire diagnostic surface; payload stays private.
}

process.stdout.write(`${JSON.stringify({ bytes: body.length, valid })}\n`);
process.exitCode = valid ? 0 : 1;
