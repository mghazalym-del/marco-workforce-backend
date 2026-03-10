const express = require("express");
const router = express.Router();

const { pool } = require("../db");
const requireAuth = require("../middleware/requireAuth");

function employeeIdFromAuth(req) {
  const direct =
    req.employee_id ||
    req.employeeId ||
    (req.user && (req.user.employee_id || req.user.employeeId)) ||
    (req.auth && (req.auth.employee_id || req.auth.employeeId)) ||
    (req.claims && (req.claims.employee_id || req.claims.employeeId));

  if (direct) return String(direct);

  const h = req.headers.authorization || "";
  const m = h.match(/Bearer\s+DEV-TOKEN-([A-Za-z0-9_-]+)/i);
  if (m && m[1]) return String(m[1]);

  return null;
}

function toNullableInt(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

function capacityStatus(currentWorkers, minWorkers, maxWorkers) {
  const current = Number(currentWorkers || 0);
  const min = Number(minWorkers || 0);
  const max = maxWorkers === null || maxWorkers === undefined ? null : Number(maxWorkers);

  if (max !== null && current > max) return "OVER_CAPACITY";
  if (max !== null && current === max) return "FULL";
  if (current < min) return "UNDER_MIN";
  return "NORMAL";
}

// Create release (SE / PM)
router.post("/", requireAuth, async (req, res) => {
  const employeeId = employeeIdFromAuth(req);

  try {
    const {
      project_id,
      task_id,
      supervisor_employee_id,
      min_workers,
      max_workers,
    } = req.body || {};

    if (!employeeId) {
      return res.status(401).json({
        success: false,
        error: { code: "UNAUTHORIZED", message: "Unauthorized" },
      });
    }

    if (!project_id || !task_id || !supervisor_employee_id) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_FIELDS",
          message: "project_id, task_id, and supervisor_employee_id are required",
        },
      });
    }

    const capacityMin = toNullableInt(min_workers) ?? 0;
    const capacityMax = toNullableInt(max_workers);

    if (capacityMin < 0) {
      return res.status(400).json({
        success: false,
        error: { code: "INVALID_MIN", message: "min_workers cannot be negative" },
      });
    }

    if (capacityMax !== null && capacityMax < 1) {
      return res.status(400).json({
        success: false,
        error: { code: "INVALID_MAX", message: "max_workers must be >= 1" },
      });
    }

    if (capacityMax !== null && capacityMax < capacityMin) {
      return res.status(400).json({
        success: false,
        error: {
          code: "INVALID_CAPACITY",
          message: "max_workers must be greater than or equal to min_workers",
        },
      });
    }

    const actor = await pool.query(
      `
      SELECT employee_id, role, full_name
      FROM employees
      WHERE employee_id = $1
      LIMIT 1
      `,
      [employeeId]
    );

    if (actor.rowCount === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: "EMPLOYEE_NOT_FOUND",
          message: "Employee not found",
        },
      });
    }

    const role = String(actor.rows[0].role || "").toUpperCase();
    if (!["SE", "PM"].includes(role)) {
      return res.status(403).json({
        success: false,
        error: {
          code: "ROLE_NOT_ALLOWED",
          message: "Only SE and PM can create task releases",
        },
      });
    }

    const sup = await pool.query(
      `
      SELECT employee_id, role, full_name
      FROM employees
      WHERE employee_id = $1
      LIMIT 1
      `,
      [supervisor_employee_id]
    );

    if (sup.rowCount === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: "SUPERVISOR_NOT_FOUND",
          message: "Supervisor not found",
        },
      });
    }

    // Prevent duplicate ACTIVE release for same project/task/supervisor
    const existing = await pool.query(
      `
      SELECT
        tr.release_id,
        tr.project_id,
        tr.task_id,
        tr.se_employee_id,
        se.full_name AS se_name,
        tr.supervisor_employee_id,
        sup.full_name AS supervisor_name,
        tr.release_status,
        tr.released_at,
        tr.released_by,
        tr.min_workers,
        tr.max_workers
      FROM task_releases tr
      LEFT JOIN employees sup
        ON sup.employee_id = tr.supervisor_employee_id
      LEFT JOIN employees se
        ON se.employee_id = tr.se_employee_id
      WHERE tr.project_id = $1
        AND tr.task_id = $2
        AND tr.supervisor_employee_id = $3
        AND tr.release_status = 'ACTIVE'
      ORDER BY tr.released_at DESC
      LIMIT 1
      `,
      [project_id, task_id, supervisor_employee_id]
    );

    if (existing.rowCount > 0) {
      return res.status(409).json({
        success: false,
        error: {
          code: "ACTIVE_RELEASE_EXISTS",
          message: "Active release already exists for this supervisor on this task. Close it first.",
        },
        data: existing.rows[0],
      });
    }

    const result = await pool.query(
      `
      INSERT INTO task_releases
      (
        project_id,
        task_id,
        se_employee_id,
        supervisor_employee_id,
        release_status,
        released_by,
        min_workers,
        max_workers
      )
      VALUES ($1, $2, $3, $4, 'ACTIVE', $3, $5, $6)
      RETURNING
        release_id,
        project_id,
        task_id,
        se_employee_id,
        supervisor_employee_id,
        release_status,
        released_at,
        released_by,
        min_workers,
        max_workers
      `,
      [project_id, task_id, employeeId, supervisor_employee_id, capacityMin, capacityMax]
    );

    return res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (e) {
    console.error("[task-releases][POST /] error:", e);
    return res.status(500).json({
      success: false,
      error: { message: "Release failed" },
    });
  }
});

// List my releases
router.get("/my", requireAuth, async (req, res) => {
  const employeeId = employeeIdFromAuth(req);

  try {
    if (!employeeId) {
      return res.status(401).json({
        success: false,
        error: { code: "UNAUTHORIZED", message: "Unauthorized" },
      });
    }

    const emp = await pool.query(
      `
      SELECT employee_id, role
      FROM employees
      WHERE employee_id = $1
      LIMIT 1
      `,
      [employeeId]
    );

    if (emp.rowCount === 0) {
      return res.status(404).json({
        success: false,
        error: { code: "EMPLOYEE_NOT_FOUND", message: "Employee not found" },
      });
    }

    const role = String(emp.rows[0].role || "").toUpperCase();

    let result;
    if (role === "ADMIN") {
      result = await pool.query(
        `
        SELECT
          tr.release_id,
          tr.project_id,
          tr.task_id,
          tr.se_employee_id,
          se.full_name AS se_name,
          tr.supervisor_employee_id,
          sup.full_name AS supervisor_name,
          tr.release_status,
          tr.released_at,
          tr.released_by,
          tr.min_workers,
          tr.max_workers
        FROM task_releases tr
        LEFT JOIN employees sup
          ON sup.employee_id = tr.supervisor_employee_id
        LEFT JOIN employees se
          ON se.employee_id = tr.se_employee_id
        WHERE tr.supervisor_employee_id = $1
          AND tr.release_status = 'ACTIVE'
        ORDER BY tr.released_at DESC
        `,
        [employeeId]
      );
    } else if (role === "SE") {
      result = await pool.query(
        `
        SELECT
          tr.release_id,
          tr.project_id,
          tr.task_id,
          tr.se_employee_id,
          se.full_name AS se_name,
          tr.supervisor_employee_id,
          sup.full_name AS supervisor_name,
          tr.release_status,
          tr.released_at,
          tr.released_by,
          tr.min_workers,
          tr.max_workers
        FROM task_releases tr
        LEFT JOIN employees sup
          ON sup.employee_id = tr.supervisor_employee_id
        LEFT JOIN employees se
          ON se.employee_id = tr.se_employee_id
        WHERE tr.se_employee_id = $1
        ORDER BY tr.released_at DESC
        `,
        [employeeId]
      );
    } else if (role === "PM") {
      result = await pool.query(
        `
        SELECT
          tr.release_id,
          tr.project_id,
          tr.task_id,
          tr.se_employee_id,
          se.full_name AS se_name,
          tr.supervisor_employee_id,
          sup.full_name AS supervisor_name,
          tr.release_status,
          tr.released_at,
          tr.released_by,
          tr.min_workers,
          tr.max_workers
        FROM task_releases tr
        LEFT JOIN employees sup
          ON sup.employee_id = tr.supervisor_employee_id
        LEFT JOIN employees se
          ON se.employee_id = tr.se_employee_id
        ORDER BY tr.released_at DESC
        `
      );
    } else {
      return res.status(403).json({
        success: false,
        error: {
          code: "ROLE_NOT_ALLOWED",
          message: "Only Supervisor, SE and PM can view task releases",
        },
      });
    }

    return res.json({
      success: true,
      data: result.rows,
    });
  } catch (e) {
    console.error("[task-releases][GET /my] error:", e);
    return res.status(500).json({
      success: false,
      error: { message: "Failed to load task releases" },
    });
  }
});

// List releases for a specific task
router.get("/by-task", requireAuth, async (req, res) => {
  const employeeId = employeeIdFromAuth(req);

  try {
    if (!employeeId) {
      return res.status(401).json({
        success: false,
        error: { code: "UNAUTHORIZED", message: "Unauthorized" },
      });
    }

    const { project_id, task_id } = req.query;

    if (!project_id || !task_id) {
      return res.status(400).json({
        success: false,
        error: {
          code: "MISSING_FIELDS",
          message: "project_id and task_id are required",
        },
      });
    }

    const result = await pool.query(
      `
      SELECT
        tr.release_id,
        tr.project_id,
        tr.task_id,
        tr.se_employee_id,
        se.full_name AS se_name,
        tr.supervisor_employee_id,
        sup.full_name AS supervisor_name,
        tr.release_status,
        tr.released_at,
        tr.released_by,
        tr.min_workers,
        tr.max_workers
      FROM task_releases tr
      LEFT JOIN employees sup
        ON sup.employee_id = tr.supervisor_employee_id
      LEFT JOIN employees se
        ON se.employee_id = tr.se_employee_id
      WHERE tr.project_id = $1
        AND tr.task_id = $2
      ORDER BY tr.released_at DESC
      `,
      [project_id, task_id]
    );

    return res.json({
      success: true,
      data: result.rows,
    });
  } catch (e) {
    console.error("[task-releases][GET /by-task] error:", e);
    return res.status(500).json({
      success: false,
      error: { message: "Failed to load task releases for task" },
    });
  }
});

// Capacity dashboard
router.get("/dashboard", requireAuth, async (req, res) => {
  const employeeId = employeeIdFromAuth(req);

  try {
    if (!employeeId) {
      return res.status(401).json({
        success: false,
        error: { code: "UNAUTHORIZED", message: "Unauthorized" },
      });
    }

    const emp = await pool.query(
      `
      SELECT employee_id, role
      FROM employees
      WHERE employee_id = $1
      LIMIT 1
      `,
      [employeeId]
    );

    if (emp.rowCount === 0) {
      return res.status(404).json({
        success: false,
        error: { code: "EMPLOYEE_NOT_FOUND", message: "Employee not found" },
      });
    }

    const role = String(emp.rows[0].role || "").toUpperCase();
    const workDate = String(req.query.work_date || new Date().toISOString().slice(0, 10));
    const projectId = req.query.project_id ? String(req.query.project_id) : null;

    const params = [workDate];
    const where = [`tr.release_status = 'ACTIVE'`];
    let paramIndex = 2;

    if (projectId) {
      where.push(`tr.project_id = $${paramIndex++}`);
      params.push(projectId);
    }

    if (role === "SE") {
      where.push(`tr.se_employee_id = $${paramIndex++}`);
      params.push(employeeId);
    } else if (role === "ADMIN") {
      where.push(`tr.supervisor_employee_id = $${paramIndex++}`);
      params.push(employeeId);
    } else if (role === "PM") {
      // PM sees all active releases
    } else {
      return res.status(403).json({
        success: false,
        error: {
          code: "ROLE_NOT_ALLOWED",
          message: "Only SE, PM and Supervisor can view capacity dashboard",
        },
      });
    }

    const result = await pool.query(
      `
      SELECT
        tr.release_id,
        tr.project_id,
        tr.task_id,
        tr.se_employee_id,
        se.full_name AS se_name,
        tr.supervisor_employee_id,
        sup.full_name AS supervisor_name,
        tr.release_status,
        tr.released_at,
        tr.released_by,
        tr.min_workers,
        tr.max_workers,
        COALESCE(ts.current_workers, 0) AS current_workers
      FROM task_releases tr
      LEFT JOIN employees sup
        ON sup.employee_id = tr.supervisor_employee_id
      LEFT JOIN employees se
        ON se.employee_id = tr.se_employee_id
      LEFT JOIN (
        SELECT
          project_id,
          task_id,
          COUNT(DISTINCT employee_id)::int AS current_workers
        FROM task_session
        WHERE work_date = $1
          AND status = 'OPEN'
        GROUP BY project_id, task_id
      ) ts
        ON ts.project_id = tr.project_id
       AND ts.task_id = tr.task_id
      WHERE ${where.join(" AND ")}
      ORDER BY tr.project_id, tr.task_id, tr.released_at DESC
      `,
      params
    );

    const data = result.rows.map((row) => {
      const current = Number(row.current_workers || 0);
      const min = Number(row.min_workers || 0);
      const max = row.max_workers === null ? null : Number(row.max_workers);
      return {
        ...row,
        current_workers: current,
        min_workers: min,
        max_workers: max,
        capacity_status: capacityStatus(current, min, max),
        available_slots: max === null ? null : Math.max(0, max - current),
      };
    });

    return res.json({
      success: true,
      data,
    });
  } catch (e) {
    console.error("[task-releases][GET /dashboard] error:", e);
    return res.status(500).json({
      success: false,
      error: { message: "Failed to load capacity dashboard" },
    });
  }
});

// Close release
router.patch("/:release_id/close", requireAuth, async (req, res) => {
  const employeeId = employeeIdFromAuth(req);

  try {
    const { release_id } = req.params;

    if (!employeeId) {
      return res.status(401).json({
        success: false,
        error: { code: "UNAUTHORIZED", message: "Unauthorized" },
      });
    }

    const result = await pool.query(
      `
      UPDATE task_releases
      SET release_status = 'CLOSED'
      WHERE release_id = $1
      RETURNING
        release_id,
        project_id,
        task_id,
        se_employee_id,
        supervisor_employee_id,
        release_status,
        released_at,
        released_by,
        min_workers,
        max_workers
      `,
      [release_id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: "RELEASE_NOT_FOUND",
          message: "Release not found",
        },
      });
    }

    return res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (e) {
    console.error("[task-releases][PATCH /:release_id/close] error:", e);
    return res.status(500).json({
      success: false,
      error: { message: "Close release failed" },
    });
  }
});

module.exports = router;