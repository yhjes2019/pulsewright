# 安装 · Obsidian

需要 Obsidian **1.6.0** 或更新的桌面版。

## 方式一：社区市场（推荐）

1. 打开 设置 → 第三方插件
2. 关闭「安全模式」
3. 点「浏览」，搜索 `Pulsewright`
4. 安装 → 启用

## 方式二：手动装三个文件

从 [Releases](https://github.com/yhjes2019/pulsewright/releases) 下载当前版本的三个文件：

```
main.js
manifest.json
styles.css
```

放进你的库：

```
<你的库>/.obsidian/plugins/pulsewright/
```

然后重载 Obsidian（`Ctrl+R`），到 设置 → 第三方插件 里找到 Pulsewright 启用。

> 三个文件必须版本一致。混用不同版本会出现「面板打不开」或「设置项错位」。

## 方式三：安装包

Release 里另外挂了两个包，给不想手动放文件的人：

- `Pulsewright-Setup-<版本>.exe` — Windows 安装器，会自动列出你本机的 Obsidian 库，选一个点「安装到这个库」即可。
- `pulsewright-<版本>.zip` — 解压后把 `pulsewright` 文件夹放进 `.obsidian/plugins/`。

## 第一次打开

装好后有三种方式打开面板：

- 左侧边栏的脉搏图标
- 命令面板搜 `Pulsewright`
- 自己绑一个快捷键（设置 → 快捷键，搜 Pulsewright）

首次打开会扫描整个库。库里有一万多篇笔记时，第一次扫描要十几秒，之后走缓存，只读改动过的文件。

## 它把数据放在哪

```
<你的库>/<数据目录>/     # 设置里可改，默认叫 Pulse
```

里面是它自己的日统计、速记、惦记配置和导出的分享卡。**不碰你的笔记正文。**

## 卸载

禁用插件即可。想连数据一起清掉，再手动删除 `<你的库>/<数据目录>/`。
