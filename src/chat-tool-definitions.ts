import type { ModelToolDefinition } from './model-gateway.js';
import { LOAD_SKILL_TOOL_DEFINITION } from './skill-tool.js';
import { DELEGATE_READ_TOOL_DEFINITION, DELEGATE_TASK_TOOL_DEFINITION, DELEGATE_WRITE_TOOL_DEFINITION } from './read-only-subagent.js';

export const WRITE_FILE_TOOL_DEFINITION: ModelToolDefinition = {
  type: 'function',
  function: {
    name: 'write_file',
    description: 'Create or overwrite a UTF-8 text file inside the current workspace. Paths are relative to the workspace root. Requires user approval in strict mode.',
    parameters: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  },
};
export const EDIT_FILE_TOOL_DEFINITION: ModelToolDefinition = {
  type: 'function',
  function: {
    name: 'edit_file',
    description: 'Replace one exact text span in a UTF-8 workspace file. old_string must match exactly once in the file (include enough surrounding lines to make it unique). Prefer this over write_file for changing part of an existing file.',
    parameters: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] },
  },
};
export const READ_ONLY_WORKSPACE_TOOLS: ReadonlySet<string> = new Set(['read_file', 'list_dir']);
export const CHAT_TOOL_DEFINITIONS: ModelToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 text file inside the current workspace. Paths are relative to the workspace root. Fails on directories; use list_dir for those.',
      parameters: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List the entries (files and directories) of a directory inside the current workspace. Use "." for the workspace root.',
      parameters: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', default: '.' } } },
    },
  },
  WRITE_FILE_TOOL_DEFINITION,
  EDIT_FILE_TOOL_DEFINITION,
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the public web (Brave when configured, otherwise DuckDuckGo) and return titles, URLs, and short descriptions. Requires user approval outside auto mode. Use web_fetch to read a result in full. For Weibo hot search, web_fetch https://s.weibo.com/top/summary directly instead of searching.',
      parameters: { type: 'object', additionalProperties: false, properties: { query: { type: 'string' }, count: { type: 'integer', minimum: 1, maximum: 10, default: 5 } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch a public http(s) web page and return its readable text (truncated to 20000 characters). Private, local, and credentialed URLs are refused. Requires user approval outside auto mode.',
      parameters: { type: 'object', additionalProperties: false, properties: { url: { type: 'string' } }, required: ['url'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_open',
      description: 'Open a public http(s) page in an agent-controlled browser. mode "visible" (default) shows a real Edge window the user can watch; mode "headless" runs without a window; mode "shared" operates on the page the user sees in the Hiero desktop browser panel (same login session), and needs the desktop shell. Returns the page title and URL. Fails on HTTP status 400 or above.',
      parameters: { type: 'object', additionalProperties: false, properties: { url: { type: 'string' }, mode: { type: 'string', enum: ['visible', 'headless', 'shared'] } }, required: ['url'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_snapshot',
      description: 'Return the accessibility tree of the current agent-browser page (roles, names, states). Use it to find elements before clicking or typing.',
      parameters: { type: 'object', additionalProperties: false, properties: { mode: { type: 'string', enum: ['visible', 'headless', 'shared'] } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description: 'Report the current agent-browser page URL, title and the screenshot byte size. The image itself is not returned; use browser_snapshot for the page structure.',
      parameters: { type: 'object', additionalProperties: false, properties: { mode: { type: 'string', enum: ['visible', 'headless', 'shared'] } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'headless_extract',
      description: 'Load a public page in the headless browser and return its visible text. Use it for bulk extraction where no human needs to watch.',
      parameters: { type: 'object', additionalProperties: false, properties: { url: { type: 'string' } }, required: ['url'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description: 'Click an element in the agent-browser page, identified by its ARIA role and exact accessible name (from browser_snapshot). Requires user approval for each click.',
      parameters: { type: 'object', additionalProperties: false, properties: { mode: { type: 'string', enum: ['visible', 'headless', 'shared'] }, role: { type: 'string' }, name: { type: 'string' } }, required: ['role', 'name'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description: 'Type text into an input identified by its ARIA role and exact accessible name (from browser_snapshot). Requires user approval for each input.',
      parameters: { type: 'object', additionalProperties: false, properties: { mode: { type: 'string', enum: ['visible', 'headless', 'shared'] }, role: { type: 'string' }, name: { type: 'string' }, text: { type: 'string' } }, required: ['role', 'name', 'text'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_recall',
      description: 'Search long-term memory (layer 2) for entries relevant to a query. Use when earlier decisions, user preferences, or project facts may matter.',
      parameters: { type: 'object', additionalProperties: false, properties: { query: { type: 'string' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_remember',
      description: 'Store one short fact, preference, or decision in long-term memory (layer 2, max 500 characters). Use scope "project" for workspace facts and "global" for user-wide preferences. Set source to "user" when the user stated it, or "inferred" when you derived it yourself. Set session_only to true to keep it for this conversation only.',
      parameters: { type: 'object', additionalProperties: false, properties: { content: { type: 'string' }, scope: { type: 'string', enum: ['global', 'project'] }, tags: { type: 'array', items: { type: 'string' } }, source: { type: 'string', enum: ['user', 'inferred'] }, session_only: { type: 'boolean' } }, required: ['content', 'scope'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_append',
      description: 'Append a line to the always-injected memory file (layer 0 global rules or layer 1 project memory). Only call this when the user explicitly asks to save a rule; never on your own initiative. Append only; existing content cannot be rewritten or removed.',
      parameters: { type: 'object', additionalProperties: false, properties: { content: { type: 'string' }, scope: { type: 'string', enum: ['global', 'project'] } }, required: ['content', 'scope'] },
    },
  },
  LOAD_SKILL_TOOL_DEFINITION,
  DELEGATE_READ_TOOL_DEFINITION,
  DELEGATE_WRITE_TOOL_DEFINITION,
  DELEGATE_TASK_TOOL_DEFINITION,
];

/** update_plan is handled by the runtime, not the tool gateway. It only records the plan for the UI and needs no approval. */
export const UPDATE_PLAN_TOOL_DEFINITION: ModelToolDefinition = {
  type: 'function',
  function: {
    name: 'update_plan',
    description: 'Publish or revise the step plan for a multi-step task so the user can follow progress. Call it once at the start with the steps, then call it again whenever a step starts, finishes, or the plan changes. Pass the full list each time. Keep each step title identical across calls so the step keeps its id; the result lists the id of each step. The user may edit the plan during the run, and an edited plan appears in your context. Keep steps short and concrete. Use it only for tasks that need several steps.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              title: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
            },
            required: ['title', 'status'],
          },
        },
      },
      required: ['steps'],
    },
  },
};

/**  ask_user is only offered in interactive chat. Scheduled tasks use a separate tool list, so they never see it. */
export const ASK_USER_TOOL_DEFINITION: ModelToolDefinition = {
  type: 'function',
  function: {
    name: 'ask_user',
    description: 'Ask the user a structured question with 1-8 form fields and wait for the answer. Use it when a decision or missing detail blocks progress. Put the missing information and why it matters in message; put the options and the default you will use if unanswered in each field description. Field types: string, number, integer, boolean, enum (single choice), multi (multiple choice, needs options). Each enum/multi field needs options. If the user declines or times out, continue with the default and say so.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        message: { type: 'string', description: 'The question or context shown above the form.' },
        fields: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              key: { type: 'string' },
              type: { type: 'string', enum: ['string', 'number', 'integer', 'boolean', 'enum', 'multi'] },
              title: { type: 'string' },
              description: { type: 'string' },
              options: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { value: { type: 'string' }, label: { type: 'string' } }, required: ['value', 'label'] } },
            },
            required: ['key', 'type', 'title'],
          },
        },
      },
      required: ['message', 'fields'],
    },
  },
};
