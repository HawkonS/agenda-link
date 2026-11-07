# 议链（agenda-link）

<p align="center">
  <img src="./apps/web/public/logo.svg" height="112" alt="议链" />
</p>

<p align="center">一次预约，会议与日程同时就位</p>

<p align="center">
  中文 ·
  <a href="./README_EN.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/HawkonS/agenda-link/actions/workflows/checks.yml"><img src="https://github.com/HawkonS/agenda-link/actions/workflows/checks.yml/badge.svg?branch=main" alt="Checks" /></a>
  <a href="https://github.com/HawkonS/agenda-link/actions/workflows/security.yml"><img src="https://github.com/HawkonS/agenda-link/actions/workflows/security.yml/badge.svg?branch=main" alt="Security" /></a>
  <a href="https://github.com/HawkonS/agenda-link/actions/workflows/codeql-analysis.yml"><img src="https://github.com/HawkonS/agenda-link/actions/workflows/codeql-analysis.yml/badge.svg?branch=main" alt="CodeQL" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache-2.0" /></a>
</p>

## 简介

议链（agenda-link）是一个面向企业内部使用的会议与日程协同平台。它把通讯录、会议预约、日程安排和录制回看集中到一个工作台，减少在多个平台之间重复填写和手动同步。

系统支持飞书和腾讯会议：可以浏览和导入组织人员，预约、修改和取消会议，创建和维护飞书日程，并在会议改期时同步更新关联日程。飞书通讯录还可以按变化同步到腾讯会议。

项目采用 React、NestJS 和 SQLite，前后端同端口部署，数据保存在本机，适合企业内网或单机服务器上的独立部署。

## 功能

- **统一工作台**：查看即将开始的会议、快速预约、进入会议和查看录制，支持桌面端与手机端。
- **通讯录**：读取飞书和腾讯会议的组织架构与人员，支持搜索、筛选和选择导入。
- **通讯录同步**：从飞书同步部门和人员到腾讯会议，支持预览、范围选择、覆盖策略和定时执行；无变化时不会重复写入。
- **会议预约**：选择会议平台、时间、参会人和发起人，统一管理会议号、链接和状态。
- **会议编辑**：腾讯会议支持修改主题、时间、参会人、录制设置和日程模板，保存时同步更新会议与关联日程。
- **日程协同**：使用飞书日历时自动创建关联日程，支持参会人、日程模板、说明渲染和改期同步。
- **录制回看**：在会议详情中查看录制状态和回放入口。
- **取消与结束**：取消会议时同步取消关联日程，结束后保留记录和操作审计。
- **权限与审计**：区分管理员、运营人员和普通用户，关键操作全部留痕。
- **系统管理**：连接配置、用户权限、同步计划、日程模板、日志、备份和升级。

## 支持平台

| 能力 | 飞书 | 腾讯会议 |
| --- | --- | --- |
| 通讯录 | 读取、搜索、导入 | 读取、搜索、导入，接收飞书同步 |
| 会议 | 预约、查询、取消、录制信息 | 预约、查询、改期、取消、云录制 |
| 日程 | 创建关联日程、参会人、模板、修改 | — |
| 登录 | 可选飞书登录 | — |

会议可以单独预约，也可以同时创建飞书日程。日程会挂载已生成的会议链接；日程失败重试不会重复创建会议。

## 快速开始

环境要求：macOS / Linux、Git、Bash、Node.js **22.12+**、npm 10+。

```bash
git clone https://github.com/HawkonS/agenda-link.git
cd agenda-link
./run.sh
```

打开 <http://127.0.0.1:15173>。首次启动会创建 `hawkon` 管理员，初始密码保存在 `.runtime/initial-admin-password`，登录后请及时修改。

停止服务使用 `Ctrl+C` 或 `./stop.sh`。

## 配置

常用配置在根目录的 `agenda-link.properties`，首次启动自动生成。数据库保存在 `data/agenda-link.sqlite`，日志位于 `logs/`。也可以通过 `AGENDA_LINK_WORKSPACE` 指定独立的数据目录。

在“系统设置 → 配置管理”中维护飞书和腾讯会议连接。连接配置由后端组件声明，密钥加密保存；只有系统管理员可以保存和测试连接。

生产环境建议使用 HTTPS，并设置正确的对外访问地址，确保日程中的会议链接可以被参会人打开。

## 部署

```bash
sudo ./tools/manage_service.sh install
sudo ./tools/manage_service.sh start
sudo ./tools/manage_service.sh upgrade
sudo ./tools/manage_service.sh backup
```

也提供 Docker Compose、Nginx 和日志轮转示例：

- [Docker Compose](./tools/compose.yml)
- [Nginx 配置](./tools/nginx/agenda-link.conf.example)
- [日志轮转](./tools/logrotate/agenda-link)

系统使用 SQLite，只支持单实例运行；不要对同一数据目录启动多个副本。

## 开发

```bash
./run.sh --dev      # 后端热更新 + Vite 开发服务器
npm run check       # lint、类型检查、测试、构建和仓库审查
npm run test:e2e    # 临时实例端到端测试，需要本机 Chrome
```

## 常见问题

**忘记管理员密码？**

```bash
./tools/reset-admin-password.sh
./tools/reset-admin-password.sh --enable
```

**服务启动失败或端口被占用？**

检查 `15173` 和 `18480` 是否被其他进程占用，并确认 Node.js 版本不低于 22.12。详细日志在 `logs/`。

## 安全说明

- 不要提交 `agenda-link.properties`、`data/`、`.runtime/`、`logs/` 和备份文件。
- 连接密钥加密保存；更换 `auth.jwt-secret` 会导致已保存凭据无法解密，并使现有会话失效。
- 生产环境使用 HTTPS，限制管理接口、备份目录和数据库文件的访问范围。
- CI 包含 Semgrep 与 CodeQL 代码扫描。

## License

Copyright 2026 HawkonS.

本项目依据 [Apache License 2.0](./LICENSE) 发布。
