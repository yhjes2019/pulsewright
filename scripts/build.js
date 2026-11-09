'use strict';

// 构建：把三个发布文件复制到 dist/。
// 这个插件零依赖、不需要打包，main.js 就是源码本身；
// 但 Obsidian 的构建验证要一个能跑的 build 脚本，才能复现产物并比对字节。

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist');
const FILES = ['main.js', 'manifest.json', 'styles.css'];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

for (const name of FILES) {
  const src = path.join(ROOT, name);
  if (!fs.existsSync(src)) {
    console.error('缺少文件：' + name);
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(OUT, name));
}

// 版本一致性：manifest.json 的 version 必须和 package.json 对得上，
// 否则 Release 的 tag 会匹配不上。
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) {
  console.error('版本不一致：manifest.json ' + manifest.version + ' ≠ package.json ' + pkg.version);
  process.exit(1);
}

for (const name of FILES) {
  const buf = fs.readFileSync(path.join(OUT, name));
  console.log(name + '  ' + buf.length + ' B');
}
console.log('构建完成：dist/  ' + manifest.version);
