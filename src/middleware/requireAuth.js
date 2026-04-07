const db = require("../db");
const pool = db.pool || db;

module.exports = async function requireAuth(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    const m = h.match(/^Bearer\s+(.+)$/i);

    if (!m) {
      return res.status(401).json({
        success: false,
        error: { code: "UNAUTHORIZED", message: "Missing Authorization Bearer token" },
      });
    }

    const token = String(m[1]).trim();

    // Expected: DEV-TOKEN-E1001 (per routes/auth.js)
    const mm = token.match(/^DEV-TOKEN-(.+)$/i);
    if (!mm) {
      return res.status(401).json({
        success: false,
        error: { code: "UNAUTHORIZED", message: "Invalid token format" },
      });
    }

    const employee_id = String(mm[1]).trim();
    if (!employee_id) {
      return res.status(401).json({
        success: false,
        error: { code: "UNAUTHORIZED", message: "Invalid employee_id in token" },
      });
    }

    // Load employee profile (same table used in auth.js)
    const q = await pool.query(
      `SELECT employee_id, full_name, role, is_supervisor, status
      FROM employees
      WHERE employee_id = $1`,
      [employee_id]
    );

    if (q.rowCount === 0) {
      return res.status(401).json({
        success: false,
        error: { code: "UNAUTHORIZED", message: "Employee not found" },
      });
    }

    req.user = q.rows[0];
    return next();
  } catch (e) {
    console.error("[AUTH] requireAuth error:", e);
    return res.status(401).json({
      success: false,
      error: { code: "UNAUTHORIZED", message: "Unauthorized" },
    });
  }
};
