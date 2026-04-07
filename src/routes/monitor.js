/**
 * MARCO Workforce - monitor.js (READ-ONLY)
 *
 * Keeps existing monitor routes and adds:
 * - Supervisor alerts with schedule-aware rules
 * - SE dashboard alerts
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

function currentHourKSA() {
  const now = new Date();
  const ksa = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Riyadh" }));
  return ksa.getHours();
}

/**
 * Your DB has both task_session and task_sessions.
 * We’ll try task_session first, then fallback to task_sessions.
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

// ---------- original routes ----------

/**
 * GET /api/v1/monitor/worker/:employee_id/day?work_date=YYYY-MM-DD
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

    const totalAcceptedScans = scans.filter((s) => s.scan_status === "Accepted").length;
    const totalRejectedScans = scans.length - totalAcceptedScans;
    const totalMinutes = sessions.reduce((sum, s) => sum + (s.duration_minutes || 0), 0);

    return res.json({
      success: true,
      data: {
        work_day: workDay,
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
        scan_counts: scanCounts || {
          total_scans: 0,
          accepted_scans: 0,
          rejected_scans: 0,
          offline_scans: 0,
        },
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

    return res.json({
      success: true,
      data: { work_date: workDate, items: rows },
    });
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
 */
router.get("/supervisors", requireAuth, async (req, res) => {
  try {
    const rows = await queryMany(
      `
     SELECT employee_id, full_name, role, status
      FROM employees
      WHERE UPPER(role) IN ('ADMIN', 'SUPERVISOR')
        AND (
          status IS NULL
          OR UPPER(TRIM(status)) = 'ACTIVE'
        )
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

// ---------- supervisor alerts ----------
router.get("/supervisors/:supervisor_id/alerts", requireAuth, async (req, res) => {
  try {
    const supervisorId = String(req.params.supervisor_id || "").trim();
    const workDate = parseISODate(req.query.work_date);
    const hour = currentHourKSA();

    if (!supervisorId || !workDate) {
      return res.status(400).json({
        success: false,
        error: { code: "BAD_REQUEST", message: "supervisor_id and work_date required" },
      });
    }

    const alerts = [];

    // after 10:00 → workers with no accepted scan
    if (hour >= 10) {
      const noScan = await queryMany(
        `
        SELECT e.employee_id, e.full_name
        FROM employees e
        WHERE TRIM(UPPER(e.supervisor_employee_id)) = TRIM(UPPER($1))
          AND NOT EXISTS (
            SELECT 1
            FROM assignment_scan a
            WHERE a.employee_id = e.employee_id
              AND a.work_date = $2
              AND a.scan_status = 'Accepted'
          )
        ORDER BY e.employee_id
        `,
        [supervisorId, workDate]
      );

      for (const r of noScan) {
        alerts.push({
          type: "NO_SCAN",
          severity: "warning",
          message: `Worker ${r.employee_id}${r.full_name ? " - " + r.full_name : ""} has not scanned today`,
        });
      }
    }

    // after 14:00 → workers still running tasks
    if (hour >= 14) {
      const openTasks = await queryMany(
        `
        SELECT ts.employee_id, e.full_name, ts.project_id, ts.task_id
        FROM task_session ts
        LEFT JOIN employees e ON e.employee_id = ts.employee_id
        WHERE ts.status='OPEN'
          AND ts.work_date=$1
          AND ts.employee_id IN (
            SELECT employee_id
            FROM employees
            WHERE TRIM(UPPER(supervisor_employee_id)) = TRIM(UPPER($2))
          )
        ORDER BY ts.employee_id
        `,
        [workDate, supervisorId]
      );

      for (const t of openTasks) {
        alerts.push({
          type: "OPEN_TASK",
          severity: "warning",
          message: `Worker ${t.employee_id}${t.fullName ? " - " + t.full_name : ""} still running task ${t.project_id}/${t.task_id}`,
        });
      }
    }

    // pending approvals
    const approvals = await queryMany(
      `
      SELECT approval_id, employee_id, approval_type, created_at
      FROM approval_item
      WHERE TRIM(UPPER(supervisor_employee_id)) = TRIM(UPPER($1))
        AND status='Submitted'
      ORDER BY created_at DESC
      LIMIT 20
      `,
      [supervisorId]
    );

    for (const a of approvals) {
      alerts.push({
        type: "PENDING_APPROVAL",
        severity: "info",
        message: `Approval waiting: ${a.approval_type} for worker ${a.employee_id}`,
      });
    }

    // after 19:00 → workers day not closed
    if (hour >= 19) {
      const notClosed = await queryMany(
        `
        SELECT e.employee_id, e.full_name
        FROM employees e
        LEFT JOIN work_day wd
          ON wd.employee_id = e.employee_id
         AND wd.work_date = $2
        WHERE TRIM(UPPER(e.supervisor_employee_id)) = TRIM(UPPER($1))
          AND COALESCE(wd.day_status, 'OPEN') <> 'CLOSED'
        ORDER BY e.employee_id
        `,
        [supervisorId, workDate]
      );

      for (const r of notClosed) {
        alerts.push({
          type: "DAY_NOT_CLOSED",
          severity: "warning",
          message: `Worker ${r.employee_id}${r.full_name ? " - " + r.full_name : ""} day is not closed`,
        });
      }
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

// ---------- SE alerts ----------
router.get("/se-alerts", requireAuth, async (req, res) => {
  try {
    const workDate = parseISODate(req.query.work_date);
    const hour = currentHourKSA();

    if (!workDate) {
      return res.status(400).json({
        success: false,
        error: { code: "BAD_REQUEST", message: "work_date required" },
      });
    }

    const alerts = [];

    // open sessions
    const openSessions = await queryMany(
      `
      SELECT ts.employee_id, e.full_name, ts.project_id, ts.task_id,
             e.supervisor_employee_id, sup.full_name AS supervisor_name
      FROM task_session ts
      LEFT JOIN employees e ON e.employee_id = ts.employee_id
      LEFT JOIN employees sup ON sup.employee_id = e.supervisor_employee_id
      WHERE ts.status='OPEN' AND ts.work_date=$1
      ORDER BY e.supervisor_employee_id, ts.employee_id
      `,
      [workDate]
    );

    for (const s of openSessions) {
      alerts.push({
        type: "OPEN_SESSION",
        severity: "warning",
        message:
          `Open task: ${s.employee_id}${s.full_name ? " - " + s.full_name : ""} on ${s.project_id}/${s.task_id}` +
          `${s.supervisor_employee_id ? ` • Supervisor ${s.supervisor_employee_id}${s.supervisor_name ? " - " + s.supervisor_name : ""}` : ""}`,
      });
    }

    // after 10:00 → workers not scanned
    if (hour >= 10) {
      const noScan = await queryMany(
        `
        SELECT e.employee_id, e.full_name, e.supervisor_employee_id, sup.full_name AS supervisor_name
        FROM employees e
        LEFT JOIN employees sup ON sup.employee_id = e.supervisor_employee_id
        WHERE NOT EXISTS (
          SELECT 1
          FROM assignment_scan a
          WHERE a.employee_id = e.employee_id
            AND a.work_date = $1
            AND a.scan_status = 'Accepted'
        )
        ORDER BY e.supervisor_employee_id, e.employee_id
        `,
        [workDate]
      );

      for (const r of noScan) {
        alerts.push({
          type: "NO_SCAN",
          severity: "warning",
          message:
            `No scan: ${r.employee_id}${r.full_name ? " - " + r.full_name : ""}` +
            `${r.supervisor_employee_id ? ` • Supervisor ${r.supervisor_employee_id}${r.supervisor_name ? " - " + r.supervisor_name : ""}` : ""}`,
        });
      }
    }

    // capacity alerts from active releases
    const capacityRows = await queryMany(
      `
      SELECT
        tr.project_id,
        tr.task_id,
        tr.supervisor_employee_id,
        sup.full_name AS supervisor_name,
        tr.min_workers,
        tr.max_workers,
        COALESCE(ts.current_workers, 0) AS current_workers
      FROM task_releases tr
      LEFT JOIN employees sup
        ON sup.employee_id = tr.supervisor_employee_id
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
      WHERE tr.release_status = 'ACTIVE'
      ORDER BY tr.project_id, tr.task_id
      `,
      [workDate]
    );

    for (const r of capacityRows) {
      const current = Number(r.current_workers || 0);
      const min = Number(r.min_workers || 0);
      const max = r.max_workers === null || r.max_workers === undefined ? null : Number(r.max_workers);

      if (current < min) {
        alerts.push({
          type: "UNDER_MIN",
          severity: "warning",
          message:
            `Under minimum: ${r.project_id}/${r.task_id} (${current}/${min})` +
            `${r.supervisor_employee_id ? ` • Supervisor ${r.supervisor_employee_id}${r.supervisor_name ? " - " + r.supervisor_name : ""}` : ""}`,
        });
      } else if (max !== null && current === max) {
        alerts.push({
          type: "FULL",
          severity: "info",
          message:
            `Full capacity: ${r.project_id}/${r.task_id} (${current}/${max})` +
            `${r.supervisor_employee_id ? ` • Supervisor ${r.supervisor_employee_id}${r.supervisor_name ? " - " + r.supervisor_name : ""}` : ""}`,
        });
      } else if (max !== null && current > max) {
        alerts.push({
          type: "OVER_CAPACITY",
          severity: "warning",
          message:
            `Over capacity: ${r.project_id}/${r.task_id} (${current}/${max})` +
            `${r.supervisor_employee_id ? ` • Supervisor ${r.supervisor_employee_id}${r.supervisor_name ? " - " + r.supervisor_name : ""}` : ""}`,
        });
      }
    }

    // after 19:00 → supervisors with workers not closed
    if (hour >= 19) {
      const supervisorNotClosed = await queryMany(
        `
        SELECT
          e.supervisor_employee_id,
          sup.full_name AS supervisor_name,
          COUNT(*)::int AS workers_not_closed
        FROM employees e
        LEFT JOIN employees sup ON sup.employee_id = e.supervisor_employee_id
        LEFT JOIN work_day wd
          ON wd.employee_id = e.employee_id
         AND wd.work_date = $1
        WHERE COALESCE(wd.day_status, 'OPEN') <> 'CLOSED'
          AND e.supervisor_employee_id IS NOT NULL
        GROUP BY e.supervisor_employee_id, sup.full_name
        ORDER BY e.supervisor_employee_id
        `,
        [workDate]
      );

      for (const r of supervisorNotClosed) {
        alerts.push({
          type: "SUPERVISOR_NOT_CLOSED",
          severity: "warning",
          message:
            `Supervisor ${r.supervisor_employee_id}${r.supervisor_name ? " - " + r.supervisor_name : ""} has ${r.workers_not_closed} worker(s) not closed`,
        });
      }
    }

    return res.json({
      success: true,
      data: { work_date: workDate, alerts },
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