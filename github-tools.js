// GitHub access, exposed to the agent as in-process MCP tools.
//
// Reads are unrestricted. Writes are PR-only by design: the bot can create a
// branch, commit to that branch, and open a pull request. It cannot commit to
// the default branch, merge, force-push, or delete anything -- every change
// stops at a PR you review in GitHub's UI.
//
// Needs GITHUB_TOKEN. For read-only use, "Contents: Read-only" is enough. For
// writes it needs "Contents: Read and write" and "Pull requests: Read and
// write" on the repos you want it to touch -- scope it to those repos, not to
// every repo you own.
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

async function ghWrite(method, pathAndQuery, body) {
  const res = await fetch(API + pathAndQuery, {
    method,
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error('GitHub ' + res.status + ': ' + text.slice(0, 300));
  return text ? JSON.parse(text) : {};
}

async function defaultBranch(owner, repo) {
  return (await gh('/repos/' + owner + '/' + repo)).default_branch;
}

// The one rule that makes this safe: never touch the default branch.
async function refuseIfProtected(owner, repo, branch) {
  const def = await defaultBranch(owner, repo);
  if (!branch || branch === def) {
    throw new Error(
      'Refused: "' + (branch || '(none)') + '" is the default branch of ' + owner + '/' + repo +
      '. This bot only commits to a side branch and opens a PR. Create or name a different branch.'
    );
  }
  return def;
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


const createBranch = tool(
  'gh_create_branch',
  'Create a new branch in a GitHub repo, branched from an existing ref. Cannot overwrite an existing branch.',
  {
    owner: z.string(),
    repo: z.string(),
    new_branch: z.string().describe('Name of the branch to create, e.g. feature/joke-categories'),
    from_ref: z.string().optional().describe('Branch to base it on; defaults to the repo default branch'),
  },
  async (args) => {
    try {
      await refuseIfProtected(args.owner, args.repo, args.new_branch);
      const base = args.from_ref || (await defaultBranch(args.owner, args.repo));
      const ref = await gh('/repos/' + args.owner + '/' + args.repo + '/git/ref/heads/' + encodeURIComponent(base));
      await ghWrite('POST', '/repos/' + args.owner + '/' + args.repo + '/git/refs', {
        ref: 'refs/heads/' + args.new_branch,
        sha: ref.object.sha,
      });
      return ok('Created branch ' + args.new_branch + ' from ' + base + ' at ' + ref.object.sha.slice(0, 7) + '.');
    } catch (e) {
      return fail(e);
    }
  }
);

const commitFiles = tool(
  'gh_commit_files',
  'Commit one or more files to a NON-default branch. Creates or replaces each file. Never commits to the default branch.',
  {
    owner: z.string(),
    repo: z.string(),
    branch: z.string().describe('Target branch. Must not be the default branch.'),
    message: z.string().describe('Commit message'),
    files: z
      .array(z.object({ path: z.string(), content: z.string() }))
      .describe('Files to write, with full new content each'),
  },
  async (args) => {
    try {
      await refuseIfProtected(args.owner, args.repo, args.branch);
      if (!args.files || !args.files.length) throw new Error('No files given.');
      if (args.files.length > 20) throw new Error('Too many files in one commit (limit 20).');

      const done = [];
      for (const f of args.files) {
        if (f.path.includes('..')) throw new Error('Refused path with "..": ' + f.path);
        // An update needs the current blob sha; a create must not send one.
        let sha;
        try {
          const existing = await gh(
            '/repos/' + args.owner + '/' + args.repo + '/contents/' + f.path +
            '?ref=' + encodeURIComponent(args.branch)
          );
          if (!Array.isArray(existing)) sha = existing.sha;
        } catch {
          /* new file */
        }
        const body = {
          message: args.message,
          content: Buffer.from(f.content, 'utf8').toString('base64'),
          branch: args.branch,
        };
        if (sha) body.sha = sha;
        const res = await ghWrite('PUT', '/repos/' + args.owner + '/' + args.repo + '/contents/' + f.path, body);
        done.push((sha ? 'updated ' : 'created ') + f.path + ' @ ' + (res.commit ? res.commit.sha.slice(0, 7) : '?'));
      }
      return ok(['Committed to ' + args.branch + ':'].concat(done).join('\n'));
    } catch (e) {
      return fail(e);
    }
  }
);

const openPr = tool(
  'gh_open_pr',
  'Open a pull request from a branch. Opens only -- it cannot merge.',
  {
    owner: z.string(),
    repo: z.string(),
    head: z.string().describe('Branch containing the changes'),
    title: z.string(),
    body: z.string().optional(),
    base: z.string().optional().describe('Branch to merge into; defaults to the repo default branch'),
  },
  async (args) => {
    try {
      const base = args.base || (await defaultBranch(args.owner, args.repo));
      if (args.head === base) throw new Error('head and base are the same branch.');
      const pr = await ghWrite('POST', '/repos/' + args.owner + '/' + args.repo + '/pulls', {
        title: args.title,
        head: args.head,
        base,
        body: [args.body || '', '', '---', 'Opened by discord-claude-bot. Review before merging.'].join('\n'),
      });
      return ok('Opened PR #' + pr.number + ': ' + pr.html_url);
    } catch (e) {
      return fail(e);
    }
  }
);

export function githubServer(allowWrite) {
  return createSdkMcpServer({
    name: 'github',
    version: '1.0.0',
    tools: allowWrite
      ? [listRepos, listTree, readFile, searchCode, listIssues, readIssue, createBranch, commitFiles, openPr]
      : [listRepos, listTree, readFile, searchCode, listIssues, readIssue],
  });
}

export const GITHUB_READ_TOOLS = [
  'mcp__github__gh_list_repos',
  'mcp__github__gh_list_files',
  'mcp__github__gh_read_file',
  'mcp__github__gh_search_code',
  'mcp__github__gh_list_issues',
  'mcp__github__gh_read_issue',
];

export const GITHUB_WRITE_TOOLS = [
  'mcp__github__gh_create_branch',
  'mcp__github__gh_commit_files',
  'mcp__github__gh_open_pr',
];

export const GITHUB_TOOL_NAMES = GITHUB_READ_TOOLS.concat(GITHUB_WRITE_TOOLS);
