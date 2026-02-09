console.log("[ASSIGNMENTS] LOADED:", __filename, "at", new Date().toISOString());
const express = require("express");
const router = express.Router();
const { pool } = require("../db");

// ---------------- AUTH ----------------
function devAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.replace("Bearer ", "");
  if (!token.startsWith("DEV-TOKEN-")) {
    return res.status(401).json({
      success: false,
      error: { code: "NOT_AUTHORIZED", message: "Missing/invalid token" },
    });
  }
  req.employee_id = token.replace("DEV-TOKEN-", "");
  next();
}

async function getEmployeeRole(employeeId) {
  // employees.role is used in your system (e.g., ADMIN). If role is missing, treat as WORKER.
  const r = await pool.query(
    `SELECT COALESCE(role,'WORKER') AS role
     FROM employees
     WHERE employee_id = $1
     LIMIT 1`,
    [employeeId]
  );
  return (r.rows[0]?.role || "WORKER").toString().toUpperCase();
}

function requireSupervisorOrAdmin(req, res, next) {
  (async () => {
    try {
      const role = await getEmployeeRole(req.employee_id);
      // In MARCO Workforce you currently use ADMIN as supervisor user too.
      if (role !== "ADMIN" && role !== "SUPERVISOR") {
        return res.status(403).json({
          success: false,
          error: { code: "FORBIDDEN", message: "Supervisor/Admin only" },
        });
      }
      req.role = role;
      next();
    } catch (e) {
      next(e);
    }
  })();
}

// ---------------- WORKER: DAY DETAILS ----------------
router.get("/day", devAuth, async (req, res, next) => {
  try {
    const { work_date } = req.query;
    if (!work_date) {
      return res.status(400).json({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "work_date is required" },
      });
    }

    const scans = await pool.query(
      `SELECT
         scan_id,
         project_id,
         task_id,
         scan_status,
         is_offline,
         scan_timestamp_device
       FROM assignment_scan
       WHERE employee_id = $1
         AND work_date = $2
       ORDER BY scan_timestamp_device ASC`,
      [req.employee_id, work_date]
    );

    const totalTasks = scans.rowCount;

    // status: PendingApproval if ANY scan is pending, else Accepted if any tasks, else NotAssigned
    let hasPending = false;
    for (const s of scans.rows) {
      if (s.scan_status === "PendingApproval") {
        hasPending = true;
        break;
      }
    }

    const status = hasPending ? "PendingApproval" : totalTasks === 0 ? "NotAssigned" : "Accepted";

    return res.json({
      success: true,
      data: {
        work_date,
        status,
        total_tasks: totalTasks,
        tasks: scans.rows,
      },
    });
  } catch (e) {
    next(e);
  }
});

async function buildDaySummary(employeeId, workDate) {
  const q = await pool.query(
    `SELECT
       start_ts,
       end_ts,
       duration_minutes,
       status,
       project_id,
       task_id
     FROM task_session
     WHERE employee_id = $1
       AND work_date = $2
     ORDER BY start_ts ASC`,
    [employeeId, workDate]
  );

  let totalMinutes = 0;
  let openTask = null;

  for (const r of q.rows) {
    if (r.status === "CLOSED") {
      totalMinutes += Number(r.duration_minutes || 0);
    } else if (r.status === "OPEN") {
      openTask = {
        project_id: r.project_id,
        task_id: r.task_id,
        start_ts: r.start_ts,
      };
    }
  }

  return {
    work_date: workDate,
    total_minutes: totalMinutes,
    total_hours: Number((totalMinutes / 60).toFixed(2)),
    sessions_count: q.rowCount,
    open_task: openTask,
  };
}

// ---------------- WORKER: DAY SUMMARY (self) ----------------
router.get("/day/summary", devAuth, async (req, res, next) => {
  try {
    const { work_date } = req.query;
    if (!work_date) {
      return res.status(400).json({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "work_date is required" },
      });
    }

    const data = await buildDaySummary(req.employee_id, work_date);
    return res.json({ success: true, data });
  } catch (e) {
    next(e);
  }
});

// ---------------- SUPERVISOR/ADMIN: DAY SUMMARY FOR ANY WORKER ----------------
// GET /api/v1/assignments/day/summary/:employee_id?work_date=YYYY-MM-DD
router.get("/day/summary/:employee_id", devAuth, requireSupervisorOrAdmin, async (req, res, next) => {
  try {
    const { work_date } = req.query;
    const employeeId = req.params.employee_id;

    if (!work_date) {
      return res.status(400).json({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "work_date is required" },
      });
    }

    const data = await buildDaySummary(employeeId, work_date);
    return res.json({ success: true, data });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
