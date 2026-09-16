# 古籍拓片缺损修补API

纯后端零依赖 Node 服务（需 Node ≥ 18），使用 `data/db.json` 持久化拓片、缺损项、修补批次、质检记录与留存归档数据。

## 启动

```bash
npm start                 # 等价于 PORT=3020 node server.js
PORT=3020 node server.js
```

环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3020` | 监听端口 |
| `DATA_DIR` | `./data` | 数据目录（热库、归档包、凭据、隔离区） |
| `CLEANUP_TOKEN_TTL_MS` | `600000` | 清理确认令牌有效期（毫秒） |

启动时会自动执行崩溃恢复：把提交前崩溃留下的孤儿归档包/凭据移入 `data/quarantine/` 并登记 `GET /recovery-log`，热库数据保持自洽。

## 测试

```bash
npm test                  # node --test test/
node scripts/smoke.js     # 全流程冒烟（临时目录，不影响真实数据）
```

测试覆盖：旧接口兼容、归档/清理/回迁全流程、幂等归档号、法律保留、两步确认、校验失败拦截、热库漂移拦截、混合批次暂缓、并发自洽、崩溃恢复。

## 数据目录

```
data/
  db.json         热库（清理后只留摘要）
  archives/       只读归档包（<归档号>.json，含清单与逐项校验值）
  receipts/       只读清理凭据（hash 链，可核验）
  quarantine/     崩溃残留隔离区
```

## 留存归档流程

```
保管项目(留存年限) → 拓片到期 → 归档(只读包,热库封存) → 清理第一步(发令牌)
   → 清理第二步(令牌确认,热库只留摘要+可核验凭据) → 可回迁(与归档前一致)
```

- 归档状态机：`sealed → cleanup_pending → cleaned → restored`（另有 `failed` 供恢复兜底）
- 法律保留期间不得归档、不得清理；已封存/已清理的记录禁止写入，冲突操作一律拦下并登记（`GET /projects/:id/blocked-records`）
- 同一归档号重复提交只生效一次（幂等）
- 归档、清理、回迁均为原子落盘，中途崩溃不产生半归档半清理状态

## 主要接口

旧接口（行为不变）：`GET /health`、`GET/POST /rubbings`、`GET/POST /rubbings/:id/damages`、`GET /damages`、`PATCH /damages/:id`、`GET/POST /batches`、`GET /batches/:id`、`POST /batches/:id/complete`

新增（节选）：

- 保管项目：`POST /projects`、`GET /projects/:id/retention`
- 法律保留：`POST /projects/:id/holds`、`POST /projects/:id/holds/:holdId/release`
- 质检记录：`POST /damages/:id/inspections`
- 归档：`POST /archives`、`POST /archives/:id/verify`、`POST /archives/:id/cleanup`、`POST /archives/:id/cleanup/confirm`、`POST /archives/:id/restore`
- 凭据与审计：`GET /cleanup-receipts/:id/verify`、`GET /projects/:id/blocked-records`、`GET /recovery-log`

完整接口文档见 [docs/API.md](docs/API.md)。

## 闭环示例

```bash
# 建项目（留存2年）并登记一条2020年的拓片
curl -X POST localhost:3020/projects -H 'Content-Type: application/json' -d '{"name":"清代拓片","retentionYears":2}'
curl -X POST localhost:3020/rubbings -H 'Content-Type: application/json' \
  -d '{"code":"TP-001","source":"碑林","paperSize":"40x60","projectId":"<项目id>","createdAt":"2020-01-01T00:00:00.000Z"}'

# 到期归档（幂等归档号可安全重试）
curl -X POST localhost:3020/archives -H 'Content-Type: application/json' \
  -d '{"projectId":"<项目id>","archiveNo":"ARC-2026-0001","operator":"李馆"}'

# 两步清理：先领令牌，再凭令牌确认
curl -X POST localhost:3020/archives/ARC-2026-0001/cleanup
curl -X POST localhost:3020/archives/ARC-2026-0001/cleanup/confirm \
  -H 'Content-Type: application/json' -d '{"token":"<上一步返回的cleanupToken>","operator":"李馆"}'

# 需要时回迁
curl -X POST localhost:3020/archives/ARC-2026-0001/restore
```
