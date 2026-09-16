const { sha256 } = require("./checksum");
const { makeId, httpError, clone } = require("./util");

const COLLECTIONS = ["rubbings", "damages", "batches", "inspections"];
// 处于这两个状态的归档，包内记录视为"已封存"，热库中的对应记录禁止写入
const ACTIVE_STATUSES = ["sealed", "cleanup_pending"];
const BLOCKED_KEEP = 1000;

function cleanupTokenTtlMs() {
  return Number(process.env.CLEANUP_TOKEN_TTL_MS || 10 * 60 * 1000);
}

// 被拦下的操作一律登记，可按项目查询
function logBlocked(db, entry) {
  db.blockedRecords.push({ id: makeId("blocked"), createdAt: new Date().toISOString(), ...entry });
  if (db.blockedRecords.length > BLOCKED_KEEP) db.blockedRecords.splice(0, db.blockedRecords.length - BLOCKED_KEEP);
}

function activeHold(db, projectId) {
  return db.holds.find((h) => h.projectId === projectId && h.active) || null;
}

// 已封存（sealed/cleanup_pending）归档中的记录 id → 归档号
function frozenIndex(db) {
  const index = { rubbings: new Map(), damages: new Map(), batches: new Map(), inspections: new Map() };
  for (const archive of db.archives) {
    if (!ACTIVE_STATUSES.includes(archive.status)) continue;
    for (const item of archive.items) index[item.collection].set(item.id, archive.archiveNo);
  }
  return index;
}

// 已清理（cleaned）归档中的记录 id → 归档号，用于把 404 转成明确的"已归档"指引
function cleanedIndex(db) {
  const index = { rubbings: new Map(), damages: new Map(), batches: new Map(), inspections: new Map() };
  for (const archive of db.archives) {
    if (archive.status !== "cleaned") continue;
    for (const item of archive.items) index[item.collection].set(item.id, archive.archiveNo);
  }
  return index;
}

function findProject(db, projectId) {
  const project = db.projects.find((p) => p.id === projectId);
  if (!project) throw httpError(404, "保管项目不存在");
  return project;
}

function findArchive(db, ref) {
  const archive = db.archives.find((a) => a.id === ref || a.archiveNo === ref);
  if (!archive) throw httpError(404, "归档记录不存在");
  return archive;
}

function expiryTime(rubbing, project) {
  const created = Date.parse(rubbing.createdAt);
  if (Number.isNaN(created)) return null;
  const d = new Date(created);
  d.setUTCFullYear(d.getUTCFullYear() + project.retentionYears);
  return d.getTime();
}

function generateArchiveNo(db) {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  let seq = db.archives.filter((a) => a.archiveNo.includes(`-${stamp}-`)).length + 1;
  let no = `ARC-${stamp}-${String(seq).padStart(4, "0")}`;
  while (db.archives.some((a) => a.archiveNo === no)) {
    seq += 1;
    no = `ARC-${stamp}-${String(seq).padStart(4, "0")}`;
  }
  return no;
}

// 归档包：清单（逐项 sha256）+ 清单自身的校验值 + 完整快照
function buildPackage({ archiveNo, project, records, operator }) {
  const items = [];
  for (const collection of COLLECTIONS) {
    for (const record of records[collection]) items.push({ collection, id: record.id, sha256: sha256(record) });
  }
  items.sort((a, b) => (a.collection === b.collection ? (a.id < b.id ? -1 : 1) : a.collection < b.collection ? -1 : 1));
  const counts = {};
  for (const collection of COLLECTIONS) counts[collection] = records[collection].length;
  return {
    format: "rubbing-archive/1",
    archiveNo,
    projectId: project.id,
    projectName: project.name,
    retentionYears: project.retentionYears,
    sealedAt: new Date().toISOString(),
    operator,
    manifest: { counts, items, manifestHash: sha256(items) },
    payload: records
  };
}

// 逐项重算校验值并与清单比对，同时核对清单自身的 hash
function verifyPackageObject(pkg) {
  if (!pkg || typeof pkg !== "object" || !pkg.manifest || !Array.isArray(pkg.manifest.items) || !pkg.payload) {
    return { ok: false, checks: [{ name: "structure", ok: false }], mismatches: [{ id: null, reason: "归档包结构不完整" }] };
  }
  const mismatches = [];
  const seen = new Set();
  for (const item of pkg.manifest.items) {
    seen.add(`${item.collection}:${item.id}`);
    const record = (pkg.payload[item.collection] || []).find((r) => r.id === item.id);
    if (!record) {
      mismatches.push({ collection: item.collection, id: item.id, reason: "包内缺少清单对应记录" });
      continue;
    }
    if (sha256(record) !== item.sha256) mismatches.push({ collection: item.collection, id: item.id, reason: "记录校验值与清单不符" });
  }
  for (const collection of COLLECTIONS) {
    for (const record of pkg.payload[collection] || []) {
      if (!seen.has(`${collection}:${record.id}`)) mismatches.push({ collection, id: record.id, reason: "记录不在清单中" });
    }
  }
  const manifestOk = sha256(pkg.manifest.items) === pkg.manifest.manifestHash;
  const checks = [
    { name: "items", ok: mismatches.length === 0 },
    { name: "manifestHash", ok: manifestOk }
  ];
  return { ok: mismatches.length === 0 && manifestOk, checks, mismatches };
}

async function loadPackage(store, archive) {
  let raw;
  try {
    raw = await store.readDataFile(archive.packageFile);
  } catch {
    throw httpError(409, "归档包文件不存在或已被隔离", { archiveNo: archive.archiveNo });
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(409, "归档包文件损坏，无法解析", { archiveNo: archive.archiveNo });
  }
}

// 清理前确认热库记录与归档时一致，防止归档后热库被绕过改动
function hotConsistency(db, archive) {
  const mismatches = [];
  for (const item of archive.items) {
    const record = db[item.collection].find((r) => r.id === item.id);
    if (!record) {
      mismatches.push({ collection: item.collection, id: item.id, reason: "热库记录缺失" });
      continue;
    }
    if (sha256(record) !== item.sha256) mismatches.push({ collection: item.collection, id: item.id, reason: "热库记录与归档包不一致" });
  }
  return mismatches;
}

// 归档：把项目内到期拓片连同缺损、批次、质检记录打成只读包，热库记录随即封存
async function sealArchive(store, { projectId, archiveNo, operator }) {
  return store.withLock(async () => {
    const db = await store.readDb();
    const project = findProject(db, projectId);

    if (archiveNo !== undefined && !/^[A-Za-z0-9][A-Za-z0-9-_]{2,63}$/.test(archiveNo)) {
      throw httpError(400, "归档号格式不正确：3-64位，仅字母、数字、-、_");
    }
    if (archiveNo) {
      const dup = db.archives.find((a) => a.archiveNo === archiveNo);
      if (dup) {
        if (dup.projectId !== projectId) throw httpError(409, "归档号已被其他项目的归档使用");
        if (dup.status === "failed") {
          db.archives = db.archives.filter((a) => a.id !== dup.id); // 失败重试：作废旧记录后重新执行
        } else {
          return { statusCode: 200, body: { data: dup, idempotent: true } }; // 同一归档号重复提交只生效一次
        }
      }
    }

    const hold = activeHold(db, projectId);
    if (hold) {
      logBlocked(db, { kind: "archive", projectId, reason: "法律保留期间不得归档", detail: `hold=${hold.id} ${hold.reason}` });
      await store.writeDb(db);
      throw httpError(409, "项目处于法律保留期，不得归档");
    }

    const now = Date.now();
    const frozen = frozenIndex(db);
    const candidates = db.rubbings.filter((r) => {
      if ((r.projectId ?? null) !== projectId || r._summary || frozen.rubbings.has(r.id)) return false;
      const exp = expiryTime(r, project);
      return exp !== null && exp <= now;
    });

    // 批次若横跨未到期或其他项目的拓片，相关拓片整体暂缓，避免批次被拆成半归档
    const candidateIds = new Set(candidates.map((r) => r.id));
    const candidateDamages = db.damages.filter((d) => candidateIds.has(d.rubbingId));
    const candidateDamageIds = new Set(candidateDamages.map((d) => d.id));
    const mixedBatches = db.batches.filter(
      (b) => b.damageIds.some((id) => candidateDamageIds.has(id)) && !b.damageIds.every((id) => candidateDamageIds.has(id))
    );
    const skipped = [];
    let rubbings = candidates;
    if (mixedBatches.length) {
      const mixedDamageIds = new Set(mixedBatches.flatMap((b) => b.damageIds));
      const heldRubbingIds = new Set(candidateDamages.filter((d) => mixedDamageIds.has(d.id)).map((d) => d.rubbingId));
      skipped.push(
        ...candidates
          .filter((r) => heldRubbingIds.has(r.id))
          .map((r) => ({ rubbingId: r.id, code: r.code, reason: "缺损项所在批次包含未到期或其他项目的拓片，整批暂缓归档" }))
      );
      rubbings = candidates.filter((r) => !heldRubbingIds.has(r.id));
    }
    if (!rubbings.length) throw httpError(400, "没有可归档的到期拓片", skipped.length ? { skipped } : undefined);

    const rubbingIds = new Set(rubbings.map((r) => r.id));
    const damages = db.damages.filter((d) => rubbingIds.has(d.rubbingId));
    const damageIds = new Set(damages.map((d) => d.id));
    const batches = db.batches.filter((b) => b.damageIds.length > 0 && b.damageIds.every((id) => damageIds.has(id)));
    const inspections = db.inspections.filter((i) => damageIds.has(i.damageId));

    const records = { rubbings: clone(rubbings), damages: clone(damages), batches: clone(batches), inspections: clone(inspections) };
    const no = archiveNo || generateArchiveNo(db);
    const pkg = buildPackage({ archiveNo: no, project, records, operator: operator || "system" });
    const packageFile = `archives/${no}.json`;

    // 先落只读包文件，再单次原子写库登记；两步之间崩溃留下孤儿包，启动恢复时隔离
    await store.writeDataFile(packageFile, JSON.stringify(pkg, null, 2), { readonly: true });
    store.fault("seal.afterPackageWrite");

    const record = {
      id: makeId("archive"),
      archiveNo: no,
      projectId,
      projectName: project.name,
      retentionYears: project.retentionYears,
      status: "sealed",
      operator: operator || "system",
      sealedAt: pkg.sealedAt,
      counts: pkg.manifest.counts,
      items: pkg.manifest.items,
      manifestHash: pkg.manifest.manifestHash,
      packageFile,
      skipped,
      cleanup: null,
      cleanedAt: null,
      cleanedBy: null,
      receiptId: null,
      restoredAt: null,
      restoredBy: null
    };
    db.archives.push(record);
    store.fault("seal.beforeDbCommit");
    await store.writeDb(db);
    return { statusCode: 201, body: { data: record } };
  });
}

// 清理第一步：校验归档包与热库一致性，签发有时效的确认令牌
async function requestCleanup(store, ref, { operator } = {}) {
  return store.withLock(async () => {
    const db = await store.readDb();
    const archive = findArchive(db, ref);
    const now = Date.now();

    if (archive.status === "cleanup_pending" && archive.cleanup && Date.parse(archive.cleanup.expiresAt) > now) {
      return {
        statusCode: 200,
        body: { data: { archiveNo: archive.archiveNo, cleanupToken: archive.cleanup.token, expiresAt: archive.cleanup.expiresAt, idempotent: true } }
      };
    }
    if (archive.status !== "sealed" && archive.status !== "cleanup_pending") {
      throw httpError(409, `归档当前状态为 ${archive.status}，不能发起清理`);
    }

    const hold = activeHold(db, archive.projectId);
    if (hold) {
      logBlocked(db, { kind: "cleanup", projectId: archive.projectId, reason: "法律保留期间不得清理", detail: `archive=${archive.archiveNo} hold=${hold.id}` });
      await store.writeDb(db);
      throw httpError(409, "项目处于法律保留期，不得清理");
    }
    const pkg = await loadPackage(store, archive);
    const report = verifyPackageObject(pkg);
    if (!report.ok || pkg.manifest.manifestHash !== archive.manifestHash) {
      logBlocked(db, { kind: "cleanup", projectId: archive.projectId, reason: "归档包校验失败，清理被拦下", detail: `archive=${archive.archiveNo}` });
      await store.writeDb(db);
      throw httpError(409, "归档包校验失败，已拦下清理", { mismatches: report.mismatches });
    }
    const drift = hotConsistency(db, archive);
    if (drift.length) {
      logBlocked(db, { kind: "cleanup", projectId: archive.projectId, reason: "热库数据与归档包不一致，清理被拦下", detail: `archive=${archive.archiveNo}` });
      await store.writeDb(db);
      throw httpError(409, "热库数据与归档包不一致，已拦下清理", { mismatches: drift });
    }

    const token = makeId("cleanup");
    const expiresAt = new Date(now + cleanupTokenTtlMs()).toISOString();
    archive.status = "cleanup_pending";
    archive.cleanup = { token, requestedAt: new Date(now).toISOString(), expiresAt, requestedBy: operator || "system" };
    await store.writeDb(db);
    return { statusCode: 200, body: { data: { archiveNo: archive.archiveNo, cleanupToken: token, expiresAt } } };
  });
}

// 清理第二步：凭令牌确认，热库记录替换为摘要并留下可核验凭据（单次原子写库）
async function confirmCleanup(store, ref, { token, operator } = {}) {
  return store.withLock(async () => {
    const db = await store.readDb();
    const archive = findArchive(db, ref);
    const now = Date.now();

    if (archive.status === "cleaned") throw httpError(409, "归档已清理，请勿重复确认");
    if (archive.status !== "cleanup_pending" || !archive.cleanup) throw httpError(409, "清理尚未发起或已失效，请先发起清理（第一步）");
    if (!token || token !== archive.cleanup.token) {
      logBlocked(db, { kind: "cleanup", projectId: archive.projectId, reason: "清理确认令牌不匹配", detail: `archive=${archive.archiveNo}` });
      await store.writeDb(db);
      throw httpError(409, "清理确认令牌不匹配");
    }
    if (Date.parse(archive.cleanup.expiresAt) < now) {
      logBlocked(db, { kind: "cleanup", projectId: archive.projectId, reason: "清理确认令牌已过期", detail: `archive=${archive.archiveNo}` });
      await store.writeDb(db);
      throw httpError(409, "清理确认令牌已过期，请重新发起清理");
    }
    const hold = activeHold(db, archive.projectId);
    if (hold) {
      logBlocked(db, { kind: "cleanup", projectId: archive.projectId, reason: "法律保留期间不得清理", detail: `archive=${archive.archiveNo} hold=${hold.id}` });
      await store.writeDb(db);
      throw httpError(409, "项目处于法律保留期，不得清理");
    }
    const pkg = await loadPackage(store, archive);
    const report = verifyPackageObject(pkg);
    if (!report.ok || pkg.manifest.manifestHash !== archive.manifestHash) {
      logBlocked(db, { kind: "cleanup", projectId: archive.projectId, reason: "归档包校验失败，清理被拦下", detail: `archive=${archive.archiveNo}` });
      await store.writeDb(db);
      throw httpError(409, "归档包校验失败，已拦下清理", { mismatches: report.mismatches });
    }
    const drift = hotConsistency(db, archive);
    if (drift.length) {
      logBlocked(db, { kind: "cleanup", projectId: archive.projectId, reason: "热库数据与归档包不一致，清理被拦下", detail: `archive=${archive.archiveNo}` });
      await store.writeDb(db);
      throw httpError(409, "热库数据与归档包不一致，已拦下清理", { mismatches: drift });
    }

    // 可核验凭据：内容 hash + 与上一条凭据的链式引用，篡改可被发现
    const prev = db.cleanupReceipts[db.cleanupReceipts.length - 1];
    const receiptCore = {
      id: makeId("receipt"),
      archiveNo: archive.archiveNo,
      projectId: archive.projectId,
      operator: operator || "system",
      cleanedAt: new Date(now).toISOString(),
      removed: archive.counts,
      summaries: archive.items.filter((i) => i.collection === "rubbings").map((i) => ({ rubbingId: i.id, checksum: i.sha256 })),
      manifestHash: archive.manifestHash,
      prevReceiptHash: prev ? prev.hash : null
    };
    const receipt = { ...receiptCore, hash: sha256(receiptCore) };
    const receiptFile = `receipts/${archive.archiveNo}.json`;

    store.fault("cleanup.beforeReceiptWrite");
    await store.writeDataFile(receiptFile, JSON.stringify({ ...receipt, receiptFile }, null, 2), { readonly: true });
    store.fault("cleanup.afterReceiptWrite");

    // 摘要替换 + 凭据登记 + 状态推进在同一次原子写库中完成，不存在半清理状态
    const ids = { rubbings: new Set(), damages: new Set(), batches: new Set(), inspections: new Set() };
    for (const item of archive.items) ids[item.collection].add(item.id);
    const payload = pkg.payload;
    db.rubbings = db.rubbings.map((r) => {
      if (!ids.rubbings.has(r.id)) return r;
      const item = archive.items.find((i) => i.collection === "rubbings" && i.id === r.id);
      const damagesOfRubbing = payload.damages.filter((d) => d.rubbingId === r.id);
      const damageIdsOfRubbing = new Set(damagesOfRubbing.map((d) => d.id));
      return {
        id: r.id,
        code: r.code,
        projectId: r.projectId ?? null,
        createdAt: r.createdAt,
        archived: true,
        _summary: true,
        archiveNo: archive.archiveNo,
        summarizedAt: receipt.cleanedAt,
        counts: {
          damages: damagesOfRubbing.length,
          inspections: payload.inspections.filter((i) => damageIdsOfRubbing.has(i.damageId)).length,
          batches: payload.batches.filter((b) => b.damageIds.some((id) => damageIdsOfRubbing.has(id))).length
        },
        checksum: item.sha256
      };
    });
    db.damages = db.damages.filter((d) => !ids.damages.has(d.id));
    db.batches = db.batches.filter((b) => !ids.batches.has(b.id));
    db.inspections = db.inspections.filter((i) => !ids.inspections.has(i.id));
    db.cleanupReceipts.push({ ...receipt, receiptFile });
    archive.status = "cleaned";
    archive.cleanedAt = receipt.cleanedAt;
    archive.cleanedBy = receipt.operator;
    archive.receiptId = receipt.id;
    archive.cleanup = null;

    store.fault("cleanup.beforeDbCommit");
    await store.writeDb(db);
    return { statusCode: 200, body: { data: { archive, receipt } } };
  });
}

// 回迁：校验归档包后把快照原样写回热库，结果与归档前一致
async function restoreArchive(store, ref, { operator } = {}) {
  return store.withLock(async () => {
    const db = await store.readDb();
    const archive = findArchive(db, ref);

    if (archive.status === "restored") return { statusCode: 200, body: { data: archive, idempotent: true } };
    if (archive.status !== "cleaned") {
      const message = archive.status === "sealed" || archive.status === "cleanup_pending" ? "归档尚未清理，数据仍在热库，无需回迁" : `归档状态为 ${archive.status}，不能回迁`;
      logBlocked(db, { kind: "restore", projectId: archive.projectId, reason: message, detail: `archive=${archive.archiveNo}` });
      await store.writeDb(db);
      throw httpError(409, message);
    }

    const pkg = await loadPackage(store, archive);
    const report = verifyPackageObject(pkg);
    if (!report.ok || pkg.manifest.manifestHash !== archive.manifestHash) {
      logBlocked(db, { kind: "restore", projectId: archive.projectId, reason: "归档包校验失败，回迁被拦下", detail: `archive=${archive.archiveNo}` });
      await store.writeDb(db);
      throw httpError(409, "归档包校验失败，已拦下回迁", { mismatches: report.mismatches });
    }

    const conflicts = [];
    for (const collection of COLLECTIONS) {
      for (const record of pkg.payload[collection]) {
        const hot = db[collection].find((r) => r.id === record.id);
        if (!hot) continue;
        const isOwnSummary = collection === "rubbings" && hot._summary && hot.archiveNo === archive.archiveNo;
        if (!isOwnSummary) conflicts.push({ collection, id: record.id, reason: "热库已存在同 id 记录" });
      }
    }
    if (conflicts.length) {
      logBlocked(db, { kind: "restore", projectId: archive.projectId, reason: "回迁与热库现有记录冲突", detail: `archive=${archive.archiveNo}` });
      await store.writeDb(db);
      throw httpError(409, "回迁与热库现有记录冲突", { conflicts });
    }

    store.fault("restore.beforeDbCommit");
    const rubbingIds = new Set(pkg.payload.rubbings.map((r) => r.id));
    db.rubbings = db.rubbings.filter((r) => !rubbingIds.has(r.id)); // 移除摘要桩
    for (const collection of COLLECTIONS) db[collection].push(...clone(pkg.payload[collection]));
    archive.status = "restored";
    archive.restoredAt = new Date().toISOString();
    archive.restoredBy = operator || "system";
    await store.writeDb(db);
    return { statusCode: 200, body: { data: { archive, restored: archive.counts } } };
  });
}

// 重新核算归档包全部校验值，并与 db 登记的清单 hash 三方比对
async function verifyArchive(store, ref) {
  const db = await store.readDb();
  const archive = findArchive(db, ref);
  let pkg;
  try {
    pkg = await loadPackage(store, archive);
  } catch (error) {
    return {
      statusCode: 200,
      body: { data: { archiveNo: archive.archiveNo, ok: false, checks: [{ name: "packageFile", ok: false }], mismatches: [{ reason: error.message }] } }
    };
  }
  const report = verifyPackageObject(pkg);
  const dbMatch = pkg.manifest.manifestHash === archive.manifestHash;
  const checks = [{ name: "packageFile", ok: true }, ...report.checks, { name: "dbManifestHash", ok: dbMatch }];
  return { statusCode: 200, body: { data: { archiveNo: archive.archiveNo, ok: report.ok && dbMatch, checks, mismatches: report.mismatches } } };
}

// 核验清理凭据：自身 hash、与归档包/登记清单的一致性、hash 链
async function verifyReceipt(store, receiptId) {
  const db = await store.readDb();
  const receipt = db.cleanupReceipts.find((r) => r.id === receiptId);
  if (!receipt) throw httpError(404, "清理凭据不存在");
  const checks = [];
  const { hash, receiptFile, ...core } = receipt;
  checks.push({ name: "receiptHash", ok: sha256(core) === hash });
  const archive = db.archives.find((a) => a.archiveNo === receipt.archiveNo);
  checks.push({ name: "archiveManifest", ok: !!archive && archive.manifestHash === receipt.manifestHash });
  let pkgOk = false;
  if (archive) {
    try {
      const pkg = await loadPackage(store, archive);
      pkgOk = pkg.manifest.manifestHash === receipt.manifestHash;
    } catch {
      pkgOk = false;
    }
  }
  checks.push({ name: "packageManifest", ok: pkgOk });
  let fileOk = false;
  if (receiptFile) {
    try {
      const fileReceipt = JSON.parse(await store.readDataFile(receiptFile));
      fileOk = fileReceipt.hash === receipt.hash;
    } catch {
      fileOk = false;
    }
  }
  checks.push({ name: "receiptFile", ok: fileOk });
  const idx = db.cleanupReceipts.findIndex((r) => r.id === receipt.id);
  const prev = idx > 0 ? db.cleanupReceipts[idx - 1] : null;
  checks.push({ name: "hashChain", ok: prev ? prev.hash === receipt.prevReceiptHash : receipt.prevReceiptHash === null });
  return { statusCode: 200, body: { data: { receiptId: receipt.id, ok: checks.every((c) => c.ok), checks } } };
}

// 项目留存状态：逐拓片的到期时间、状态（hot/sealed/archived）、保留与拦截概览
function retentionStatus(db, projectId) {
  const project = findProject(db, projectId);
  const now = Date.now();
  const frozen = frozenIndex(db);
  const rubbings = db.rubbings
    .filter((r) => (r.projectId ?? null) === projectId)
    .map((r) => {
      const exp = expiryTime(r, project);
      const frozenNo = frozen.rubbings.get(r.id);
      const state = r._summary ? "archived" : frozenNo ? "sealed" : "hot";
      return {
        id: r.id,
        code: r.code,
        createdAt: r.createdAt,
        expiresAt: exp ? new Date(exp).toISOString() : null,
        expired: exp ? exp <= now : false,
        state,
        archiveNo: r._summary ? r.archiveNo : frozenNo || null
      };
    });
  const holds = db.holds.filter((h) => h.projectId === projectId);
  const archives = db.archives.filter((a) => a.projectId === projectId);
  return {
    project,
    retentionYears: project.retentionYears,
    legalHold: { active: holds.some((h) => h.active), holds },
    rubbings,
    counts: {
      total: rubbings.length,
      hot: rubbings.filter((r) => r.state === "hot").length,
      sealed: rubbings.filter((r) => r.state === "sealed").length,
      archived: rubbings.filter((r) => r.state === "archived").length,
      expired: rubbings.filter((r) => r.expired && r.state === "hot").length
    },
    archives: archives.map((a) => ({ archiveNo: a.archiveNo, status: a.status, sealedAt: a.sealedAt, counts: a.counts })),
    blockedCount: db.blockedRecords.filter((b) => b.projectId === projectId).length
  };
}

module.exports = {
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
  findArchive,
  activeHold
};
