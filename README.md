# dsh-memorix-panel

> 在 DSH Web GUI 里查看与管理本地 **Memorix** 记忆库。

版本 `0.1.0` · 许可证 MIT · 作者 [@biubiu23333333](https://github.com/biubiu23333333) · 仓库 <https://github.com/biubiu23333333/dsh-memorix-panel>

本插件是一个 **DSH profile 级插件**(同时带 host 半与 client 半),常驻运行,可以被任何 DSH 部署安装使用。

## 项目简介

[Memorix](https://github.com/AVIDS2/memorix) 是一个**本地优先的 AI 记忆控制平面**:它由 CLI(`memorix`)、MCP server 与本地 SQLite 数据库组成,把项目记忆保存在本机,供各种 AI 编码代理共享检索。

`dsh-memorix-panel` 把这份记忆库搬进 DSH Web GUI:在会话界面里直接浏览记忆库状态、按项目和类型检索记忆、查看单条记忆的完整正文与元信息,并在需要时修改记忆状态或新建记忆。读取是**只读直连 SQLite**;所有写入**一律交给官方 `memorix` CLI** 执行,以保证 Memorix 自己的检索索引保持同步。

## 功能一览

| 功能 | 说明 |
| --- | --- |
| 库状态 | 显示记忆库路径、文件大小、WAL 大小、最后更新时间、`memorix` CLI 版本 |
| 总量统计 | 记忆 / 项目 / 活跃 / 归档 / 长期记忆 / 迷你技能 / 会话 / 证据卡 / 知识页 |
| 搜索 | 按标题、实体(entityName)、类型检索记忆 |
| 筛选 | 按记忆类型与状态(active / resolved / archived)筛选 |
| 项目列表 | 手风琴式展开项目,查看该项目下的记忆 |
| 记忆详情 | 元信息 + 正文 + 要点(facts)+ 概念(concepts)+ 涉及文件 + 关联提交 + 关联实体 |
| 改状态 | 详情页可直接改记忆状态(带二次确认) |
| 新建记忆 | 面板内新建一条记忆(带二次确认) |
| **长期记忆视图** | 独立分区浏览耐用记忆层:状态(已批准 / 已确认 / 候选 / 已归档 / 已被取代)、作用域(用户级 / 项目级 / 团队级)、可携带性、类型(事实 / 流程 / 事件);按状态与作用域筛选;点开可看内容、要点、标签、适用性、证据链与审计事件(created → qualified → approved)。面板会提示「候选与已确认都不会进入 Workset,必须 approve」 |
| **长期记忆管理** | 详情页可直接驱动 Memorix 自己的状态机:候选 →「确认 (qualify)」→ 已确认 →「批准 (approve)」→ 已批准,以及「归档」;每次操作都要填**理由**(写入审计事件)并二次确认,状态机规则与报错由官方 CLI 给出 |
| **一键复制项目名** | 项目行上的「复制」按钮一键复制 projectId(点完变 ✓,且不会触发项目行的展开/折叠);记忆详情的「项目」行与长期记忆详情的「起源项目」行旁同样有复制按钮。复制失败时回退到 execCommand 方式 |

**界面入口**

1. **会话标题栏入口(默认位置)**:入口就挂在**会话标题栏里「Session 日志」按钮的右边**(与它同一行、紧邻其后)。
2. **右侧边缘停靠(无会话时的兜底)**:没有活动会话(或找不到「Session 日志」按钮)时,入口自动停靠到**浏览器窗口右侧边缘、垂直居中**处;一旦会话出现,会自动回到标题栏。会话切换/页面重渲染后也会自动重新落位。
3. **右侧工作台 tab(彩蛋)**:若部署里安装了 `dsh-better-sidebar` 且与本插件处于**同一个客户端组装域**,工作台的「+ / 空面板卡片」里还会多出一项「**Memorix 记忆**」。

无论停在哪个位置,面板都以**浏览器顶层浮层(top-layer)**抽屉的形式从右侧滑出。

> ⚠️ **为什么是 body 级挂载 + DOM 落位,而不是槽位**:DSH 的浏览器侧由**多个客户端组装域**组成,槽位系统(`slots`)与 `dsh-better-sidebar` 的 tab 注册表都**按域隔离**;插件实例可能被挂进一个不被可见 UI 读取的域,于是出现"注册成功但界面上看不到"的静默失败(实测踩过)。现在入口先挂到 `document.body`,再按 **DOM 查找**「Session 日志」按钮把自己插进它右侧——不依赖任何域,也不需要任何注入声明。

## 多语言 / Localization

面板文案跟随 **DSH 外壳的当前语言**:两种语言都注册在客户端 `locale` 服务的 `dsh-memorix-panel` 命名空间下,每次取值都读当时的活动语言。

| 语言 | 状态 |
| --- | --- |
| 简体中文 `zh` | 默认(上游原文逐字保留) |
| English `en` | 新增 |

- 切换外壳语言后,已经打开的面板会立即重绘,不需要刷新页面。
- 部署里没有 `locale` 服务时,面板回退到简体中文,行为与旧版完全一致。
- 标签映射(记忆类型、状态、长期记忆的 state / scope / kind)存的是**语言键**,在取值时翻译——写成模块级常量会在模块加载时就把语言定死。
- host 半不再拼装面向用户的文案:`/memorix-panel/api` 的错误响应新增稳定的 `code`(可选 `params` / `hintCode` / `hintParams`),由浏览器半按当前语言渲染;`error` 字段保留为中文兜底,供日志与不认识该 `code` 的调用方使用。
- 相对时间改由浏览器半渲染(host 只发 ISO 时间戳),因此响应里的 `lastAge` / `age` 字段已移除。

## 前置条件

| 依赖 | 要求 | 说明 |
| --- | --- | --- |
| DSH (DeepSeek Harness) | 已安装并可用 Web GUI | 插件以 profile 级 bundle 形式挂载,默认 profile 名为 `web` |
| Node.js | **≥ 22.18.0** | 这是 Memorix 自身的版本要求;本插件的 `node:sqlite` 读取路径需要 Node ≥ 22.5,已被覆盖 |
| Git | 已安装 | Memorix 的项目身份来自真实 Git 根 |
| Memorix CLI | 已安装(见第一步) | 提供 `memorix` 命令 |
| `dsh-better-sidebar` | 可选 | 只在需要「Memorix 记忆」侧边 tab 时才需要 |
| `python3` | 可选回退 | 当 `node:sqlite` 不可用时(如 Node < 22.5),插件自动回退到 `python3` 标准库 `sqlite3` 读库 |

插件本身**零运行时依赖**(除 DSH 自身与 react 外,不依赖任何第三方 npm 包)。

## 第一步:安装 Memorix

> 依据:Memorix 官方 README 的 `#install` 章节,以及官方 `docs/SETUP.md`。

### 1. 全局安装 CLI

官方推荐方式是 npm 全局安装:

```bash
npm install -g memorix
```

官方文档明确建议**持久化配置里不要用 `npx`**(`docs/SETUP.md` 原文:*"Avoid `npx` in persistent MCP configs. Use the globally installed `memorix` binary so startup is predictable."*)。如果你只是想临时试一下,可以用 `npx memorix@latest --version`,但正式接入请使用全局二进制。

### 2. 验证安装

```bash
memorix --version
which memorix
```

预期输出:版本号一行(本机验证为 `1.9.1`),以及二进制路径(本机为 `/usr/bin/memorix`)。版本号比 `1.9.1` 更高是正常的。

### 3.(可选)生成全局配置

```bash
memorix init --global
```

`memorix init` 是**可选**步骤,它会创建或更新 TOML 配置:`~/.memorix/config.toml`(全局默认值)与 `<git-root>/memorix.toml`(单项目可选覆盖)。

### 4. 接入 DSH

```bash
memorix setup --agent dsh --global
```

对 DeepSeek Harness 而言,这条命令会:往 `$DSH_HOME/cordis.patch.yml`(默认 `~/.dsh/cordis.patch.yml`)写入一行 Memorix 的 `@deepseek-ai/dsh-mcp-client` 行;往 harness 的 `AGENTS.md`(`~/.dsh/AGENTS.md`)追加使用指引;并在 `$DSH_HOME/skills`(默认 `~/.dsh/skills`)安装官方 skills。接入完成后 MCP 工具以 `mcp__memorix__*` 出现。

校验与修复:

```bash
memorix doctor agents --agent dsh    # 检查 MCP 配置与指引是否最新
memorix repair agents --agent dsh    # 需要时修复 Memorix 自己写入的条目
```

### 5. 让 Memorix 认识你的项目

Memorix 的项目身份**来自真实 Git 根**。让某个项目被注册,最简单的方式就是在该项目目录里跑一次命令:

```bash
cd /path/to/your/project
memorix status              # 查看当前项目身份(Name / ID / Root / Observations)

# 想确认项目上下文是否可检索,可以再跑一次:
memorix context "正在做的事" --brief-json
```

这一步的结果会体现在下面这两个文件里,本插件正是读取它们来还原「项目 ↔ 记忆」的映射:

| 路径 | 内容 |
| --- | --- |
| `~/.memorix/data/.project-aliases.json` | 项目别名分组:`groups[].canonical` / `aliases` / `rootPaths` |
| `~/.memorix/last-project-root` | 最近一次使用的项目根路径 |

> 未覆盖的场景请参见 Memorix 官方 README 与 `docs/SETUP.md`(npm 包名 `memorix`,仓库 <https://github.com/AVIDS2/memorix>)。

## 第二步:安装本插件

三种安装方式任选其一。

```bash
# 方式一:从 npm 安装
dsh plugin --profile web add dsh-memorix-panel

# 方式二:从 GitHub 安装
dsh plugin --profile web add github:biubiu23333333/dsh-memorix-panel

# 方式三:本地开发安装
cd ~/.dsh/profiles/web && dsh plugin --profile web add /绝对路径/dsh-memorix-panel
```

安装完成后:**硬刷新浏览器**(Windows/Linux `Ctrl+Shift+R`,macOS `Cmd+Shift+R`),让 client 半生效;如果 **host 半有更新**,还需要重启 `dsh-web`。

## 第三步:验证

### 1. 确认 Memorix 侧正常

```bash
memorix --version
ls -la ~/.memorix/data/memorix.db
```

应当能看到版本号,以及记忆库文件(可能还会看到同目录下的 `memorix.db-wal`、`memorix.db-shm`)。

### 2. 确认插件侧生效

硬刷新页面后,打开任意一个会话:

- 会话标题栏里,**「Session 日志」按钮的右边**应出现入口「**● 记忆 N**」;
- 点它 → 右侧滑出顶层浮层抽屉(面板顶部显示记忆库路径与大小);
- 没有打开的会话时,入口会停靠在**窗口右侧边缘垂直居中**处(兜底位置);
- 若你装了 `dsh-better-sidebar` 且与插件同域,工作台「+ / 空面板卡片」里还会多一项「Memorix 记忆」(可选)。

统计区应给出记忆/项目/活跃/归档等数量。如果数量为 0,先按第一步第 5 小节在一个真实项目里跑一次 `memorix status`。

也可以用命令行直接验证 host 半(需把 `<TOKEN>` 换成启动日志里打印的令牌,loopback 访问时通常直接可通):

```bash
curl -s -X POST http://127.0.0.1:3080/memorix-panel/api \
  -H 'content-type: application/json' -d '{"action":"overview"}' | head -c 400
```

返回形如 `{"ok":true,"backend":"node:sqlite",...}` 即为正常。

## 使用说明

### 界面结构

| 区域 | 内容 |
| --- | --- |
| 库状态 | 记忆库路径、库文件大小、WAL 大小、最后更新时间、`memorix` CLI 版本 |
| 总计 | 记忆 / 项目 / 活跃 / 归档 / 长期记忆 / 迷你技能 / 会话 / 证据卡 / 知识页 |
| 搜索与筛选 | 搜索框(按标题、实体、类型)+ 记忆类型与状态筛选器 |
| 项目列表 | 手风琴分组,展开后列出该项目下的记忆 |
| 详情视图 | 元信息、正文、要点、概念、涉及文件、关联提交、关联实体;底部是改状态与操作按钮 |

### 数据存储(只读读取)

| 路径 | 说明 |
| --- | --- |
| `~/.memorix/data/memorix.db` | SQLite 记忆库,**单库多项目**,以 `projectId` 列区分项目 |
| `~/.memorix/data/.project-aliases.json` | 项目映射:`groups[].canonical` / `aliases` / `rootPaths` |
| `~/.memorix/last-project-root` | 最近使用的项目根 |

`observations` 表包含 `id` / `type` / `title` / `narrative` / `facts` / `concepts` / `filesModified` / `status` / `createdAt` / `updatedAt` / `entityName` / `valueCategory` / `topicKey` / `source` / `visibility` 等字段。

### 读取实现

按顺序尝试,任一成功即停止:

按顺序尝试,任一成功即停止:Node 内置 `node:sqlite`(需 Node ≥ 22.5)→ `python3` 标准库 sqlite3 模块 → 系统 `sqlite3` CLI。

### 写入实现

写入**一律通过官方 CLI**,不做裸 SQL 写入(这样 Memorix 自己的检索索引才会同步)。

```bash
# 改状态
memorix memory resolve --id <n> --status active|resolved|archived --json --cwd <项目根>

# 新建记忆
memorix memory store --text <正文> --title <标题> --type <类型> \
  [--entity ...] [--facts a,b] [--concepts x,y] [--files p1,p2] [--topicKey ...] \
  --json --cwd <项目根>
```

### 记忆状态语义

| 状态 | 含义 |
| --- | --- |
| `active` | 活跃。默认检索可见 |
| `resolved` | 已解决 |
| `archived` | 已归档。**默认检索不返回**,但数据不会删除,可随时改回 |

面板里「改状态」和「新建记忆」都带**二次确认**,避免误操作。

## 配置

所有配置项都写在 profile 的 `cordis.patch.yml` 里该插件**行的 `config`** 中,全部可选。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `bin` | `memorix` | Memorix CLI 可执行文件名或绝对路径 |
| `dbPath` | 自动探测 `~/.memorix/data/memorix.db` | 记忆库 SQLite 文件路径 |
| `cliTimeoutMs` | `25000` | 每次调用 CLI 的超时时间(毫秒) |
| `allowWrite` | `true` | 是否允许「改状态」 |
| `allowStore` | `true` | 是否允许「新建记忆」 |

示例(`cordis.patch.yml`):

```yaml
- insert:
    - id: memorix-panel
      name: dsh-memorix-panel
      config:
        bin: memorix
        cliTimeoutMs: 25000
        allowWrite: true
        allowStore: true
```

如果只想开放只读浏览,把 `allowWrite` 与 `allowStore` 都设为 `false` 即可。

## 开发与目录结构

插件是 DSH 常见的 **host 半 + client 半**结构:host 半跑在 DSH 的 Node 进程里,负责读库、探测路径、调用 `memorix` CLI;client 半跑在浏览器里,负责按钮入口、浮层抽屉与右侧工作台 tab。

目录布局(遵循 DSH 插件约定):

```text
dsh-memorix-panel/
├── lib/
│   ├── index.js         # host 半:读 SQLite、探测项目映射、调用 memorix CLI
│   └── client.js        # client 半:标题栏入口按钮 / 浮层抽屉 / 侧边栏 tab
├── cordis.patch.yml     # bundle patch:把插件行挂到 profile 上
├── package.json         # dsh.bundle.patch + dsh.client.platform = web
└── LICENSE              # MIT
```

本地迭代:

```bash
# 以本地路径安装到 web profile
cd ~/.dsh/profiles/web && dsh plugin --profile web add /绝对路径/dsh-memorix-panel
# 只改了 client 半 → 硬刷新浏览器即可;改了 host 半 → 重启 dsh-web
```

## 常见问题

### 1. 看不到「● 记忆 N」入口

1. **硬刷新**浏览器(`Ctrl/Cmd+Shift+R`)——client 半是独立 bundle,不刷新不会更新。
2. 确认你装的 profile 正确:本 README 以 `web` 为例,若你的 Web profile 名字不同,把命令里的 `--profile web` 换成实际名字。
3. 确认插件确实已安装:检查该 profile 的 `package.json`(依赖列表与 `dsh.profile.bundles` 数组里是否有 `dsh-memorix-panel`),或查看 profile 的 `node_modules`。
4. 如果 host 半刚更新过,重启 `dsh-web`。

### 2. 写入失败:`EACCES: permission denied`

这是**沙箱 / 权限边界**问题,不是插件 bug。Memorix 的库在 `~/.memorix` 下,如果 DSH 进程的工作目录(或沙箱的 `workspaceRoot`)不包含 `~/.memorix`,写入就会被拒绝。处理方式二选一:

- 让 `dsh web` 以 `$HOME` 为工作目录运行,使 `~/.memorix` 落在可写范围内;
- 或使用更高的权限模式(如 full-access)运行。

### 3. 提示 Node 版本相关错误

插件的首选读取路径使用 Node 内置 `node:sqlite`,**需要 Node ≥ 22.5**。升级 Node 到 22.5 以上(建议直接满足 Memorix 要求的 ≥ 22.18.0);或安装 `python3`(标准库自带 `sqlite3`),让插件走回退路径。

### 4. 报「未找到项目根」

1. 检查 `~/.memorix/data/.project-aliases.json` 是否有对应的 `groups[]` 条目(`canonical` / `aliases` / `rootPaths`);
2. 检查 `~/.memorix/last-project-root` 指向哪里;
3. 在目标项目里跑一次 `memorix`(在该项目目录内,或带 `--cwd <项目根>`),让 Memorix 注册这个项目,然后回到面板重试。

### 5. 改了状态,但检索结果里还是老样子 / 或者仍然搜不到

Memorix 的 MCP 常驻进程持有**内存索引**,状态变更后可能滞后一拍。面板是直接读库的,所以**面板始终显示最新状态**;等常驻进程刷新后再检索即可。

### 6. 中文关键词检索效果弱

Memorix 默认使用 FTS/BM25 全文检索,对中文分词较弱。可考虑按官方文档配置 embedding 来提升中文召回质量(参见 Memorix 官方 README 与 `docs/SETUP.md`)。

## 安全与隐私

- 插件只**读取本机** Memorix 记忆库;所有改动都交给官方 `memorix` CLI 执行,不做裸 SQL 写入。
- 所有 HTTP 路由都要求**同源**,且只接受 **loopback 或部署的受信主机**。
- 跨站请求被拒绝:携带 `sec-fetch-site: cross-site` 的请求直接返回 **403**。
- **无遥测**、**无外部网络请求**。

## License

MIT © biubiu23333333

---

## Quick Start (English)

```bash
# 1. Install the Memorix CLI (requires Node >= 22.18.0 and Git)
npm install -g memorix
memorix --version              # expect e.g. 1.9.1
memorix setup --agent dsh --global   # wire Memorix into DSH

# 2. Register a project (project identity comes from the real Git root)
cd /path/to/your/project && memorix status

# 3. Install this panel
dsh plugin --profile web add dsh-memorix-panel
#    then hard-refresh the browser (Ctrl/Cmd+Shift+R)
```

Look for the native **「● 记忆 N」 / "● Memory N"** button at the top-right of the session header (or the「Memorix 记忆」/ "Memorix Memory" tab if `dsh-better-sidebar` is installed). Panel copy follows the shell's active locale — Simplified Chinese or English. Reads are direct and read-only against `~/.memorix/data/memorix.db`; every write goes through the official `memorix` CLI. MIT licensed.
