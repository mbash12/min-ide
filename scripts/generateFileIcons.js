/* regenerates js/sidebar/fileIcons.js and ext/fileTreeIcons/ from the
  material-icon-theme package (MIT). Download it once with:
    curl -sL <registry tarball url> | tar xz -C /tmp
  then run:
    node scripts/generateFileIcons.js /tmp/package
  The generated files are committed, so this only needs to run when the
  icon set should be updated. */

const fs = require('fs')
const path = require('path')

const srcRoot = process.argv[2]
if (!srcRoot) {
  console.error('usage: node scripts/generateFileIcons.js <material-icon-theme-package-dir>')
  process.exit(1)
}

const projectRoot = path.resolve(__dirname, '..')
const OUT_DIR = path.join(projectRoot, 'ext/fileTreeIcons')
const OUT_JS = path.join(projectRoot, 'js/sidebar/fileIcons.js')

const m = require(path.join(srcRoot, 'dist/material-icons.json'))

const wantedExts = [
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts',
  'py', 'rb', 'php', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'cs',
  'json', 'jsonc', 'md', 'markdown', 'rst',
  'css', 'scss', 'sass', 'less', 'html', 'htm', 'vue', 'svelte',
  'sh', 'bash', 'zsh', 'fish', 'ps1',
  'yml', 'yaml', 'toml', 'xml', 'svg',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp',
  'mp3', 'mp4', 'webm', 'ogg', 'wav',
  'pdf', 'zip', 'tar', 'gz', 'rar', '7z', 'xz',
  'exe', 'deb', 'dmg', 'msi',
  'txt', 'rtf', 'log', 'csv', 'tsv',
  'sql', 'db', 'sqlite', 'sqlite3',
  'env', 'conf', 'ini', 'cfg', 'editorconfig',
  'bat', 'cmd', 'apk', 'appx', 'iso', 'img'
]

const wantedNames = [
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'composer.lock',
  'dockerfile', 'makefile', 'license', 'readme', 'readme.md',
  '.gitignore', '.gitattributes', '.gitmodules',
  '.env', '.env.example', '.editorconfig', '.npmrc', '.nvmrc',
  'gemfile', 'rakefile', 'procfile', 'vagrantfile', 'webpack.config.js'
]

const extMap = {}
const nameMap = {}
const neededIcons = new Set()

function resolveIcon (name) {
  const def = m.iconDefinitions && m.iconDefinitions[name]
  if (!def || !def.iconPath) return null
  const base = path.basename(def.iconPath)
  const plain = path.join(srcRoot, 'icons', base)
  return { name: base, file: fs.existsSync(plain) ? plain : null }
}

function addExt (ext, iconName) {
  if (iconName) {
    extMap[ext] = iconName
    neededIcons.add(iconName)
  }
}

function addName (key, iconName) {
  if (iconName) {
    nameMap[key] = iconName
    neededIcons.add(iconName)
  }
}

for (const ext of wantedExts) {
  const hit = m.fileExtensions ? Object.entries(m.fileExtensions).find(([k]) => k === ext) : null
  if (!hit) { console.log('no ext mapping:', ext); continue }
  const r = resolveIcon(hit[1])
  if (!r) { console.log('no icon def:', ext, '->', hit[1]); continue }
  addExt(ext, r.name)
}

for (const key of wantedNames) {
  const lower = key.toLowerCase()
  const hit = m.fileNames ? Object.entries(m.fileNames).find(([k]) => k.toLowerCase() === lower) : null
  if (!hit) { console.log('no name mapping:', key); continue }
  const r = resolveIcon(hit[1])
  if (!r) { console.log('no icon def (name):', key, '->', hit[1]); continue }
  addName(key, r.name)
}

const fallback = resolveIcon(m.file && m.file.icon)
if (fallback) {
  nameMap.__default = fallback.name
  neededIcons.add(fallback.name)
}

fs.mkdirSync(OUT_DIR, { recursive: true })
for (const iconName of neededIcons) {
  const src = path.join(srcRoot, 'icons', iconName)
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(OUT_DIR, iconName))
  } else {
    console.log('MISSING FILE:', iconName)
  }
}

const header = `/* generated file (from material-icon-theme, MIT) - maps file extensions
and filenames to SVG icons in ext/fileTreeIcons/. Regenerate with
scripts/generateFileIcons.js. */

const pathPrefix = 'ext/fileTreeIcons/'

`

const body = `const extMap = ${JSON.stringify(extMap, null, 2)}

const nameMap = ${JSON.stringify(nameMap, null, 2)}

const defaultIcon = ${JSON.stringify(nameMap.__default)}

function getIcon (filename) {
  const lower = filename.toLowerCase()
  if (nameMap[lower]) return nameMap[lower]
  const dot = filename.lastIndexOf('.')
  const ext = dot !== -1 ? filename.slice(dot + 1).toLowerCase() : ''
  return extMap[ext] || defaultIcon
}

module.exports = { pathPrefix, getIcon }
`

fs.writeFileSync(OUT_JS, header + body)
console.log('wrote', path.relative(projectRoot, OUT_JS))
console.log('exts:', Object.keys(extMap).length, 'names:', Object.keys(nameMap).length)
console.log('icons copied:', neededIcons.size)
