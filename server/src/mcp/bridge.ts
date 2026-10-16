#!/usr/bin/env node
/**
 * agentdeck-mcp — standalone MCP stdio bridge for AgentDeck.
 *
 * Hand-rolled JSON-RPC 2.0 / MCP server (no SDK dependency). Register this
 * binary as an MCP server in Claude Code, ZCode or Antigravity and that agent
 * can delegate work to any other agent on this machine.
 *
 * Environment:
 *   AGENTDECK_URL          base URL of the AgentDeck server (default http://127.0.0.1:<port>)
 *   AGENTDECK_PORT         server port if AGENTDECK_URL unset (default 8787)
 *   AGENTDECK_BRIDGE_TOKEN bridge token; falls back to <dataDir>/bridge-token
 *   AGENTDECK_DATA_DIR     data dir (default ~/.local/share/agentdeck)
 *
 * Tools:
 *   agentdeck_list_agents                      → available agents + capabilities
 *   agentdeck_delegate {agent, prompt, ...}    → run a turn, returns final text
 *   agentdeck_project_files {project?, path?}  → file listing
 */
import { createInterface } from 'node:readline';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AGENT_IDS } from '@agentdeck/shared';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_NAME = 'agentdeck-mcp';
const SERVER_VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// Configuration (resolved without importing server modules — stays standalone)
// ---------------------------------------------------------------------------

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

interface BridgeConfig {
  baseUrl: string;
  token: string | undefined;
  dataDir: string;
}

function resolveConfig(): BridgeConfig {
  const dataDir = expandHome(process.env.AGENTDECK_DATA_DIR || '~/.local/share/agentdeck');
  let port = Number(process.env.AGENTDECK_PORT);
  if (!Number.isFinite(port) || port <= 0) {
    try {
      const configFile = expandHome(process.env.AGENTDECK_CONFIG || '~/.config/agentdeck/config.json');
      const cfg = JSON.parse(readFileSync(configFile, 'utf8')) as {
        port?: number;
      };
      if (typeof cfg.port === 'number' && cfg.port > 0) port = cfg.port;
    } catch {
      // ignore missing config
    }
    if (!Number.isFinite(port) || port <= 0) port = 8787;
  }
  const baseUrl = (process.env.AGENTDECK_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, '');
  let token: string | undefined = process.env.AGENTDECK_BRIDGE_TOKEN;
  if (!token) {
    try {
      token = readFileSync(join(dataDir, 'bridge-token'), 'utf8').trim() || undefined;
    } catch {
      token = undefined;
    }
  }
  return { baseUrl, token, dataDir };
}

const CONFIG: BridgeConfig = resolveConfig();

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

interface RpcMessage {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

function send(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function respond(id: unknown, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id: unknown, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

// ---------------------------------------------------------------------------
// AgentDeck REST calls
// ---------------------------------------------------------------------------

async function apiCall(path: string, init: RequestInit = {}): Promise<unknown> {
  if (!CONFIG.token) {
    throw new Error('bridge token not found — start the AgentDeck server first');
  }
  const res = await fetch(`${CONFIG.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${CONFIG.token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: { message: text.slice(0, 500) } };
  }
  if (!res.ok) {
    throw new Error(readErrorMessage(body) ?? `HTTP ${res.status} from ${path}`);
  }
  return body;
}

function readErrorMessage(body: unknown): string | undefined {
  if (body !== null && typeof body === 'object' && 'error' in body) {
    const err = (body as { error?: unknown }).error;
    if (err !== null && typeof err === 'object') {
      const message = (err as { message?: unknown }).message;
      if (typeof message === 'string') return message;
    }
  }
  return undefined;
}

interface ApiAgent {
  id?: unknown;
  label?: unknown;
  available?: unknown;
  reason?: unknown;
  version?: unknown;
  capabilities?: Record<string, unknown>;
}

interface ApiFileEntry {
  kind?: unknown;
  path?: unknown;
  size?: unknown;
}

interface ApiRunResult {
  ok?: unknown;
  text?: unknown;
  error?: unknown;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'agentdeck_list_agents',
    description:
      'List all coding agents registered on this machine via AgentDeck (Claude Code, ZCode, Antigravity, Codex, OpenCode) with availability and capabilities.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'agentdeck_delegate',
    description:
      'Delegate a task to another coding agent on this machine. Runs the prompt as a full turn and returns the agent’s final assistant text. Use agentdeck_list_agents first to see who is available.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          enum: [...AGENT_IDS],
          description: 'Which agent should run the task.',
        },
        prompt: { type: 'string', description: 'The task/prompt for the agent.' },
        project: {
          type: 'string',
          description: 'Project id or name to work in. Defaults to the "bridge" project.',
        },
        model: { type: 'string', description: 'Optional model override.' },
        timeoutMs: {
          type: 'number',
          description: 'Optional run timeout in milliseconds (default 600000).',
        },
      },
      required: ['agent', 'prompt'],
    },
  },
  {
    name: 'agentdeck_project_files',
    description:
      'List files of an AgentDeck project (sandboxed to the project directory). Pass path:"" for the project root.',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project id or name. Defaults to the "bridge" project.',
        },
        path: { type: 'string', description: 'Subdirectory to list (relative to project root).' },
      },
      additionalProperties: false,
    },
  },
];

function textResult(text: string, isError = false): Record<string, unknown> {
  const result: Record<string, unknown> = { content: [{ type: 'text', text }] };
  if (isError) result['isError'] = true;
  return result;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (name === 'agentdeck_list_agents') {
    const agents = (await apiCall('/api/bridge/agents')) as ApiAgent[];
    const lines = (Array.isArray(agents) ? agents : []).map((a) => {
      const caps = Object.entries(a.capabilities ?? {})
        .filter(([, v]) => v === true)
        .map(([k]) => k)
        .join(', ');
      const parts = [
        `- ${String(a.id)} (${String(a.label)}) — ${a.available ? 'available' : 'unavailable'}`,
        typeof a.reason === 'string' ? ` (${a.reason})` : '',
        caps ? `; capabilities: ${caps}` : '',
        typeof a.version === 'string' ? `; version ${a.version}` : '',
      ];
      return parts.join('');
    });
    return textResult(lines.join('\n') || 'No agents configured.');
  }

  if (name === 'agentdeck_delegate') {
    const body: Record<string, unknown> = {
      agent: args['agent'],
      prompt: args['prompt'],
      ...(args['project'] !== undefined ? { project: args['project'] } : {}),
      ...(args['model'] !== undefined ? { model: args['model'] } : {}),
      ...(args['timeoutMs'] !== undefined ? { timeoutMs: args['timeoutMs'] } : {}),
    };
    const result = (await apiCall('/api/bridge/run', {
      method: 'POST',
      body: JSON.stringify(body),
    })) as ApiRunResult;
    if (result && result.ok === true) {
      return textResult(String(result.text || '(agent returned no text)'));
    }
    return textResult(`Delegation failed: ${String(result?.error || 'unknown error')}`, true);
  }

  if (name === 'agentdeck_project_files') {
    const params = new URLSearchParams();
    if (args['project'] !== undefined) params.set('project', String(args['project']));
    params.set('path', args['path'] !== undefined ? String(args['path']) : '');
    const entries = (await apiCall(`/api/bridge/files?${params.toString()}`)) as ApiFileEntry[];
    const lines = (Array.isArray(entries) ? entries : []).map((e) => {
      const marker = e.kind === 'dir' ? '[dir] ' : '      ';
      const size = e.size !== undefined ? ` (${String(e.size)} B)` : '';
      return `${marker}${String(e.path)}${size}`;
    });
    return textResult(lines.join('\n') || '(empty directory)');
  }

  throw new Error(`Unknown tool: ${name}`);
}

// ---------------------------------------------------------------------------
// MCP method dispatch
// ---------------------------------------------------------------------------

async function handle(message: RpcMessage): Promise<void> {
  const { id, method, params } = message;
  if (id === undefined || id === null) return; // notification from client

  switch (method) {
    case 'initialize':
      respond(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;
    case 'ping':
      respond(id, {});
      return;
    case 'tools/list':
      respond(id, { tools: TOOLS });
      return;
    case 'tools/call': {
      const toolName = String(params?.['name'] ?? '');
      const args = (params?.['arguments'] as Record<string, unknown> | undefined) ?? {};
      try {
        respond(id, await callTool(toolName, args));
      } catch (err) {
        respond(id, textResult(`AgentDeck bridge error: ${errorText(err)}`, true));
      }
      return;
    }
    case 'resources/list':
      respond(id, { resources: [] });
      return;
    case 'prompts/list':
      respond(id, { prompts: [] });
      return;
    default:
      respondError(id, -32601, `Method not found: ${method ?? '(none)'}`);
  }
}

function main(): void {
  if (!existsSync(join(CONFIG.dataDir, 'bridge-token')) && !process.env.AGENTDECK_BRIDGE_TOKEN) {
    process.stderr.write(
      '[agentdeck-mcp] warning: no bridge token found; start the AgentDeck server first (tools will fail until then)\n',
    );
  }
  process.stderr.write(`[agentdeck-mcp] bridging to ${CONFIG.baseUrl}\n`);

  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: RpcMessage;
    try {
      message = JSON.parse(trimmed) as RpcMessage;
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (message === null || typeof message !== 'object' || typeof message.method !== 'string') {
      if (message && message.id !== undefined) {
        respondError(message.id, -32600, 'Invalid Request');
      }
      return;
    }
    if (message.method.startsWith('notifications/')) {
      return; // notifications never get a response
    }
    handle(message).catch((err) => {
      if (message.id !== undefined && message.id !== null) {
        respondError(message.id, -32603, `Internal error: ${errorText(err)}`);
      }
    });
  });
  rl.on('close', () => process.exit(0));
}

main();
