/**
 * Publish dsh-task-brief without a local git binary.
 *
 * Creates (or reuses) the GitHub repository through the REST API, commits every
 * file of the bundle directory as one commit, and prints the resulting URLs.
 * npm publishing stays a separate step because it needs its own token.
 *
 * Usage:
 *   GITHUB_TOKEN=ghp_xxx node scripts/publish-github.mjs [--owner NAME] [--repo NAME] [--private]
 *
 * The token needs `repo` scope for a private repository, or `public_repo` for a
 * public one; creating a repository also requires that scope on the account.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const API = 'https://api.github.com'
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Files and directories that never enter the repository. */
const IGNORED = new Set(['node_modules', '.git', '.dsh-ppt'])
const IGNORED_SUFFIXES = ['.tgz', '.log']

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  return value === undefined || value.startsWith('--') ? true : value
}

const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
if (!token) {
  console.error('Missing GITHUB_TOKEN (or GH_TOKEN).')
  process.exit(2)
}

const ownerArg = arg('owner', undefined)
const repoNames = arg('repo', 'dsh-task-brief')
const isPrivate = arg('private', false) === true

async function api(path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'dsh-task-brief-publisher',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
    signal: AbortSignal.timeout(60000),
  })
  const text = await response.text()
  let data
  try {
    data = text.length > 0 ? JSON.parse(text) : undefined
  } catch {
    data = text
  }
  return { status: response.status, ok: response.ok, data }
}

/** Collect every publishable file as a repository-relative POSIX path. */
async function collect(directory, collected = new Map()) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue
    if (IGNORED_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue
    const full = join(directory, entry.name)
    if (entry.isDirectory()) {
      await collect(full, collected)
      continue
    }
    if (!entry.isFile()) continue
    const info = await stat(full)
    if (info.size > 900_000) {
      console.warn(`skip ${relative(ROOT, full)} (${info.size} bytes; use the Git Data API for large files)`)
      continue
    }
    collected.set(relative(ROOT, full).split(sep).join('/'), await readFile(full))
  }
  return collected
}

const me = await api('/user')
if (!me.ok) {
  console.error('Token rejected:', me.status, JSON.stringify(me.data).slice(0, 300))
  process.exit(1)
}
const owner = typeof ownerArg === 'string' ? ownerArg : me.data.login
console.log(`Authenticated as ${me.data.login}; target ${owner}/${repoNames}`)

const repository = await api(`/repos/${owner}/${repoNames}`)
if (repository.ok) {
  console.log(`Repository exists (${repository.data.html_url}); files will be committed into it.`)
} else if (repository.status === 404) {
  const createPath = me.data.login === owner
    ? '/user/repos'
    : `/orgs/${owner}/repos`
  const created = await api(createPath, {
    method: 'POST',
    body: JSON.stringify({
      name: repoNames,
      description: 'Task brief on the first task of every new Session, with a model and reasoning-effort recommendation.',
      homepage: `https://github.com/${owner}/${repoNames}`,
      private: isPrivate,
      has_issues: true,
      has_wiki: false,
      auto_init: false,
    }),
  })
  if (!created.ok) {
    console.error('Could not create the repository:', created.status, JSON.stringify(created.data).slice(0, 500))
    process.exit(1)
  }
  console.log(`Created ${created.data.html_url}`)
} else {
  console.error('Repository lookup failed:', repository.status, JSON.stringify(repository.data).slice(0, 300))
  process.exit(1)
}

const branch = 'main'
let reference = await api(`/repos/${owner}/${repoNames}/git/ref/heads/${branch}`)
let baseCommit
let baseTree

/** GitHub refuses Git Data writes on a repository with no commit yet. */
if (!reference.ok) {
  const seed = await api(`/repos/${owner}/${repoNames}/contents/README.md`, {
    method: 'PUT',
    body: JSON.stringify({
      message: 'chore: initialize repository',
      content: Buffer.from('# dsh-task-brief\n').toString('base64'),
      branch,
    }),
  })
  if (!seed.ok) {
    console.error('Could not initialize the empty repository:', seed.status, JSON.stringify(seed.data).slice(0, 400))
    process.exit(1)
  }
  console.log(`Initialized ${branch} with a placeholder commit`)
  reference = await api(`/repos/${owner}/${repoNames}/git/ref/heads/${branch}`)
}

if (reference.ok) {
  baseCommit = reference.data.object.sha
  const commit = await api(`/repos/${owner}/${repoNames}/git/commits/${baseCommit}`)
  baseTree = commit.ok ? commit.data.tree.sha : undefined
  console.log(`Updating existing ${branch} at ${baseCommit.slice(0, 8)}`)
}

const files = await collect(ROOT)
console.log(`Prepared ${files.size} files`)

const treeEntries = []
for (const [path, bytes] of files) {
  const blob = await api(`/repos/${owner}/${repoNames}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({ content: bytes.toString('base64'), encoding: 'base64' }),
  })
  if (!blob.ok) {
    console.error(`Blob upload failed for ${path}:`, blob.status, JSON.stringify(blob.data).slice(0, 300))
    process.exit(1)
  }
  treeEntries.push({ path, mode: '100644', type: 'blob', sha: blob.data.sha })
}

const tree = await api(`/repos/${owner}/${repoNames}/git/trees`, {
  method: 'POST',
  body: JSON.stringify({ ...(baseTree === undefined ? {} : { base_tree: baseTree }), tree: treeEntries }),
})
if (!tree.ok) {
  console.error('Tree creation failed:', tree.status, JSON.stringify(tree.data).slice(0, 400))
  process.exit(1)
}

const commit = await api(`/repos/${owner}/${repoNames}/git/commits`, {
  method: 'POST',
  body: JSON.stringify({
    message: 'feat: task brief on the first task of every new Session',
    tree: tree.data.sha,
    ...(baseCommit === undefined ? {} : { parents: [baseCommit] }),
  }),
})
if (!commit.ok) {
  console.error('Commit creation failed:', commit.status, JSON.stringify(commit.data).slice(0, 400))
  process.exit(1)
}

const updated = await api(`/repos/${owner}/${repoNames}/git/refs/heads/${branch}`, {
  method: reference.ok ? 'PATCH' : 'POST',
  body: JSON.stringify(reference.ok
    ? { sha: commit.data.sha, force: false }
    : { ref: `refs/heads/${branch}`, sha: commit.data.sha }),
})
if (!updated.ok) {
  console.error('Ref update failed:', updated.status, JSON.stringify(updated.data).slice(0, 400))
  process.exit(1)
}

console.log('')
console.log(`Repository: https://github.com/${owner}/${repoNames}`)
console.log(`Commit:     https://github.com/${owner}/${repoNames}/commit/${commit.data.sha}`)
