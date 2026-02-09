// C:\MARCO-Workforce-App\backend\src\routes\day.js
// Worker day endpoints (schema-aligned with your DB)
const requireAuth = require("../middleware/requireAuth");

const express = require("express");
const router = express.Router();
const db = require("../db");

// ---- DB helpers (support db exports: Pool, {pool}, {query}) ----
function getPool() {
  if (db && typeof db.query === "function") return db;           // exported Pool-like
  if (db && db.pool && typeof db.pool.query === "function") return db.pool; // exported {pool}
  if (db && db.default && typeof db.default.query === "function") return db.default;
  throw new Error("DB pool not found: ../db must export a pg Pool or { pool }");
}

async function withClient(fn) {
  const pool = getPool();
  if (typeof pool.connect === "function") {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch (_) {}
      throw e;
    } finally {
      try { client.release(); } catch (_) {}
    }
  }
  // fallback: no transactions (still works)
  return await fn(pool);
}

// ---- Auth helper ----
function employeeIdFromAuth(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || "";
  const m = String(h).match(/DEV-TOKEN-([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

function minutesBetween(a, b) {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Math.max(0, Math.floor(ms / 60000));
}


function endTsForWorkDate(workDate) {
  // workDate: 'YYYY-MM-DD'
  const today = new Date().toISOString().slice(0, 10);
  if (String(workDate) < today) {
    // cap to end-of-day to avoid massive durations for historical open tasks
    return new Date(String(workDate) + "T23:59:59.000Z");
  }
  return new Date();
}

async function ensureWorkDay(q, employeeId, workDate) {
  await q(
    `
    INSERT INTO work_day (employee_id, work_date, day_status)
    VALUES ($1, $2, 'OPEN')
    ON CONFLICT (employee_id, work_date) DO NOTHING
    `,
    [employeeId, workDate]
  );

  const r = await q(
    `SELECT employee_id, work_date, day_status, closed_at, closed_by, reopened_at, reopened_by
     FROM work_day
     WHERE employee_id=$1 AND work_date=$2`,
    [employeeId, workDate]
  );
  return r.rows[0];
}

/**
 * POST /api/v1/day/end
 * Close the day for the authenticated worker.
 *
 * Rules:
 * - If day already CLOSED => success + already_closed=true (idempotent)
 * - Block if any pending approvals exist for this worker/day:
 *   - assignment_scan.scan_status='PendingApproval'
 *   - OR approval_item.status='Submitted' for same assignment_day
 * - Close any OPEN task_session rows for this worker/day
 * - Set work_day.day_status='CLOSED'
 */
// POST /api/v1/day/close-open-task
// Closes the single OPEN task_session for the authenticated worker on a given work_date.
// For historical work dates, end_ts is capped to end-of-day to avoid huge durations.
router.post("/close-open-task", requireAuth, async (req, res) => {
  const employeeId = req.user?.employee_id || employeeIdFromAuth(req);
  const workDate = (req.body?.work_date || req.body?.workDate || "").toString().trim();

  if (!employeeId || !workDate) {
    return res.status(400).json({
      success: false,
      error: { code: "BAD_REQUEST", message: "work_date is required" },
    });
  }

  try {
    const data = await withClient(async (client) => {
      const q = (t, p) => client.query(t, p);

      // Find latest OPEN session for that day
      const r = await q(
        `
        SELECT session_id, project_id, task_id, start_ts
        FROM task_session
        WHERE employee_id=$1 AND work_date=$2 AND status='OPEN'
        ORDER BY start_ts DESC
        LIMIT 1
        `,
        [employeeId, workDate]
      );

      if (r.rowCount === 0) {
        return { closed: false, message: "No open task to close." };
      }

      const row = r.rows[0];
      const endTs = endTsForWorkDate(workDate);
      const duration = minutesBetween(row.start_ts, endTs);

      const u = await q(
        `
        UPDATE task_session
        SET end_ts=$1,
            duration_minutes=$2,
            status='CLOSED'
        WHERE session_id=$3
        RETURNING session_id, project_id, task_id, start_ts, end_ts, duration_minutes
        `,
        [endTs.toISOString(), duration, row.session_id]
      );

      return { closed: true, session: u.rows[0] };
    });

    return res.json({ success: true, data });
  } catch (err) {
    console.error("POST /day/close-open-task error:", err);
    return res.status(500).json({
      success: false,
      error: { code: "INTERNAL_ERROR", message: err.message || "Unexpected error" },
    });
  }
});

router.post("/end", requireAuth, async (req, res) => {
  const employeeId =
    req.employee_id ||
    employeeIdFromAuth(req) ||
    req.body?.employee_id ||
    req.body?.employeeId;

  const workDate = req.body?.work_date || req.body?.workDate;
  const closeAll = req.body?.close_all === true || req.body?.closeAll === true;


  if (!employeeId || !workDate) {
    return res.status(400).json({
      success: false,
      error: { code: "BAD_REQUEST", message: "employee_id and work_date are required" },
    });
  }

  try {
    const data = await withClient(async (client) => {
      const q = (t, p) => client.query(t, p);

      const wd = await ensureWorkDay(q, employeeId, workDate);
      if (String(wd.day_status).toUpperCase() === "CLOSED") {
        return {
          employee_id: employeeId,
          work_date: workDate,
          already_closed: true,
          message: "Day already closed.",
        };
      }

      // Pending approvals - scan level
      const pendingScan = await q(
        `SELECT 1
         FROM assignment_scan
         WHERE employee_id=$1 AND work_date=$2 AND scan_status='PendingApproval'
         LIMIT 1`,
        [employeeId, workDate]
      );
      if (pendingScan.rowCount > 0) {
        const err = new Error("PENDING_APPROVALS");
        err.httpStatus = 409;
        err.payload = {
          success: false,
          error: {
            code: "CLOSE_DAY_BLOCKED_PENDING_APPROVALS",
            message:
              "You still have tasks pending approval. Ask your supervisor to review them before closing the day.",
          },
          data: { employee_id: employeeId, work_date: workDate },
        };
        throw err;
      }

      // Pending approvals - approval_item (defensive)
      const pendingAi = await q(
        `
        SELECT 1
        FROM approval_item ai
        JOIN assignment_day ad ON ad.assignment_day_id = ai.assignment_day_id
        WHERE ad.employee_id=$1 AND ad.work_date=$2 AND ai.status='Submitted'
        LIMIT 1
        `,
        [employeeId, workDate]
      );
      if (pendingAi.rowCount > 0) {
        const err = new Error("PENDING_APPROVALS");
        err.httpStatus = 409;
        err.payload = {
          success: false,
          error: {
            code: "CLOSE_DAY_BLOCKED_PENDING_APPROVALS",
            message:
              "You still have tasks pending approval. Ask your supervisor to review them before closing the day.",
          },
          data: { employee_id: employeeId, work_date: workDate },
        };
        throw err;
      }

      // Close OPEN sessions
      const openSessions = await q(
        `SELECT session_id, start_ts
         FROM task_session
         WHERE employee_id=$1 AND work_date=$2 AND status='OPEN'
         ORDER BY start_ts ASC`,
        [employeeId, workDate]
      );

      // If there is an open task, block close unless caller explicitly requests close_all
      if (openSessions.rowCount > 0 && !closeAll) {
        const err = new Error("OPEN_TASK_EXISTS");
        err.httpStatus = 409;
        err.payload = {
          success: false,
          error: {
            code: "CLOSE_DAY_BLOCKED_OPEN_TASKS",
            message:
              "There is an open task. Please close it before closing the day.",
          },
          data: { employee_id: employeeId, work_date: workDate },
        };
        throw err;
      }

      const now = new Date();
      let closedCount = 0;

      for (const s of openSessions.rows) {
        const duration = minutesBetween(s.start_ts, now);
        await q(
          `UPDATE task_session
           SET end_ts=$1,
               duration_minutes=$2,
               status='CLOSED'
           WHERE session_id=$3`,
          [now, duration, s.session_id]
        );
        closedCount += 1;
      }

      // Close day
      await q(
        `UPDATE work_day
         SET day_status='CLOSED', closed_at=NOW(), closed_by=$3
         WHERE employee_id=$1 AND work_date=$2`,
        [employeeId, workDate, employeeId]
      );

      return {
        employee_id: employeeId,
        work_date: workDate,
        closed_sessions: closedCount,
        closed: true,
        message: "Day closed successfully.",
      };
    });

    return res.json({ success: true, data });
  } catch (err) {
    if (err && err.payload && err.httpStatus) {
      return res.status(err.httpStatus).json(err.payload);
    }
    console.error("POST /day/end error:", err);
    return res.status(500).json({
      success: false,
      error: { code: "INTERNAL_ERROR", message: err.message || "Unexpected error" },
    });
  }
});

module.exports = router;
