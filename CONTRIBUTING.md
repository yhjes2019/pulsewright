# 贡献指南

感谢你愿意花时间。这个插件很小，规矩也简单：**能核实、能测、不联网**。

## 报告问题

提 Issue 前先确认：

1. 你的 Obsidian 版本（设置 → 关于）与本插件版本（设置 → 第三方插件 → Pulsewright 那一行）
2. 问题在**新建的空库**里能否复现——很多「分数不对」是库里有排除目录或 `created` 写错
3. 打开开发者工具（`Ctrl+Shift+I`）看 Console 有没有报错，把报错原文贴进来

用模板提：`.github/ISSUE_TEMPLATE/bug_report.yml`。请**不要**贴整段笔记正文，脱敏后再贴。

## 提功能建议

先说清「你现在怎么凑合解决的」。一个功能如果已经有变通办法，优先级会低。用 `.github/ISSUE_TEMPLATE/feature_request.yml`。

## 提代码

```bash
git clone https://github.com/yhjes2019/pulsewright.git
cd pulsewright
npm test        # 必须 71 项全过
npm run check   # 语法检查
```

改完在**真机**上验证一遍：把 `main.js` / `manifest.json` / `styles.css` 拷进 `<库>/.obsidian/plugins/pulsewright/`，Obsidian 里重载插件，七个标签页都点一遍。

PR 要求：

- 一个 PR 只做一件事，别把格式化改动混进功能改动
- 新逻辑要有测试。纯函数挂到 `PURE` 上（`module.exports.PURE = PURE`），`tests/kp_test.js` 里加断言
- 不要引入运行时依赖。`package.json` 的 `dependencies` 必须保持为空——这是「纯本地、可审计」的底线
- 不要加任何网络请求、遥测、远程配置、授权校验
- 中文注释、中文界面文案保持一致；要加 i18n 请单独开 PR 并先讨论结构

## 代码风格

- 2 空格缩进，单引号，行尾分号
- 用裸 `setInterval` / `setTimeout`，不要 `window.setInterval`（Node 测试会炸）
- DOM 类名统一 `kp-` 前缀
- 新增面板元素记得在 `styles.css` 里补样式，并保证 `.kp-shell` 的 `box-sizing: border-box` 不被覆盖
- 日期一律走 `DAY_MS` 常量与本地时区归一化，不要直接 `new Date(str)`

## 提交信息

`<类型>: <一句话>`

类型用 `feat` / `fix` / `docs` / `test` / `refactor` / `style` / `chore`。例：

```
feat: 月相日历支持跨年翻页
fix: 排除目录前缀匹配漏掉根目录自身
docs: 补 historyDays 死配置说明
```

## 版本与发布

版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)：破坏性改动升主版本，新功能升次版本，修 bug 升补丁版本。改版本要同时改 `manifest.json` 与 `package.json` 的 `version`，并在 `CHANGELOG.md` 顶部加条目。维护者会在 GitHub 上打 tag 并发 Release。

## 许可

提交 PR 即表示你同意以 **MIT** 许可贡献你的代码（与本仓库一致）。
