#!/usr/bin/env node
// Interactive front-end for `claude --print --input-format stream-json`.
//
// The real TUI needs Bun.ant.CellSegmenter (Anthropic's private Bun fork) and cannot run on
// stock Bun. The stream-json session mode is a full multi-turn conversation with no renderer
// involved, so a line-oriented client on top of it gets an interactive Claude Code on Termux.
const { spawn } = require('child_process');
const readline = require('readline');

const CLI = process.env.CLAUDE_REPL_CLI || 'claude-bun';
const child = spawn(CLI, [
  '-p', '--verbose',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--include-partial-messages',
  ...process.argv.slice(2),
], { stdio: ['pipe', 'pipe', 'inherit'] });

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: bold('> ') });
let busy = false;
let atLineStart = true;
let ended = false;
let announced = false;
let aborting = false;
const queued = [];

const write = (s) => {
  if (!s) return;
  process.stdout.write(s);
  atLineStart = s.endsWith('\n');
};
const line = (s) => write((atLineStart ? '' : '\n') + s + '\n');

const send = (text) => {
  busy = true;
  child.stdin.write(JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  }) + '\n');
};

const preview = (v, n = 90) => {
  const s = (typeof v === 'string' ? v : JSON.stringify(v) || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
};

const handle = (msg) => {
  switch (msg.type) {
    case 'system':
      // init repeats on every turn; the session itself persists, so announce it once.
      if (msg.subtype === 'init' && !announced) {
        announced = true;
        line(dim(`${msg.model} · ${msg.cwd || ''} · /exit to quit`));
      }
      return;
    case 'stream_event': {
      const e = msg.event || {};
      if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') write(e.delta.text);
      if (e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta') write(dim(e.delta.thinking));
      return;
    }
    case 'assistant':
      for (const c of msg.message?.content || []) {
        if (c.type === 'tool_use') line(dim(`⚒ ${c.name} ${preview(c.input?.command ?? c.input?.file_path ?? c.input?.pattern ?? c.input)}`));
      }
      return;
    case 'user':
      for (const c of msg.message?.content || []) {
        if (c.type !== 'tool_result') continue;
        const body = Array.isArray(c.content) ? c.content.map((b) => b.text || `[${b.type}]`).join(' ') : c.content;
        line(dim(`  ${c.is_error ? '✗' : '→'} ${preview(body)}`));
      }
      return;
    case 'result':
      if (aborting) line(dim('(interrupted)'));
      else if (msg.is_error) line(`\x1b[31m${msg.subtype}: ${preview(msg.result, 300)}\x1b[0m`);
      aborting = false;
      busy = false;
      if (queued.length) send(queued.shift());
      else if (ended) child.stdin.end();
      else rl.prompt();
      return;
  }
};

let buf = '';
child.stdout.on('data', (chunk) => {
  buf += chunk;
  const parts = buf.split('\n');
  buf = parts.pop();
  for (const p of parts) {
    if (!p.trim()) continue;
    try { handle(JSON.parse(p)); } catch { line(dim(p)); }
  }
});

rl.on('line', (text) => {
  if (!text.trim()) return rl.prompt();
  if (['/exit', '/quit'].includes(text.trim())) return rl.close();
  if (busy) queued.push(text);
  else send(text);
});
rl.on('close', () => {
  ended = true;
  if (!busy && !queued.length) child.stdin.end();
});
child.on('exit', (code) => { rl.close(); process.exit(code ?? 0); });
// readline swallows Ctrl-C on a TTY and emits its own event, so both lanes are needed.
const onInterrupt = () => {
  if (!busy) return rl.close();
  aborting = true;
  queued.length = 0;
  child.stdin.write(JSON.stringify({
    type: 'control_request',
    request_id: `interrupt-${Date.now()}`,
    request: { subtype: 'interrupt' },
  }) + '\n');
};
rl.on('SIGINT', onInterrupt);
process.on('SIGINT', onInterrupt);
