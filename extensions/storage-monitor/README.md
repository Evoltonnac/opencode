# OpenCode 存储面板

私有部署扩展，基于 `2.2.7-naiverse.1` / `219236440a614493ada709249d8e67ba33b63503`。采用原生插件 RPC；不修改 Core、Protocol 或生成的 Client。Web 设置复用原生 `Progress`、`Button`、服务器上下文和 `plugin.updated` 事件。

## 行为与范围

- 参考容量默认为十进制 2 GB（2,000,000,000 字节），可在同一面板设置为 0.001–1024 GB，最多三位小数。通过原生插件 `ctx.storage` 持久保存到自己的命名空间，所有设备共用；无需重启。当前 OpenCode 配置和原生 API 没有磁盘硬配额；参考上限只用于提示，不阻止写入、不自动清理。
- 保存与刷新按同一状态机串行执行，未保存草稿不会被轮询覆盖。写入回执丢失时先只读确认，不自动重发；仍不明确时保留草稿并显示提示。
- 50% 起黄色，80% 起红色；超过容量显示真实百分比，条宽保持在 100% 以内。
- 打开设置时统计；面板可见时每分钟刷新，服务器端合并并缓存 30 秒。SQLite 扫描在独立线程运行，有 8 秒上限，避免阻塞对话服务器。插件加载事件会重新读取，刷新不会关闭已展开的明细。失败保留并标注旧样本，缺失数据不显示为 0。
- 统计服务器专用数据目录、缓存和工作区，不只当前项目。包含会话、附件、会话事件、已知可再生模型/指令缓存、数据库空页和日志、工具输出、运行日志、shell 临时文件、`opencode-untracked-*` 临时快照及工作区文件。
- 排除程序/插件、`cache/bin` 工具、账号/凭据/权限/项目元数据、备份、未知 KV 内容及其他系统临时目录。工作区内的用户文件只是计量对象，未增加删除操作。
- SQLite 使用只读连接和 `dbstat` 区分表及索引，WAL 中尚未写回的新页不会重复计量；不执行 checkpoint、VACUUM、迁移或删除。文件按分配块计量，跳过符号链接并对硬链接去重。扫描有时间和条目上限，部分结果会明确标识。
- `usage` / `getCapacity` RPC 只接受空输入，`setCapacity` 只接受范围内的整数字节数。不接受客户端路径或 SQL，不返回文件名、消息内容或凭据。设置不进入用量统计；共享 KV 仅在没有未知键时计入模型缓存的溢出页，保留元数据页。

## 构建与验证

在完整对应源码中使用 Bun 1.4.4 完成冻结依赖安装。数据模型和 RPC 定义的唯一源码在 `packages/app/src/settings/storage/model.ts`、`rpc.ts`；服务器包构建时将其一起打包。安装包必须包含 `index.js`、`worker.js` 和 `package.json`。

```sh
# 从本目录执行，dist 是安装包。
bun run test
bun run typecheck
bun run build

# 从 packages/app 执行。
bun run typecheck:tsc
bun test --conditions=browser --preload ./test-pairing/solid-preload.ts --preload ./happydom.ts ./test-pairing/settings-storage.test.ts ./test-pairing/settings-pairing.test.ts
OPENCODE_CHANNEL=latest VITE_OPENCODE_VERSION=2.2.7-naiverse.1 bun run build

# 从源码根执行。
bun run check
```

## 部署与后续同步

将 `dist` 安装为 `/opt/opencode/plugins/storage-monitor/releases/1.1.0-<hash>`，再向现有配置的 `plugins` 添加该目录（升级时仅替换本扩展原条目）；沿用配置观察器热加载，稳定插件 ID `mhxing.storage-monitor` 保留上限设置。保持原有所有插件、凭据和会话。Web 资源以同一 CLI 版本构建，通过现有 agent HTTPS 入口提供，API、鉴权、WebSocket 和 SSE 继续转发原生服务。

源码同步必须保留本目录、`packages/app/src/settings/storage/`、服务器设置入口，以及配对/存储的自定义中文键和两项组件回归。升级 CLI 时，同时从新的完整源码重建 Web 静态资源，设置 `VITE_OPENCODE_VERSION` 为实际部署版本并更新 Web current 链接。不要让旧静态资源覆盖新版本内嵌 UI；静态资源不能更新时先恢复原生入口，并明确该面板尚未交付。

原生 PWA 在所有旧标签页关闭后启用完整新构建；保留该机制。发布时保留对当前内嵌资源的回源，以支持仍打开的旧页面。回滚仅撤回本次插件条目、静态资源链接和 Nginx 差异，保留后续配置、会话与凭据。具体部署证据与恢复步骤记录在 VPS `/etc/host-ops`。

官方契约：[RPC](https://opencode.ai/docs/build/plugins/rpc/)、[GUI 加载边界](https://opencode.ai/docs/build/plugins/gui/)。当前 Web 不加载桌面 GUI 扩展，因此使用一个轻量设置面板。
