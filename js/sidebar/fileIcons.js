/* generated file (from material-icon-theme, MIT) - maps file extensions
and filenames to SVG icons in ext/fileTreeIcons/. Regenerate with
scripts/generateFileIcons.js. */

const pathPrefix = 'ext/fileTreeIcons/'

const extMap = {
  js: 'javascript.svg',
  mjs: 'javascript.svg',
  cjs: 'javascript.svg',
  jsx: 'react.svg',
  ts: 'typescript.svg',
  tsx: 'react_ts.svg',
  mts: 'typescript.svg',
  cts: 'typescript.svg',
  py: 'python.svg',
  rb: 'ruby.svg',
  php: 'php.svg',
  go: 'go.svg',
  rs: 'rust.svg',
  java: 'java.svg',
  c: 'c.svg',
  h: 'h.svg',
  cpp: 'cpp.svg',
  hpp: 'hpp.svg',
  cs: 'csharp.svg',
  json: 'json.svg',
  jsonc: 'json.svg',
  md: 'markdown.svg',
  markdown: 'markdown.svg',
  rst: 'markdown.svg',
  css: 'css.svg',
  scss: 'sass.svg',
  sass: 'sass.svg',
  less: 'less.svg',
  html: 'html.svg',
  htm: 'html.svg',
  vue: 'vue.svg',
  svelte: 'svelte.svg',
  sh: 'console.svg',
  bash: 'console.svg',
  zsh: 'console.svg',
  fish: 'console.svg',
  ps1: 'powershell.svg',
  yml: 'yaml.svg',
  yaml: 'yaml.svg',
  toml: 'toml.svg',
  xml: 'xml.svg',
  svg: 'svg.svg',
  png: 'image.svg',
  jpg: 'image.svg',
  jpeg: 'image.svg',
  gif: 'image.svg',
  webp: 'image.svg',
  ico: 'image.svg',
  bmp: 'image.svg',
  mp3: 'audio.svg',
  mp4: 'video.svg',
  webm: 'video.svg',
  ogg: 'video.svg',
  wav: 'audio.svg',
  pdf: 'pdf.svg',
  zip: 'zip.svg',
  tar: 'zip.svg',
  gz: 'zip.svg',
  rar: 'zip.svg',
  '7z': 'zip.svg',
  xz: 'zip.svg',
  exe: 'exe.svg',
  deb: 'zip.svg',
  dmg: 'disc.svg',
  msi: 'exe.svg',
  txt: 'document.svg',
  rtf: 'word.svg',
  log: 'log.svg',
  csv: 'table.svg',
  tsv: 'table.svg',
  sql: 'database.svg',
  db: 'database.svg',
  sqlite: 'database.svg',
  sqlite3: 'database.svg',
  env: 'tune.svg',
  conf: 'settings.svg',
  ini: 'settings.svg',
  cfg: 'settings.svg',
  bat: 'console.svg',
  cmd: 'console.svg',
  apk: 'android.svg',
  iso: 'disc.svg',
  img: 'image.svg'
}

const nameMap = {
  'package.json': 'nodejs.svg',
  'package-lock.json': 'nodejs.svg',
  'pnpm-lock.yaml': 'pnpm.svg',
  'yarn.lock': 'yarn.svg',
  'composer.lock': 'json.svg',
  dockerfile: 'docker.svg',
  makefile: 'makefile.svg',
  license: 'license.svg',
  readme: 'readme.svg',
  'readme.md': 'readme.svg',
  '.gitignore': 'git.svg',
  '.gitattributes': 'git.svg',
  '.gitmodules': 'git.svg',
  '.env.example': 'tune.svg',
  '.editorconfig': 'editorconfig.svg',
  '.npmrc': 'npm.svg',
  '.nvmrc': 'nodejs.svg',
  gemfile: 'gemfile.svg',
  rakefile: 'ruby.svg',
  procfile: 'heroku.svg',
  vagrantfile: 'vagrant.svg',
  'webpack.config.js': 'webpack.svg'
}

const defaultIcon = 'file.svg'

function getIcon (filename) {
  const lower = filename.toLowerCase()
  if (nameMap[lower]) return nameMap[lower]
  const dot = filename.lastIndexOf('.')
  const ext = dot !== -1 ? filename.slice(dot + 1).toLowerCase() : ''
  return extMap[ext] || defaultIcon
}

module.exports = { pathPrefix, getIcon }
