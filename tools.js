// Tools for the raw Messages API build.
//
// On the Agent SDK we borrowed Claude Code's built-in Read/Grep/Glob and paid
// ~28k tokens of harness on every call. Here we define a small set ourselves,
// which is why a message costs cents instead of a third of a dollar.
//
// Path containment lives inside each handler. It cannot be shadowed by config
// the way the SDK's permission callback could -- there is no path from a tool
// call to the filesystem that does not go through safePath().
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const NUL = String.fromCharCode(0);
const GH_API = 'https://api.github.com';

export class Repos {
  constructor(cfg) {
    this.cfg = cfg || {};
    this.roots = new Map();
    for (const [name, p] of Object.entries(this.cfg.repos || {})) {
      this.roots.set(name, path.resolve(p));
    }
  }

  root(repo) {
    const r = this.roots.get(repo);
    if (!r) {
      const avail = [...this.roots.keys()].join(', ') || '(none configured)';
      throw new Error('Unknown repo "' + repo + '". Available: ' + avail);
    }
    if (!fs.existsSync(r)) throw new Error('Repo "' + repo + '" path does not exist: ' + r);
    return r;
  }

  isSecret(full) {
    const base = path.basename(full).toLowerCase();
    const ext = path.extname(full).toLowerCase();
    if (base.startsWith('.env')) return true;
    if ((this.cfg.denyNames || []).some((n) => n.toLowerCase() === base)) return true;
    if ((this.cfg.denyExtensions || []).includes(ext)) return true;
    return false;
  }

  skipDir(name) {
    const skip = this.cfg.skipDirs || [
      'node_modules', '.git', 'build', 'dist', '.next', '__pycache__', 'venv', '.venv',
    ];
    return skip.includes(name);
  }

  safePath(repo, rel) {
    const root = this.root(repo);
    const target = path.resolve(root, rel || '.');
    const r = path.relative(root, target);
    if (r.startsWith('..') || path.isAbsolute(r)) {
      throw new Error('Path "' + rel + '" escapes the repo root. Refused.');
    }
    if (this.isSecret(target)) throw new Error('"' + rel + '" is on the secrets denylist. Refused.');
    return target;
  }

  list() {
    const rows = [...this.roots.entries()].map(([n, p]) => n + ' -> ' + p);
    return rows.join('\n') || 'No repos configured.';
  }

  files(repo, subpath, cap) {
    const limit = cap || 400;
    const start = this.safePath(repo, subpath || '.');
    const root = this.root(repo);
    const out = [];
    const walk = (dir, depth) => {
      if (out.length >= limit || depth > 8) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (out.length >= limit) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!this.skipDir(e.name)) walk(full, depth + 1);
        } else if (!this.isSecret(full)) {
          out.push(path.relative(root, full).split(path.sep).join('/'));
        }
      }
    };
    if (fs.statSync(start).isDirectory()) walk(start, 0);
    else out.push(path.relative(root, start).split(path.sep).join('/'));
    return out.join('\n') + (out.length >= limit ? '\n... (truncated)' : '') || '(no files)';
  }

  read(repo, rel) {
    const target = this.safePath(repo, rel);
    const st = fs.statSync(target);
    if (st.isDirectory()) throw new Error('"' + rel + '" is a directory - use list_files.');
    const cap = this.cfg.maxFileBytes || 200000;
    if (st.size > cap) {
      const fd = fs.openSync(target, 'r');
      const buf = Buffer.alloc(cap);
      fs.readSync(fd, buf, 0, cap, 0);
      fs.closeSync(fd);
      return buf.toString('utf8') + '\n... (truncated, file is ' + st.size + ' bytes)';
    }
    return fs.readFileSync(target, 'utf8');
  }

  search(repo, query, max) {
    const root = this.root(repo);
    const limit = Math.min(max || 40, 200);
    let re;
    try { re = new RegExp(query, 'i'); }
    catch { re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
    const hits = [];
    const walk = (dir, depth) => {
      if (hits.length >= limit || depth > 8) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (hits.length >= limit) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (!this.skipDir(e.name)) walk(full, depth + 1); continue; }
        if (this.isSecret(full)) continue;
        let st; try { st = fs.statSync(full); } catch { continue; }
        if (st.size > 1500000) continue;
        let text; try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
        if (text.indexOf(NUL) !== -1) continue;
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length && hits.length < limit; i++) {
          if (re.test(lines[i])) {
            hits.push(
              path.relative(root, full).split(path.sep).join('/') + ':' + (i + 1) + ': ' +
              lines[i].trim().slice(0, 200)
            );
          }
        }
      }
    };
    walk(root, 0);
    return hits.join('\n') || 'No matches for /' + query + '/i in ' + repo + '.';
  }

  async gitLog(repo, count) {
    const root = this.root(repo);
    try {
      const { stdout } = await execFileAsync(
        'git', ['log', '-' + Math.min(count || 15, 50), '--pretty=format:%h %ad %an: %s', '--date=short'],
        { cwd: root, timeout: 15000 }
      );
      return stdout.trim() || '(no commits)';
    } catch (e) {
      return 'git log failed: ' + e.message;
    }
  }
}

async function gh(pathAndQuery) {
  const t = process.env.GITHUB_TOKEN;
  const h = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'discord-claude-bot',
  };
  if (t) h.Authorization = 'Bearer ' + t;
  const res = await fetch(GH_API + pathAndQuery, { headers: h });
  if (!res.ok) throw new Error('GitHub ' + res.status + ': ' + (await res.text()).slice(0, 300));
  return res.json();
}

const REPO_TOOLS = [
  { name: 'list_repos', description: 'List local repositories this bot may read.',
    input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'list_files', description: 'List files in a local repo (recursive, skips node_modules/.git/secrets).',
    input_schema: { type: 'object', properties: { repo: { type: 'string' }, subpath: { type: 'string' } }, required: ['repo'] } },
  { name: 'read_file', description: 'Read a text file from a local repo.',
    input_schema: { type: 'object', properties: { repo: { type: 'string' }, path: { type: 'string' } }, required: ['repo', 'path'] } },
  { name: 'search_repo', description: 'Regex/substring search in a local repo. Returns file:line: match.',
    input_schema: { type: 'object', properties: { repo: { type: 'string' }, query: { type: 'string' }, max_results: { type: 'number' } }, required: ['repo', 'query'] } },
  { name: 'git_log', description: 'Recent commits in a local repo.',
    input_schema: { type: 'object', properties: { repo: { type: 'string' }, count: { type: 'number' } }, required: ['repo'] } },
];

const GITHUB_TOOLS = [
  { name: 'gh_list_repos', description: 'List GitHub repos the token can see, most recently pushed first.',
    input_schema: { type: 'object', properties: { limit: { type: 'number' } }, required: [] } },
  { name: 'gh_list_files', description: 'List the file tree of a GitHub repo.',
    input_schema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, ref: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'gh_read_file', description: 'Read a file from a GitHub repo.',
    input_schema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, path: { type: 'string' }, ref: { type: 'string' } }, required: ['owner', 'repo', 'path'] } },
  { name: 'gh_search_code', description: 'Search code on GitHub. Scope with qualifiers like repo:owner/name.',
    input_schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'gh_list_issues', description: 'List issues and PRs on a GitHub repo.',
    input_schema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' }, limit: { type: 'number' } }, required: ['owner', 'repo'] } },
  { name: 'gh_read_issue', description: 'Read one issue or PR with its comments.',
    input_schema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, number: { type: 'number' } }, required: ['owner', 'repo', 'number'] } },
];

export function toolDefs(repoAllowed, githubEnabled) {
  const out = [];
  if (repoAllowed) out.push(...REPO_TOOLS);
  if (repoAllowed && githubEnabled) out.push(...GITHUB_TOOLS);
  return out;
}

export async function runTool(name, input, ctx) {
  const { repos, repoAllowed, githubEnabled } = ctx;
  const isRepoTool = REPO_TOOLS.some((t) => t.name === name);
  const isGhTool = GITHUB_TOOLS.some((t) => t.name === name);

  // Belt and braces: never dispatch a tool the asker is not entitled to, even
  // if it somehow appears in a request.
  if (isRepoTool && !repoAllowed) throw new Error('Repo access is not available to you.');
  if (isGhTool && (!repoAllowed || !githubEnabled)) throw new Error('GitHub access is not enabled.');

  switch (name) {
    case 'list_repos': return repos.list();
    case 'list_files': return repos.files(input.repo, input.subpath);
    case 'read_file': return repos.read(input.repo, input.path);
    case 'search_repo': return repos.search(input.repo, input.query, input.max_results);
    case 'git_log': return await repos.gitLog(input.repo, input.count);

    case 'gh_list_repos': {
      const n = Math.min(input.limit || 30, 100);
      const rs = await gh('/user/repos?per_page=' + n + '&sort=pushed');
      return rs.map((r) => r.full_name + (r.private ? ' [private]' : '') + ' - ' + (r.description || '')).join('\n') || 'None.';
    }
    case 'gh_list_files': {
      let ref = input.ref;
      if (!ref) ref = (await gh('/repos/' + input.owner + '/' + input.repo)).default_branch;
      const tree = await gh('/repos/' + input.owner + '/' + input.repo + '/git/trees/' + encodeURIComponent(ref) + '?recursive=1');
      const files = (tree.tree || []).filter((t) => t.type === 'blob').map((t) => t.path);
      return files.slice(0, 500).join('\n') + (files.length > 500 ? '\n... (' + files.length + ' total)' : '');
    }
    case 'gh_read_file': {
      const q = input.ref ? '?ref=' + encodeURIComponent(input.ref) : '';
      const d = await gh('/repos/' + input.owner + '/' + input.repo + '/contents/' + input.path + q);
      if (Array.isArray(d)) return 'Directory:\n' + d.map((x) => x.type + ' ' + x.name).join('\n');
      if (d.encoding !== 'base64' || !d.content) return 'Not readable as text (size ' + d.size + ').';
      return Buffer.from(d.content, 'base64').toString('utf8').slice(0, 100000);
    }
    case 'gh_search_code': {
      const n = Math.min(input.limit || 20, 50);
      const d = await gh('/search/code?per_page=' + n + '&q=' + encodeURIComponent(input.query));
      return 'Total: ' + d.total_count + '\n' +
        ((d.items || []).map((i) => i.repository.full_name + ' :: ' + i.path).join('\n') || '(none)');
    }
    case 'gh_list_issues': {
      const n = Math.min(input.limit || 20, 100);
      const items = await gh('/repos/' + input.owner + '/' + input.repo + '/issues?state=' + (input.state || 'open') + '&per_page=' + n);
      return items.map((i) => '#' + i.number + ' [' + (i.pull_request ? 'PR' : 'issue') + '/' + i.state + '] ' + i.title).join('\n') || 'None.';
    }
    case 'gh_read_issue': {
      const base = '/repos/' + input.owner + '/' + input.repo + '/issues/' + input.number;
      const issue = await gh(base);
      const comments = await gh(base + '/comments?per_page=30');
      const parts = ['#' + issue.number + ' ' + issue.title + ' [' + issue.state + '] by ' + issue.user.login, '', issue.body || '(no body)'];
      for (const c of comments) parts.push('', '--- ' + c.user.login + ':', c.body || '');
      return parts.join('\n').slice(0, 100000);
    }
    default:
      throw new Error('Unknown tool: ' + name);
  }
}
