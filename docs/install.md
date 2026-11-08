# 安装、备份与恢复

本插件当前从源码构建，以本地 `link:` 方式接入 DSH；尚未发布 npm 包。安装脚本适用于 DSH 桌面 profile 的 **pnpm 9 格式锁文件**，不会联网安装依赖或重启 DSH。

## 构建与安装

需要 Node.js 22.21 或更新版本。获取源码后，在项目目录运行：

```sh
npm ci
npm run verify
mkdir -p "$HOME/dsh-backups"
```

`verify` 包含类型检查、自动化测试和构建。确认 DSH 的所有任务已经处理完毕，**完整退出 DSH，包括后台进程**，再执行以下示例。按环境替换路径，备份目录须为空、其父目录须已存在：

```sh
node scripts/install.mjs \
  --profile "$HOME/.dsh/profiles/desktop" \
  --data-home "$HOME/.dsh" \
  --backup-dir "$HOME/dsh-backups/keep-whale-first-install" \
  --name 大肥鱼 --confirm-stopped
```

三个路径参数都须为绝对路径；`--data-home` 指 DSH_HOME，插件数据会放在其下的 `dsh-keep-whale` 目录。`--confirm-stopped` 表示你已确认 DSH 退出；脚本也检查旧插件的进程锁，若仍运行则停止。

- `--name` 设置初始伙伴名，可省略；重启后仍可在界面改名。
- 观察默认关闭。要在初始化时启用之后的新对话观察，可加 `--observe`；也可启动后在设置中开启。旧伙伴明确绑定的专属会话 ID 会加入排除范围；普通 DeepSeek 会话不会因旧 persona 绑定而被批量排除。
- 首次安装不猜模型价格。重启后在「设置 → 模型与预算」选择 DSH 已配置的线路，并自行填写输入、缓存命中、输出单价、单位和每日预算；后台默认预算为 100 积分，可修改。
- `--tju` 是特定迁移辅助选项：仅当本机旧插件已保存的 tju 线路及 30／0.6／120 积分每百万 token、30 积分/元恰好与已确认信息一致时，才写入对应价格和每日 100 积分。其他用户不需要使用此选项；不匹配时脚本停止，不推测价格。

重新打开 DSH，在侧栏「养鲸」或浮层进入面板，核对模型、费用、观察范围和普通会话身份。首次使用从空白记忆开始；当前核心功能已有自动化检查，真实对话、长期陪伴与后台行为仍需在目标设备验证。

## 备份与切换

安装器备份 profile 的 `cordis.yml`、`cordis.patch.yml`、包配置和 pnpm 文件；通过 SQLite 在线 backup 保存旧记忆数据库的一致性副本，包括已提交 WAL。同时备份旧伙伴状态及浏览经历账本，不读取旧聊天，不导入旧记忆。旧浏览器账户目录和 Cookie 不复制，原位置保持不变。

脚本从 bundle 列表精确移除已知旧陪伴插件，保留其安装包与源码；为本插件添加本地链接与 pnpm 锁定项。其他皮肤、记账挂件及模型线路不应受影响。若 profile YAML 还有对旧插件的直接引用或非标准别名，脚本会停止并要求人工核对。已存在新插件数据、同名插件或不兼容的锁文件也会停止，避免覆盖。

同一备份目录重复安装时会核对配置、链接及初始化参数；一致则不重置数据，参数不同需在插件设置中修改。备份含私人配置，应限制访问，不要提交到 Git。源码目录须保留；后续包管理器可能重建 `node_modules`，若本地链接丢失，请先核对配置和备份再修复。

## 恢复旧版

先完整退出 DSH，使用安装时相同的路径与备份目录：

```sh
node scripts/restore.mjs \
  --profile "$HOME/.dsh/profiles/desktop" \
  --data-home "$HOME/.dsh" \
  --backup-dir "$HOME/dsh-backups/keep-whale-first-install" \
  --confirm-stopped
```

恢复前会核对安装后的包配置、pnpm 锁文件和链接。若它们在安装后被修改，脚本会拒绝自动覆盖，需人工合并。恢复只撤销本次安装对 profile 的修改，不覆盖或删除新插件数据、旧数据库或旧账户资料；备份仍保留。
