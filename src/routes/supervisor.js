// C:\MARCO-Workforce-App\backend\src\routes\supervisor.js
// Supervisor endpoints (schema-aligned with your DB)
const requireAuth = require("../middleware/requireAuth");

const express = require("express");
const router = express.Router();
const db = require("../db");

// ---- DB helpers (support db exports: Pool, {pool}, {query}) ----
function getPool() {
  if (db && typeof db.query === "function") return db;
  if (db && db.pool && typeof db.pool.query === "function") return db.pool;
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
     FROM work_day WHERE employee_id=$1 AND work_date=$2`,
    [employeeId, workDate]
  );
  return r.rows[0];
}

async function setWorkDayStatus(q, employeeId, workDate, status, actorId) {
  if (String(status).toUpperCase() === "OPEN") {
    await q(
      `UPDATE work_day
       SET day_status='OPEN', reopened_at=NOW(), reopened_by=$3
       WHERE employee_id=$1 AND work_date=$2`,
      [employeeId, workDate, actorId]
    );
  } else {
    await q(
      `UPDATE work_day
       SET day_status='CLOSED', closed_at=NOW(), closed_by=$3
       WHERE employee_id=$1 AND work_date=$2`,
      [employeeId, workDate, actorId]
    );
  }
}

async function rebuildTaskSessionsForDay(q, employeeId, workDate) {
  const scans = await q(
    `
    SELECT project_id, task_id, scan_timestamp_device
    FROM assignment_scan
    WHERE employee_id=$1
      AND work_date=$2
      AND scan_status='Accepted'
    ORDER BY scan_timestamp_device ASC
    `,
    [employeeId, workDate]
  );

  await q(
    `DELETE FROM task_session WHERE employee_id=$1 AND work_date=$2`,
    [employeeId, workDate]
  );

  if (scans.rowCount === 0) return;

  for (let i = 0; i < scans.rows.length; i++) {
    const cur = scans.rows[i];
    const next = scans.rows[i + 1] || null;

    const startTs = cur.scan_timestamp_device;
    const endTs = next ? next.scan_timestamp_device : null;

    let duration = null;
    let status = "OPEN";

    if (endTs) {
      duration = Math.max(
        0,
        Math.floor((new Date(endTs).getTime() - new Date(startTs).getTime()) / 60000)
      );
      status = "CLOSED";
    }

    await q(
      `
      INSERT INTO task_session(
        employee_id, work_date, project_id, task_id,
        start_ts, end_ts, duration_minutes,
        is_offline, status, approval_id
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,false,$8,NULL)
      `,
      [employeeId, workDate, cur.project_id, cur.task_id, startTs, endTs, duration, status]
    );
  }
}

/**
 * POST /api/v1/supervisor/assign/scan
 * Supports:
 * - worker_employee_id / workerEmployeeId / employee_id / employeeId
 * - work_date / workDate
 * - qr "PROJECT|TASK" or "PROJECT/TASK" (optional if project_id+task_id provided)
 * - project_id + task_id (preferred, supports temporary codes)
 * - override_duplicate
 * - reopen_day
 * - scan_timestamp_device (optional)
 *
 * NOTE:
 * Supervisor assigning a task should NOT create a supervisor-approval for the same scan.
 * Over-3-tasks/day approval applies to WORKER scans only.
 */
const __tableColsCache = {};
async function getTableColumns(q, tableName) {
  if (__tableColsCache[tableName]) return __tableColsCache[tableName];
  const r = await q(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1`,
    [tableName]
  );
  const cols = new Set(r.rows.map((x) => x.column_name));
  __tableColsCache[tableName] = cols;
  return cols;
}
function pickFirstExisting(colsSet, candidates) {
  for (const c of candidates) if (colsSet.has(c)) return c;
  return null;
}
async function insertDynamic(q, tableName, dataObj, returningCandidates = []) {
  const colsSet = await getTableColumns(q, tableName);

  const cols = [];
  const vals = [];
  for (const [k, v] of Object.entries(dataObj)) {
    if (v === undefined) continue;
    if (!colsSet.has(k)) continue;
    cols.push(k);
    vals.push(v);
  }

  if (cols.length === 0) {
    throw new Error(`No insertable columns matched for ${tableName}`);
  }

  const placeholders = cols.map((_, i) => `$${i + 1}`).join(",");
  const returningCol = pickFirstExisting(colsSet, returningCandidates);
  const returningSql = returningCol ? ` RETURNING ${returningCol}` : "";

  const sql = `INSERT INTO ${tableName} (${cols.join(",")}) VALUES (${placeholders})${returningSql}`;
  const r = await q(sql, vals);

  return { row: r.rows[0] || null, returningCol };
}

// POST /api/v1/supervisor/close-open-task
// Closes a worker's single OPEN task_session for a given work_date.
// For historical work dates, end_ts is capped to end-of-day to avoid huge durations.
router.post("/close-open-task", requireAuth, async (req, res) => {
  const supervisorId = req.user?.employee_id || employeeIdFromAuth(req);
  const employeeId = (req.body?.employee_id || req.body?.employeeId || "").toString().trim();
  const workDate = (req.body?.work_date || req.body?.workDate || "").toString().trim();

  if (!supervisorId || !employeeId || !workDate) {
    return res.status(400).json({
      success: false,
      error: { code: "BAD_REQUEST", message: "employee_id and work_date are required" },
    });
  }

  try {
    const data = await withClient(async (client) => {
      const q = (t, p) => client.query(t, p);

      // Find latest OPEN session for that worker/day
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
        RETURNING session_id, employee_id, work_date, project_id, task_id, start_ts, end_ts, duration_minutes, status
        `,
        [endTs.toISOString(), duration, row.session_id]
      );

      // Audit in approvals_history if you want later; for now return actor.
      return { closed: true, closed_by: supervisorId, session: u.rows[0] };
    });

    return res.json({ success: true, data });
  } catch (err) {
    console.error("POST /supervisor/close-open-task error:", err);
    return res.status(500).json({
      success: false,
      error: { code: "INTERNAL_ERROR", message: err.message || "Unexpected error" },
    });
  }
});

router.post("/assign/scan", requireAuth, async (req, res) => {
  console.log("[SUP ASSIGN] hit endpoint");
  console.log("[SUP ASSIGN] body:", req.body);

  const supervisorId = req.employee_id || employeeIdFromAuth(req);
  if (!supervisorId) return res.status(401).json({ success: false, error: "Unauthorized" });

  const workerEmployeeId =
    req.body?.worker_employee_id ||
    req.body?.workerEmployeeId ||
    req.body?.employee_id ||
    req.body?.employeeId;

  const workDate = req.body?.work_date || req.body?.workDate;

  const overrideDuplicate = !!req.body?.override_duplicate;
  const reopenDay = !!req.body?.reopen_day;

  // Prefer explicit project_id/task_id (temporary codes supported)
  let projectId = req.body?.project_id || req.body?.projectId || null;
  let taskId = req.body?.task_id || req.body?.taskId || null;

  // Fallback to parsing qr
  const qr = req.body?.qr || null;
  if ((!projectId || !taskId) && qr) {
    const parsed = parseQrFlexible(String(qr));
    if (parsed) {
      projectId = projectId || parsed.project_id;
      taskId = taskId || parsed.task_id;
    }
  }

  // Final validation
  if (!workerEmployeeId || !workDate) {
    return res.status(400).json({
      success: false,
      error: { code: "BAD_REQUEST", message: "worker_employee_id and work_date are required" },
    });
  }
  if (!projectId || !taskId) {
    return res.status(400).json({
      success: false,
      error: {
        code: "BAD_QR",
        message: "Invalid QR format. Expected PROJECT|TASK or PROJECT/TASK",
      },
    });
  }

  const scanTs = req.body?.scan_timestamp_device ? new Date(req.body.scan_timestamp_device) : new Date();
  const deviceId = req.body?.device_id || req.body?.deviceId || null;

  try {
    const out = await withClient(async (client) => {
      const q = (t, p) => client.query(t, p);

      const wd = await ensureWorkDay(q, workerEmployeeId, workDate);

      

      // Hard lock: once FINALIZED by Site Engineer, the day cannot be reopened or modified
      if (String(wd.day_status).toUpperCase() === "FINALIZED") {
        const err = new Error("DAY_FINALIZED_LOCKED");
        err.httpStatus = 409;
        err.payload = {
          success: false,
          error: {
            code: "DAY_FINALIZED_LOCKED",
            message: `This day is FINALIZED and cannot be reopened or modified for ${workDate}.`,
          },
          data: { worker_employee_id: workerEmployeeId, work_date: workDate },
        };
        throw err;
      }
if (String(wd.day_status).toUpperCase() === "CLOSED" && !reopenDay) {
        const err = new Error("DAY_CLOSED_CONFIRM");
        err.httpStatus = 409;
        err.payload = {
          success: false,
          error: {
            code: "DAY_CLOSED_CONFIRM",
            message: `This worker already closed the day for ${workDate}. If you continue, the system will re-open the day and assign the new task.`,
          },
          data: { worker_employee_id: workerEmployeeId, work_date: workDate },
        };
        throw err;
      }

      if (String(wd.day_status).toUpperCase() === "CLOSED" && reopenDay) {
        await setWorkDayStatus(q, workerEmployeeId, workDate, "OPEN", supervisorId);
      }

      // Ensure assignment_day exists
      const ad = await q(
        `INSERT INTO assignment_day (employee_id, work_date, status, total_tasks, has_offline_scans)
         VALUES ($1, $2, 'Accepted', 0, false)
         ON CONFLICT (employee_id, work_date) DO UPDATE SET employee_id=EXCLUDED.employee_id
         RETURNING assignment_day_id`,
        [workerEmployeeId, workDate]
      );
      const assignmentDayId = ad.rows[0].assignment_day_id;

      // Duplicate check (ignore Rejected)
      if (!overrideDuplicate) {
        const dup = await q(
          `SELECT 1 FROM assignment_scan
           WHERE employee_id=$1 AND work_date=$2 AND project_id=$3 AND task_id=$4
             AND COALESCE(scan_status,'') <> 'Rejected'
           LIMIT 1`,
          [workerEmployeeId, workDate, projectId, taskId]
        );
        if (dup.rowCount > 0) {
          return {
            success: true,
            data: { status: "Rejected", note: "Duplicate task. Use override_duplicate if needed." },
          };
        }
      }

      // Insert scan as Accepted (supervisor-assigned tasks never require supervisor approval)
      const crypto = require("crypto");
      const clientReferenceId =
        req.body?.client_reference_id ||
        req.body?.clientReferenceId ||
        (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex"));

      const now = new Date();

      const dataToInsert = {
        assignment_day_id: assignmentDayId,
        employee_id: workerEmployeeId,
        work_date: workDate,
        project_id: projectId,
        task_id: taskId,
        scan_timestamp_device: scanTs,
        scan_timestamp_server: now,
        supervisor_employee_id: supervisorId,
        is_offline: false,
        scan_status: "Accepted",
        status: "Accepted", // some schemas use 'status'
        device_id: deviceId,
        client_reference_id: clientReferenceId,
        created_at: now,
        updated_at: now,
      };

      const ins = await insertDynamic(q, "assignment_scan", dataToInsert, ["scan_id", "id"]);

      await rebuildTaskSessionsForDay(q, workerEmployeeId, workDate);

      return {
        success: true,
        data: {
          status: "Accepted",
          note: "Assigned by supervisor.",
          scan_id: ins.row ? ins.row[ins.returningCol] : null,
          worker_employee_id: workerEmployeeId,
          supervisor_employee_id: supervisorId,
          work_date: workDate,
          project_id: projectId,
          task_id: taskId,
        },
      };
    });

    return res.json(out);
  } catch (e) {
    if (e && e.payload && e.httpStatus) return res.status(e.httpStatus).json(e.payload);
    console.error("POST /supervisor/assign/scan error:", e);
    return res.status(500).json({ success: false, error: e.message || "Unexpected error" });
  }
});

/**
 * POST /api/v1/supervisor/close-day
 * Close selected worker day:
 * - If pending approvals exist for THAT worker/day => block
 * - If open tasks exist => return list + allow close_all=true to close them
 * - Idempotent if already closed
 */
router.post("/close-day", requireAuth, async (req, res) => {
  const supervisorId = req.employee_id || employeeIdFromAuth(req);
  if (!supervisorId) return res.status(401).json({ success: false, error: "Unauthorized" });

  const employeeId =
    req.body?.employee_id ||
    req.body?.employeeId ||
    req.body?.worker_employee_id ||
    req.body?.workerEmployeeId;

  const workDate = req.body?.work_date || req.body?.workDate;
  const closeAll = !!req.body?.close_all;

  if (!employeeId || !workDate) {
    return res.status(400).json({ success: false, error: { code: "BAD_REQUEST", message: "employee_id and work_date are required" } });
  }

  try {
    const out = await withClient(async (client) => {
      const q = (t, p) => client.query(t, p);

      const wd = await ensureWorkDay(q, employeeId, workDate);

      if (String(wd.day_status).toUpperCase() === "CLOSED") {
        return {
          success: true,
          data: { employee_id: employeeId, work_date: workDate, already_closed: true, message: "Day already closed." },
        };
      }

      // Pending approvals for this worker/day
      const pendingScan = await q(
        `SELECT 1 FROM assignment_scan
         WHERE employee_id=$1 AND work_date=$2 AND scan_status='PendingApproval'
         LIMIT 1`,
        [employeeId, workDate]
      );
      if (pendingScan.rowCount > 0) {
        const err = new Error("PENDING_APPROVALS");
        err.httpStatus = 409;
        err.payload = {
          success: false,
          error: { code: "CLOSE_DAY_BLOCKED_PENDING_APPROVALS", message: "There are pending approvals for this worker/day." },
          data: { employee_id: employeeId, work_date: workDate },
        };
        throw err;
      }

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
          error: { code: "CLOSE_DAY_BLOCKED_PENDING_APPROVALS", message: "There are pending approvals for this worker/day." },
          data: { employee_id: employeeId, work_date: workDate },
        };
        throw err;
      }

      // Open sessions for THIS worker/day
      const open = await q(
        `SELECT session_id, project_id, task_id, start_ts
         FROM task_session
         WHERE employee_id=$1 AND work_date=$2 AND status='OPEN'
         ORDER BY start_ts ASC`,
        [employeeId, workDate]
      );

      if (open.rowCount > 0 && !closeAll) {
        const err = new Error("OPEN_TASKS");
        err.httpStatus = 409;
        err.payload = {
          success: false,
          error: { code: "CLOSE_DAY_BLOCKED_OPEN_TASKS", message: "Worker has open tasks. Close them before closing the day." },
          data: {
            employee_id: employeeId,
            work_date: workDate,
            open_tasks: open.rows.map((r) => ({
              session_id: r.session_id,
              project_id: r.project_id,
              task_id: r.task_id,
              start_ts: r.start_ts,
            })),
          },
        };
        throw err;
      }

      if (open.rowCount > 0 && closeAll) {
        const now = new Date();
        for (const s of open.rows) {
          const duration = minutesBetween(s.start_ts, now);
          await q(
            `UPDATE task_session
             SET end_ts=$1,
                 duration_minutes=$2,
                 status='CLOSED'
             WHERE session_id=$3`,
            [now, duration, s.session_id]
          );
        }
      }

      await setWorkDayStatus(q, employeeId, workDate, "CLOSED", supervisorId);

      return {
        success: true,
        data: { employee_id: employeeId, work_date: workDate, closed: true, message: "Day closed successfully." },
      };
    });

    return res.json(out);
  } catch (e) {
    if (e && e.payload && e.httpStatus) return res.status(e.httpStatus).json(e.payload);
    console.error("POST /supervisor/close-day error:", e);
    return res.status(500).json({ success: false, error: e.message || "Unexpected error" });
  }
});

/**
 * GET /api/v1/supervisor/workers
 * Returns list of workers for supervisor screens.
 */
router.get("/workers", requireAuth, async (req, res) => {
  try {
    const out = await withClient(async (client) => {
      const q = (t, p) => client.query(t, p);

      // Try full schema first
      try {
        const r = await q(
          `SELECT employee_id, full_name, status
             FROM employees
            WHERE COALESCE(is_supervisor,false)=false
            ORDER BY employee_id`,
          []
        );
        return r.rows;
      } catch (e) {
        // Fallback if some columns don't exist (ex: status/is_supervisor)
        const r2 = await q(
          `SELECT employee_id, full_name
             FROM employees
            ORDER BY employee_id`,
          []
        );
        return r2.rows.map((x) => ({ ...x, status: "Active" }));
      }
    });

    console.log(
      "[SUP ASSIGN] RESPONSE JSON:",
      JSON.stringify({ success: true, data: { /* same object you return */ } }, null, 2)
    );

    // --- DEBUG: log ANY response returned by this route (temporary)
    const _json = res.json.bind(res);
    const _status = res.status.bind(res);

    res.status = (code) => {
      res.__statusCode = code;
      return _status(code);
    };

    res.json = (body) => {
      console.log(
        "[SUP ASSIGN] RESPONSE JSON:",
        JSON.stringify(
          { statusCode: res.__statusCode || 200, body },
          null,
          2
        )
      );
      return _json(body);
    };
    // --- END DEBUG

    const _send = res.send.bind(res);
    res.send = (body) => {
      try {
        console.log("[SUP ASSIGN] RESPONSE SEND:", body);
      } catch {}
      return _send(body);
    };




    return res.json(out);
  } catch (e) {
    console.error("GET /supervisor/workers error:", e);
    return res.status(500).json({ success: false, error: e.message || "Unexpected error" });
  }
});



/**
 * POST /api/v1/supervisor/finalize-day
 * Site Engineer action: permanently finalize a worker day (cannot be reopened).
 * Body: { employee_id, work_date }
 */
router.post("/finalize-day", requireAuth, async (req, res) => {
  const decidedBy = req.employee_id || employeeIdFromAuth(req);
  const employeeId = req.body?.employee_id || req.body?.worker_employee_id;
  const workDate = req.body?.work_date;

  if (!decidedBy) return res.status(401).json({ success: false, error: "Unauthorized" });
  if (!employeeId || !workDate) {
    return res.status(400).json({
      success: false,
      error: { code: "BAD_REQUEST", message: "employee_id and work_date are required" },
    });
  }

  try {
    const out = await withClient(async (client) => {
      const q = (t, p) => client.query(t, p);

      const wd = await ensureWorkDay(q, employeeId, workDate);

      if (String(wd.day_status).toUpperCase() === "FINALIZED") {
        return { already_finalized: true, employee_id: employeeId, work_date: workDate };
      }
      if (String(wd.day_status).toUpperCase() !== "CLOSED") {
        const err = new Error("DAY_NOT_CLOSED");
        err.httpStatus = 409;
        err.payload = {
          success: false,
          error: {
            code: "DAY_NOT_CLOSED",
            message: "Day must be CLOSED by supervisor before showing SE finalization.",
          },
          data: { employee_id: employeeId, work_date: workDate, day_status: wd.day_status },
        };
        throw err;
      }

      await q(
        `UPDATE work_day
         SET day_status='FINALIZED',
             closed_at = COALESCE(closed_at, NOW()),
             closed_by = COALESCE(closed_by, $3)
         WHERE employee_id=$1 AND work_date=$2`,
        [employeeId, workDate, decidedBy]
      );

      const after = await q(`SELECT * FROM work_day WHERE employee_id=$1 AND work_date=$2`, [employeeId, workDate]);
      return { employee_id: employeeId, work_date: workDate, work_day: after.rows[0] };
    });

    return res.json({ success: true, data: out });
  } catch (e) {
    const status = e.httpStatus || 500;
    return res.status(status).json(e.payload || { success: false, error: e.message || "Unexpected error" });
  }
});

/**
 * POST /api/v1/supervisor/finalize-supervisor-day
 * Site Engineer action: finalize ALL worker days that had activity under a supervisor for a given date.
 * Body: { supervisor_id, work_date }
 */
router.post("/finalize-supervisor-day", requireAuth, async (req, res) => {
  const decidedBy = req.employee_id || employeeIdFromAuth(req);
  const supervisorId = req.body?.supervisor_id;
  const workDate = req.body?.work_date;

  if (!decidedBy) return res.status(401).json({ success: false, error: "Unauthorized" });
  if (!supervisorId || !workDate) {
    return res.status(400).json({
      success: false,
      error: { code: "BAD_REQUEST", message: "supervisor_id and work_date are required" },
    });
  }

  try {
    const result = await withClient(async (client) => {
      const q = (t, p) => client.query(t, p);

      // workers who had supervisor-assigned scans that day
      const w = await q(
        `SELECT DISTINCT employee_id
         FROM assignment_scan
         WHERE supervisor_employee_id = $1 AND work_date = $2`,
        [supervisorId, workDate]
      );
      const workers = w.rows.map((r) => String(r.employee_id));

      const finalized = [];
      const skipped = [];

      for (const empId of workers) {
        const wd = await ensureWorkDay(q, empId, workDate);
        const st = String(wd.day_status).toUpperCase();

        if (st === "FINALIZED") {
          skipped.push({ employee_id: empId, reason: "ALREADY_FINALIZED" });
          continue;
        }
        if (st !== "CLOSED") {
          skipped.push({ employee_id: empId, reason: `NOT_CLOSED(${wd.day_status})` });
          continue;
        }

        await q(
          `UPDATE work_day
           SET day_status='FINALIZED',
               closed_at = COALESCE(closed_at, NOW()),
               closed_by = COALESCE(closed_by, $3)
           WHERE employee_id=$1 AND work_date=$2`,
          [empId, workDate, decidedBy]
        );

        finalized.push(empId);
      }

      return { supervisor_id: supervisorId, work_date: workDate, workers_count: workers.length, finalized, skipped };
    });

    return res.json({ success: true, data: result });
  } catch (e) {
    const status = e.httpStatus || 500;
    return res.status(status).json(e.payload || { success: false, error: e.message || "Unexpected error" });
  }
});
/**
 * POST /api/v1/supervisor/return-supervisor-day
 * SE/PM action: return ALL worker days under a supervisor back to OPEN (unless FINALIZED).
 * Body: { supervisor_id, work_date, reason? }
 */
router.post("/return-supervisor-day", requireAuth, async (req, res) => {
  const decidedBy = req.employee_id || employeeIdFromAuth(req);
  const supervisorId = req.body?.supervisor_id;
  const workDate = req.body?.work_date;
  const reason = req.body?.reason || null;

  if (!decidedBy) return res.status(401).json({ success: false, error: "Unauthorized" });
  if (!supervisorId || !workDate) {
    return res.status(400).json({
      success: false,
      error: { code: "BAD_REQUEST", message: "supervisor_id and work_date are required" },
    });
  }

  try {
    const result = await withClient(async (client) => {
      const q = (t, p) => client.query(t, p);

      // workers who had supervisor-assigned scans that day (same logic as finalize-supervisor-day)
      const w = await q(
        `SELECT DISTINCT employee_id
         FROM assignment_scan
         WHERE supervisor_employee_id = $1 AND work_date = $2`,
        [supervisorId, workDate]
      );
      const workers = w.rows.map((r) => String(r.employee_id));

      const reopened = [];
      const skipped = [];

      for (const empId of workers) {
        const wd = await ensureWorkDay(q, empId, workDate);
        const st = String(wd.day_status).toUpperCase();

        if (st === "FINALIZED") {
          skipped.push({ employee_id: empId, reason: "FINALIZED" });
          continue;
        }

        // Return day back to OPEN
        await q(
          `UPDATE work_day
           SET day_status='OPEN',
               reopened_at = NOW(),
               reopened_by = $3
           WHERE employee_id=$1 AND work_date=$2`,
          [empId, workDate, decidedBy]
        );

        reopened.push(empId);
      }

      return {
        supervisor_id: supervisorId,
        work_date: workDate,
        workers_count: workers.length,
        reopened,
        skipped,
        reason,
      };
    });

    return res.json({ success: true, data: result });
  } catch (e) {
    const status = e.httpStatus || 500;
    return res.status(status).json(e.payload || { success: false, error: e.message || "Unexpected error" });
  }
});


module.exports = router;
