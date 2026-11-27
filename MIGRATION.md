# 迁移与安装说明（dsh-task-brief）

本文是给你自己在另一台设备上复现同一套设置用的。另一台设备不需要 GitHub、不需要 npm，**本地目录安装即可**。

---

## 一、这个插件做什么

新会话的**第一条任务**到达时，先输出一张《任务简报》表格再开工，包含九个字段：

任务 / 类型 / 难度 / 关键要求 / 工作量 / Token 估算 / 时间估算 / 推荐配置 / 推荐理由

表格后一句话收尾，三选一：`按推荐继续`、`当前配置即可，直接开始`、`建议先切到 X 再继续（我不会自动切换）`。

另外，空白新会话的输入框右上角会显示一枚「首轮先出任务简报」的提示条。

**只建议模型，不自动切换。** 它不会改你的模型选择。

## 二、什么时候生效 / 什么时候静默

| 情况 | 是否有简报 |
|---|---|
| 新会话的第一轮任务 | ✅ 有 |
| 会话已完成过至少一轮（含续接、带历史的 fork） | ❌ 静默 |
| 本轮只是寒暄、一句话能答完的问答、澄清反问 | ❌ 跳过 |

实现方式：协议注册在 **Agent 自己的作用域**里，检测到 session 有 `turn/end` 事件就立刻返回空字符串。不写 Session 日志、不新增事件类型，所以对续接、fork、回放都安全。

## 三、迁移到另一台设备

### 方式 A：直接拷贝目录（最简单，推荐）

1. 把整个 `dsh-task-brief` 目录拷到新设备，例如放到 `D:\dsh-plugins\dsh-task-brief`
2. 打开 DSH Web 界面
3. 左侧 **Plugins** → **Add plugin**（添加插件）
4. 选择该目录
5. 安装后确认插件行 `task-brief` 显示为已启用
6. **新开一个会话**（不要用旧会话验证），发一条真实任务，回复开头应出现 `## 任务简报`

> 目录里不能有 `node_modules`，也不需要。这是个纯 JS 包，没有依赖。

### 方式 B：从 GitHub 拉取

仓库地址：`https://github.com/wen986731824-commits/dsh-task-brief`

在那台设备上：

```bash
git clone https://github.com/wen986731824-commits/dsh-task-brief.git
```

然后按方式 A 的第 2–6 步，指向 clone 下来的目录。

### 方式 C：安装 tgz 包

如果目录里带了一个 `dsh-task-brief-1.0.0.tgz`：

```bash
# 解包到一个目录，再按方式 A 安装
tar -xzf dsh-task-brief-1.0.0.tgz
```

## 四、配置项

安装后，在 profile 的 `cordis.patch.yml` 里追加（或修改）这一段：

```yaml
- id: task-brief
  name: 'dsh-task-brief'
  config:
    enabled: true             # 总开关，false 则完全不注入
    includeModelCatalog: true # 是否把本次运行的真实模型目录注入提示词
    maxCatalogModels: 24      # 最多列多少个模型
    catalogTimeoutMs: 12000   # 取模型目录的超时；超时则按通用能力推荐
```

改完保存，新会话生效。

## 五、验证是否装好了

三条独立验证，任一条不过就是没装好：

**① 插件行存在**

Plugins 面板里能看到 `任务简报 / Task brief` 这一行，状态为启用。

**② 提示条出现**

新建一个空会话，输入框上方/右侧应有「首轮先出任务简报」的小胶囊。

**③ 简报真的出来了**

在**新会话**发一条真实任务（例如「帮我看看这个目录的结构，整理成文档」），回复开头应为：

```
## 任务简报

| 项目 | 内容 |
|---|---|
| 任务 | ... |
| 类型 | ... |
| 难度 | ... |
```

> 注意：如果你在**已有对话**里测试，简报不会出现——这是设计如此，不是故障。

## 六、故障排查

| 现象 | 原因与处理 |
|---|---|
| 装了但新会话没简报 | 90% 是模型没遵守提示词。先确认 ③ 的测试用的是**全新会话**；仍不行则在配置里把 `enabled` 改成 `false` 再改回 `true`，触发重载 |
| 没看到提示条 | 检查是否在**空白新会话**里看。有历史内容的会话不显示 |
| 简报里没有模型目录 | `includeModelCatalog` 被关，或 `llm` 服务超时。看 DSH 日志里 `task-brief:` 开头的警告 |
| 简报把估算写成精确值 | 模型行为问题，不是插件承诺。插件只要求它给区间并标注「估算」 |
| 想彻底关掉 | 配置里 `enabled: false`，或直接在 Plugins 面板禁用该插件 |

## 七、文件清单

```
dsh-task-brief/
├── package.json          包清单（dsh.bundle / dsh.client 声明）
├── cordis.patch.yml      插件行声明与默认配置
├── index.js              Host 半：注入协议 + 采集模型目录
├── client.js             Client 半：空白会话的提示条
├── locale/en.json        英文标题与描述
├── locale/zh.json        中文标题与描述
├── icon.svg              插件图标
├── docs/DETAIL.md        英文详情页（含预览图）
├── docs/DETAIL.zh.md     中文详情页
├── docs/preview.svg      英文预览图
├── docs/preview.zh.svg   中文预览图
├── README.md             完整说明
├── LICENSE               MIT
└── scripts/
    ├── test-host.mjs     本地接线测试（node scripts/test-host.mjs）
    └── publish-github.mjs 走 GitHub API 发布（备用，本次未用于 npm）
```

## 八、已知限制

1. **不自动切模型**。这是当初有意选择的行为：避免意外切到高价模型。
2. **估算不是实测**。Token 与时间都是量级参考。
3. **每轮多 200–400 token 输出**（简报本身）。介意就关掉。
4. **无法上架 npm 社区市场**。本机 `www.npmjs.com` 被 Cloudflare 托管质询拦截，注册通道拿不到有效凭据。GitHub 仓库已上传，可 clone 使用。
