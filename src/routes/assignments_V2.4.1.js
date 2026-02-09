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

// ---------------- SUPERVISOR/AADMIN ROLE CHECK ----------------
async function requireSupervisorOrAdmin(req, res, next) {
  try {
    const r = await pool.query(
      `SELECT role FROM employees WHERE employee_id = $1 LIMIT 1`,
      [req.employee_id]
    );

    const role = (r.rows[0]?.role || "").toString().toLowerCase();

    if (role !== "admin" && role !== "supervisor") {
      return res.status(403).json({
        success: false,
        error: { code: "FORBIDDEN", message: "Supervisor/Admin only" },
      });
    }

    next();
  } catch (e) {
    next(e);
  }
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

    const status =
      hasPending ? "PendingApproval" : totalTasks === 0 ? "NotAssigned" : "Accepted";

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

// ---------------- WORKER: DAY SUMMARY ----------------
router.get("/day/summary", devAuth, async (req, res, next) => {
  try {
    const { work_date } = req.query;
    if (!work_date) {
      return res.status(400).json({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "work_date is required" },
      });
    }

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
      [req.employee_id, work_date]
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

    return res.json({
      success: true,
      data: {
        work_date,
        total_minutes: totalMinutes,
        total_hours: Number((totalMinutes / 60).toFixed(2)),
        sessions_count: q.rowCount,
        open_task: openTask,
      },
    });
  } catch (e) {
    next(e);
  }
});

// ---------------- SUPERVISOR: DAY SUMMARY FOR A WORKER ----------------
// GET /api/v1/assignments/day/summary/:employee_id?work_date=YYYY-MM-DD
router.get("/day/summary/:employee_id", devAuth, requireSupervisorOrAdmin, async (req, res, next) => {
  try {
    const { work_date } = req.query;
    const targetEmployeeId = req.params.employee_id;

    if (!work_date) {
      return res.status(400).json({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "work_date is required" },
      });
    }

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
      [targetEmployeeId, work_date]
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

    return res.json({
      success: true,
      data: {
        employee_id: targetEmployeeId,
        work_date,
        total_minutes: totalMinutes,
        total_hours: Number((totalMinutes / 60).toFixed(2)),
        sessions_count: q.rowCount,
        open_task: openTask,
      },
    });
  } catch (e) {
    next(e);
  }
});



module.exports = router;
