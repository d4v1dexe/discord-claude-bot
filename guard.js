// Permission guard.
//
// The Agent SDK ships real tools -- Read, Grep, Glob and friends. That is how
// the bot reads your repos without me hand-rolling a file API. It also means
// that without a guard, anyone who can talk to the bot can read ANY file the
// process can reach, including secrets sitting inside an allowed repo.
//
// So: an allowlist of tools, and a canUseTool callback that re-checks every
// path against the configured roots and a secrets denylist. Deny by default.
import path from 'node:path';

// Read-only built-ins. Nothing here can write, delete or execute.
export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];

// Named explicitly as well as implicitly, so a future SDK default cannot
// quietly hand the bot a shell.
export const FORBIDDEN_TOOLS = [
  'Bash',
  'BashOutput',
  'KillShell',
  'Write',
  'Edit',
  'NotebookEdit',
  'Task',
  'WebFetch',
  'WebSearch',
  'SlashCommand',
];

function isSecret(fullPath, cfg) {
  const base = path.basename(fullPath).toLowerCase();
  const ext = path.extname(fullPath).toLowerCase();
  if (base.startsWith('.env')) return true;
  if ((cfg.denyNames || []).some((n) => n.toLowerCase() === base)) return true;
  if ((cfg.denyExtensions || []).includes(ext)) return true;
  return false;
}

function insideAny(target, roots) {
  return roots.some((root) => {
    const rel = path.relative(root, target);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

// Pull whatever path-ish argument a tool was given.
function pathArg(toolName, input) {
  if (toolName === 'Read') return input.file_path || input.path || input.notebook_path;
  if (toolName === 'Grep' || toolName === 'Glob') return input.path;
  return undefined;
}

/**
 * Build the canUseTool callback.
 *
 * IMPORTANT: whatever calls this must NOT also list these tools in the SDK's
 * `allowedTools`. A bare name there auto-approves the tool before this callback
 * runs, silently disabling every check below.
 *
 * @param {object} cfg  repoAccess config (denylists)
 * @param {string[]} readableRoots  the COMPLETE set of directories readable for
 *   this request. Pass repo roots only when the asker is allowlisted.
 * @param {boolean} githubEnabled
 */
export function makeGuard(cfg, readableRoots, githubEnabled) {
  const roots = (readableRoots || []).map((p) => path.resolve(p));

  return async function canUseTool(toolName, input) {
    if (FORBIDDEN_TOOLS.includes(toolName)) {
      return { behavior: 'deny', message: toolName + ' is not available to this bot.' };
    }

    if (githubEnabled && toolName.startsWith('mcp__github__')) {
      return { behavior: 'allow', updatedInput: input };
    }

    if (!READ_ONLY_TOOLS.includes(toolName)) {
      return { behavior: 'deny', message: toolName + ' is not on this bot\'s allowlist.' };
    }

    const raw = pathArg(toolName, input || {});
    // Grep/Glob without an explicit path default to cwd, which is already a root.
    if (!raw) return { behavior: 'allow', updatedInput: input };

    const target = path.resolve(String(raw));
    if (!insideAny(target, roots)) {
      return {
        behavior: 'deny',
        message: 'Path is outside the directories this bot may read.',
      };
    }
    if (isSecret(target, cfg)) {
      return { behavior: 'deny', message: 'That file is on the secrets denylist.' };
    }
    return { behavior: 'allow', updatedInput: input };
  };
}

export function allowedToolList(githubEnabled) {
  return READ_ONLY_TOOLS.slice();
}

export { isSecret, insideAny };
