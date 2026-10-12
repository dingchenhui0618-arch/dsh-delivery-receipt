#!/usr/bin/env node
// 零依赖构建。
//
// host 半区是普通 ESM，只 import node: 内置模块和它自己的兄弟模块，所以"把源码
// 复制进 lib/"就是完整构建 —— 不需要打包器，也就没有装不上的 devDependency。
//
// client 半区是 CommonJS，由宿主的 window.__ModuleLoader__ 加载，因此它不能带
// 自己的相对 require：唯一那处相对 require（样式表）在下面内联，且这里会在它
// 消失或变形时直接失败。
//
// 如果以后要发 npm 并做 tree-shaking，可以把这一步换成 esbuild；产物布局
// （lib/index.js、lib/client.js）保持不变。

import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { wrapClient } from './wrap-client.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'lib')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })

// host.js 变成 index.js；它依赖的兄弟模块保持同名。
await copyFile(join(root, 'src', 'host.js'), join(out, 'index.js'))
const hostModules = ['collect.js', 'evidence.js', 'zones.js', 'receipt.js']
for (const file of hostModules) {
  await copyFile(join(root, 'src', file), join(out, file))
}

const cssModule = await import(pathToFileURL(join(root, 'src', 'client-css.cjs')).href)
const css = cssModule.default
if (typeof css !== 'string' || css.length === 0) {
  throw new Error('src/client-css.cjs 没有导出非空 CSS 字符串')
}

const clientSource = await readFile(join(root, 'src', 'client.cjs'), 'utf8')
const CSS_REQUIRE = /require\((['"])\.\/client-css\.cjs\1\)/
if (!CSS_REQUIRE.test(clientSource)) {
  throw new Error('src/client.cjs 已不再 require ./client-css.cjs —— 请同步 scripts/build.mjs')
}

const bundle = wrapClient(clientSource.replace(CSS_REQUIRE, JSON.stringify(css)), pkg.name)
await writeFile(join(out, 'client.js'), bundle)

// 编译客户端 bundle，并把 host 侧整张模块图 import 一遍：断链在这里失败，
// 而不是等到浏览器里（那里的报错难读得多）。
new Function(bundle)
for (const file of ['index.js'].concat(hostModules)) {
  await import(pathToFileURL(join(out, file)).href)
}
const host = await import(pathToFileURL(join(out, 'index.js')).href)
if (host.name !== pkg.name || typeof host.apply !== 'function') {
  throw new Error('host 插件导出不合法：需要 name "' + pkg.name + '" 和一个 apply() 函数')
}

console.log('Built ' + pkg.name + ' ' + pkg.version + '：lib/index.js、lib/client.js 与 ' + hostModules.length + ' 个兄弟模块')
