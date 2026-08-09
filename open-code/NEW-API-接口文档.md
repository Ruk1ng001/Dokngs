# new-api 二开接口文档（Dokng 桌面客户端）

Dokng 账户面板依赖以下 new-api 接口：

1. `GET /api/app/profile`：二开新增，返回账户余额、当前 API Key 信息和真实模型 Token 用量。是账户页的主数据源。
2. `GET /v1/models`：上游已有，返回当前 API Key 可用模型。
3. `GET /api/usage/token`：上游已有，返回当前 API Key 的额度概览。与 profile 的 `key_*` 字段同源，可用于交叉校验，但不是账户页必需项。

所有请求使用 `Authorization: Bearer sk-xxx`。后端必须由该 Key 对应的 `model.Token` 记录派生 `token_id` 和 `user_id`，不得从请求参数读取这些 ID。

> **本二开后端只返回 `account_*` / `key_*` 新字段，不再返回任何旧版字段。** 客户端按本文字段对接即可。

---

## 先统一三个容易混淆的概念

| 概念 | new-api 上游来源 | 含义 | UI 文案 |
|---|---|---|---|
| 账户额度 | `model.User.Quota` / `User.UsedQuota` | 用户剩余额度与累计费用额度 | 可用余额、今日费用、累计费用 |
| API Key | `model.Token` 表（上游代码也称 Token） | 一条 `sk-...` 凭据及其限额 | API Key、Key 名称、额度不限 |
| 模型 Tokens | `logs.prompt_tokens + logs.completion_tokens` | 模型实际处理的输入、输出 Token 数 | 今日 Tokens、输入 / 输出 |

> **禁止把 API Key 条数叫做 Token 用量。** “2 个 Token”只能描述两条 new-api Token 记录，不能表达模型消耗。账户页统一称“2 个 Key”；“今日 Tokens 12.1K”只来自日志中的 `prompt_tokens + completion_tokens`。

---

## 通用约定

| 项 | 值 |
|---|---|
| 鉴权头 | `Authorization: Bearer sk-xxx` |
| Accept | `application/json` |
| 站点根推导 | `baseURL` 去掉末尾 `/v1`；profile 挂在站点根 `/api` 下 |
| 额度单位 | 默认 `QuotaPerUnit = 500000`，即 500000 额度 = 1 美元；客户端负责换算金额 |
| 模型 Token 单位 | 原始整数个数，不经过 `QuotaPerUnit` 换算；客户端显示为 `12.1K`、`12.4M` 等 |
| 今日范围 | 站点配置时区的本地自然日 `[今日 00:00, 明日 00:00)`，响应应保持一致 |
| 失败降级 | 非 200 / 网络异常转为中文错误；可选统计聚合失败时返回 `null` 或省略，不阻塞基础资料 |

---

## 1. `GET /api/app/profile` — 账户、当前 Key 与今日用量（新增）

### 请求

```http
GET {站点根}/api/app/profile
Authorization: Bearer sk-xxxx
Accept: application/json
```

响应可以是扁平对象，也可以包在 `data` 中；客户端兼容 `body.data ?? body`。若响应带 `success: false`，客户端读取 `message`。

### 推荐响应字段

#### 账户级字段

同一账户下不同 Key 返回值相同。

| 字段 | 类型 | 上游来源 / 算法 | UI 用途 |
|---|---|---|---|
| `username` | string | `user.Username` | 用户账号 |
| `display_name` | string | `user.DisplayName`，为空回退 `Username` | 顶部主标题 |
| `avatar` | string，可选 | 上游标准 `User` 当前没有头像字段；仅站点自行扩展时返回 | 客户端为空时显示首字母 |
| `account_remaining_quota` | number | `user.Quota` | 可用余额 |
| `account_used_quota` | number | `user.UsedQuota` | 累计费用 |
| `account_total_quota` | number | `user.Quota + user.UsedQuota` | 额度使用率分母 |
| `account_quota_used_today` | number，可选 | 今日消费日志 `SUM(logs.quota)`，限定 `user_id`、`type=2` | 今日费用 |
| `account_tokens_used_today` | number，可选 | 今日 `SUM(prompt_tokens + completion_tokens)`，限定 `user_id`、`type=2` | 今日 Tokens |
| `account_prompt_tokens_today` | number，可选 | 今日 `SUM(prompt_tokens)` | 今日输入 Tokens |
| `account_completion_tokens_today` | number，可选 | 今日 `SUM(completion_tokens)` | 今日输出 Tokens |
| `request_count_today` | number，可选 | 今日消费日志 `COUNT(*)` | 可扩展展示请求数 |

#### 当前 API Key 字段

随 Bearer Key 不同而不同。字段统一使用 `key_*`，避免与模型 Token 数混淆。

| 字段 | 类型 | 上游来源 / 算法 | UI 用途 |
|---|---|---|---|
| `key_name` | string | `token.Name` | 本地名称为空时直接展示，并一次性回填本地 label |
| `key_remaining_quota` | number | `token.RemainQuota` | Key 剩余额度 |
| `key_used_quota` | number | `token.UsedQuota` | Key 累计费用 |
| `key_quota_used_today` | number，可选 | 今日 `SUM(logs.quota)`，限定当前 `token_id`、`type=2` | Key 今日费用 |
| `key_tokens_used_today` | number，可选 | 今日 `SUM(prompt_tokens + completion_tokens)`，限定当前 `token_id`、`type=2` | Key 今日 Tokens |
| `key_prompt_tokens_today` | number，可选 | 今日 `SUM(prompt_tokens)`，限定当前 `token_id` | Key 今日输入 |
| `key_completion_tokens_today` | number，可选 | 今日 `SUM(completion_tokens)`，限定当前 `token_id` | Key 今日输出 |
| `key_unlimited_quota` | bool | `token.UnlimitedQuota` | 仅影响当前 Key 的额度条，不得影响账户余额和账户额度环 |
| `key_group` | string | 有效分组：`token.Group` 非空即用它，为空回退 `user.Group` | 展示当前 Key 生效的定价分组 |
| `key_dynamic_ratio` | bool | 有效分组是否启用二开的分组级动态倍率（`ratio_setting.IsGroupDynamicRatioEnabled`）；`auto` 分组恒为 `false` | 标记当前 Key 是否走动态倍率 |
| `key_status` | number | `token.Status`（1 启用 / 2 禁用 / 3 过期 / 4 耗尽，见 `common.TokenStatus*`） | 卡片健康度徽标（禁用 / 过期 / 耗尽） |
| `key_expires_at` | number | `token.ExpiredTime`（秒；`-1` 归零为 `0`） | 过期提示，`0` 表示永不过期 |
| `key_model_limits_enabled` | bool | `token.ModelLimitsEnabled` | 是否启用模型白名单 |
| `key_model_limits` | string[] | `token.GetModelLimits()`（未启用时为空数组） | 展示该 Key 允许的模型数 / 列表 |

### 响应示例

```json
{
  "success": true,
  "data": {
    "username": "alice",
    "display_name": "Alice",
    "account_remaining_quota": 3750000,
    "account_used_quota": 1250000,
    "account_total_quota": 5000000,
    "account_quota_used_today": 85000,
    "account_tokens_used_today": 12140,
    "account_prompt_tokens_today": 10340,
    "account_completion_tokens_today": 1800,
    "request_count_today": 23,
    "key_name": "生产主 key",
    "key_remaining_quota": 0,
    "key_used_quota": 125000,
    "key_quota_used_today": 85000,
    "key_tokens_used_today": 12140,
    "key_prompt_tokens_today": 10340,
    "key_completion_tokens_today": 1800,
    "key_unlimited_quota": true,
    "key_group": "vip",
    "key_dynamic_ratio": true,
    "key_status": 1,
    "key_expires_at": 0,
    "key_model_limits_enabled": true,
    "key_model_limits": ["gpt-4o", "claude-sonnet-5"]
  }
}
```

该示例中当前 Key 是“额度不限”，但账户仍展示真实的 `$7.50` 可用余额与 25% 账户额度使用率。Key 的不限额标记不能让账户余额变成“不限额”。

`key_group` / `key_dynamic_ratio` 描述当前 Key 生效的定价分组及其是否走动态倍率。动态倍率是本二开新增的**分组级**开关，绑在定价分组上、不在单个令牌字段上，因此后端先解析该 Key 的有效分组再查开关。当 `key_group` 为 `auto`（跨分组自动选择）时无法在请求前确定实际分组，`key_dynamic_ratio` 一律为 `false`。

`key_status` / `key_expires_at` / `key_model_limits*` 供 App 展示 Key 健康度与权限：

- `key_status` 取 `common.TokenStatus*`：`1` 启用、`2` 禁用、`3` 过期、`4` 额度耗尽。App 据此在卡片上显示禁用 / 过期 / 耗尽徽标。
- `key_expires_at` 为秒级过期时间戳，`token.ExpiredTime == -1`（永不过期）归零为 `0`，与 `/api/usage/token` 的 `expires_at` 口径一致。App 可据此提示「N 天后过期」。
- `key_model_limits_enabled` 为 `false` 时表示该 Key 不限模型；`key_model_limits` **恒为数组**（未启用白名单时为空数组 `[]`），避免 App 端判空分支。

### 后端聚合建议

new-api 上游已有可复用数据：

- `model.User`：`Username`、`DisplayName`、`Quota`、`UsedQuota`、`RequestCount`。
- `model.Token`：`Id`、`UserId`、`Name`、`RemainQuota`、`UsedQuota`、`UnlimitedQuota`、`ModelLimitsEnabled`、`ModelLimits`、`ExpiredTime`、`Group`。
- `model.Log`：`UserId`、`TokenId`、`Quota`、`PromptTokens`、`CompletionTokens`、`ModelName`、`CreatedAt`、`Type`。
- `model.QuotaData`：按小时保存 `TokenUsed`、`Count`、`Quota`，适合数据看板；账户页需要当天实时值时，优先直接聚合消费日志，避免缓存写入延迟。

统计必须使用 `token_id`，不要只按 `token_name` 聚合，因为 Key 名称可以为空或重复。消费日志条件必须带 `type = model.LogTypeConsume`。

### 实现说明与字段生成

本二开后端 `controller/app_profile.go` 的实现要点：

- 基础字段（`username` / `display_name` / `avatar` / `account_remaining_quota` / `account_used_quota` / `account_total_quota` / `key_name` / `key_remaining_quota` / `key_used_quota` / `key_unlimited_quota`）**必返回**。
- 可选统计字段（`account_*_today` / `key_*_today` / `request_count_today`）仅在对应聚合成功时写入；聚合失败则**省略该字段**（不返回 0），App 端据此显示 `—`。可选字段的有无不影响基础字段返回。
- `display_name` 取 `user.DisplayName`，为空回退 `user.Username`。
- `avatar` 恒为空串（后端不存头像），App 端按用户名生成占位。
- 模型 Tokens（`*_tokens_today` / `*_prompt_tokens_today` / `*_completion_tokens_today`）来自消费日志 `SUM(prompt_tokens)` / `SUM(completion_tokens)`，为模型处理的原始 token 个数，绝不用费用额度或 Key 数量冒充。日志被站点关闭或清理时，这些字段自然为空（显示 `—`）。

---

## 2. `GET /api/usage/token` — 当前 Key 额度概览（上游已有）

上游 `GET /api/usage/token` 由 `Bearer sk-` 令牌自查其额度概览，走 `TokenAuthReadOnly` 中间件。与 profile 的 `key_*` 字段同源（都来自 `model.Token`），可用于交叉校验，但账户页数据以 profile 为准，本接口非必需。

### 请求

```http
GET {站点根}/api/usage/token
Authorization: Bearer sk-xxxx
Accept: application/json
```

### 响应

> **注意信封字段是 `code`（bool），不是 `success`。** 这是上游历史约定，客户端解析时需区别对待。

```json
{
  "code": true,
  "message": "ok",
  "data": {
    "object": "token_usage",
    "name": "生产主 key",
    "total_granted": 125000,
    "total_used": 125000,
    "total_available": 0,
    "unlimited_quota": true,
    "model_limits": {},
    "model_limits_enabled": false,
    "expires_at": 0
  }
}
```

| 字段 | 类型 | 上游来源 / 算法 | 说明 |
|---|---|---|---|
| `object` | string | 常量 `"token_usage"` | 固定标识 |
| `name` | string | `token.Name` | 等价 profile `key_name` |
| `total_granted` | number | `token.RemainQuota + token.UsedQuota` | 该 Key 总额度（原始 quota 整数） |
| `total_used` | number | `token.UsedQuota` | 等价 profile `key_used_quota` |
| `total_available` | number | `token.RemainQuota` | 等价 profile `key_remaining_quota` |
| `unlimited_quota` | bool | `token.UnlimitedQuota` | 等价 profile `key_unlimited_quota` |
| `model_limits` | object | `token.GetModelLimitsMap()` | 模型白名单映射 |
| `model_limits_enabled` | bool | `token.ModelLimitsEnabled` | 是否启用模型白名单 |
| `expires_at` | number | `token.ExpiredTime`（秒；`-1` 归零为 `0`） | 过期时间戳，`0` 表示永不过期 |

鉴权失败返回 HTTP 401 且信封为 `{"success": false, "message": "..."}`；令牌无效时返回 `success: false` 并带 i18n 错误消息。

> 上游 `controller/token.go` 中还有一个 `GetTokenStatus`（`credit_summary`），**当前没有任何路由挂载它**，属死代码，不属于本契约，客户端不应依赖。令牌管理 CRUD（`/api/token/*`）走会话（cookie / access token）鉴权，`sk-` 客户端无法访问，也不在本契约范围。

---

## 3. `GET /v1/models` — 当前 Key 可用模型（上游已有）

new-api 上游 `GET /v1/models` 已按当前 Key 的 `model_limits` 过滤。客户端直接复用，无需新增 `/api/app/models`。

```http
GET {站点根}/v1/models
Authorization: Bearer sk-xxxxx
Accept: application/json
```

兼容 OpenAI 风格 `{ "data": [...] }` 或直接数组；元素可以是字符串 ID 或 `{ "id": "..." }`。

```json
{ "data": [{ "id": "gpt-4o" }, { "id": "claude-sonnet-5" }] }
```

客户端提取非空 ID、去重并缓存。失败返回空列表，不阻断 Key 切换。

---

## 错误与安全要求

1. `user_id`、`token_id` 只能从 Bearer Key 对应记录派生，绝不读取请求参数。
2. profile 只返回当前用户和当前 Key 的数据，不返回 Key 明文。
3. 今日统计失败时保留账户 / Key 基础字段，将统计字段省略或置 `null`。
4. 非 200：客户端显示 `请求返回 HTTP <status>`；`success: false` 使用 `message`；网络异常使用异常消息。
5. 若日志功能被站点关闭或历史日志被清理，应让 Token 统计为空，不应伪造为 0。
