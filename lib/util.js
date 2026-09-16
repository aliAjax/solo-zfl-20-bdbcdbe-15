function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function httpError(status, message, extra) {
  const error = new Error(message);
  error.status = status;
  if (extra) error.extra = extra;
  return error;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) throw httpError(400, `缺少字段：${missing.join(", ")}`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = { makeId, httpError, required, clone };
