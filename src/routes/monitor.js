/**
 * MARCO Workforce - monitor.js (READ-ONLY)
 *
 * Desktop Phase 1 APIs:
 * - Worker Day View: work_day + assignment_scan + task_session(s)
 * - Dashboard summary
 * - Project/task activity
 * - Supervisors + supervisor day summaries
 *
 * Safety:
 * - GET only
 * - No writes
 * - Uses existing requireAuth
 */

const express = require("express");
const router = express.Router();

const { pool } = require("../db");
const requireAuth = require("../middleware/requireAuth");

// ---------- helpers ----------
function parseISODate(s) {
  if (!s || typeof s !== "string") return null;
  // Expect YYYY-MM-DD
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return s;
}

function asInt(s, defVal) {
  const n = Number.parseInt(String(s ?? ""), 10);
  return Number.isFinite(n) ? n : defVal;
}

async function queryOne(text, params) {
  const r = await pool.query(text, params);
  return r.rows[0] || null;
}

async function queryMany(text, params) {
  const r = await pool.query(text, params);
  return r.rows || [];
}

/**
 * Your DB has both task_session and task_sessions.
 * We’ll try task_session first (it’s used in scans.js), then fallback to task_sessions.
 */
async function getSessions(employeeId, workDate) {
  const q1 = `
    SELECT session_id, employee_id, work_date, project_id, task_id,
           start_ts, end_ts, duration_minutes, is_offline, status, approval_id, created_at
      FROM task_session
     WHERE employee_id=$1 AND work_date=$2
     ORDER BY start_ts ASC
  `;
  try {
    return await queryMany(q1, [employeeId, workDate]);
  } catch (e) {
    const q2 = `
      SELECT session_id, employee_id, work_date, project_id, task_id,
             start_ts, end_ts, duration_minutes, is_offline, status, approval_id, created_at
        FROM task_sessions
       WHERE employee_id=$1 AND work_date=$2
       ORDER BY start_ts ASC
    `;
    return await queryMany(q2, [employeeId, workDate]);
  }
}

// ---------- routes ----------

/**
 * GET /api/v1/monitor/worker/:employee_id/day?work_date=YYYY-MM-DD
 * Returns: work_day header + scans + sessions
 */
router.get("/worker/:employee_id/day", requireAuth, async (req, res) => {
  try {
    const employeeId = String(req.params.employee_id || "").trim();
    const workDate = parseISODate(req.query.work_date);

    if (!employeeId) {
      return res.status(400).json({
        success: false,
        error: { code: "BAD_REQUEST", message: "employee_id is required" },
      });
    }
    if (!workDate) {
      return res.status(400).json({
        success: false,
        error: { code: "BAD_REQUEST", message: "work_date must be YYYY-MM-DD" },
      });
    }

    const workDay = await queryOne(
      `
      SELECT employee_id, work_date, day_status, closed_at, closed_by, reopened_at, reopened_by
        FROM work_day
       WHERE employee_id=$1 AND work_date=$2
      `,
      [employeeId, workDate]
    );

    const scans = await queryMany(
      `
      SELECT scan_id, assignment_day_id, employee_id, work_date, project_id, task_id,
             scan_timestamp_device, scan_timestamp_server, supervisor_employee_id,
             gps_lat, gps_lon, is_offline, scan_status, rejection_reason, client_reference_id,
             created_at, updated_at
        FROM assignment_scan
       WHERE employee_id=$1 AND work_date=$2
       ORDER BY scan_timestamp_server ASC
      `,
      [employeeId, workDate]
    );

    const sessions = await getSessions(employeeId, workDate);

    // lightweight summary
    const totalAcceptedScans = scans.filter((s) => s.scan_status === "Accepted").length;
    const totalRejectedScans = scans.length - totalAcceptedScans;
    const totalMinutes = sessions.reduce((sum, s) => sum + (s.duration_minutes || 0), 0);

    return res.json({
      success: true,
      data: {
        work_day: workDay, // can be null if not created yet
        scans,
        sessions,
        summary: {
          accepted_scans: totalAcceptedScans,
          rejected_scans: totalRejectedScans,
          total_minutes: totalMinutes,
        },
      },
    });
  } catch (e) {
    console.error("[MONITOR] worker day error:", e);
    return res.status(500).json({
      success: false,
      error: { code: "INTERNAL_ERROR", message: e.message || "Internal error" },
    });
  }
});

/**
 * GET /api/v1/monitor/workers?status=Active
 * Simple read-only directory (useful for desktop search/filter)
 */
router.get("/workers", requireAuth, async (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status) : null;

    const rows = await queryMany(
      `
      SELECT employee_id, full_name, status, is_supervisor, supervisor_employee_id
        FROM employees
       WHERE ($1::text IS NULL OR status = $1)
       ORDER BY employee_id
      `,
      [status]
    );

    return res.json({ success: true, data: { workers: rows } });
  } catch (e) {
    console.error("[MONITOR] workers error:", e);
    return res.status(500).json({
      success: false,
      error: { code: "INTERNAL_ERROR", message: e.message || "Internal error" },
    });
  }
});

/**
 * GET /api/v1/monitor/dashboard?work_date=YYYY-MM-DD
 * Aggregates counts for a single date
 */
router.get("/dashboard", requireAuth, async (req, res) => {
  try {
    const workDate = parseISODate(req.query.work_date);
    if (!workDate) {
      return res.status(400).json({
        success: false,
        error: { code: "BAD_REQUEST", message: "work_date must be YYYY-MM-DD" },
      });
    }

    const dayCounts = await queryOne(
      `
      SELECT
        SUM(CASE WHEN day_status='OPEN' THEN 1 ELSE 0 END)::int AS open_days,
        SUM(CASE WHEN day_status='CLOSED' THEN 1 ELSE 0 END)::int AS closed_days
      FROM work_day
      WHERE work_date=$1
      `,
      [workDate]
    );

    const scanCounts = await queryOne(
      `
      SELECT
        COUNT(*)::int AS total_scans,
        SUM(CASE WHEN scan_status='Accepted' THEN 1 ELSE 0 END)::int AS accepted_scans,
        SUM(CASE WHEN scan_status<>'Accepted' THEN 1 ELSE 0 END)::int AS rejected_scans,
        SUM(CASE WHEN is_offline THEN 1 ELSE 0 END)::int AS offline_scans
      FROM assignment_scan
      WHERE work_date=$1
      `,
      [workDate]
    );

    const topTasks = await queryMany(
      `
      SELECT project_id, task_id, COUNT(*)::int AS scans
      FROM assignment_scan
      WHERE work_date=$1 AND scan_status='Accepted'
      GROUP BY project_id, task_id
      ORDER BY scans DESC
      LIMIT 20
      `,
      [workDate]
    );

    return res.json({
      success: true,
      data: {
        work_date: workDate,
        day_counts: dayCounts || { open_days: 0, closed_days: 0 },
        scan_counts: scanCounts || { total_scans: 0, accepted_scans: 0, rejected_scans: 0, offline_scans: 0 },
        top_tasks: topTasks,
      },
    });
  } catch (e) {
    console.error("[MONITOR] dashboard error:", e);
    return res.status(500).json({
      success: false,
      error: { code: "INTERNAL_ERROR", message: e.message || "Internal error" },
    });
  }
});

/**
 * GET /api/v1/monitor/activity/projects?work_date=YYYY-MM-DD&limit=200
 * Project/task activity rollup from scans
 */
router.get("/activity/projects", requireAuth, async (req, res) => {
  try {
    const workDate = parseISODate(req.query.work_date);
    const limit = Math.min(Math.max(asInt(req.query.limit, 200), 1), 1000);

    if (!workDate) {
      return res.status(400).json({
        success: false,
        error: { code: "BAD_REQUEST", message: "work_date must be YYYY-MM-DD" },
      });
    }

    const rows = await queryMany(
      `
      SELECT
        project_id,
        task_id,
        COUNT(*) FILTER (WHERE scan_status='Accepted')::int AS accepted_scans,
        COUNT(*) FILTER (WHERE scan_status<>'Accepted')::int AS rejected_scans,
        COUNT(DISTINCT employee_id)::int AS workers,
        MIN(scan_timestamp_server) AS first_scan,
        MAX(scan_timestamp_server) AS last_scan
      FROM assignment_scan
      WHERE work_date=$1
      GROUP BY project_id, task_id
      ORDER BY last_scan DESC NULLS LAST
      LIMIT ${limit}
      `,
      [workDate]
    );

    return res.json({ success: true, data: { work_date: workDate, items: rows } });
  } catch (e) {
    console.error("[MONITOR] activity projects error:", e);
    return res.status(500).json({
      success: false,
      error: { code: "INTERNAL_ERROR", message: e.message || "Internal error" },
    });
  }
});

/**
 * GET /api/v1/monitor/supervisors
 * Returns active supervisors (based on employees.is_supervisor)
 */
router.get("/supervisors", requireAuth, async (req, res) => {
  try {
    const rows = await queryMany(
      `
      SELECT employee_id, full_name, status
      FROM employees
      WHERE is_supervisor = TRUE AND (status='Active' OR status IS NULL)
      ORDER BY employee_id
      `,
      []
    );

    return res.json({ success: true, data: { supervisors: rows } });
  } catch (e) {
    console.error("[MONITOR] supervisors error:", e);
    return res.status(500).json({
      success: false,
      error: { code: "INTERNAL_ERROR", message: e.message || "Internal error" },
    });
  }
});

/**
 * GET /api/v1/monitor/supervisors/:supervisor_id/days?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Summary per day for a supervisor (SE review page later)
 */
router.get("/supervisors/:supervisor_id/days", requireAuth, async (req, res) => {
  try {
    const supervisorId = String(req.params.supervisor_id || "").trim();
    const from = parseISODate(req.query.from);
    const to = parseISODate(req.query.to);

    if (!supervisorId) {
      return res.status(400).json({
        success: false,
        error: { code: "BAD_REQUEST", message: "supervisor_id is required" },
      });
    }
    if (!from || !to) {
      return res.status(400).json({
        success: false,
        error: { code: "BAD_REQUEST", message: "from and to must be YYYY-MM-DD" },
      });
    }

    const rows = await queryMany(
      `
      SELECT
        a.work_date::date AS work_date,
        $1 AS supervisor_id,
        COUNT(DISTINCT a.employee_id)::int AS workers,
        COUNT(*) FILTER (WHERE a.scan_status='Accepted')::int AS accepted_scans,
        COUNT(*) FILTER (WHERE a.scan_status<>'Accepted')::int AS rejected_scans,
        MIN(a.scan_timestamp_server) AS first_activity,
        MAX(a.scan_timestamp_server) AS last_activity
      FROM assignment_scan a
      JOIN employees e ON TRIM(UPPER(e.employee_id)) = TRIM(UPPER(a.employee_id))
      WHERE TRIM(UPPER(e.supervisor_employee_id)) = TRIM(UPPER($1))
        AND a.work_date::date BETWEEN $2::date AND $3::date
      GROUP BY a.work_date::date
      ORDER BY a.work_date::date DESC
      `,
      [supervisorId, from, to]
    );


    return res.json({
      success: true,
      data: { supervisor_id: supervisorId, from, to, days: rows },
    });
  } catch (e) {
    console.error("[MONITOR] supervisor days error:", e);
    return res.status(500).json({
      success: false,
      error: { code: "INTERNAL_ERROR", message: e.message || "Internal error" },
    });
  }
});

/**
 * GET /api/v1/monitor/supervisors/:supervisor_id/workers?work_date=YYYY-MM-DD
 * Returns distinct workers under a supervisor on a specific date (based on assignment_scan.supervisor_employee_id)
 * Used for Site Engineer drill-down: Supervisor Day -> Worker list -> Worker Day details.
 */
router.get("/supervisors/:supervisor_id/workers", requireAuth, async (req, res) => {
  try {
    const supervisorId = String(req.params.supervisor_id || "").trim();
    const workDate = parseISODate(req.query.work_date);

    if (!supervisorId) {
      return res.status(400).json({
        success: false,
        error: { code: "BAD_REQUEST", message: "supervisor_id is required" },
      });
    }
    if (!workDate) {
      return res.status(400).json({
        success: false,
        error: { code: "BAD_REQUEST", message: "work_date must be YYYY-MM-DD" },
      });
    }

    const rows = await queryMany(
      `
      SELECT
        e2.employee_id,
        e2.full_name,
        COALESCE(wd.day_status, 'NONE') AS day_status
      FROM (
        SELECT DISTINCT a.employee_id
        FROM assignment_scan a
        JOIN employees e ON TRIM(UPPER(e.employee_id)) = TRIM(UPPER(a.employee_id))
        WHERE TRIM(UPPER(e.supervisor_employee_id)) = TRIM(UPPER($1))
          AND a.work_date::date = $2::date
      ) x
      JOIN employees e2 ON e2.employee_id = x.employee_id
      LEFT JOIN work_day wd
        ON wd.employee_id = x.employee_id
      AND wd.work_date = $2::date
      ORDER BY e2.employee_id
      `,
      [supervisorId, workDate]
    );

    return res.json({
      success: true,
      data: { supervisor_id: supervisorId, work_date: workDate, workers: rows },
    });
  } catch (e) {
    console.error("[MONITOR] supervisor workers error:", e);
    return res.status(500).json({
      success: false,
      error: { code: "INTERNAL_ERROR", message: e.message || "Internal error" },
    });
  }
});

/**
 * GET /api/v1/monitor/supervisors/:supervisor_id/alerts?work_date=YYYY-MM-DD
 * Supervisor alert feed (read-only)
 */
router.get("/supervisors/:supervisor_id/alerts", requireAuth, async (req, res) => {
  try {
    const supervisorId = String(req.params.supervisor_id || "").trim();
    const workDate = parseISODate(req.query.work_date);

    if (!supervisorId) {
      return res.status(400).json({
        success: false,
        error: { code: "BAD_REQUEST", message: "supervisor_id required" },
      });
    }

    if (!workDate) {
      return res.status(400).json({
        success: false,
        error: { code: "BAD_REQUEST", message: "work_date must be YYYY-MM-DD" },
      });
    }

    // workers with OPEN sessions
    const openTasks = await queryMany(
      `
      SELECT employee_id, project_id, task_id
      FROM task_session
      WHERE status='OPEN'
        AND work_date=$1
        AND employee_id IN (
          SELECT employee_id
          FROM employees
          WHERE supervisor_employee_id=$2
        )
      `,
      [workDate, supervisorId]
    );

    // pending approvals
    const approvals = await queryMany(
      `
      SELECT approval_id, employee_id, approval_type, created_at
      FROM approval_item
      WHERE supervisor_employee_id=$1
        AND status='Submitted'
      ORDER BY created_at DESC
      LIMIT 20
      `,
      [supervisorId]
    );

    const alerts = [];

    for (const t of openTasks) {
      alerts.push({
        type: "OPEN_TASK",
        severity: "warning",
        message: `Worker ${t.employee_id} still running task ${t.project_id}/${t.task_id}`,
      });
    }

    for (const a of approvals) {
      alerts.push({
        type: "PENDING_APPROVAL",
        severity: "info",
        message: `Approval waiting: ${a.approval_type} for worker ${a.employee_id}`,
      });
    }

    return res.json({
      success: true,
      data: {
        supervisor_id: supervisorId,
        work_date: workDate,
        alerts,
      },
    });
  } catch (e) {
    console.error("[MONITOR] supervisor alerts error:", e);
    return res.status(500).json({
      success: false,
      error: { code: "INTERNAL_ERROR", message: e.message },
    });
  }
});

/**
 * GET /api/v1/monitor/se-alerts?work_date=YYYY-MM-DD
 * Site Engineer alert feed (read-only)
 */
router.get("/se-alerts", requireAuth, async (req, res) => {
  try {
    const workDate = parseISODate(req.query.work_date);

    if (!workDate) {
      return res.status(400).json({
        success: false,
        error: { code: "BAD_REQUEST", message: "work_date must be YYYY-MM-DD" },
      });
    }

    const alerts = [];

    // 1️⃣ workers still running tasks
    const openSessions = await queryMany(
      `
      SELECT employee_id, project_id, task_id
      FROM task_session
      WHERE status='OPEN'
        AND work_date=$1
      `,
      [workDate]
    );

    for (const s of openSessions) {
      alerts.push({
        type: "OPEN_SESSION",
        severity: "warning",
        message: `Worker ${s.employee_id} still running ${s.project_id}/${s.task_id}`,
      });
    }

    // 2️⃣ tasks under minimum workers
    const underMin = await queryMany(
      `
      SELECT project_id, task_id, current_workers, min_workers
      FROM task_release_dashboard
      WHERE work_date=$1
        AND current_workers < min_workers
      `,
      [workDate]
    );

    for (const r of underMin) {
      alerts.push({
        type: "UNDER_MIN",
        severity: "warning",
        message: `Task ${r.project_id}/${r.task_id} below minimum workers (${r.current_workers}/${r.min_workers})`,
      });
    }

    return res.json({
      success: true,
      data: {
        work_date: workDate,
        alerts,
      },
    });
  } catch (e) {
    console.error("[MONITOR] SE alerts error:", e);
    return res.status(500).json({
      success: false,
      error: { code: "INTERNAL_ERROR", message: e.message },
    });
  }
});

module.exports = router;
