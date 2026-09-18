// GitHub access, exposed to the agent as in-process MCP tools.
//
// Read-only. Needs a GitHub token in GITHUB_TOKEN. A fine-grained personal
// access token with "Contents: Read-only" (plus "Issues"/"Pull requests" read
// if you want those tools) is enough -- do not hand it a classic token with
// write scopes.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const API = 'https://api.github.com';

function headers() {
  const t = process.env.GITHUB_TOKEN;
  const h = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'discord-claude-bot',
  };
  if (t) h.Authorization = 'Bearer ' + t;
  return h;
}

async function gh(pathAndQuery) {
  const res = await fetch(API + pathAndQuery, { headers: headers() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error('GitHub ' + res.status + ': ' + body.slice(0, 300));
  }
  return res.json();
}

const ok = (text) => ({ content: [{ type: 'text', text: String(text).slice(0, 100000) }] });
const fail = (e) => ({ content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true });

const listRepos = tool(
  'gh_list_repos',
  'List GitHub repositories the configured token can see, most recently pushed first.',
  {
    limit: z.number().optional().describe('How many to return (default 30, max 100)'),
    visibility: z.enum(['all', 'public', 'private']).optional(),
  },
  async (args) => {
    try {
      const n = Math.min(args.limit || 30, 100);
      const vis = args.visibility || 'all';
      const repos = await gh(
        '/user/repos?per_page=' + n + '&sort=pushed&visibility=' + vis
      );
      const rows = repos.map(
        (r) => r.full_name + (r.private ? ' [private]' : '') + ' - ' + (r.description || 'no description')
      );
      return ok(rows.join('\n') || 'No repositories visible to this token.');
    } catch (e) {
      return fail(e);
    }
  }
);

const readFile = tool(
  'gh_read_file',
  'Read a file from a GitHub repository.',
  {
    owner: z.string(),
    repo: z.string(),
    path: z.string().describe('Path within the repo, e.g. src/index.ts'),
    ref: z.string().optional().describe('Branch, tag or commit SHA'),
  },
  async (args) => {
    try {
      const q = args.ref ? '?ref=' + encodeURIComponent(args.ref) : '';
      const data = await gh(
        '/repos/' + args.owner + '/' + args.repo + '/contents/' + args.path + q
      );
      if (Array.isArray(data)) {
        return ok('That path is a directory:\n' + data.map((d) => d.type + ' ' + d.name).join('\n'));
      }
      if (data.encoding !== 'base64' || !data.content) {
        return ok('File is not readable as text (size ' + data.size + ').');
      }
      return ok(Buffer.from(data.content, 'base64').toString('utf8'));
    } catch (e) {
      return fail(e);
    }
  }
);

const listTree = tool(
  'gh_list_files',
  'List the file tree of a GitHub repository.',
  {
    owner: z.string(),
    repo: z.string(),
    ref: z.string().optional().describe('Branch or commit; defaults to the default branch'),
  },
  async (args) => {
    try {
      let ref = args.ref;
      if (!ref) {
        const info = await gh('/repos/' + args.owner + '/' + args.repo);
        ref = info.default_branch;
      }
      const tree = await gh(
        '/repos/' + args.owner + '/' + args.repo + '/git/trees/' + encodeURIComponent(ref) + '?recursive=1'
      );
      const files = (tree.tree || []).filter((t) => t.type === 'blob').map((t) => t.path);
      const head = files.slice(0, 500);
      return ok(head.join('\n') + (files.length > 500 ? '\n... (' + files.length + ' files total)' : ''));
    } catch (e) {
      return fail(e);
    }
  }
);

const searchCode = tool(
  'gh_search_code',
  'Search code on GitHub. Scope it with qualifiers such as repo:owner/name or user:name.',
  {
    query: z.string().describe('e.g. "findChannel repo:v-3/discordmcp"'),
    limit: z.number().optional(),
  },
  async (args) => {
    try {
      const n = Math.min(args.limit || 20, 50);
      const data = await gh('/search/code?per_page=' + n + '&q=' + encodeURIComponent(args.query));
      const rows = (data.items || []).map((i) => i.repository.full_name + ' :: ' + i.path);
      return ok(
        'Total matches: ' + data.total_count + '\n' + (rows.join('\n') || '(none)')
      );
    } catch (e) {
      return fail(e);
    }
  }
);

const listIssues = tool(
  'gh_list_issues',
  'List issues and pull requests on a repository.',
  {
    owner: z.string(),
    repo: z.string(),
    state: z.enum(['open', 'closed', 'all']).optional(),
    limit: z.number().optional(),
  },
  async (args) => {
    try {
      const n = Math.min(args.limit || 20, 100);
      const items = await gh(
        '/repos/' + args.owner + '/' + args.repo + '/issues?state=' +
          (args.state || 'open') + '&per_page=' + n
      );
      const rows = items.map(
        (i) => '#' + i.number + ' [' + (i.pull_request ? 'PR' : 'issue') + '/' + i.state + '] ' + i.title
      );
      return ok(rows.join('\n') || 'None.');
    } catch (e) {
      return fail(e);
    }
  }
);

const readIssue = tool(
  'gh_read_issue',
  'Read one issue or pull request, including its comments.',
  { owner: z.string(), repo: z.string(), number: z.number() },
  async (args) => {
    try {
      const base = '/repos/' + args.owner + '/' + args.repo + '/issues/' + args.number;
      const issue = await gh(base);
      const comments = await gh(base + '/comments?per_page=30');
      const parts = [
        '#' + issue.number + ' ' + issue.title + '  [' + issue.state + ']',
        'by ' + issue.user.login,
        '',
        issue.body || '(no body)',
      ];
      for (const c of comments) parts.push('', '--- ' + c.user.login + ':', c.body || '');
      return ok(parts.join('\n'));
    } catch (e) {
      return fail(e);
    }
  }
);

export function githubServer() {
  return createSdkMcpServer({
    name: 'github',
    version: '1.0.0',
    tools: [listRepos, listTree, readFile, searchCode, listIssues, readIssue],
  });
}

export const GITHUB_TOOL_NAMES = [
  'mcp__github__gh_list_repos',
  'mcp__github__gh_list_files',
  'mcp__github__gh_read_file',
  'mcp__github__gh_search_code',
  'mcp__github__gh_list_issues',
  'mcp__github__gh_read_issue',
];
