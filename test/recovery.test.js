const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { createApp } = require("../lib/app");
const { api, seedFull, readDbFile } = require("./helpers");

// 可重启的服务器：同一数据目录、可控故障注入点
function makeRestartable(t) {
  const state = { app: null, base: null, arm: null };
  const faultAt = (point) => {
    if (state.arm === point) throw new Error(`注入故障：${point}`);
  };
  state.start = async () => {
    state.app = createApp({ dataDir: state.dir, faultAt });
    await state.app.start(0);
    state.base = `http://127.0.0.1:${state.app.server.address().port}`;
  };
  state.restart = async () => {
    await new Promise((resolve) => state.app.server.close(() => resolve()));
    await state.start();
  };
  state.init = async () => {
    state.dir = await fs.mkdtemp(path.join(os.tmpdir(), "rubbing-crash-"));
    // 从空库开始，不带演示数据
    await fs.writeFile(path.join(state.dir, "db.json"), JSON.stringify({ rubbings: [], damages: [], batches: [] }, null, 2));
    await state.start();
  };
  t.after(async () => {
    try {
      await new Promise((resolve) => state.app.server.close(() => resolve()));
    } catch {
      // 已关闭
    }
    await fs.rm(state.dir, { recursive: true, force: true });
  });
  return state;
}

test("崩溃恢复：归档包已写但登记前崩溃，重启隔离残留并可原号重试", async (t) => {
  const srv = makeRestartable(t);
  await srv.init();
  const { project } = await seedFull(srv.base);

  srv.arm = "seal.afterPackageWrite";
  const crashed = await api(srv.base, "POST", "/archives", { projectId: project.id, archiveNo: "ARC-CRASH-1" });
  assert.equal(crashed.status, 500);

  // 崩溃现场：孤儿包文件在，db 无归档记录，热库完好
  const archivesDir = path.join(srv.dir, "archives");
  assert.deepEqual(await fs.readdir(archivesDir), ["ARC-CRASH-1.json"]);
  let db = await readDbFile(srv.dir);
  assert.equal(db.archives.length, 0);
  assert.equal(db.damages.length, 1);

  await srv.restart();

  // 恢复：孤儿包被隔离并登记，不冒充实效归档
  const log = await api(srv.base, "GET", "/recovery-log");
  assert.ok(log.body.data.some((n) => n.action === "package.quarantined"));
  assert.deepEqual(await fs.readdir(archivesDir), []);
  assert.equal((await fs.readdir(path.join(srv.dir, "quarantine"))).length, 1);

  // 同一归档号重试正常生效
  srv.arm = null;
  const retried = await api(srv.base, "POST", "/archives", { projectId: project.id, archiveNo: "ARC-CRASH-1" });
  assert.equal(retried.status, 201);
  const verify = await api(srv.base, "POST", "/archives/ARC-CRASH-1/verify", {});
  assert.equal(verify.body.data.ok, true);
});

test("崩溃恢复：清理凭据已写但提交前崩溃，重启后可重新确认，不留半清理", async (t) => {
  const srv = makeRestartable(t);
  await srv.init();
  const { project, rubbing, damage } = await seedFull(srv.base);
  await api(srv.base, "POST", "/archives", { projectId: project.id, archiveNo: "ARC-CRASH-2" });
  const step1 = await api(srv.base, "POST", "/archives/ARC-CRASH-2/cleanup", {});
  const token = step1.body.data.cleanupToken;

  srv.arm = "cleanup.afterReceiptWrite";
  const crashed = await api(srv.base, "POST", "/archives/ARC-CRASH-2/cleanup/confirm", { token });
  assert.equal(crashed.status, 500);

  // 崩溃现场：孤儿凭据在，但 db 仍是 cleanup_pending，热库记录一条不少
  const receiptsDir = path.join(srv.dir, "receipts");
  assert.deepEqual(await fs.readdir(receiptsDir), ["ARC-CRASH-2.json"]);
  let db = await readDbFile(srv.dir);
  assert.equal(db.archives[0].status, "cleanup_pending");
  assert.equal(db.cleanupReceipts.length, 0);
  assert.equal(db.damages.length, 1);
  assert.equal(db.rubbings[0]._summary, undefined);

  await srv.restart();

  const log = await api(srv.base, "GET", "/recovery-log");
  assert.ok(log.body.data.some((n) => n.action === "receipt.quarantined"));
  assert.deepEqual(await fs.readdir(receiptsDir), []);

  // 热库仍是封存原样，重新发起（幂等同令牌）后确认成功
  const damages = await api(srv.base, "GET", `/rubbings/${rubbing.id}/damages`);
  assert.equal(damages.status, 200);
  assert.equal(damages.body.data.length, 1);
  assert.equal(damages.body.data[0].id, damage.id);

  srv.arm = null;
  const step1Again = await api(srv.base, "POST", "/archives/ARC-CRASH-2/cleanup", {});
  assert.equal(step1Again.body.data.cleanupToken, token);
  const confirmed = await api(srv.base, "POST", "/archives/ARC-CRASH-2/cleanup/confirm", { token });
  assert.equal(confirmed.status, 200);

  const verify = await api(srv.base, "GET", `/cleanup-receipts/${confirmed.body.data.receipt.id}/verify`);
  assert.equal(verify.body.data.ok, true);
  const rubbings = await api(srv.base, "GET", "/rubbings");
  assert.equal(rubbings.body.data.find((r) => r.id === rubbing.id)._summary, true);
});

test("崩溃恢复：清理写库前一刻崩溃，热库原样保留", async (t) => {
  const srv = makeRestartable(t);
  await srv.init();
  const { project, rubbing } = await seedFull(srv.base);
  await api(srv.base, "POST", "/archives", { projectId: project.id, archiveNo: "ARC-CRASH-3" });
  const step1 = await api(srv.base, "POST", "/archives/ARC-CRASH-3/cleanup", {});
  const token = step1.body.data.cleanupToken;

  srv.arm = "cleanup.beforeDbCommit";
  const crashed = await api(srv.base, "POST", "/archives/ARC-CRASH-3/cleanup/confirm", { token });
  assert.equal(crashed.status, 500);

  await srv.restart();

  // 无半清理：热库仍是完整记录，归档停留在 cleanup_pending
  const damages = await api(srv.base, "GET", `/rubbings/${rubbing.id}/damages`);
  assert.equal(damages.status, 200);
  assert.equal(damages.body.data.length, 1);
  const archive = await api(srv.base, "GET", "/archives/ARC-CRASH-3");
  assert.equal(archive.body.data.status, "cleanup_pending");

  srv.arm = null;
  const confirmed = await api(srv.base, "POST", "/archives/ARC-CRASH-3/cleanup/confirm", { token });
  assert.equal(confirmed.status, 200);
  const after = await api(srv.base, "GET", "/rubbings");
  assert.equal(after.body.data.find((r) => r.id === rubbing.id)._summary, true);
});

test("崩溃恢复：回迁写库前崩溃，摘要与归档状态原样保留", async (t) => {
  const srv = makeRestartable(t);
  await srv.init();
  const { project, rubbing } = await seedFull(srv.base);
  await api(srv.base, "POST", "/archives", { projectId: project.id, archiveNo: "ARC-CRASH-4" });
  const step1 = await api(srv.base, "POST", "/archives/ARC-CRASH-4/cleanup", {});
  await api(srv.base, "POST", "/archives/ARC-CRASH-4/cleanup/confirm", { token: step1.body.data.cleanupToken });

  srv.arm = "restore.beforeDbCommit";
  const crashed = await api(srv.base, "POST", "/archives/ARC-CRASH-4/restore", {});
  assert.equal(crashed.status, 500);

  await srv.restart();

  const archive = await api(srv.base, "GET", "/archives/ARC-CRASH-4");
  assert.equal(archive.body.data.status, "cleaned");
  const rubbings = await api(srv.base, "GET", "/rubbings");
  assert.equal(rubbings.body.data.find((r) => r.id === rubbing.id)._summary, true);

  srv.arm = null;
  const restored = await api(srv.base, "POST", "/archives/ARC-CRASH-4/restore", {});
  assert.equal(restored.status, 200);
  const after = await api(srv.base, "GET", "/rubbings");
  assert.equal(after.body.data.find((r) => r.id === rubbing.id)._summary, undefined);
});

test("崩溃恢复：db 中残留中间态标记，启动时标记失败而不误清数据", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rubbing-crash-"));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  const { initialData } = require("../lib/store");
  const db = initialData();
  db.archives.push({
    id: "archive_stuck",
    archiveNo: "ARC-STUCK-1",
    projectId: "project_x",
    status: "cleaning",
    items: [],
    counts: {},
    manifestHash: "x",
    packageFile: "archives/ARC-STUCK-1.json"
  });
  await fs.mkdir(path.join(dir, "archives"), { recursive: true });
  await fs.writeFile(path.join(dir, "db.json"), JSON.stringify(db, null, 2));
  await fs.writeFile(path.join(dir, "archives", "ARC-STUCK-1.json"), "{}");

  const app = createApp({ dataDir: dir });
  await app.start(0);
  t.after(async () => {
    await new Promise((resolve) => app.server.close(() => resolve()));
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const archive = await api(base, "GET", "/archives/ARC-STUCK-1");
  assert.equal(archive.body.data.status, "failed");
  const log = await api(base, "GET", "/recovery-log");
  assert.ok(log.body.data.some((n) => n.action === "archive.failed"));
  // 演示数据完好无损
  const rubbings = await api(base, "GET", "/rubbings");
  assert.equal(rubbings.body.data.length, 1);
});
