const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { createApp } = require("../lib/app");
const { api } = require("./helpers");

// 旧版 db.json：没有 projects/inspections/archives 等新键，拓片也没有 projectId
const legacyDb = {
  rubbings: [
    {
      id: "rubbing_demo",
      code: "TP-清-014",
      source: "地方碑刻残页",
      paperSize: "42x68cm",
      note: "边缘有旧折痕",
      createdAt: "2026-06-16T00:00:00.000Z"
    }
  ],
  damages: [
    {
      id: "damage_demo_1",
      rubbingId: "rubbing_demo",
      position: "左上角第3列题字旁",
      type: "虫蛀孔",
      beforePhotoUrl: "https://example.local/before-014-1.jpg",
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      createdAt: "2026-06-16T00:00:00.000Z",
      repairedAt: null
    },
    {
      id: "damage_demo_2",
      rubbingId: "rubbing_demo",
      position: "下边缘中央",
      type: "撕裂",
      beforePhotoUrl: "https://example.local/before-014-2.jpg",
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      createdAt: "2026-06-16T00:00:00.000Z",
      repairedAt: null
    }
  ],
  batches: []
};

async function makeLegacyServer(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rubbing-legacy-"));
  await fs.writeFile(path.join(dir, "db.json"), JSON.stringify(legacyDb, null, 2));
  const app = createApp({ dataDir: dir });
  await app.start(0);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => app.server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { app, dir, base };
}

test("旧数据文件照常加载，旧接口行为不变", async (t) => {
  const { base } = await makeLegacyServer(t);

  const health = await api(base, "GET", "/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.ok(health.body.routes.includes("GET /rubbings"));

  const rubbings = await api(base, "GET", "/rubbings");
  assert.equal(rubbings.status, 200);
  assert.equal(rubbings.body.data.length, 1);
  assert.equal(rubbings.body.data[0].code, "TP-清-014");
  assert.equal(rubbings.body.data[0].damageCount, 2);
  assert.equal(rubbings.body.data[0].pendingDamages, 2);

  const damages = await api(base, "GET", "/rubbings/rubbing_demo/damages");
  assert.equal(damages.status, 200);
  assert.equal(damages.body.data.length, 2);

  const filtered = await api(base, "GET", "/damages?status=pending&type=虫蛀孔");
  assert.equal(filtered.status, 200);
  assert.equal(filtered.body.data.length, 1);
  assert.equal(filtered.body.data[0].id, "damage_demo_1");

  const created = await api(base, "POST", "/rubbings", { code: "TP-清-015", source: "馆藏碑刻", paperSize: "50x70cm" });
  assert.equal(created.status, 201);
  assert.ok(created.body.data.id.startsWith("rubbing_"));

  const newDamage = await api(base, "POST", `/rubbings/${created.body.data.id}/damages`, {
    position: "右下角",
    type: "霉斑",
    beforePhotoUrl: "https://example.local/b-015.jpg"
  });
  assert.equal(newDamage.status, 201);
  assert.equal(newDamage.body.data.status, "pending");

  const patched = await api(base, "PATCH", "/damages/damage_demo_1", { status: "repaired", repairNote: "已补" });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.data.status, "repaired");
  assert.ok(patched.body.data.repairedAt);

  const batch = await api(base, "POST", "/batches", { name: "六月小批修补", damageIds: ["damage_demo_2"] });
  assert.equal(batch.status, 201);
  assert.equal(batch.body.data.total, 1);

  const completed = await api(base, "POST", `/batches/${batch.body.data.id}/complete`, { defaultRepairNote: "托裱完成" });
  assert.equal(completed.status, 200);
  assert.equal(completed.body.data.repaired, 1);

  const missing = await api(base, "GET", "/no-such-route");
  assert.equal(missing.status, 404);
});

test("旧数据自动迁移出新集合，新接口可用且旧记录不被改写", async (t) => {
  const { base, dir } = await makeLegacyServer(t);

  const projects = await api(base, "GET", "/projects");
  assert.equal(projects.status, 200);
  assert.deepEqual(projects.body.data, []);

  const recovery = await api(base, "GET", "/recovery-log");
  assert.equal(recovery.status, 200);
  assert.deepEqual(recovery.body.data, []);

  const created = await api(base, "POST", "/projects", { name: "清代拓片保管", retentionYears: 5 });
  assert.equal(created.status, 201);

  // 旧拓片没有 projectId，可正常认领进项目
  const assigned = await api(base, "PATCH", "/rubbings/rubbing_demo", { projectId: created.body.data.id });
  assert.equal(assigned.status, 200);
  assert.equal(assigned.body.data.projectId, created.body.data.id);

  const retention = await api(base, "GET", `/projects/${created.body.data.id}/retention`);
  assert.equal(retention.status, 200);
  assert.equal(retention.body.data.counts.total, 1);

  // 旧记录字段原样保留
  const db = JSON.parse(await fs.readFile(path.join(dir, "db.json"), "utf8"));
  const demo = db.rubbings.find((r) => r.id === "rubbing_demo");
  assert.equal(demo.code, "TP-清-014");
  assert.equal(demo.note, "边缘有旧折痕");
  assert.ok(Array.isArray(db.archives));
});
