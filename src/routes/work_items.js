const express = require("express");
const router = express.Router();

const { pool } = require("../db");
const requireAuth = require("../middleware/requireAuth");

async function resolveRole(req) {
  const direct = String(req.user?.role || "").toUpperCase();
  if (direct) return direct;

  const employeeId = String(req.user?.employee_id || "").trim();
  if (!employeeId) return "";

  const q = await pool.query(`SELECT role FROM employees WHERE employee_id = $1`, [employeeId]);
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
      console.error("[WORK_ITEMS] role check failed:", e);
      return res.status(500).json({
        success: false,
        error: { code: "SERVER_ERROR", message: "Role check failed" },
      });
    }
  };
}

// GET /api/v1/projects/:project_code/tree
router.get(
  "/projects/:project_code/tree",
  requireAuth,
  requireAnyDb(["ADMIN", "PM", "SE"]),
  async (req, res) => {
    try {
      const projectCode = String(req.params.project_code || "").trim();

      const q = await pool.query(
        `SELECT
            work_item_id,
            project_code,
            parent_work_item_id,
            item_type,
            item_code,
            name,
            planned_start,
            planned_end,
            planned_duration_days,
            status,                       -- plan status (e.g. DRAFT)
            owner_employee_id,
            task_status,                  -- execution status (ACTIVE/INACTIVE/IN_PROGRESS/ASSIGNED/COMPLETED)
            activated_at,
            activated_by,
            assigned_to_employee_id,
            assigned_by,
            assigned_at
         FROM work_items
         WHERE project_code = $1
         ORDER BY
           CASE item_type
             WHEN 'MILESTONE' THEN 1
             WHEN 'TASK' THEN 2
             ELSE 3
           END,
           item_code`,
        [projectCode]
      );

      return res.json({
        success: true,
        data: { project_code: projectCode, items: q.rows },
      });
    } catch (e) {
      console.error("[WORK_ITEMS] tree:", e);
      return res.status(500).json({
        success: false,
        error: { code: "SERVER_ERROR", message: "Unexpected error" },
      });
    }
  }
);

module.exports = router;
