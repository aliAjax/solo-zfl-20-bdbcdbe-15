# 接口文档

古籍拓片缺损修补与留存归档 API。所有接口返回 JSON；错误格式为 `{ "error": "…" }`，冲突类错误（HTTP 409）会被登记为"被拦下的记录"。

## 目录

- [通用约定](#通用约定)
- [旧接口（行为不变）](#旧接口行为不变)
- [保管项目](#保管项目)
- [法律保留](#法律保留)
- [质检记录](#质检记录)
- [留存状态查询](#留存状态查询)
- [归档](#归档)
- [清理（两步确认）](#清理两步确认)
- [回迁](#回迁)
- [清理凭据](#清理凭据)
- [被拦下的记录与恢复日志](#被拦下的记录与恢复日志)
- [归档包格式与校验算法](#归档包格式与校验算法)
- [崩溃恢复语义](#崩溃恢复语义)

## 通用约定

- 写操作在进程内串行执行：归档与写入不会交错，冲突的一方被拦下（409）并登记。
- 已封存（`sealed`/`cleanup_pending`）归档包内的记录禁止写入；已清理（`cleaned`）的记录在热库只剩摘要，写操作返回 409 并指向归档号。
- `POST /archives` 的 `archiveNo` 是幂等键：同一归档号重复提交返回首次结果（`idempotent: true`），只生效一次。建议客户端总是自带归档号以便安全重试；不传则由服务端生成 `ARC-YYYYMMDD-NNNN`。
- 归档号格式：`3-64` 位，仅字母、数字、`-`、`_`，且按项目唯一。

## 旧接口（行为不变）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查与路由清单 |
| GET | `/rubbings` | 拓片列表（含归档摘要，摘要带 `_summary: true`） |
| POST | `/rubbings` | 新建拓片；新增可选字段 `projectId`、`createdAt`（补录用） |
| GET | `/rubbings/:id/damages` | 拓片的缺损列表；已清理的拓片返回 409 与归档号 |
| POST | `/rubbings/:id/damages` | 新建缺损项；拓片已封存/已清理时 409 |
| GET | `/damages?status=&type=` | 缺损筛选 |
| PATCH | `/damages/:id` | 修改缺损项；已封存/已清理时 409 |
| GET | `/batches`、`GET /batches/:id` | 批次查询 |
| POST | `/batches` | 新建批次；引用已归档缺损时 409 |
| POST | `/batches/:id/complete` | 完成批次；批次已封存/已清理时 409 |

新增：`PATCH /rubbings/:id` 可修改 `code/source/paperSize/note/projectId`（用于把旧拓片认领进保管项目）。

## 保管项目

项目承载留存年限，拓片按 `projectId` 归属项目；未分配项目的拓片不参与留存计算。

### `POST /projects`

```json
{ "name": "清代拓片保管", "retentionYears": 5, "description": "可选" }
```

`201 → { data: Project }`。`retentionYears` 必须为正数（年）。

### `GET /projects` / `GET /projects/:id`

返回项目及统计（`rubbingCount`、`activeHold`、`archiveCount`）。

### `PATCH /projects/:id`

可改 `name`、`retentionYears`、`description`。留存年限即时影响到期判定。

### `GET /projects/:id/retention`

项目留存状态：

```json
{
  "data": {
    "project": { "id": "…", "retentionYears": 5 },
    "legalHold": { "active": false, "holds": [] },
    "rubbings": [
      { "id": "…", "code": "TP-001", "createdAt": "…", "expiresAt": "…", "expired": true, "state": "hot|sealed|archived", "archiveNo": null }
    ],
    "counts": { "total": 3, "hot": 1, "sealed": 1, "archived": 1, "expired": 1 },
    "archives": [ { "archiveNo": "ARC-…", "status": "sealed", "counts": {} } ],
    "blockedCount": 2
  }
}
```

## 法律保留

项目存在有效保留期间，归档与清理一律 409 并登记；解除后自动恢复。保留不限制普通读写。

### `POST /projects/:id/holds`

```json
{ "reason": "诉讼保全", "createdBy": "法务" }
```

`201 → { data: Hold }`，`Hold = { id, projectId, reason, createdBy, active, createdAt, releasedAt, releasedBy }`。

### `POST /projects/:id/holds/:holdId/release`

解除保留（幂等）。`GET /projects/:id/holds` 可查全部保留记录。

## 质检记录

### `POST /damages/:id/inspections`

```json
{ "inspector": "王师傅", "result": "pass", "note": "修补平整" }
```

`result ∈ pass / fail / rework`。`201 → { data: Inspection }`。缺损已封存/已清理时 409。

### `GET /damages/:id/inspections`、`GET /inspections?damageId=&result=`

查询质检记录。缺损已清理时前者返回 409 与归档号。

## 归档

把项目内**到期**（`createdAt + retentionYears ≤ 现在`）且未封存的拓片，连同其缺损、批次、质检记录打成只读归档包。批次若横跨未到期或其他项目的拓片，相关拓片整体暂缓（响应 `skipped` 中说明），避免批次被拆开。

归档状态机：

```
sealed ──发起清理──> cleanup_pending ──确认──> cleaned ──回迁──> restored
   └──────────── 崩溃残留（sealing/cleaning/restoring）恢复时 ──> failed
```

### `POST /archives`

```json
{ "projectId": "…", "archiveNo": "ARC-2026-0001", "operator": "李馆" }
```

- `201 → { data: Archive }`：归档成功，热库对应记录随即封存（只读）。
- `200 → { data: Archive, idempotent: true }`：同一归档号重复提交，返回首次结果。
- `400`：没有可归档的到期拓片（附 `skipped`）；`404` 项目不存在；`409` 法律保留中 / 归档号被他项目占用。

`Archive` 关键字段：`status`、`counts`、`items`（清单：逐条 `{collection, id, sha256}`）、`manifestHash`、`packageFile`、`skipped`、`cleanup`、`receiptId`。

### `GET /archives?projectId=&status=`、`GET /projects/:id/archives`、`GET /archives/:id`

查询归档记录（`:id` 也接受归档号）。

### `GET /archives/:id/package`

返回只读归档包完整内容（清单 + 快照）。

### `POST /archives/:id/verify`

重算包内全部校验值并与清单、登记 hash 三方比对：

```json
{ "data": { "archiveNo": "…", "ok": false, "checks": [ {"name":"items","ok":false}, … ], "mismatches": [ {"collection":"damages","id":"…","reason":"记录校验值与清单不符"} ] } }
```

## 清理（两步确认）

清理把热库中的已归档记录替换为摘要（`id/code/projectId/createdAt/counts/checksum`），完整内容只存于归档包。

### 第一步 `POST /archives/:id/cleanup`

校验归档包完整性、热库与包的一致性后签发确认令牌：

```json
{ "data": { "archiveNo": "…", "cleanupToken": "cleanup_…", "expiresAt": "…" } }
```

令牌有效期默认 10 分钟（`CLEANUP_TOKEN_TTL_MS`）。未过期前重复发起返回同一令牌（幂等）。以下情况 409 并登记：法律保留中、归档包校验失败（附 `mismatches`）、热库数据与归档包不一致。

### 第二步 `POST /archives/:id/cleanup/confirm`

```json
{ "token": "cleanup_…", "operator": "李馆" }
```

`200 → { data: { archive, receipt } }`。令牌不匹配/已过期/已清理 → 409。确认时再次全量校验，通过后在**单次原子写库**中完成摘要替换、凭据登记与状态推进，不存在半清理状态。

## 回迁

### `POST /archives/:id/restore`

仅 `cleaned` 状态可回迁。校验归档包后把快照原样写回热库（结果与归档前一致），移除摘要。重复调用幂等。归档包校验失败 → 409 并登记；`sealed` 状态数据仍在热库，无需回迁（409）。

## 清理凭据

每次清理生成一条凭据，内容 hash + 与上一条凭据的链式引用（`prevReceiptHash`），凭据文件只读落盘 `data/receipts/<归档号>.json`。

```json
{ "id": "receipt_…", "archiveNo": "…", "projectId": "…", "operator": "…", "cleanedAt": "…",
  "removed": {"rubbings":1,"damages":2,"batches":1,"inspections":1},
  "summaries": [ {"rubbingId":"…","checksum":"…"} ],
  "manifestHash": "…", "prevReceiptHash": "…|null", "hash": "…" }
```

- `GET /cleanup-receipts?projectId=`、`GET /cleanup-receipts/:id`：查询。
- `GET /cleanup-receipts/:id/verify`：核验自身 hash、与归档包/登记清单的一致性、凭据文件、hash 链，返回逐项 `checks`。

## 被拦下的记录与恢复日志

- `GET /projects/:id/blocked-records`：按项目查被拦下的操作（`kind: write|archive|cleanup|restore`，含原因与时间，最新在前，最多保留 1000 条）。
- `GET /recovery-log`：启动恢复处理记录（孤儿包/凭据隔离、中间态标记失败等）。

## 归档包格式与校验算法

`data/archives/<归档号>.json`（只读，`0444`）：

```json
{
  "format": "rubbing-archive/1",
  "archiveNo": "…", "projectId": "…", "projectName": "…", "retentionYears": 5,
  "sealedAt": "…", "operator": "…",
  "manifest": {
    "counts": { "rubbings": 1, "damages": 2, "batches": 1, "inspections": 1 },
    "items": [ { "collection": "rubbings", "id": "…", "sha256": "…" } ],
    "manifestHash": "…"
  },
  "payload": { "rubbings": [], "damages": [], "batches": [], "inspections": [] }
}
```

校验算法：记录先按**键排序的稳定 JSON**（`canonical`）序列化，再取 SHA-256 十六进制。`manifestHash` 为清单数组的同法摘要。任何一条记录被改动，其 `sha256` 即与清单不符；清单被整体替换，`manifestHash` 不符；包文件被换掉，与热库登记的 `manifestHash` 三方比对不符。

## 崩溃恢复语义

所有落盘均为"临时文件 + 原子改名"，多步操作的每一步要么完整生效要么不存在：

| 崩溃点 | 现场 | 恢复行为 |
| --- | --- | --- |
| 归档包已写、登记前 | 孤儿包文件 | 移入 `quarantine/`，热库未动，可同归档号重试 |
| 清理凭据已写、提交前 | 孤儿凭据文件 | 移入 `quarantine/`，归档仍为 `cleanup_pending`，可重新确认 |
| 清理/回迁写库前 | 无任何残留 | 状态保持，重试即可 |
| db 残留中间态标记 | `sealing/cleaning/restoring` | 标记 `failed`，热库数据不动 |

恢复处理全部登记 `recoveryLog`（`GET /recovery-log`）。
