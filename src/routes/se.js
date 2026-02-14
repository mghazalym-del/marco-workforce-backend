// backend/src/routes/se.js
// SE endpoints (role-based supervisor scoping)

const express = require("express");
const router = express.Router();
const requireAuth = require("../middleware/requireAuth");
const db = require("../db");

// ---- DB helper (works with db exports: Pool, {pool}, {query}) ----
function getPool() {
  if (db && typeof db.query === "function") return db;
  if (db && db.pool && typeof db.pool.query === "function") return db.pool;
  if (db && db.default && typeof db.default.query === "function") return db.default;
  throw new Error("DB pool not found: ../db must export a pg Pool or { pool }");
}

// ---- Auth helper (fallback if requireAuth doesn't set req.user) ----
function employeeIdFromAuth(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || "";
  const m = String(h).match(/DEV-TOKEN-([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

// GET /api/v1/se/supervisors
// Returns supervisors that report to this SE (employees.supervisor_employee_id = SE employee_id)
router.get("/supervisors", requireAuth, async (req, res) => {
  try {
    const seId = req.user?.employee_id || employeeIdFromAuth(req);
    if (!seId) {
      return res.status(401).json({
        success: false,
        error: { code: "UNAUTHORIZED", message: "Missing Authorization Bearer token" },
      });
    }

    const pool = getPool();

    // Verify caller role = SE (or ADMIN/PM if you want to allow later)
    const me = await pool.query(
      `SELECT employee_id, role FROM employees WHERE employee_id = $1`,
      [seId]
    );
    if (me.rowCount === 0) {
      return res.status(401).json({
        success: false,
        error: { code: "UNAUTHORIZED", message: "Employee not found" },
      });
    }

    const myRole = String(me.rows[0].role || "").toUpperCase();
    if (myRole !== "SE" && myRole !== "ADMIN" && myRole !== "PM") {
      return res.status(403).json({
        success: false,
        error: { code: "FORBIDDEN", message: "Forbidden" },
      });
    }

    // Supervisors under this SE
    // (in your data, supervisors are role ADMIN but we also allow SUPERVISOR)
    const q = await pool.query(
      `SELECT employee_id, full_name, role, supervisor_employee_id
         FROM employees
        WHERE supervisor_employee_id = $1
          AND UPPER(role) IN ('ADMIN','SUPERVISOR')
        ORDER BY employee_id`,
      [seId]
    );

    return res.json({
      success: true,
      data: { se_employee_id: seId, supervisors: q.rows },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      success: false,
      error: { code: "SERVER_ERROR", message: "Unexpected error" },
    });
  }
});

module.exports = router;
