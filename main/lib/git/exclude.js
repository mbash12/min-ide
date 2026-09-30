/* Keeps Min's generated output out of the user's commits.

Min writes tool results, screenshots and Figma exports into <workspace>/.min/.
Those can hold anything a tool printed (including secrets) and large binaries,
and "Stage all" or an agent's `git add -A` would sweep them into a commit. The
folders are listed in the repository's own info/exclude, which is local to the
clone: the tracked .gitignore is never touched, and .min/playbooks and the
design spec stay versionable. Best effort: a failure here must never fail the
write it accompanies. */

const fs = require('fs')
const path = require('path')
const childProcess = require('child_process')

const handled = new Set()

/* dir must already exist. Returns true when an entry was added. */
function excludeFromGit (dir) {
  let real
  try {
    real = fs.realpathSync(dir)
  } catch (e) {
    return false
  }
  if (!real.split(path.sep).includes('.min') || handled.has(real)) return false
  // decided once per folder, whatever the outcome: no git process per write
  handled.add(real)

  let top
  let excludeFile
  try {
    const output = childProcess.execFileSync('git', ['rev-parse', '--show-toplevel', '--git-path', 'info/exclude'], {
      cwd: real,
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore']
    }).split('\n')
    top = fs.realpathSync(output[0])
    excludeFile = path.resolve(real, output[1])
  } catch (e) {
    return false // not a repository, or no git
  }

  const relative = path.relative(top, real)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false
  const entry = '/' + relative.split(path.sep).join('/').replace(/[\\*?[\]]/g, '\\$&') + '/'

  try {
    let current = ''
    try {
      current = fs.readFileSync(excludeFile, 'utf8')
    } catch (e) {
      if (e.code !== 'ENOENT') return false
    }
    if (current.split(/\r?\n/).includes(entry)) return false
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true })
    fs.appendFileSync(excludeFile, (current && !current.endsWith('\n') ? '\n' : '') + entry + '\n')
    return true
  } catch (e) {
    return false
  }
}

module.exports = { excludeFromGit: excludeFromGit }
