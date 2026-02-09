function parseQr(qr) {
  if (!qr || typeof qr !== "string") return null;
  const parts = qr.split("|").map((s) => s.trim());
  if (parts.length !== 2) return null;

  const [project_id, task_id] = parts;
  if (!project_id || !task_id) return null;

  return { project_id, task_id };
}

module.exports = { parseQr };
