// 冒烟脚本：在临时 DATA_DIR 中跑通 归档→校验→拦截→两步清理→凭据→回迁 全流程
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { createApp } = require("../lib/app");

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rubbing-smoke-"));
  const app = createApp({ dataDir: dir });
  await app.start(0);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const show = (label, value) => console.log(`${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);

  const project = (await api("POST", "/projects", { name: "清代拓片", retentionYears: 2 })).body.data;
  const rubbing = (
    await api("POST", "/rubbings", { code: "TP-001", source: "碑林", paperSize: "40x60", projectId: project.id, createdAt: "2020-01-01T00:00:00.000Z" })
  ).body.data;
  const damage = (await api("POST", `/rubbings/${rubbing.id}/damages`, { position: "左上", type: "虫蛀孔", beforePhotoUrl: "u" })).body.data;
  const batch = (await api("POST", "/batches", { name: "批一", damageIds: [damage.id] })).body.data;
  await api("POST", `/batches/${batch.id}/complete`, {});
  await api("POST", `/damages/${damage.id}/inspections`, { inspector: "王", result: "pass" });

  const sealed = await api("POST", "/archives", { projectId: project.id, archiveNo: "ARC-SMOKE-1", operator: "冒烟" });
  show("归档", `${sealed.status} ${sealed.body.data.status} ${JSON.stringify(sealed.body.data.counts)}`);
  show("包校验", (await api("POST", "/archives/ARC-SMOKE-1/verify", {})).body.data.ok);
  show("封存后写入", (await api("PATCH", `/damages/${damage.id}`, { repairNote: "x" })).status);

  const step1 = (await api("POST", "/archives/ARC-SMOKE-1/cleanup", {})).body.data;
  const confirmed = await api("POST", "/archives/ARC-SMOKE-1/cleanup/confirm", { token: step1.cleanupToken });
  show("清理", `${confirmed.body.data.archive.status} receipt=${confirmed.body.data.receipt.hash.slice(0, 16)}…`);

  const list = await api("GET", "/rubbings");
  const stub = list.body.data.find((r) => r.id === rubbing.id);
  show("热库摘要", { _summary: stub._summary, archiveNo: stub.archiveNo, counts: stub.counts });

  const receiptId = confirmed.body.data.receipt.id;
  show("凭据核验", (await api("GET", `/cleanup-receipts/${receiptId}/verify`)).body.data.ok);

  const restored = await api("POST", "/archives/ARC-SMOKE-1/restore", {});
  show("回迁", restored.body.data.archive.status);
  const damages = await api("GET", `/rubbings/${rubbing.id}/damages`);
  show("回迁后缺损", `${damages.body.data.length} 条, status=${damages.body.data[0].status}`);

  await new Promise((r) => app.server.close(r));
  await fs.rm(dir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
