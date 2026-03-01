/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per query).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function readMemoryFile(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

function buildPrompt(prompt: string): string {
  const globalMemory = readMemoryFile('/workspace/global/CODEX.md');
  const groupMemory = readMemoryFile('/workspace/group/CODEX.md');

  const parts: string[] = [];
  if (globalMemory) {
    parts.push(`Global CODEX.md:\n${globalMemory}`);
  }
  if (groupMemory) {
    parts.push(`Group CODEX.md:\n${groupMemory}`);
  }

  if (parts.length === 0) return prompt;
  return `${parts.join('\n\n')}\n\nUser message:\n${prompt}`;
}

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

function extractAgentText(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null;
  const value = item as Record<string, unknown>;
  if (typeof value.text === 'string') return value.text;
  if (typeof value.content === 'string') return value.content;
  if (Array.isArray(value.content)) {
    const parts = value.content
      .map((part) => {
        if (!part || typeof part !== 'object') return '';
        const obj = part as Record<string, unknown>;
        if (typeof obj.text === 'string') return obj.text;
        if (typeof obj.content === 'string') return obj.content;
        return '';
      })
      .filter(Boolean);
    if (parts.length > 0) return parts.join('');
  }
  return null;
}

interface CodexRunResult {
  sessionId?: string;
  message?: string;
  error?: string;
}

function runCodexExec(args: string[], promptLabel: string): Promise<CodexRunResult> {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      HOME: '/home/node',
    };

    const child = spawn('codex', args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: '/workspace/group',
    });

    let stdoutBuffer = '';
    let stderrBuffer = '';
    let sessionId: string | undefined;
    let lastMessage: string | undefined;
    let errorMessage: string | undefined;

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        const type = event.type as string | undefined;
        if (type === 'thread.started') {
          const id = event.thread_id ?? (event.thread as Record<string, unknown> | undefined)?.id;
          if (typeof id === 'string') sessionId = id;
        }
        if (type === 'item.completed') {
          const item = event.item as Record<string, unknown> | undefined;
          if (item?.type === 'agent_message') {
            const text = extractAgentText(item);
            if (text) lastMessage = text;
          }
        }
        if (type === 'turn.failed') {
          const error = event.error as Record<string, unknown> | undefined;
          if (typeof error?.message === 'string') {
            errorMessage = error.message;
          }
        }
      } catch (err) {
        log(`Failed to parse codex JSONL (${promptLabel}): ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    child.stdout.on('data', (data: Buffer) => {
      stdoutBuffer += data.toString();
      while (true) {
        const idx = stdoutBuffer.indexOf('\n');
        if (idx === -1) break;
        const line = stdoutBuffer.slice(0, idx);
        stdoutBuffer = stdoutBuffer.slice(idx + 1);
        handleLine(line);
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      stderrBuffer += data.toString();
    });

    child.on('close', (code) => {
      if (stdoutBuffer.trim().length > 0) {
        handleLine(stdoutBuffer.trim());
      }
      if (code !== 0) {
        const fallbackError = stderrBuffer.trim() || `codex exited with code ${code}`;
        resolve({ sessionId, message: lastMessage, error: errorMessage || fallbackError });
        return;
      }
      resolve({ sessionId, message: lastMessage, error: errorMessage });
    });

    child.on('error', (err) => {
      resolve({ sessionId, message: lastMessage, error: err.message });
    });
  });
}

async function runQuery(
  prompt: string,
  sessionId: string | undefined,
): Promise<{ newSessionId?: string; closedDuringQuery: boolean; resultText: string | null; error?: string }> {
  const fullPrompt = buildPrompt(prompt);

  const baseArgs = [
    'exec',
    '--json',
    '--full-auto',
    '--sandbox',
    'workspace-write',
    '--skip-git-repo-check',
    '--cd',
    '/workspace/group',
  ];

  let args: string[];
  if (sessionId) {
    args = [...baseArgs, 'resume', sessionId, fullPrompt];
  } else {
    args = [...baseArgs, fullPrompt];
  }

  log(`Starting codex exec (${sessionId ? 'resume' : 'new'})`);
  let result = await runCodexExec(args, sessionId ? 'resume' : 'new');

  if (result.error && sessionId) {
    const fallbackArgs = sessionId
      ? ['exec', 'resume', sessionId, '--json', '--full-auto', '--sandbox', 'workspace-write', '--skip-git-repo-check', '--cd', '/workspace/group', fullPrompt]
      : ['exec', '--json', '--full-auto', '--sandbox', 'workspace-write', '--skip-git-repo-check', '--cd', '/workspace/group', fullPrompt];

    log('Retrying codex exec with alternate argument order');
    result = await runCodexExec(fallbackArgs, 'retry');
  }

  const closedDuringQuery = false;
  return {
    newSessionId: result.sessionId || sessionId,
    resultText: result.message || null,
    error: result.error || undefined,
    closedDuringQuery,
  };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    // Delete the temp file the entrypoint wrote
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  try {
    while (true) {
      const queryResult = await runQuery(prompt, sessionId);
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }

      if (queryResult.error) {
        writeOutput({
          status: 'error',
          result: null,
          newSessionId: sessionId,
          error: queryResult.error,
        });
      } else {
        writeOutput({
          status: 'success',
          result: queryResult.resultText,
          newSessionId: sessionId,
        });
      }

      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      log('Query ended, waiting for next IPC message...');
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
