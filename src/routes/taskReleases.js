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
    if (role === "ADMIN" || role === "SUPERVISOR") {
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
    } else if (role === "ADMIN" || role === "SUPERVISOR") {
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
      ORDER BY tr.released_at DESC
      `,
      params
    );

    const rows = result.rows.map((r) => {
      const current = Number(r.current_workers || 0);
      const min = Number(r.min_workers || 0);
      const max =
        r.max_workers === null || r.max_workers === undefined
          ? null
          : Number(r.max_workers);

      const availableSlots =
        max === null || Number.isNaN(max) ? null : Math.max(max - current, 0);

      return {
        ...r,
        current_workers: current,
        min_workers: min,
        max_workers: max,
        available_slots: availableSlots,
        capacity_status: capacityStatus(current, min, max),
      };
    });

    return res.json({
      success: true,
      data: rows,
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

    const actor = await pool.query(
      `
      SELECT employee_id, role
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
          message: "Only SE and PM can close task releases",
        },
      });
    }

    const rel = await pool.query(
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
      WHERE tr.release_id = $1
      LIMIT 1
      `,
      [release_id]
    );

    if (rel.rowCount === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: "RELEASE_NOT_FOUND",
          message: "Release not found",
        },
      });
    }

    const release = rel.rows[0];

    if (String(release.release_status || "").toUpperCase() !== "ACTIVE") {
      return res.status(409).json({
        success: false,
        error: {
          code: "RELEASE_NOT_ACTIVE",
          message: "Only ACTIVE releases can be closed",
        },
        data: release,
      });
    }

    const open = await pool.query(
      `
      SELECT
        e.supervisor_employee_id,
        sup.full_name AS supervisor_name,
        COUNT(DISTINCT ts.employee_id)::int AS open_workers_count,
        json_agg(
          DISTINCT jsonb_build_object(
            'employee_id', ts.employee_id,
            'full_name', e.full_name
          )
        ) FILTER (WHERE ts.employee_id IS NOT NULL) AS workers
      FROM task_session ts
      LEFT JOIN employees e
        ON e.employee_id = ts.employee_id
      LEFT JOIN employees sup
        ON sup.employee_id = e.supervisor_employee_id
      WHERE ts.project_id = $1
        AND ts.task_id = $2
        AND ts.status = 'OPEN'
      GROUP BY e.supervisor_employee_id, sup.full_name
      ORDER BY e.supervisor_employee_id
      `,
      [release.project_id, release.task_id]
    );

    if (open.rowCount > 0) {
      return res.status(409).json({
        success: false,
        error: {
          code: "OPEN_TASKS_EXIST",
          message: "Cannot close release because workers still have open task sessions",
        },
        data: {
          release_id: release.release_id,
          project_id: release.project_id,
          task_id: release.task_id,
          supervisor_employee_id: release.supervisor_employee_id,
          supervisor_name: release.supervisor_name,
          blockers: open.rows.map((r) => ({
            supervisor_employee_id: r.supervisor_employee_id,
            supervisor_name: r.supervisor_name,
            open_workers_count: r.open_workers_count,
            workers: Array.isArray(r.workers) ? r.workers : [],
          })),
        },
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