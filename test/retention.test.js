const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");
const { api, makeServer, seedFull, readDbFile } = require("./helpers");
const { sha256 } = require("../lib/checksum");

test("到期拓片归档：打包、逐项校验值、只读包、热库封存", async (t) => {
  const { base, dir } = await makeServer(t);
  const { project, rubbing, damage, batch, inspection } = await seedFull(base);
  // 同项目一条未到期拓片，不应被归档
  const fresh = await api(base, "POST", "/rubbings", {
    code: "TP-测-002",
    source: "馆藏",
    paperSize: "40x60cm",
    projectId: project.id
  });
  const freshDamage = await api(base, "POST", `/rubbings/${fresh.body.data.id}/damages`, {
    position: "边缘",
    type: "撕裂",
    beforePhotoUrl: "https://example.local/x.jpg"
  });

  const sealed = await api(base, "POST", "/archives", { projectId: project.id, archiveNo: "ARC-TEST-0001", operator: "李馆" });
  assert.equal(sealed.status, 201);
  const record = sealed.body.data;
  assert.equal(record.status, "sealed");
  assert.equal(record.archiveNo, "ARC-TEST-0001");
  assert.deepEqual(record.counts, { rubbings: 1, damages: 1, batches: 1, inspections: 1 });
  assert.equal(record.items.length, 4);
  for (const item of record.items) assert.match(item.sha256, /^[0-9a-f]{64}$/);

  // 包文件只读，清单与逐项校验值可独立复算
  const pkgFile = path.join(dir, "archives", "ARC-TEST-0001.json");
  const stat = await fs.stat(pkgFile);
  assert.equal(stat.mode & 0o222, 0, "归档包应为只读");
  const pkg = JSON.parse(await fs.readFile(pkgFile, "utf8"));
  assert.equal(pkg.manifest.manifestHash, sha256(pkg.manifest.items));
  assert.equal(pkg.payload.rubbings[0].id, rubbing.id);
  assert.equal(pkg.payload.damages[0].id, damage.id);
  assert.equal(pkg.payload.batches[0].id, batch.id);
  assert.equal(pkg.payload.inspections[0].id, inspection.id);
  for (const item of pkg.manifest.items) {
    const recordInPkg = pkg.payload[item.collection].find((r) => r.id === item.id);
    assert.equal(item.sha256, sha256(recordInPkg));
  }

  const verified = await api(base, "POST", `/archives/${record.id}/verify`, {});
  assert.equal(verified.body.data.ok, true);

  // 留存状态：到期拓片 sealed，未到期 hot
  const retention = await api(base, "GET", `/projects/${project.id}/retention`);
  const byId = Object.fromEntries(retention.body.data.rubbings.map((r) => [r.id, r]));
  assert.equal(byId[rubbing.id].state, "sealed");
  assert.equal(byId[rubbing.id].archiveNo, "ARC-TEST-0001");
  assert.equal(byId[fresh.body.data.id].state, "hot");
  assert.equal(retention.body.data.counts.sealed, 1);

  // 已封存的缺损/拓片禁止写入，未到期拓片不受影响
  const patch = await api(base, "PATCH", `/damages/${damage.id}`, { repairNote: "改动" });
  assert.equal(patch.status, 409);
  const addDamage = await api(base, "POST", `/rubbings/${rubbing.id}/damages`, { position: "x", type: "y", beforePhotoUrl: "z" });
  assert.equal(addDamage.status, 409);
  const addInspection = await api(base, "POST", `/damages/${damage.id}/inspections`, { inspector: "x", result: "pass" });
  assert.equal(addInspection.status, 409);
  const patchFresh = await api(base, "PATCH", `/damages/${freshDamage.body.data.id}`, { repairNote: "可以改" });
  assert.equal(patchFresh.status, 200);

  // 被拦下的记录可按项目查询
  const blocked = await api(base, "GET", `/projects/${project.id}/blocked-records`);
  assert.equal(blocked.status, 200);
  assert.ok(blocked.body.data.length >= 3);
  assert.ok(blocked.body.data.every((b) => b.kind === "write"));
});

test("同一归档号重复提交只生效一次", async (t) => {
  const { base } = await makeServer(t);
  const { project } = await seedFull(base);

  const first = await api(base, "POST", "/archives", { projectId: project.id, archiveNo: "ARC-DUP-1" });
  assert.equal(first.status, 201);
  const second = await api(base, "POST", "/archives", { projectId: project.id, archiveNo: "ARC-DUP-1" });
  assert.equal(second.status, 200);
  assert.equal(second.body.idempotent, true);
  assert.equal(second.body.data.id, first.body.data.id);

  const list = await api(base, "GET", `/archives?projectId=${project.id}`);
  assert.equal(list.body.data.length, 1);

  // 归档号不能跨项目复用
  const other = await seedFull(base, { code: "TP-测-009" });
  const cross = await api(base, "POST", "/archives", { projectId: other.project.id, archiveNo: "ARC-DUP-1" });
  assert.equal(cross.status, 409);
});

test("法律保留期间不得归档或清理，解除后恢复", async (t) => {
  const { base } = await makeServer(t);
  const { project } = await seedFull(base);

  const hold = await api(base, "POST", `/projects/${project.id}/holds`, { reason: "诉讼保全", createdBy: "法务" });
  assert.equal(hold.status, 201);
  assert.equal(hold.body.data.active, true);

  const sealed = await api(base, "POST", "/archives", { projectId: project.id, archiveNo: "ARC-HOLD-1" });
  assert.equal(sealed.status, 409);

  const blocked = await api(base, "GET", `/projects/${project.id}/blocked-records`);
  assert.ok(blocked.body.data.some((b) => b.kind === "archive"));

  await api(base, "POST", `/projects/${project.id}/holds/${hold.body.data.id}/release`, { releasedBy: "法务" });
  const sealed2 = await api(base, "POST", "/archives", { projectId: project.id, archiveNo: "ARC-HOLD-1" });
  assert.equal(sealed2.status, 201);

  // 清理同样受保留约束
  await api(base, "POST", `/projects/${project.id}/holds`, { reason: "二次保全" });
  const cleanup = await api(base, "POST", "/archives/ARC-HOLD-1/cleanup", {});
  assert.equal(cleanup.status, 409);
  const blocked2 = await api(base, "GET", `/projects/${project.id}/blocked-records`);
  assert.ok(blocked2.body.data.some((b) => b.kind === "cleanup"));

  const holds = await api(base, "GET", `/projects/${project.id}/holds`);
  const active = holds.body.data.find((h) => h.active);
  await api(base, "POST", `/projects/${project.id}/holds/${active.id}/release`, {});
  const cleanup2 = await api(base, "POST", "/archives/ARC-HOLD-1/cleanup", {});
  assert.equal(cleanup2.status, 200);
});

test("清理两步确认：令牌、摘要、可核验凭据与 hash 链", async (t) => {
  const { base, dir } = await makeServer(t);
  const first = await seedFull(base, { code: "TP-测-101" });
  const second = await seedFull(base, { code: "TP-测-102" });

  await api(base, "POST", "/archives", { projectId: first.project.id, archiveNo: "ARC-CLN-1" });

  // 未发起就确认 → 409；令牌错误 → 409 且登记
  const early = await api(base, "POST", "/archives/ARC-CLN-1/cleanup/confirm", { token: "x" });
  assert.equal(early.status, 409);
  const step1 = await api(base, "POST", "/archives/ARC-CLN-1/cleanup", { operator: "李馆" });
  assert.equal(step1.status, 200);
  const { cleanupToken, expiresAt } = step1.body.data;
  assert.ok(cleanupToken && expiresAt);
  const again = await api(base, "POST", "/archives/ARC-CLN-1/cleanup", {});
  assert.equal(again.body.data.cleanupToken, cleanupToken, "重复发起应幂等返回同一令牌");
  const wrong = await api(base, "POST", "/archives/ARC-CLN-1/cleanup/confirm", { token: "cleanup_wrong" });
  assert.equal(wrong.status, 409);

  const confirmed = await api(base, "POST", "/archives/ARC-CLN-1/cleanup/confirm", { token: cleanupToken, operator: "李馆" });
  assert.equal(confirmed.status, 200);
  const receipt = confirmed.body.data.receipt;
  assert.match(receipt.hash, /^[0-9a-f]{64}$/);
  assert.equal(receipt.prevReceiptHash, null);
  assert.equal(confirmed.body.data.archive.status, "cleaned");

  // 热库只留摘要
  const rubbings = await api(base, "GET", "/rubbings");
  const summary = rubbings.body.data.find((r) => r.id === first.rubbing.id);
  assert.equal(summary._summary, true);
  assert.equal(summary.archiveNo, "ARC-CLN-1");
  assert.equal(summary.counts.damages, 1);
  assert.equal(summary.source, undefined, "摘要不应保留全文字段");
  const damages = await api(base, "GET", `/rubbings/${first.rubbing.id}/damages`);
  assert.equal(damages.status, 409);
  const patchArchived = await api(base, "PATCH", `/damages/${first.damage.id}`, { repairNote: "x" });
  assert.equal(patchArchived.status, 409);

  // 凭据可核验，凭据文件只读
  const verify = await api(base, "GET", `/cleanup-receipts/${receipt.id}/verify`);
  assert.equal(verify.body.data.ok, true);
  assert.ok(verify.body.data.checks.every((c) => c.ok));
  const receiptStat = await fs.stat(path.join(dir, "receipts", "ARC-CLN-1.json"));
  assert.equal(receiptStat.mode & 0o222, 0);

  // 重复确认 → 409；幂等提交同一归档号仍只生效一次
  const reconfirm = await api(base, "POST", "/archives/ARC-CLN-1/cleanup/confirm", { token: cleanupToken });
  assert.equal(reconfirm.status, 409);
  const resubmit = await api(base, "POST", "/archives", { projectId: first.project.id, archiveNo: "ARC-CLN-1" });
  assert.equal(resubmit.status, 200);
  assert.equal(resubmit.body.idempotent, true);

  // 第二次清理的凭据链接上一条，形成可核验链
  await api(base, "POST", "/archives", { projectId: second.project.id, archiveNo: "ARC-CLN-2" });
  const step1b = await api(base, "POST", "/archives/ARC-CLN-2/cleanup", {});
  const confirmed2 = await api(base, "POST", "/archives/ARC-CLN-2/cleanup/confirm", { token: step1b.body.data.cleanupToken });
  const receipt2 = confirmed2.body.data.receipt;
  assert.equal(receipt2.prevReceiptHash, receipt.hash);
  const verify2 = await api(base, "GET", `/cleanup-receipts/${receipt2.id}/verify`);
  assert.equal(verify2.body.data.ok, true);

  const blocked = await api(base, "GET", `/projects/${first.project.id}/blocked-records`);
  assert.ok(blocked.body.data.some((b) => b.kind === "cleanup" && b.reason.includes("令牌")));
});

test("回迁结果与归档前一致", async (t) => {
  const { base, dir } = await makeServer(t);
  const { project, rubbing } = await seedFull(base);

  const before = await readDbFile(dir);
  const snapshot = {
    rubbings: before.rubbings.filter((r) => r.projectId === project.id),
    damages: before.damages,
    batches: before.batches,
    inspections: before.inspections
  };

  await api(base, "POST", "/archives", { projectId: project.id, archiveNo: "ARC-RST-1" });
  const step1 = await api(base, "POST", "/archives/ARC-RST-1/cleanup", {});
  await api(base, "POST", "/archives/ARC-RST-1/cleanup/confirm", { token: step1.body.data.cleanupToken });

  const restored = await api(base, "POST", "/archives/ARC-RST-1/restore", { operator: "李馆" });
  assert.equal(restored.status, 200);
  assert.deepEqual(restored.body.data.restored, { rubbings: 1, damages: 1, batches: 1, inspections: 1 });

  const after = await readDbFile(dir);
  assert.deepEqual(after.rubbings.filter((r) => r.id === rubbing.id), snapshot.rubbings);
  assert.deepEqual(after.damages, snapshot.damages);
  assert.deepEqual(after.batches, snapshot.batches);
  assert.deepEqual(after.inspections, snapshot.inspections);

  const retention = await api(base, "GET", `/projects/${project.id}/retention`);
  assert.equal(retention.body.data.rubbings[0].state, "hot");

  // 重复回迁幂等；质检记录随回迁恢复可查
  const again = await api(base, "POST", "/archives/ARC-RST-1/restore", {});
  assert.equal(again.status, 200);
  assert.equal(again.body.idempotent, true);
  const inspections = await api(base, "GET", `/damages/${snapshot.damages[0].id}/inspections`);
  assert.equal(inspections.status, 200);
  assert.equal(inspections.body.data.length, 1);
});

test("归档包被篡改：校验失败并拦下清理与回迁", async (t) => {
  const { base, dir } = await makeServer(t);
  const one = await seedFull(base, { code: "TP-测-201" });
  const two = await seedFull(base, { code: "TP-测-202" });

  await api(base, "POST", "/archives", { projectId: one.project.id, archiveNo: "ARC-TMP-1" });
  await api(base, "POST", "/archives", { projectId: two.project.id, archiveNo: "ARC-TMP-2" });
  const step1 = await api(base, "POST", "/archives/ARC-TMP-2/cleanup", {});
  await api(base, "POST", "/archives/ARC-TMP-2/cleanup/confirm", { token: step1.body.data.cleanupToken });

  // 篡改两个包：改内容不动清单
  for (const no of ["ARC-TMP-1", "ARC-TMP-2"]) {
    const file = path.join(dir, "archives", `${no}.json`);
    await fs.chmod(file, 0o644);
    const pkg = JSON.parse(await fs.readFile(file, "utf8"));
    pkg.payload.damages[0].repairNote = "篡改内容";
    await fs.writeFile(file, JSON.stringify(pkg, null, 2));
  }

  const verify = await api(base, "POST", "/archives/ARC-TMP-1/verify", {});
  assert.equal(verify.body.data.ok, false);
  assert.ok(verify.body.data.mismatches.some((m) => m.collection === "damages"));

  const cleanup = await api(base, "POST", "/archives/ARC-TMP-1/cleanup", {});
  assert.equal(cleanup.status, 409);
  assert.ok(cleanup.body.mismatches.length > 0);

  const restore = await api(base, "POST", "/archives/ARC-TMP-2/restore", {});
  assert.equal(restore.status, 409);

  // 热库未被波及：摘要仍在、全文未回迁
  const db = await readDbFile(dir);
  assert.ok(db.rubbings.find((r) => r.id === two.rubbing.id)._summary);
  assert.equal(db.damages.length, 1, "第一个项目的缺损仍在热库，第二个项目的缺损仍是摘要状态");

  const blocked1 = await api(base, "GET", `/projects/${one.project.id}/blocked-records`);
  assert.ok(blocked1.body.data.some((b) => b.kind === "cleanup"));
  const blocked2 = await api(base, "GET", `/projects/${two.project.id}/blocked-records`);
  assert.ok(blocked2.body.data.some((b) => b.kind === "restore"));
});

test("归档后热库被绕过改动：清理被拦下", async (t) => {
  const { base, dir } = await makeServer(t);
  const { project, damage } = await seedFull(base);
  await api(base, "POST", "/archives", { projectId: project.id, archiveNo: "ARC-DRIFT-1" });

  // 绕过 API 直接改热库文件
  const dbFile = path.join(dir, "db.json");
  const db = JSON.parse(await fs.readFile(dbFile, "utf8"));
  db.damages.find((d) => d.id === damage.id).repairNote = "库外改动";
  await fs.writeFile(dbFile, JSON.stringify(db, null, 2));

  const cleanup = await api(base, "POST", "/archives/ARC-DRIFT-1/cleanup", {});
  assert.equal(cleanup.status, 409);
  assert.match(cleanup.body.error, /热库数据与归档包不一致/);
});

test("混合批次：跨未到期拓片的批次整批暂缓归档", async (t) => {
  const { base } = await makeServer(t);
  const project = (await api(base, "POST", "/projects", { name: "混合批次项目", retentionYears: 1 })).body.data;
  const mk = async (code, createdAt) => {
    const rubbing = (
      await api(base, "POST", "/rubbings", { code, source: "s", paperSize: "p", projectId: project.id, createdAt })
    ).body.data;
    const damage = (
      await api(base, "POST", `/rubbings/${rubbing.id}/damages`, { position: "p", type: "t", beforePhotoUrl: "u" })
    ).body.data;
    return { rubbing, damage };
  };
  const a = await mk("TP-混-1", "2020-01-01T00:00:00.000Z"); // 到期
  const b = await mk("TP-混-2", new Date().toISOString()); // 未到期
  const c = await mk("TP-混-3", "2020-01-01T00:00:00.000Z"); // 到期且无混合批次
  await api(base, "POST", "/batches", { name: "混合批", damageIds: [a.damage.id, b.damage.id] });

  const sealed = await api(base, "POST", "/archives", { projectId: project.id, archiveNo: "ARC-MIX-1" });
  assert.equal(sealed.status, 201);
  assert.equal(sealed.body.data.counts.rubbings, 1, "只有 TP-混-3 被归档");
  assert.equal(sealed.body.data.skipped.length, 1);
  assert.equal(sealed.body.data.skipped[0].rubbingId, a.rubbing.id);

  const retention = await api(base, "GET", `/projects/${project.id}/retention`);
  const byId = Object.fromEntries(retention.body.data.rubbings.map((r) => [r.id, r]));
  assert.equal(byId[a.rubbing.id].state, "hot");
  assert.equal(byId[c.rubbing.id].state, "sealed");
});

test("归档与写入并发：结果必然自洽", async (t) => {
  const { base } = await makeServer(t);
  const { project, damage } = await seedFull(base);

  const [sealed, patched] = await Promise.all([
    api(base, "POST", "/archives", { projectId: project.id, archiveNo: "ARC-RACE-1" }),
    api(base, "PATCH", `/damages/${damage.id}`, { repairNote: "并发修改" })
  ]);

  if (patched.status === 200) {
    // 先写后归档：包内必须包含新值
    assert.equal(sealed.status, 201);
    const pkg = await api(base, "GET", "/archives/ARC-RACE-1/package");
    assert.equal(pkg.body.data.payload.damages[0].repairNote, "并发修改");
  } else {
    // 先归档后写：写入被拦下且登记
    assert.equal(patched.status, 409);
    assert.equal(sealed.status, 201);
    const blocked = await api(base, "GET", `/projects/${project.id}/blocked-records`);
    assert.ok(blocked.body.data.some((b) => b.kind === "write"));
  }
});

test("清理令牌过期后需重新发起", async (t) => {
  const { base } = await makeServer(t);
  const { project } = await seedFull(base);
  await api(base, "POST", "/archives", { projectId: project.id, archiveNo: "ARC-EXP-1" });

  const old = process.env.CLEANUP_TOKEN_TTL_MS;
  process.env.CLEANUP_TOKEN_TTL_MS = "1";
  t.after(() => {
    if (old === undefined) delete process.env.CLEANUP_TOKEN_TTL_MS;
    else process.env.CLEANUP_TOKEN_TTL_MS = old;
  });

  const step1 = await api(base, "POST", "/archives/ARC-EXP-1/cleanup", {});
  assert.equal(step1.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const confirm = await api(base, "POST", "/archives/ARC-EXP-1/cleanup/confirm", { token: step1.body.data.cleanupToken });
  assert.equal(confirm.status, 409);
  assert.match(confirm.body.error, /已过期/);

  const db = await api(base, "GET", `/projects/${project.id}/retention`);
  assert.equal(db.body.data.rubbings[0].state, "sealed", "过期未确认不应清理");
});
