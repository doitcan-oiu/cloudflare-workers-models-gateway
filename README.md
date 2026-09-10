# EdgeGate

基于 **Cloudflare Workers + AI Gateway + D1 + KV** 的大模型网关管理程序。React 19 + HeroUI 3 + Tailwind CSS 4 前端，Hono + TypeScript 后端。功能参考 AxonHub 的统一模型接入场景，目前为单管理员、单工作空间。

**自定义服务商的推理请求全部经过 Cloudflare AI Gateway。** 本程序调用 Cloudflare API 管理服务商和 BYOK，直接读取 Cloudflare 日志与 GraphQL 分析，不再向 D1 写入推理日志或自行计算费用。

部署请阅读 [Workers 部署指南](./DEPLOYMENT.md)，包含 GitHub 自动部署、一键部署按钮、命令行部署和首次配置步骤。

## 职责与架构

```mermaid
flowchart LR
    App[应用 / OpenAI SDK] -->|应用 API Key| Worker[Worker · 鉴权 / 配额 / 模型别名 / 路由]
    UI[React 管理控制台] -->|管理会话| Worker
    Worker -->|推理| AIG[Cloudflare AI Gateway]
    AIG --> Custom[自定义服务商]
    Worker -->|服务商 / BYOK / 日志 / 分析| API[Cloudflare REST + GraphQL API]
    AIG --> Secrets[Cloudflare Secrets Store · BYOK]
    Worker --> D1[(D1 · 业务配置与配额)]
    Worker --> KV[(KV · 会话与分析 Schema 缓存)]
```

| 能力 | 实现位置 |
| --- | --- |
| 自定义服务商注册、查询、修改与删除 | Cloudflare Custom Providers API，账户级资源 |
| 供应商密钥 | Cloudflare Secrets Store + AI Gateway Provider Configs |
| 模型转发、日志采集、缓存、用量与费用数据 | Cloudflare AI Gateway |
| 日志列表与详情 | Worker 代理 Cloudflare Logs REST API |
| 总览、趋势、模型分布 | Cloudflare GraphQL `aiGatewayRequestsAdaptiveGroups` |
| 应用 API Key、模型权限、模型别名、渠道映射、原子配额 | Worker + D1 |
| 管理员会话 | Workers KV |

前端静态资源和 API 由同一个 Worker 提供。管理接口不把 Cloudflare Token 或供应商密钥返回浏览器。客户端 API Key 仅保存 SHA-256 哈希。自定义服务商密钥不保存到 D1；其他 Cloudflare 渠道的可选 Token 覆盖值仍使用 AES-256-GCM 加密。

前端使用 HeroUI 的按钮、输入框、选择器、弹窗、开关、复选框、状态标签及页签，采用中性炭黑背景、深灰卡片与翠绿色强调色，使用顶部导航、流量工作台、渠道资源列表、模型目录与路由详情、密钥权限卡片，以及分组的侧边编辑抽屉。Playground 将对话与参数并列展示，设置页按连接、凭据与接入代码分类。主题变量统一在 `src/styles.css` 中定义；各管理页面按需加载，支持窄屏导航。

## 本地启动

需要 Node.js 22.16+（建议 Node.js 24）和 npm。

```bash
npm ci
npm run setup
npm run dev
```

打开 [本地控制台](http://localhost:5173)。`setup` 在 `.dev.vars` 不存在时生成随机 `ADMIN_TOKEN` 和 `ENCRYPTION_KEY`，以 `0600` 权限保存，并应用本地 D1 迁移。已有文件不会覆盖。

使用 `.dev.vars` 中的 `ADMIN_TOKEN` 登录。没有 Cloudflare 配置时，可管理本地模型、应用密钥等；云端服务商、日志和分析页面会明确提示缺少配置。

安装或升级依赖后，请重启开发服务。如果页面白屏且依赖脚本请求一直处于等待状态，先停止旧的 `npm run dev`，再运行 `npm run dev -- --force` 重建 Vite 依赖缓存并刷新页面。开发端口固定为 `5173`，被占用时会直接报错，避免预览误连到旧进程。

### Cloudflare 配置

1. 在 Cloudflare 创建一个 AI Gateway，开启网关认证并检查日志采集设置。
2. 在 `wrangler.jsonc` 的 `vars` 填写 `CLOUDFLARE_ACCOUNT_ID`（32 位 Account ID）和 `AI_GATEWAY_ID`（网关名称/ID）。
3. 在 `.dev.vars` 添加 `CF_API_TOKEN`。Token 需授权目标账户的 **AI Gateway Read/Edit** 和 **Account Analytics Read**。
4. 如果要在本程序输入供应商 API Key，Token 还需 **Secrets Store Edit** 权限，并在 Cloudflare 创建 Secrets Store。可在 `vars.SECRETS_STORE_ID` 指定 Store ID；留空时仅在账户恰好有一个 Store 时自动采用它。程序不自动创建 Store。
5. 可选：添加独立的 `CF_AIG_TOKEN` 用于推理认证；不配置时使用 `CF_API_TOKEN`，此时它还必须包含 **AI Gateway Run** 权限。独立推理 Token 同样需要 AI Gateway Run 权限。仅使用已有 BYOK 别名时不需要本程序读取或写入 Secrets Store。
6. 重启开发服务器。

云端 API 始终连接真实 Cloudflare 账户，即使程序运行在本地。新增服务商、输入供应商密钥和 Playground 调用会实际修改云端配置或调用模型。

## 添加自定义服务商与渠道

在「渠道管理」选择「添加渠道」，接入方式默认为「自定义服务商 · AI Gateway」。

- **创建服务商**：填写名称、账户内唯一的 slug、HTTPS Base URL。保存时调用 Cloudflare Custom Providers API。
- **关联已有服务商**：从 Cloudflare 实时列表中选择，支持搜索和分页，不重复创建服务商。
- **设置凭据**：填写供应商 API Key，或者已有的 BYOK 别名。输入新 Key 会先创建 Secrets Store secret，再调用网关的 `provider_configs` API 建立关联。
- **设置请求路径**：请求路径会拼接到供应商的 Base URL 后面。程序使用 Cloudflare 的 Provider Native 自定义端点，不依赖 `/compat` 来转发自定义服务商。

例如供应商的实际 Chat Completions 地址是 `https://api.example.com/v1/chat/completions`：

| Base URL | 请求路径 |
| --- | --- |
| `https://api.example.com` | `v1/chat/completions` |
| `https://api.example.com/v1` | `chat/completions` |

两种设置都可用，不要重复添加 `/v1`。自定义服务商可选择 OpenAI Chat Completions 或 Anthropic Messages 协议。Worker 自动转换两种协议；其他私有协议尚不支持。

实际推理地址：

```text
https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/custom-{slug}/{path}
```

Worker 只附带 `cf-aig-authorization`、`cf-aig-byok-alias` 和关联元数据，由 AI Gateway 从 Secrets Store 取出供应商密钥。

上传密钥时使用 Cloudflare 要求的 secret 名称 `{gateway_id}_custom-{slug}_{alias}`，scope 为 API 定义的 `ai_gateway`。每次换 Key 都创建独立随机别名，不覆盖其他渠道的凭据。旧 BYOK 和 secret 不自动删除，可在确认没有其他使用方后通过 Cloudflare 管理。

「Cloudflare 服务商」页直接管理账户资源。修改名称、描述、启用状态会调用 Cloudflare API。为避免将共享凭据转发到其他地址，此页面不允许更改已有服务商的 slug / Base URL；需要变更目的地时新建服务商。删除本地渠道仅删除本地渠道及路由；删除 Cloudflare 服务商会影响账户内所有使用它的网关，界面会提示此影响，并阻止删除仍被本程序渠道使用的服务商。

Cloudflare 与 D1 之间没有跨服务事务。如果服务商、secret 或 BYOK 已创建而后续步骤失败，错误会给出可用于恢复的资源信息。不要反复创建同一个 slug；从已有服务商重新关联，必要时在 Cloudflare 完成 BYOK 关联。

### 模型与应用接入

在「模型与路由」创建公开模型别名，例如 `smart-chat`，添加路由，选择刚创建的渠道，上游模型 ID 填供应商原始模型名。

在「API 密钥」创建应用密钥，然后设置应用服务端环境变量 `EDGEGATE_API_KEY`：

```bash
curl https://YOUR-WORKER.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer $EDGEGATE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"smart-chat","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

支持 `GET /v1/models`、`POST /v1/chat/completions` 和 `POST /v1/messages`，包括 JSON / SSE、文本、图片和工具调用。客户端使用 OpenAI SDK 时把 Base URL 设置为 `https://YOUR-WORKER.workers.dev/v1`。

### 其他保留的渠道

- **Cloudflare AI REST API**：使用 `CF_AI_TOKEN`（Workers AI Read 权限），向 `/accounts/{account}/ai/v1/chat/completions` 发送请求，附带 `cf-aig-gateway-id` 接入 AI Gateway。上游模型使用 `openai/...`、`anthropic/...` 或 `@cf/...` 等账户支持的模型 ID；统一计费需要在 Cloudflare 配置可用余额。
- **AI Gateway 内置模型 / 动态路由**：使用 `CF_AIG_TOKEN` 或 `CF_API_TOKEN`，通过 `/compat/chat/completions` 调用已配置 BYOK 的内置模型或 `dynamic/{route-name}`。Cloudflare 已将普通单模型兼容端点标记为弃用，动态路由仍使用它。

初始化预置的三个模型和 Cloudflare 渠道只是可编辑示例，不保证你的账户具备相应模型权限。主要使用自定义服务商时可停用示例路由。

## 服务商协议与双向转换

自定义服务商的「服务商协议」决定其上游请求格式；客户端调用的端点决定客户端协议。转换按每条路由独立完成，故障转移切换协议时始终从原始请求重新转换。

| 客户端端点 | 服务商协议 | 行为 |
| --- | --- | --- |
| `/v1/chat/completions` | OpenAI | 同协议透传 |
| `/v1/chat/completions` | Anthropic | OpenAI 请求 → Messages；响应 / SSE → OpenAI |
| `/v1/messages` | Anthropic | 同协议透传，转发版本与 Beta 请求头 |
| `/v1/messages` | OpenAI | Messages 请求 → Chat Completions；响应 / SSE → Anthropic |

Anthropic 服务商常用路径是 `v1/messages`（Base URL 已包含 `/v1` 时填 `messages`），OpenAI 为 `v1/chat/completions`。在服务商页切换协议会自动调整这些标准路径，特殊自定义路径需在渠道中手动调整。

两种端点均接受应用 `Authorization: Bearer eg_…` 或 `x-api-key: eg_…`。客户端的凭据不会转发给供应商，Cloudflare 认证和 BYOK 仍由服务端设置。Anthropic 请求示例：

```bash
curl https://YOUR-WORKER.workers.dev/v1/messages \
  -H "x-api-key: $EDGEGATE_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-5","max_tokens":1024,"messages":[{"role":"user","content":"你好"}],"stream":true}'
```

转换覆盖 system / developer、文本、图片 URL / Base64、客户端 function / tool_use、工具结果、工具选择、停止原因及上游用量。Anthropic 错误工具结果转换为保留 `is_error` 和内容的 JSON 文本。SSE 逐事件转换，保持背压和取消传播，支持分片 UTF-8、多个工具和分片 JSON 参数；异常结束输出错误事件，不伪造正常结束事件。

协议存在差异，当前边界如下：

- 同协议请求保留原协议扩展。跨协议不支持的参数（如扩展 thinking、提示缓存控制、服务端工具、音频、JSON response_format、多候选 `n > 1`、Anthropic `top_k`）返回明确的 `unsupported_conversion`。存在同协议可用路由时可跳过无法转换的候选。
- OpenAI → Anthropic 未指定输出长度时使用 `max_tokens=4096`；Anthropic 的温度范围要求为 0–1，程序不悄悄截断超出范围的温度。实际模型仍可能有更严格要求。
- Anthropic 客户端调用 OpenAI 服务商时，流式请求会向上游请求 `include_usage`。Anthropic 的初始流式计数从 0 开始，结束事件更新为上游报告值；若上游缺少必要用量、缺少结束事件或出现无法表示的内容，转换会报错。不会为此向 D1 写入日志或计算账单。
- 协议转换不改变自定义服务商的认证方式。服务商需接受当前 Cloudflare BYOK 对该自定义端点配置的认证；仅接受特定认证头的服务商需在 Cloudflare 配置相应认证。此处没有假设 Cloudflare 未公开的自定义认证模板字段。

## 服务商标签与模型并集

创建服务商或创建新服务商渠道时，可以填写协议、标签和模型清单。已有服务商在「Cloudflare 服务商」页统一编辑。它们是 EdgeGate 的业务配置，保存在 D1，并关联 Cloudflare provider ID；不会伪装成 Cloudflare 原生标签参数。

模型清单每行一个上游模型 ID。关联渠道后自动注册同名公开模型与路由；多个渠道、多个服务商共享同一公开模型时，模型列表去重，所有符合权限的路由都保留。已有自定义模型别名继续有效。

创建 API Key 时可选择服务商标签，规则如下：

1. 未选择标签：不限制服务商标签，包括无标签服务商。
2. 选择一个或多个标签：服务商只需匹配其中任意一个（OR）。无标签服务商不在这个范围内。标签区分大小写，并去重。
3. `/v1/models` 返回符合标签范围、拥有已启用且已配置渠道路由的公开模型的**并集**，再与 Key 的可选模型白名单取交集。
4. 标签限制同时应用于两种推理端点和每次故障转移；不能通过同名模型、请求参数或备用路由越过权限。
5. 新增服务商或修改标签后，已有 Key 的模型范围随之变化，不需要重新签发 Key。权限查询不使用 KV 缓存。

例如：

| 服务商 | 协议 | 标签 | 模型清单 |
| --- | --- | --- | --- |
| A | Anthropic | `claude` | `claude-sonnet-4-5` |
| B | OpenAI | `claude` | `claude-opus-4-6` |
| C | OpenAI | `private` | `private-model` |

只选择 `claude` 标签且未限制模型白名单的 Key，调用 `/v1/models` 得到：

```json
{
  "object": "list",
  "data": [
    { "id": "claude-opus-4-6", "object": "model", "owned_by": "edgegate" },
    { "id": "claude-sonnet-4-5", "object": "model", "owned_by": "edgegate" }
  ]
}
```

以上省略了实际响应中的 `created` 时间戳。两个模型都能通过任一协议端点调用；不会暴露 C 的模型。模型清单由管理员配置，不会自动爬取供应商的全量模型目录。

修改清单只删除该清单管理的自动路由，保留手工配置的模型别名；编辑自动路由后，该路由转为手工管理。删除已无路由的公开模型可在模型页完成，其不会出现在 `/v1/models` 中。

升级时执行 `npm run db:migrate`（生产使用 `npm run db:migrate:remote`），应用 `0003_protocols_and_tags.sql`。旧服务商默认 OpenAI 协议、无标签；已有 API Key 默认不限制标签，原有模型白名单继续生效。

## 日志与分析

日志数据来自 Cloudflare，不在 D1 重复存储：

```text
GET /client/v4/accounts/{account}/ai-gateway/gateways/{gateway}/logs
GET /client/v4/accounts/{account}/ai-gateway/gateways/{gateway}/logs/{id}
POST /client/v4/graphql
```

- 日志页支持分页、成功/失败和上游模型筛选；详情显示 Cloudflare 日志 ID、EdgeGate 请求 ID、模型、用量、费用及耗时。缺失指标显示「未报告」或 `—`。
- 总览调用 GraphQL 聚合接口，独立于已保留的日志页数量。按网关过滤，提供过去 24 小时 / 7 天的整点时间桶、趋势和模型分布；7 天视图将 Cloudflare 的小时聚合合并为 UTC 日桶。
- 分析接口先查询实时 Schema，只请求可用的用量、费用、错误和缓存指标。KV 仅缓存 Schema 字段，不缓存请求正文或复制推理日志。无权限或查询失败显示错误，不用伪造的 0 掩盖问题。
- 范围为当前 AI Gateway 的全部调用，包含其他客户端。一次 EdgeGate 请求发生故障转移时，可能生成多条 Cloudflare 日志。
- 通过 `cf-aig-metadata` 传递请求 ID、应用 Key ID/名称、模型别名、渠道与尝试序号。返回 `X-Request-ID`、`X-Gateway-Attempts`，以及上游提供的 `cf-aig-log-id`，便于关联。
- Worker 不再强制关闭 AI Gateway 日志或缓存。正文是否采集、日志保留期限、缓存和 Custom costs 由 Cloudflare 网关设置决定。完整请求/响应正文目前在 Cloudflare 控制台查看。
- Cloudflare 分析可能延迟或采样，部分自定义服务商无法自动提供 Token / 成本；本程序不会自行补算。需要补充单价时在 Cloudflare 配置 Custom costs。
- Worker 提前拒绝的鉴权、配额或路由错误没有到达 AI Gateway，因此不会出现在 AI Gateway 推理日志中。Worker 自身运行异常仍可通过 Cloudflare Workers Observability 排查。

## 升级旧版直连配置

```bash
npm run db:migrate          # 本地
# 正式部署前，对生产 D1 执行：
npm run db:migrate:remote
```

`0002_ai_gateway_control_plane.sql` 为渠道增加 Cloudflare 服务商 ID、slug、请求路径、BYOK 别名。保留原模型、应用密钥、配额与历史 `request_logs` 表；旧日志不会删除，但新程序不再读写该表或运行日志清理任务。定时任务现在只清理过期配额计数。

旧「OpenAI 兼容」直连渠道会显示待配置，**不会继续直连供应商**。编辑渠道，将其关联到 Cloudflare 服务商，并确认请求路径。仅当完整上游 URL 与旧地址完全一致时，旧加密 Key 才可迁入 BYOK；目的地不一致需重新输入密钥或提供已有 BYOK 别名。迁移成功后清除 D1 中该渠道的供应商密钥。

## 部署

完整步骤见 [Workers 部署指南](./DEPLOYMENT.md)。支持连接 GitHub 仓库交给 Workers Builds 构建，也可在公开仓库添加 Deploy to Cloudflare 按钮。

配置好生产 D1 / KV、AI Gateway 和运行时 Secrets 后，本地更新部署使用：

```bash
npm run check
npm run deploy
```

`deploy` 会依次构建、应用远程 D1 增量迁移、发布 Worker。Workers Builds 的 Build command 填 `npm run build`，Deploy command 填 `npm run deploy:ci`，避免重复构建。迁移通过 `DB` 绑定定位数据库，允许一键部署时重命名 D1。

本地与生产 D1 / KV 相互独立，本地渠道与应用 Key 不自动上传；若使用同一 Account / Gateway，则 Cloudflare 服务商、BYOK 和日志是共享的。`.dev.vars` 仅供本地使用，不会随部署上传。

## 路由与配额

路由按优先级从小到大选择，同级按权重随机选择；每条候选最多一次、最多 5 条，总时限 180 秒，单渠道完整响应超时最多 120 秒。上游认证、限流、不可用模型、5xx、连接失败可故障转移；一般参数错误不重试。开始向客户端输出 SSE 后不再重试。断连或重试仍可能产生上游费用。

D1 通过原子条件更新执行每个应用 Key 的每分钟 / 每日请求限额，使用 UTC 固定窗口；授权且格式有效的请求在路由前消耗一次配额，重试不重复计数。撤销立即影响后续鉴权，进行中的请求继续完成。KV 会话单独退出的跨区域传播受最终一致性影响，并有显式 24 小时到期限制。

## 工程与验证

```text
src/                    React 管理界面
worker/
  index.ts              路由入口、错误处理、配额清理
  auth.ts               管理会话、应用 API Key 鉴权
  admin.ts              业务配置管理
  channels.ts           Cloudflare 服务商与本地渠道映射
  cloudflare.ts          REST / GraphQL 客户端、Secrets Store / BYOK
  observability.ts       Cloudflare 日志与分析
  gateway.ts            应用配额、故障转移与 SSE 透传
  upstream.ts           AI Gateway 端点与标签范围内的路由选择
  providers.ts          协议、标签、模型清单与自动路由
  protocols/            OpenAI / Anthropic 请求、响应与 SSE 转换
migrations/             D1 增量迁移
scripts/setup-local.mjs 本地随机密钥生成
tests/gateway.test.ts   workerd / Miniflare 接口测试
wrangler.jsonc          Worker 静态资源、D1 / KV、环境配置
```

```bash
npm run typecheck
npm test
npm run build
npm run check
npm audit
npx wrangler deploy --dry-run
```

测试在隔离的 D1 / KV 中运行，模拟 Cloudflare 控制 API、Secrets Store 和推理响应，并禁止供应商直连。覆盖真实 Worker 运行时中的鉴权、并发配额、服务商管理、BYOK 命名与关联、迁移、故障转移、SSE、日志分页和 GraphQL 聚合。测试不调用真实供应商；未提供账户凭据时无法完成云端联调。

当前未实现多租户 / RBAC、充值或硬金额预算、Responses、embeddings、图像 / 音频接口、熔断与长期健康探测。前端同源访问；管理 / Playground 请求体上限 64 KiB，推理请求体 2 MiB，非流式上游响应 8 MiB。

## 官方参考

- [Custom Providers API 与推理地址](https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/)
- [BYOK 与 API 创建密钥命名约定](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/)
- [Secrets Store 创建密钥 API](https://developers.cloudflare.com/api/resources/secrets_store/subresources/stores/subresources/secrets/methods/create/)
- [Secrets Store 权限](https://developers.cloudflare.com/secrets-store/access-control/)
- [AI Gateway Logs API](https://developers.cloudflare.com/api/resources/ai_gateway/subresources/logs/methods/list/)
- [AI Gateway GraphQL Analytics](https://developers.cloudflare.com/ai-gateway/observability/analytics/)
- [Cloudflare AI REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/)
- [AI Gateway 兼容端点与动态路由](https://developers.cloudflare.com/ai-gateway/usage/chat-completion/)

- [OpenAI Chat Completions API](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- [Anthropic Messages API](https://platform.claude.com/docs/en/api/messages/create)
- [Anthropic SSE 事件格式](https://platform.claude.com/docs/en/build-with-claude/streaming)
