# Pulsewright · Zotero 端

Zotero 插件端。同一个 Pulsewright，换了一个宿主：Obsidian 端管「整理与复盘」，Zotero 端管「检索与思维模式」。

## 一句话定位

选中一篇文献，回答六个问题，把「我为什么把它存进来」变成可回看的记录。

| 序 | 问题 | 数据来源 | 谁来写 |
|---|---|---|---|
| 1 | 这本文献讲了什么 | 题录 + 摘要 | 自动 |
| 2 | 我为什么选它 | 加入日期、分类、标签、有无 PDF、库内相近篇数 | 自动出提示，人写一句话 |
| 3 | 库里有相关的吗 | 全库 TF-IDF 相似度 | 自动 |
| 4 | 有没有更优解 | 与最相近一篇逐项对比 | 自动 |
| 5 | 读完还有哪些问题 | 人的输入 | 人写，可存成子笔记 |
| 6 | 下一本该读什么 | 相似度 + 新旧 + 同类型 | 自动 |
| — | 你的阅读痕迹 | 批注数、页码分布、颜色 | 自动 |

## 怎么打开

四个入口，任选其一：

- 文献列表工具栏的脉冲图标（常驻可见）
- 右键任意文献 → 六问
- 菜单 工具 → 六问
- 快捷键 `Ctrl/Cmd + Shift + 6`

## 技术形态

| | 说明 |
|---|---|
| 形态 | bootstrapped extension（不是 WebExtension 页面） |
| 入口 | 顶层 `install / startup / shutdown / uninstall` + `onMainWindowLoad` |
| 界面 | XUL `<panel>` 弹窗（自绘 HTML 内容） |
| 网络 | 零网络请求，全本地计算 |
| 写入 | 只写 Zotero 子笔记（带 `<!-- pulsewright-six -->` 标记），不改题录字段 |

## 目录

```
bootstrap.js            插件生命周期、加载脚本、注册入口
manifest.json           Zotero 插件清单（id: pulsewright@luo.dev）
content/scripts/core.js 纯函数层：分词、TF-IDF、相似度、批注画像、六问文本
content/scripts/sixpane.js 界面层：弹窗、七段渲染、四个入口
content/icons/          品牌图标（透明底）
locale/{en-US,zh-CN}/   节头与菜单文案
tests/core.test.js      纯函数层单元测试
```

`core.js` 零宿主依赖：不出现 `Zotero.`，也不出现 DOM，可以直接用 Node 跑。

## 测试

```bash
cd zotero && node tests/core.test.js
```

当前 93 条断言全通过。

## 打包

把 `bootstrap.js`、`manifest.json`、`content/`、`locale/` 压成 zip 后改名 `.xpi`，在 Zotero 里
工具 → 插件 → 齿轮 → Install Plugin From File 安装。侧载安装后 Zotero 默认禁用，需在插件页手动启用。

## 与 Obsidian 端的关系

两端共用同一套设计语言、术语、品牌与版本号，但**代码不共享**：Obsidian 端跑在 Obsidian 进程里用它的 API，
Zotero 端跑在 Zotero 进程里用 `Zotero.Items`。强行抽象成一份反而两边都别扭。

`core.js` 是唯一计划复用的一层——Obsidian 端 1.1.0 抽 `core/` 时可以对照这里的实现。
