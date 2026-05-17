/**
 * Interactive REPL for the NanoClaw CLI channel.
 *
 *   pnpm run repl
 *
 * Opens a persistent connection to data/cli.sock. Each line you type is sent
 * as one message; replies stream back as they arrive. Ctrl-D or Ctrl-C exits.
 */
import net from 'net';
import path from 'path';
import readline from 'readline';

import { DATA_DIR } from '../src/config.js';

const PROMPT = '> ';

function socketPath(): string {
  return path.join(DATA_DIR, 'cli.sock');
}

function main(): void {
  const sock = net.connect(socketPath());

  sock.on('error', (err) => {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') {
      console.error(`NanoClaw daemon not reachable at ${socketPath()}.`);
      console.error('Start the service (launchctl/systemd) before running repl.');
    } else {
      console.error('CLI socket error:', err);
    }
    process.exit(2);
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: PROMPT });

  sock.on('connect', () => rl.prompt());

  let buf = '';
  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (typeof msg.text === 'string') {
          // Clear the current prompt line, print the reply, redraw the prompt
          // with whatever the user has already typed.
          readline.cursorTo(process.stdout, 0);
          readline.clearLine(process.stdout, 0);
          process.stdout.write(msg.text + '\n');
          rl.prompt(true);
        }
      } catch {
        // Ignore non-JSON lines.
      }
    }
  });

  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) {
      rl.prompt();
      return;
    }
    sock.write(JSON.stringify({ text }) + '\n');
    // Don't re-prompt yet — wait for replies to come back first. The data
    // handler will redraw the prompt after printing each reply.
  });

  rl.on('close', () => {
    sock.end();
    process.exit(0);
  });

  sock.on('close', () => {
    rl.close();
    process.exit(0);
  });
}

main();
