const crypto = require("crypto");

// 稳定的 JSON 序列化（键排序），保证同一记录任何时候算出的校验值一致
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(canonical(value)).digest("hex");
}

module.exports = { canonical, sha256 };
