const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { createApp } = require("../lib/app");

async function api(base, method, p, body) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // 非 JSON 响应
  }
  return { status: res.status, body: json };
}

async function makeServer(t, opts = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rubbing-test-"));
  // 测试默认从空库开始，不带演示数据；需要旧数据形态的测试自行写 db.json
  if (opts.emptyDb !== false) {
    await fs.writeFile(path.join(dir, "db.json"), JSON.stringify({ rubbings: [], damages: [], batches: [] }, null, 2));
  }
  const app = createApp({ dataDir: dir, faultAt: opts.faultAt });
  await app.start(0);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => app.server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { app, dir, base };
}

// 造一条完整的业务链：项目 → 到期拓片 → 缺损 → 批次完成 → 质检通过
async function seedFull(base, { retentionYears = 2, createdAt = "2020-01-01T00:00:00.000Z", code = "TP-测-001" } = {}) {
  const project = (await api(base, "POST", "/projects", { name: `项目-${code}`, retentionYears })).body.data;
  const rubbing = (
    await api(base, "POST", "/rubbings", { code, source: "碑林残页", paperSize: "40x60cm", projectId: project.id, createdAt })
  ).body.data;
  const damage = (
    await api(base, "POST", `/rubbings/${rubbing.id}/damages`, { position: "左上角", type: "虫蛀孔", beforePhotoUrl: "https://example.local/b1.jpg" })
  ).body.data;
  const batch = (await api(base, "POST", "/batches", { name: "批次一", damageIds: [damage.id] })).body.data;
  await api(base, "POST", `/batches/${batch.id}/complete`, { results: [{ damageId: damage.id, afterPhotoUrl: "https://example.local/a1.jpg", repairNote: "补纸托裱" }] });
  const inspection = (await api(base, "POST", `/damages/${damage.id}/inspections`, { inspector: "王师傅", result: "pass", note: "修补平整" })).body.data;
  return { project, rubbing, damage, batch, inspection };
}

async function readDbFile(dir) {
  return JSON.parse(await fs.readFile(path.join(dir, "db.json"), "utf8"));
}

module.exports = { api, makeServer, seedFull, readDbFile };
