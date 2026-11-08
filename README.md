# 百亿补贴 · API 路由中心

基于 **Material 3（Material You）** 设计规范的 **AI 模型路由中心**：公开模型目录页 + 管理员后台，配套纯 Node.js 后端（零第三方依赖，无需 `npm install`）。支持**账号密码登录**、**邮箱验证码登录**（QQ 邮箱 SMTP 发信）与**第三方 OAuth 登录**（GitHub / 微信 / Google）。

## 模型数据模型

每条路由记录即一个上游模型接入，字段包括：

| 字段 | 说明 |
|---|---|
| `name` | 模型名称（如 GPT-4o） |
| `model` | 模型标识（如 `gpt-4o`，调用时传入的 model 参数） |
| `vendor` | 上游厂商（OpenAI / Anthropic / Google / DeepSeek 等） |
| `path` | 接入路径（如 `/v1/chat/completions`） |
| `group` | 渠道分组：对话补全 / 图像生成 / 向量嵌入 / 语音服务 |
| `context` | 上下文长度（token） |
| `priceIn` / `priceOut` | 输入 / 输出单价（元 / 百万 token）；按次计费模型记 0 |
| `balance` | 剩余额度（点） |
| `status` | online / offline / deprecated；`calls`、`latency` 为运行时统计 |

种子数据内置 18 个主流模型（对话、图像、嵌入、语音四类，8 家上游厂商），可在后台增删改。

## 功能

### 公开目录页 `/`
- 模型概览统计（总数 / 在线 / 上游厂商）
- 关键词搜索（模型名、标识、厂商、路径、描述、标签）
- 按请求方法、渠道分组、状态筛选
- 模型详情对话框：标识、厂商、上下文、输入 / 输出单价、接入地址，一键复制
- 浅色 / 深色主题切换，响应式布局

### 管理后台 `/admin.html`
- **账号密码登录**：服务端 scrypt 加盐校验，签发 Bearer Token 会话（12 小时有效）
- **邮箱验证码登录**：SMTP 发送 6 位数字验证码；按邮箱匹配账号，未匹配则自动创建 `member` 账号
- **第三方登录**：GitHub / 微信 / Google 授权码流程，回调后自动匹配或创建账号
- 概览面板：模型总数、在线模型、上游厂商数、累计调用，最近更新列表
- 模型路由管理：搜索、筛选、列表查看（上下文、单价、额度一目了然）
- 新建 / 编辑模型（表单校验，服务端二次校验）
- 在线 / 离线状态一键切换；删除模型二次确认
- 全部写接口均需登录，未登录或会话过期自动退回登录页

## 目录结构

```
百亿补贴/
├── server.js              # 纯 Node.js HTTP 后端（静态托管 + REST API + 鉴权 + OAuth）
├── package.json           # 启动脚本与 Node 版本要求（无第三方依赖）
├── data/                  # 运行时数据（首次启动自动生成，可清空重置）
│   ├── routes.json        # 模型路由数据（自动生成种子数据）
│   ├── accounts.json       # 账号与第三方绑定关系（scrypt 加盐哈希）
│   └── mail-config.json  # SMTP 凭据（本地配置，不进部署包；可用环境变量替代）
├── public/
│   ├── index.html          # 公开 API 目录页
│   ├── admin.html          # 管理后台（登录 + 控制台）
│   └── oauth-callback.html # 第三方登录回调落地页
└── README.md
```

## 本地运行

```bash
node server.js
# 或 npm start
# 目录页   http://localhost:3000/
# 后台     http://localhost:3000/admin.html
```

环境变量：

| 变量 | 说明 | 默认值 |
|---|---|---|
| `PORT` | 监听端口 | `3000` |
| `ADMIN_USER` | 管理员账号（仅首次生成 `data/accounts.json` 时生效） | `hub_ops` |
| `ADMIN_PASS` | 管理员密码（仅首次生成时生效） | `K7xQ-2mW9-Pz41` |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub OAuth 应用凭据 | 空（演示模式） |
| `WECHAT_APP_ID` / `WECHAT_APP_SECRET` | 微信开放平台应用凭据 | 空（演示模式） |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth 凭据 | 空（演示模式） |
| `SMTP_HOST` / `SMTP_PORT` | 邮件 SMTP 服务器与端口（隐式 TLS） | `smtp.qq.com` / `465` |
| `MAIL_USER` | 发件邮箱账号（SMTP 登录名） | `729594565@qq.com` |
| `MAIL_CODE` | 邮箱 SMTP 授权码（QQ 邮箱后台生成，非登录密码） | 空（读取 `data/mail-config.json`） |

> 如需重置账号：停止服务后删除 `data/accounts.json` 再启动，将按环境变量重新生成管理员。

## 默认管理员账号

> 账号与密码均不是常见的 `amb` 开头默认凭据。

- 账号：`hub_ops`
- 密码：`K7xQ-2mW9-Pz41`

密码在服务端以 scrypt 加盐哈希存储，前端代码与页面中不包含任何明文密码。

## 第三方登录配置

### 演示模式（默认，无需申请应用）

未配置任何 OAuth 凭据时，点击 GitHub / 微信 / Google 按钮会走内置演示身份：服务端生成一次性授权码 → 回调校验 → 签发会话 Token，流程结构与真实 OAuth 完全一致，便于本地联调与演示。演示账号按渠道固定绑定，重复登录进入同一账号。

### 接入真实第三方应用

1. 在对应平台创建 OAuth 应用，回调地址填写：
   - GitHub：`https://<你的域名>/api/oauth/github/callback`
   - 微信：`https://<你的域名>/api/oauth/wechat/callback`
   - Google：`https://<你的域名>/api/oauth/google/callback`
2. 配置上表对应的环境变量后重启服务，按钮即自动切换为真实授权跳转（`/api/oauth/providers` 返回 `configured: true`）。
3. 服务端在回调中用授权码换取访问令牌，再拉取第三方用户资料，按渠道 UID 匹配本地账号；未匹配时自动创建 `member` 角色账号并绑定该渠道。

> 说明：微信开放平台的令牌接口参数名与标准 OAuth2 略有差异，如正式接入微信，可在 `server.js` 的 `exchangeCode` 中按其文档调整请求字段。

## 邮箱验证码登录与 SMTP 配置

后端用 Node 内置 `tls/net` 手写最小 SMTP 客户端，**不安装 nodemailer 等第三方邮件库**。

### 配置方式（二选一）

1. **环境变量**（推荐生产环境）：`SMTP_HOST`、`SMTP_PORT`、`MAIL_USER`、`MAIL_CODE`；
2. **本地配置文件** `data/mail-config.json`：

```json
{
  "host": "smtp.qq.com",
  "port": 465,
  "user": "729594565@qq.com",
  "pass": "你的 SMTP 授权码"
}
```

> 授权码只保存在服务端配置或环境变量中，不会下发到前端页面，也不打进部署包。`data/mail-config.json` 已被 `.gitignore` 排除。

### 验证码规则

- 6 位数字验证码，**10 分钟内有效**；
- 同一邮箱 **60 秒**重发冷却，连续校验错误 **5 次**后作废需重新获取；
- 验证码登录按邮箱匹配本地账号；未匹配时自动创建 `member` 角色账号（用户名 `mail_<随机串>`，昵称取邮箱 `@` 前缀）；
- 服务器需放行到 SMTP 服务器的 **465 端口出站**（QQ 邮箱隐式 TLS）；若出站被拦截，发送接口返回 502「验证码邮件发送失败」。

## 部署到网站

要求服务器支持 **Node.js 18+**（纯内置模块，无 `npm install` 步骤）。

1. 上传整个目录（保留 `server.js`、`package.json`、`public/`、`data/`）。
2. 启动：`node server.js` 或 `npm start`；可用 PM2 守护：`pm2 start server.js --name baiyi-api-center`。
3. 反向代理（Nginx 等）将域名指向对应端口；HTTPS 下请透传 `X-Forwarded-Proto` 头，保证回调地址生成正确的 `https://` 链接。
4. 在平台面板配置上述环境变量（端口、管理员凭据、OAuth 凭据）。

## 后端接口

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/health` | 否 | 健康检查 |
| GET | `/api/oauth/providers` | 否 | 第三方渠道及是否已配置 |
| GET | `/api/oauth/:provider/start` | 否 | 发起第三方授权（302 跳转） |
| GET | `/api/oauth/:provider/callback` | 否 | 第三方回调，签发会话后跳转落地页 |
| POST | `/api/login` | 否 | 账号密码登录，返回 Bearer Token |
| POST | `/api/email/code` | 否 | 发送邮箱验证码（60 秒重发冷却） |
| POST | `/api/email/login` | 否 | 邮箱验证码登录，返回 Bearer Token |
| POST | `/api/logout` | 是 | 退出登录，销毁会话 |
| GET | `/api/me` | 是 | 当前登录账号（账号、昵称、渠道、角色） |
| GET | `/api/stats` | 否 | 概览统计 |
| GET | `/api/groups` | 否 | 全部分组 |
| GET | `/api/routes` | 否 | 模型列表，支持 `q / method / group / status` 查询参数 |
| GET | `/api/routes/:id` | 否 | 模型详情 |
| POST | `/api/routes` | 是 | 新建模型 |
| PUT | `/api/routes/:id` | 是 | 全量更新模型 |
| PATCH | `/api/routes/:id` | 是 | 局部更新（如状态切换） |
| DELETE | `/api/routes/:id` | 是 | 删除模型 |

## 设计与合规说明

- **M3 令牌**：亮色 / 暗色两套完整语义色令牌，暗色仅通过变量切换；组件规则内不硬编码颜色。
- **图标**：全部为内联 SVG（`fill="currentColor"`），未使用 emoji 作为功能图标。
- **无障碍**：跳转链接、按钮可聚焦、`:focus-visible` 焦点环、对话框 `role="dialog"` + `aria-modal`、`aria-live` 播报区、`prefers-reduced-motion` 降级、不禁止页面缩放。
- **响应式**：手机单列起步，宽屏升级为多列卡片 / 侧边导航栏。
- **零依赖**：后端仅使用 Node 内置模块；前端无 CDN、无构建步骤。

## 校验

设计规范仓库内附带四个检查脚本，可在项目根目录执行：

```bash
python3 ../m3-design-spec/m3-design-spec/scripts/check_m3_html.py public/index.html
node    ../m3-design-spec/m3-design-spec/scripts/dom_harness.js public/index.html
node    ../m3-design-spec/m3-design-spec/scripts/audit_keyboard.js public/index.html
# admin.html、oauth-callback.html 同理
```
