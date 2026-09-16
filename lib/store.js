const fs = require("fs/promises");
const path = require("path");
const { makeId } = require("./util");

// 旧版 db.json 只有前三个键，迁移时补齐其余键，旧记录本身不改动
const DB_ARRAY_KEYS = [
  "rubbings",
  "damages",
  "batches",
  "projects",
  "inspections",
  "archives",
  "cleanupReceipts",
  "blockedRecords",
  "holds",
  "recoveryLog"
];

function initialData() {
  return {
    rubbings: [
      {
        id: "rubbing_demo",
        code: "TP-清-014",
        source: "地方碑刻残页",
        paperSize: "42x68cm",
        note: "边缘有旧折痕",
        projectId: null,
        createdAt: new Date().toISOString()
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
        createdAt: new Date().toISOString(),
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
        createdAt: new Date().toISOString(),
        repairedAt: null
      }
    ],
    batches: [],
    projects: [],
    inspections: [],
    archives: [],
    cleanupReceipts: [],
    blockedRecords: [],
    holds: [],
    recoveryLog: []
  };
}

function createStore(options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || path.join(__dirname, "..", "data");
  const dbFile = path.join(dataDir, "db.json");
  const archiveDir = path.join(dataDir, "archives");
  const receiptDir = path.join(dataDir, "receipts");
  const quarantineDir = path.join(dataDir, "quarantine");
  // 测试专用的故障注入点，正常运行为 null
  const faultAt = options.faultAt || null;
  let tmpCounter = 0;
  let queue = Promise.resolve();

  function fault(point) {
    if (faultAt) faultAt(point);
  }

  async function ensureDirs() {
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.mkdir(receiptDir, { recursive: true });
    await fs.mkdir(quarantineDir, { recursive: true });
  }

  function migrate(db) {
    for (const key of DB_ARRAY_KEYS) {
      if (!Array.isArray(db[key])) db[key] = [];
    }
    return db;
  }

  async function readDb() {
    await ensureDirs();
    let db;
    try {
      db = JSON.parse(await fs.readFile(dbFile, "utf8"));
    } catch {
      db = initialData();
      await writeDb(db);
    }
    return migrate(db);
  }

  // 先写临时文件再 rename，保证任何时刻 db.json / 归档包要么完整要么不存在
  async function writeFileAtomic(absFile, content) {
    const tmp = `${absFile}.tmp-${process.pid}-${tmpCounter++}`;
    const fh = await fs.open(tmp, "w");
    try {
      await fh.writeFile(content);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, absFile);
  }

  async function writeDb(db) {
    await writeFileAtomic(dbFile, JSON.stringify(db, null, 2));
  }

  async function writeDataFile(relPath, content, { readonly = false } = {}) {
    const abs = path.join(dataDir, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await writeFileAtomic(abs, content);
    if (readonly) await fs.chmod(abs, 0o444);
  }

  async function readDataFile(relPath) {
    return fs.readFile(path.join(dataDir, relPath), "utf8");
  }

  // 进程内互斥锁：所有写操作串行化，归档与写入不会交错执行
  function withLock(fn) {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  }

  async function listDir(abs) {
    try {
      return await fs.readdir(abs);
    } catch {
      return [];
    }
  }

  async function quarantine(absFile, prefix) {
    const target = path.join(quarantineDir, `${prefix}-${Date.now()}-${path.basename(absFile)}`);
    await fs.rename(absFile, target);
    return path.relative(dataDir, target);
  }

  // 启动恢复：多步操作每一步落盘都是原子的，崩溃只会留下"孤儿文件"或"中间态标记"，
  // 这里把残留隔离到 quarantine/ 并登记 recoveryLog，热库数据保持自洽，可安全重试。
  async function recover() {
    await ensureDirs();
    const notes = [];
    const note = (action, detail) => notes.push({ id: makeId("recovery"), at: new Date().toISOString(), action, detail });
    const db = await readDb();

    // 防御：正常流程不会持久化中间态，若出现说明崩溃发生在状态切换写库途中
    for (const archive of db.archives) {
      if (["sealing", "cleaning", "restoring"].includes(archive.status)) {
        note("archive.failed", `${archive.archiveNo} 崩溃残留状态 ${archive.status}，已标记失败，热库数据未改动`);
        archive.status = "failed";
        archive.failedReason = "崩溃残留中间态，恢复时标记失败";
      }
    }

    // 孤儿归档包：包文件已写但 db 记录未提交（或反过来缺失文件），一律隔离不采用
    const knownPackages = new Set(db.archives.map((a) => a.packageFile));
    for (const name of await listDir(archiveDir)) {
      const abs = path.join(archiveDir, name);
      if (name.includes(".tmp-")) {
        await fs.rm(abs, { force: true });
        note("tmp.removed", `archives/${name}`);
        continue;
      }
      if (!knownPackages.has(`archives/${name}`)) {
        const to = await quarantine(abs, "package");
        note("package.quarantined", `archives/${name} → ${to}（提交前崩溃的残留，热库数据未受影响）`);
      }
    }

    // 孤儿清理凭据：凭据文件已写但 db 未提交，清理未生效，隔离后可重新确认
    const knownReceipts = new Set(db.cleanupReceipts.map((r) => r.receiptFile));
    for (const name of await listDir(receiptDir)) {
      const abs = path.join(receiptDir, name);
      if (name.includes(".tmp-")) {
        await fs.rm(abs, { force: true });
        note("tmp.removed", `receipts/${name}`);
        continue;
      }
      if (!knownReceipts.has(`receipts/${name}`)) {
        const to = await quarantine(abs, "receipt");
        note("receipt.quarantined", `receipts/${name} → ${to}（清理提交前崩溃的残留，可重新确认清理）`);
      }
    }

    for (const name of await listDir(dataDir)) {
      if (name.startsWith("db.json.tmp-")) {
        await fs.rm(path.join(dataDir, name), { force: true });
        note("tmp.removed", name);
      }
    }

    if (notes.length) {
      db.recoveryLog.push(...notes);
      if (db.recoveryLog.length > 200) db.recoveryLog.splice(0, db.recoveryLog.length - 200);
      await writeDb(db);
    }
    return notes;
  }

  return {
    dataDir,
    dbFile,
    paths: { archiveDir, receiptDir, quarantineDir },
    fault,
    ensureDirs,
    readDb,
    writeDb,
    writeDataFile,
    readDataFile,
    withLock,
    recover
  };
}

module.exports = { createStore, initialData };
