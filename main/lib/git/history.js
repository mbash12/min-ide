/* One-process graph and commit data query used by the Source Control panel. */

function parseGraphHistory (output) {
  var graphLines = []
  var commits = []
  output.split('\n').forEach(function (line) {
    if (!line) return
    var separator = line.indexOf('\0')
    if (separator === -1) {
      graphLines.push(line)
      return
    }
    var lanePrefix = line.slice(0, separator)
    var fields = line.slice(separator + 1).split('\0')
    if (fields.length < 6 || !fields[0]) return
    var commit = {
      hash: fields[0],
      shortHash: fields[1],
      message: fields[2],
      author: fields[3],
      date: fields[4],
      refs: fields[5]
    }
    commits.push(commit)
    // The renderer reads the graph lane prefix; commit text comes from the
    // structured record above. Preserve connector rows between commits.
    graphLines.push(lanePrefix + commit.shortHash + ' ' + commit.message)
  })
  return { graph: graphLines.join('\n'), commits: commits }
}

module.exports = function createGitHistory (runGit, isDirectoryPath) {
  async function getGraphData (cwd, limit) {
    if (!isDirectoryPath(cwd)) return { error: 'Invalid path' }
    var count = String(limit || 30)
    var result = await runGit(cwd, [
      'log', '--graph', '--topo-order', '--all', '--decorate', '--no-color',
      '--pretty=format:%x00%H%x00%h%x00%s%x00%an%x00%at%x00%D', '-n', count
    ])
    if (result.status !== 0) return { error: result.stderr || 'git log failed' }
    return parseGraphHistory(result.stdout)
  }

  return { getGraphData: getGraphData }
}

module.exports.parseGraphHistory = parseGraphHistory
