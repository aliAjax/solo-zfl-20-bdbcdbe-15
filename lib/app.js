const http = require("http");
const { createStore } = require("./store");
const { makeId, httpError, required } = require("./util");
const {
  sealArchive,
  requestCleanup,
  confirmCleanup,
  restoreArchive,
  verifyArchive,
  verifyReceipt,
  retentionStatus,
  frozenIndex,
  cleanedIndex,
  logBlocked,
  findProject,
  findArchive
} = require("./archive");

const routes = [
  "GET /health",
  "GET /rubbings",
  "POST /rubbings",
  "PATCH /rubbings/:id",
  "GET /rubbings/:id/damages",
  "POST /rubbings/:id/damages",
  "GET /damages?status=&type=",
  "PATCH /damages/:id",
  "GET /damages/:id/inspections",
  "POST /damages/:id/inspections",
  "GET /inspections?damageId=&result=",
  "GET /batches",
  "POST /batches",
  "GET /batches/:id",
  "POST /batches/:id/complete",
  "GET /projects",
  "POST /projects",
  "GET /projects/:id",
  "PATCH /projects/:id",
  "GET /projects/:id/retention",
  "GET /projects/:id/archives",
  "GET /projects/:id/blocked-records",
  "GET /projects/:id/holds",
  "POST /projects/:id/holds",
  "POST /projects/:id/holds/:holdId/release",
  "POST /archives",
  "GET /archives?projectId=&status=",
  "GET /archives/:id",
  "GET /archives/:id/package",
  "POST /archives/:id/verify",
  "POST /archives/:id/cleanup",
  "POST /archives/:id/cleanup/confirm",
  "POST /archives/:id/restore",
  "GET /cleanup-receipts?projectId=",
  "GET /cleanup-receipts/:id",
  "GET /cleanup-receipts/:id/verify",
  "GET /recovery-log"
];

function createApp(options = {}) {
  const store = createStore(options);

  function send(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body, null, 2));
  }

  async function parseBody(req) {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw httpError(400, "请求体必须是合法JSON");
    }
  }

  function findRubbing(db, rubbingId) {
    const rubbing = db.rubbings.find((item) => item.id === rubbingId);
    if (!rubbing) throw httpError(404, "拓片不存在");
    return rubbing;
  }

  function enrichBatch(db, batch) {
    const damages = db.damages.filter((item) => batch.damageIds.includes(item.id));
    return {
      ...batch,
      damages,
      total: damages.length,
      repaired: damages.filter((item) => item.status === "repaired").length,
      pending: damages.filter((item) => item.status !== "repaired").length
    };
  }

  // 拦下冲突操作：登记 blockedRecords 后返回 409
  async function blockConflict(db, entry) {
    logBlocked(db, { kind: entry.kind || "write", projectId: entry.projectId || null, reason: entry.reason, detail: entry.detail || "" });
    await store.writeDb(db);
    throw httpError(409, entry.reason, entry.extra);
  }

  // 记录已随归档清理时，把"找不到"转成明确的已归档指引；未归档返回 false
  async function blockIfCleaned(db, collection, id, label) {
    const archiveNo = cleanedIndex(db)[collection].get(id);
    if (!archiveNo) return false;
    const arc = db.archives.find((a) => a.archiveNo === archiveNo);
    await blockConflict(db, {
      projectId: arc ? arc.projectId : null,
      reason: `${label}已归档清理（归档号 ${archiveNo}），如需修改请先回迁`,
      detail: `${collection}=${id} archive=${archiveNo}`
    });
    return true;
  }

  async function blockIfFrozen(db, collection, id, projectId, label) {
    const archiveNo = frozenIndex(db)[collection].get(id);
    if (!archiveNo) return false;
    await blockConflict(db, {
      projectId,
      reason: `${label}已封存进归档包（归档号 ${archiveNo}），归档期间禁止写入，如需修改请先完成清理后回迁`,
      detail: `${collection}=${id} archive=${archiveNo}`
    });
    return true;
  }

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // ---------- 归档动作（archive.js 内部自行加锁） ----------
    if (req.method === "POST" && pathname === "/archives") {
      const body = await parseBody(req);
      required(body, ["projectId"]);
      const result = await sealArchive(store, { projectId: body.projectId, archiveNo: body.archiveNo, operator: body.operator });
      return send(res, result.statusCode, result.body);
    }

    const verifyMatch = pathname.match(/^\/archives\/([^/]+)\/verify$/);
    if (verifyMatch && req.method === "POST") {
      const result = await verifyArchive(store, verifyMatch[1]);
      return send(res, result.statusCode, result.body);
    }

    const cleanupConfirmMatch = pathname.match(/^\/archives\/([^/]+)\/cleanup\/confirm$/);
    if (cleanupConfirmMatch && req.method === "POST") {
      const body = await parseBody(req);
      const result = await confirmCleanup(store, cleanupConfirmMatch[1], { token: body.token, operator: body.operator });
      return send(res, result.statusCode, result.body);
    }

    const cleanupMatch = pathname.match(/^\/archives\/([^/]+)\/cleanup$/);
    if (cleanupMatch && req.method === "POST") {
      const body = await parseBody(req);
      const result = await requestCleanup(store, cleanupMatch[1], { operator: body.operator });
      return send(res, result.statusCode, result.body);
    }

    const restoreMatch = pathname.match(/^\/archives\/([^/]+)\/restore$/);
    if (restoreMatch && req.method === "POST") {
      const body = await parseBody(req);
      const result = await restoreArchive(store, restoreMatch[1], { operator: body.operator });
      return send(res, result.statusCode, result.body);
    }

    // ---------- 只读接口 ----------
    if (req.method === "GET") {
      const db = await store.readDb();

      if (pathname === "/health") {
        return send(res, 200, { ok: true, service: "rubbing-repair-api", routes });
      }

      if (pathname === "/rubbings") {
        const data = db.rubbings.map((rubbing) => {
          if (rubbing._summary) {
            return { ...rubbing, damageCount: rubbing.counts?.damages ?? 0, pendingDamages: 0 };
          }
          const damages = db.damages.filter((item) => item.rubbingId === rubbing.id);
          return {
            ...rubbing,
            damageCount: damages.length,
            pendingDamages: damages.filter((item) => item.status !== "repaired").length
          };
        });
        return send(res, 200, { data });
      }

      const rubbingDamagesMatch = pathname.match(/^\/rubbings\/([^/]+)\/damages$/);
      if (rubbingDamagesMatch) {
        const rubbing = findRubbing(db, rubbingDamagesMatch[1]);
        if (rubbing._summary) {
          return send(res, 409, {
            error: "拓片已归档清理，热库仅存摘要",
            archiveNo: rubbing.archiveNo,
            hint: `可查看 GET /archives/${rubbing.archiveNo}/package 获取归档内容，或 POST /archives/${rubbing.archiveNo}/restore 回迁`
          });
        }
        return send(res, 200, { data: db.damages.filter((item) => item.rubbingId === rubbing.id) });
      }

      if (pathname === "/damages") {
        const status = url.searchParams.get("status");
        const type = url.searchParams.get("type");
        const data = db.damages.filter((item) => (!status || item.status === status) && (!type || item.type === type));
        return send(res, 200, { data });
      }

      const damageInspectionsMatch = pathname.match(/^\/damages\/([^/]+)\/inspections$/);
      if (damageInspectionsMatch) {
        const damageId = damageInspectionsMatch[1];
        const damage = db.damages.find((item) => item.id === damageId);
        if (!damage) {
          const archiveNo = cleanedIndex(db).damages.get(damageId);
          if (archiveNo) {
            return send(res, 409, { error: `缺损项已归档清理（归档号 ${archiveNo}），质检记录请查阅归档包`, archiveNo });
          }
          return send(res, 404, { error: "缺损项不存在" });
        }
        return send(res, 200, { data: db.inspections.filter((item) => item.damageId === damageId) });
      }

      if (pathname === "/inspections") {
        const damageId = url.searchParams.get("damageId");
        const result = url.searchParams.get("result");
        const data = db.inspections.filter((item) => (!damageId || item.damageId === damageId) && (!result || item.result === result));
        return send(res, 200, { data });
      }

      if (pathname === "/batches") {
        return send(res, 200, { data: db.batches.map((batch) => enrichBatch(db, batch)) });
      }

      const batchMatch = pathname.match(/^\/batches\/([^/]+)$/);
      if (batchMatch) {
        const batch = db.batches.find((item) => item.id === batchMatch[1]);
        if (!batch) return send(res, 404, { error: "修补批次不存在" });
        return send(res, 200, { data: enrichBatch(db, batch) });
      }

      if (pathname === "/projects") {
        const data = db.projects.map((project) => ({
          ...project,
          rubbingCount: db.rubbings.filter((r) => (r.projectId ?? null) === project.id).length,
          activeHold: db.holds.some((h) => h.projectId === project.id && h.active),
          archiveCount: db.archives.filter((a) => a.projectId === project.id).length
        }));
        return send(res, 200, { data });
      }

      const projectRetentionMatch = pathname.match(/^\/projects\/([^/]+)\/retention$/);
      if (projectRetentionMatch) {
        return send(res, 200, { data: retentionStatus(db, projectRetentionMatch[1]) });
      }

      const projectArchivesMatch = pathname.match(/^\/projects\/([^/]+)\/archives$/);
      if (projectArchivesMatch) {
        findProject(db, projectArchivesMatch[1]);
        return send(res, 200, { data: db.archives.filter((a) => a.projectId === projectArchivesMatch[1]) });
      }

      const projectBlockedMatch = pathname.match(/^\/projects\/([^/]+)\/blocked-records$/);
      if (projectBlockedMatch) {
        findProject(db, projectBlockedMatch[1]);
        const data = db.blockedRecords.filter((b) => b.projectId === projectBlockedMatch[1]).slice().reverse();
        return send(res, 200, { data });
      }

      const projectHoldsMatch = pathname.match(/^\/projects\/([^/]+)\/holds$/);
      if (projectHoldsMatch) {
        findProject(db, projectHoldsMatch[1]);
        return send(res, 200, { data: db.holds.filter((h) => h.projectId === projectHoldsMatch[1]) });
      }

      const projectMatch = pathname.match(/^\/projects\/([^/]+)$/);
      if (projectMatch) {
        const project = findProject(db, projectMatch[1]);
        return send(res, 200, {
          data: {
            ...project,
            rubbingCount: db.rubbings.filter((r) => (r.projectId ?? null) === project.id).length,
            activeHold: db.holds.some((h) => h.projectId === project.id && h.active),
            archiveCount: db.archives.filter((a) => a.projectId === project.id).length
          }
        });
      }

      if (pathname === "/archives") {
        const projectId = url.searchParams.get("projectId");
        const status = url.searchParams.get("status");
        const data = db.archives.filter((a) => (!projectId || a.projectId === projectId) && (!status || a.status === status));
        return send(res, 200, { data });
      }

      const archivePackageMatch = pathname.match(/^\/archives\/([^/]+)\/package$/);
      if (archivePackageMatch) {
        const archive = findArchive(db, archivePackageMatch[1]);
        let pkg;
        try {
          pkg = JSON.parse(await store.readDataFile(archive.packageFile));
        } catch {
          return send(res, 404, { error: "归档包文件不存在或已被隔离", archiveNo: archive.archiveNo });
        }
        return send(res, 200, { data: pkg });
      }

      const archiveMatch = pathname.match(/^\/archives\/([^/]+)$/);
      if (archiveMatch) {
        return send(res, 200, { data: findArchive(db, archiveMatch[1]) });
      }

      if (pathname === "/cleanup-receipts") {
        const projectId = url.searchParams.get("projectId");
        const data = db.cleanupReceipts.filter((r) => !projectId || r.projectId === projectId);
        return send(res, 200, { data });
      }

      const receiptVerifyMatch = pathname.match(/^\/cleanup-receipts\/([^/]+)\/verify$/);
      if (receiptVerifyMatch) {
        const result = await verifyReceipt(store, receiptVerifyMatch[1]);
        return send(res, result.statusCode, result.body);
      }

      const receiptMatch = pathname.match(/^\/cleanup-receipts\/([^/]+)$/);
      if (receiptMatch) {
        const receipt = db.cleanupReceipts.find((r) => r.id === receiptMatch[1]);
        if (!receipt) return send(res, 404, { error: "清理凭据不存在" });
        return send(res, 200, { data: receipt });
      }

      if (pathname === "/recovery-log") {
        return send(res, 200, { data: db.recoveryLog });
      }

      return send(res, 404, { error: "接口不存在", routes });
    }

    // ---------- 写接口（锁内执行，归档冲突在此拦下） ----------

    if (req.method === "POST" && pathname === "/rubbings") {
      const body = await parseBody(req);
      required(body, ["code", "source", "paperSize"]);
      if (body.createdAt !== undefined && Number.isNaN(Date.parse(body.createdAt))) throw httpError(400, "createdAt 必须是合法时间");
      return store.withLock(async () => {
        const db = await store.readDb();
        if (body.projectId !== undefined && body.projectId !== null && body.projectId !== "" && !db.projects.find((p) => p.id === body.projectId)) {
          throw httpError(400, "保管项目不存在");
        }
        const rubbing = {
          id: makeId("rubbing"),
          code: body.code,
          source: body.source,
          paperSize: body.paperSize,
          note: body.note || "",
          projectId: body.projectId || null,
          createdAt: body.createdAt || new Date().toISOString()
        };
        db.rubbings.push(rubbing);
        await store.writeDb(db);
        return send(res, 201, { data: rubbing });
      });
    }

    const rubbingPatchMatch = pathname.match(/^\/rubbings\/([^/]+)$/);
    if (rubbingPatchMatch && req.method === "PATCH") {
      const body = await parseBody(req);
      return store.withLock(async () => {
        const db = await store.readDb();
        const rubbing = db.rubbings.find((item) => item.id === rubbingPatchMatch[1]);
        if (!rubbing) throw httpError(404, "拓片不存在");
        if (rubbing._summary) {
          await blockConflict(db, {
            projectId: rubbing.projectId,
            reason: `拓片已归档清理（归档号 ${rubbing.archiveNo}），如需修改请先回迁`,
            detail: `rubbing=${rubbing.id} archive=${rubbing.archiveNo}`
          });
        }
        await blockIfFrozen(db, "rubbings", rubbing.id, rubbing.projectId ?? null, "拓片");
        if (body.projectId !== undefined && body.projectId !== null && !db.projects.find((p) => p.id === body.projectId)) {
          throw httpError(400, "保管项目不存在");
        }
        Object.assign(rubbing, {
          code: body.code ?? rubbing.code,
          source: body.source ?? rubbing.source,
          paperSize: body.paperSize ?? rubbing.paperSize,
          note: body.note ?? rubbing.note
        });
        if (body.projectId !== undefined) rubbing.projectId = body.projectId;
        await store.writeDb(db);
        return send(res, 200, { data: rubbing });
      });
    }

    const rubbingDamagesPostMatch = pathname.match(/^\/rubbings\/([^/]+)\/damages$/);
    if (rubbingDamagesPostMatch && req.method === "POST") {
      const body = await parseBody(req);
      required(body, ["position", "type", "beforePhotoUrl"]);
      return store.withLock(async () => {
        const db = await store.readDb();
        const rubbing = findRubbing(db, rubbingDamagesPostMatch[1]);
        if (rubbing._summary) {
          await blockConflict(db, {
            projectId: rubbing.projectId,
            reason: `拓片已归档清理（归档号 ${rubbing.archiveNo}），仅存摘要，如需新增缺损请先回迁`,
            detail: `rubbing=${rubbing.id} archive=${rubbing.archiveNo}`
          });
        }
        await blockIfFrozen(db, "rubbings", rubbing.id, rubbing.projectId ?? null, "拓片");
        const damage = {
          id: makeId("damage"),
          rubbingId: rubbing.id,
          position: body.position,
          type: body.type,
          beforePhotoUrl: body.beforePhotoUrl,
          afterPhotoUrl: "",
          status: "pending",
          repairNote: "",
          batchId: null,
          createdAt: new Date().toISOString(),
          repairedAt: null
        };
        db.damages.push(damage);
        await store.writeDb(db);
        return send(res, 201, { data: damage });
      });
    }

    const damagePatchMatch = pathname.match(/^\/damages\/([^/]+)$/);
    if (damagePatchMatch && req.method === "PATCH") {
      const body = await parseBody(req);
      return store.withLock(async () => {
        const db = await store.readDb();
        const damage = db.damages.find((item) => item.id === damagePatchMatch[1]);
        if (!damage) {
          await blockIfCleaned(db, "damages", damagePatchMatch[1], "缺损项");
          throw httpError(404, "缺损项不存在");
        }
        const rubbing = db.rubbings.find((item) => item.id === damage.rubbingId);
        await blockIfFrozen(db, "damages", damage.id, rubbing ? rubbing.projectId ?? null : null, "缺损项");
        Object.assign(damage, {
          position: body.position ?? damage.position,
          type: body.type ?? damage.type,
          beforePhotoUrl: body.beforePhotoUrl ?? damage.beforePhotoUrl,
          afterPhotoUrl: body.afterPhotoUrl ?? damage.afterPhotoUrl,
          status: body.status ?? damage.status,
          repairNote: body.repairNote ?? damage.repairNote
        });
        damage.repairedAt = damage.status === "repaired" ? new Date().toISOString() : damage.repairedAt;
        await store.writeDb(db);
        return send(res, 200, { data: damage });
      });
    }

    const damageInspectionsPostMatch = pathname.match(/^\/damages\/([^/]+)\/inspections$/);
    if (damageInspectionsPostMatch && req.method === "POST") {
      const body = await parseBody(req);
      required(body, ["inspector", "result"]);
      if (!["pass", "fail", "rework"].includes(body.result)) throw httpError(400, "result 必须是 pass / fail / rework");
      return store.withLock(async () => {
        const db = await store.readDb();
        const damage = db.damages.find((item) => item.id === damageInspectionsPostMatch[1]);
        if (!damage) {
          await blockIfCleaned(db, "damages", damageInspectionsPostMatch[1], "缺损项");
          throw httpError(404, "缺损项不存在");
        }
        const rubbing = db.rubbings.find((item) => item.id === damage.rubbingId);
        await blockIfFrozen(db, "damages", damage.id, rubbing ? rubbing.projectId ?? null : null, "缺损项");
        const inspection = {
          id: makeId("inspection"),
          damageId: damage.id,
          inspector: body.inspector,
          result: body.result,
          note: body.note || "",
          createdAt: new Date().toISOString()
        };
        db.inspections.push(inspection);
        await store.writeDb(db);
        return send(res, 201, { data: inspection });
      });
    }

    if (req.method === "POST" && pathname === "/batches") {
      const body = await parseBody(req);
      required(body, ["name", "damageIds"]);
      if (!Array.isArray(body.damageIds) || body.damageIds.length === 0) throw httpError(400, "damageIds必须是非空数组");
      return store.withLock(async () => {
        const db = await store.readDb();
        const invalid = body.damageIds.filter((id) => !db.damages.find((damage) => damage.id === id));
        if (invalid.length) {
          const cleaned = cleanedIndex(db).damages;
          const archivedIds = invalid.filter((id) => cleaned.has(id));
          if (archivedIds.length) {
            const arc = db.archives.find((a) => a.archiveNo === cleaned.get(archivedIds[0]));
            await blockConflict(db, {
              projectId: arc ? arc.projectId : null,
              reason: `缺损项已归档清理，不能加入新批次：${archivedIds.join(", ")}`,
              detail: `damages=${archivedIds.join(",")}`
            });
          }
          throw httpError(400, `缺损项不存在：${invalid.join(", ")}`);
        }
        const frozen = frozenIndex(db).damages;
        const frozenIds = body.damageIds.filter((id) => frozen.has(id));
        if (frozenIds.length) {
          const damage = db.damages.find((d) => d.id === frozenIds[0]);
          const rubbing = damage && db.rubbings.find((r) => r.id === damage.rubbingId);
          await blockConflict(db, {
            projectId: rubbing ? rubbing.projectId ?? null : null,
            reason: `缺损项已封存进归档包（归档号 ${frozen.get(frozenIds[0])}），不能加入新批次：${frozenIds.join(", ")}`,
            detail: `damages=${frozenIds.join(",")}`
          });
        }
        const batch = {
          id: makeId("batch"),
          name: body.name,
          status: "open",
          damageIds: body.damageIds,
          note: body.note || "",
          createdAt: new Date().toISOString(),
          completedAt: null
        };
        db.batches.push(batch);
        db.damages.forEach((damage) => {
          if (body.damageIds.includes(damage.id)) {
            damage.batchId = batch.id;
            damage.status = "in_repair";
          }
        });
        await store.writeDb(db);
        return send(res, 201, { data: enrichBatch(db, batch) });
      });
    }

    const completeMatch = pathname.match(/^\/batches\/([^/]+)\/complete$/);
    if (completeMatch && req.method === "POST") {
      const body = await parseBody(req);
      return store.withLock(async () => {
        const db = await store.readDb();
        const batch = db.batches.find((item) => item.id === completeMatch[1]);
        if (!batch) {
          await blockIfCleaned(db, "batches", completeMatch[1], "修补批次");
          throw httpError(404, "修补批次不存在");
        }
        await blockIfFrozen(db, "batches", batch.id, null, "修补批次");
        const results = Array.isArray(body.results) ? body.results : [];
        batch.status = "completed";
        batch.completedAt = new Date().toISOString();
        batch.note = body.note ?? batch.note;
        db.damages.forEach((damage) => {
          if (!batch.damageIds.includes(damage.id)) return;
          const result = results.find((item) => item.damageId === damage.id) || {};
          damage.status = "repaired";
          damage.afterPhotoUrl = result.afterPhotoUrl || body.defaultAfterPhotoUrl || damage.afterPhotoUrl;
          damage.repairNote = result.repairNote || body.defaultRepairNote || damage.repairNote;
          damage.repairedAt = new Date().toISOString();
        });
        await store.writeDb(db);
        return send(res, 200, { data: enrichBatch(db, batch) });
      });
    }

    if (req.method === "POST" && pathname === "/projects") {
      const body = await parseBody(req);
      required(body, ["name", "retentionYears"]);
      if (!(Number(body.retentionYears) > 0)) throw httpError(400, "retentionYears 必须是正数（留存年限/年）");
      return store.withLock(async () => {
        const db = await store.readDb();
        const project = {
          id: makeId("project"),
          name: body.name,
          retentionYears: Number(body.retentionYears),
          description: body.description || "",
          createdAt: new Date().toISOString()
        };
        db.projects.push(project);
        await store.writeDb(db);
        return send(res, 201, { data: project });
      });
    }

    const projectPatchMatch = pathname.match(/^\/projects\/([^/]+)$/);
    if (projectPatchMatch && req.method === "PATCH") {
      const body = await parseBody(req);
      if (body.retentionYears !== undefined && !(Number(body.retentionYears) > 0)) throw httpError(400, "retentionYears 必须是正数（留存年限/年）");
      return store.withLock(async () => {
        const db = await store.readDb();
        const project = findProject(db, projectPatchMatch[1]);
        Object.assign(project, {
          name: body.name ?? project.name,
          description: body.description ?? project.description
        });
        if (body.retentionYears !== undefined) project.retentionYears = Number(body.retentionYears);
        await store.writeDb(db);
        return send(res, 200, { data: project });
      });
    }

    const holdsPostMatch = pathname.match(/^\/projects\/([^/]+)\/holds$/);
    if (holdsPostMatch && req.method === "POST") {
      const body = await parseBody(req);
      required(body, ["reason"]);
      return store.withLock(async () => {
        const db = await store.readDb();
        findProject(db, holdsPostMatch[1]);
        const hold = {
          id: makeId("hold"),
          projectId: holdsPostMatch[1],
          reason: body.reason,
          createdBy: body.createdBy || "system",
          active: true,
          createdAt: new Date().toISOString(),
          releasedAt: null,
          releasedBy: null
        };
        db.holds.push(hold);
        await store.writeDb(db);
        return send(res, 201, { data: hold });
      });
    }

    const holdReleaseMatch = pathname.match(/^\/projects\/([^/]+)\/holds\/([^/]+)\/release$/);
    if (holdReleaseMatch && req.method === "POST") {
      const body = await parseBody(req);
      return store.withLock(async () => {
        const db = await store.readDb();
        findProject(db, holdReleaseMatch[1]);
        const hold = db.holds.find((h) => h.id === holdReleaseMatch[2] && h.projectId === holdReleaseMatch[1]);
        if (!hold) throw httpError(404, "法律保留记录不存在");
        if (!hold.active) return send(res, 200, { data: hold, idempotent: true });
        hold.active = false;
        hold.releasedAt = new Date().toISOString();
        hold.releasedBy = body.releasedBy || "system";
        await store.writeDb(db);
        return send(res, 200, { data: hold });
      });
    }

    return send(res, 404, { error: "接口不存在", routes });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误", ...(error.extra || {}) }));
  });

  async function start(port = Number(process.env.PORT || 3020)) {
    await store.ensureDirs();
    const notes = await store.recover();
    if (notes.length) console.log(`启动恢复：处理 ${notes.length} 项崩溃残留（详见 GET /recovery-log）`);
    await new Promise((resolve) => server.listen(port, resolve));
    return server;
  }

  return { server, store, start };
}

module.exports = { createApp, routes };
