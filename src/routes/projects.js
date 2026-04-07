const express = require("express");
const router = express.Router();
const { pool } = require("../db");
const requireAuth = require("../middleware/requireAuth");

/**
 * Resolve role safely:
 * - Use req.user.role if present
 * - Otherwise load from DB using employee_id
 */
async function resolveRole(req) {
  const direct = String(req.user?.role || "").toUpperCase();
  if (direct) return direct;

  const employeeId = String(req.user?.employee_id || "").trim();
  if (!employeeId) return "";

  const q = await pool.query(
    `SELECT role FROM employees WHERE employee_id = $1`,
    [employeeId]
  );

  return String(q.rows[0]?.role || "").toUpperCase();
}

function requireAnyDb(roles) {
  return async (req, res, next) => {
    try {
      const role = await resolveRole(req);
      if (!roles.includes(role)) {
        return res.status(403).json({
          success: false,
          error: { code: "FORBIDDEN", message: "Insufficient role" },
        });
      }
      next();
    } catch (e) {
      console.error("[PROJECTS] role check failed:", e);
      return res.status(500).json({
        success: false,
        error: { code: "SERVER_ERROR", message: "Role check failed" },
      });
    }
  };
}

// GET /api/v1/projects
router.get(
  "/",
  requireAuth,
  requireAnyDb(["ADMIN", "PM", "SE", "COST_CONTROLLER"]),
  async (req, res) => {
    try {
      const q = await pool.query(
        `SELECT project_code, project_name, status, pm_employee_id, last_synced_at
         FROM projects
         WHERE project_code IS NOT NULL
         ORDER BY project_code`
      );
      return res.json({ success: true, data: { projects: q.rows } });
    } catch (e) {
      console.error("[PROJECTS] list:", e);
      return res.status(500).json({
        success: false,
        error: { code: "SERVER_ERROR", message: "Unexpected error" },
      });
    }
  }
);

module.exports = router;
