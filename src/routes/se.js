// D:\MARCO-Workforce-App\backend\src\routes\se.js
const express = require("express");
const router = express.Router();

const requireAuth = require("../middleware/requireAuth");
const db = require("../db");

// ---- DB helpers (support db exports: Pool, {pool}, {query}) ----
function getPool() {
  if (db && typeof db.query === "function") return db; // exported Pool-like
  if (db && db.pool && typeof db.pool.query === "function") return db.pool; // exported {pool}
  if (db && db.default && typeof db.default.query === "function") return db.default;
  throw new Error("DB pool not found: ../db must export a pg Pool or { pool }");
}

async function withClient(fn) {
  const pool = getPool();
  if (typeof pool.connect === "function") {
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }
  return await fn(pool);
}

function ok(res, data) {
  return res.json({ success: true, data });
}
function fail(res, code, message, status = 400) {
  return res.status(status).json({ success: false, error: { code, message } });
}

// Your middleware usually sets req.user.
// We’ll support both req.user.employee_id and req.user.employeeId.
function employeeIdFromReq(req) {
  return (
    req?.user?.employee_id ||
    req?.user?.employeeId ||
    req?.user?.id ||
    null
  );
}
function roleFromReq(req) {
  return (req?.user?.role || "").toString().toUpperCase();
}

async function requireSE(req, res) {
  const empId = employeeIdFromReq(req);
  if (!empId) {
    fail(res, "UNAUTHORIZED", "Unauthorized", 401);
    return false;
  }

  const pool = getPool();

  const r = await pool.query(
    "SELECT role FROM employees WHERE employee_id = $1 LIMIT 1",
    [empId]
  );

  if (!r.rowCount) {
    fail(res, "FORBIDDEN", "Employee not found", 403);
    return false;
  }

  const role = (r.rows[0].role || "").toString().toUpperCase();

  if (!["SE", "ADMIN"].includes(role)) {
    fail(res, "FORBIDDEN", "SE access required", 403);
    return false;
  }

  return true;
}

async function ensureSupervisorBelongsToSE(client, seId, supervisorId) {
  // Supervisor must report to this SE (employees.supervisor_employee_id = SE)
  const q = `
    SELECT employee_id, full_name, role, supervisor_employee_id
    FROM employees
    WHERE employee_id = $1
    LIMIT 1
  `;
  const r = await client.query(q, [supervisorId]);
  if (r.rowCount === 0) return { ok: false, code: "NOT_FOUND", msg: "Supervisor not found" };

  const sup = r.rows[0];
  const supRole = (sup.role || "").toString().toUpperCase();

  // In your data, supervisors use role ADMIN (example E2001).
  // Allow ADMIN or SUPERVISOR.
  if (!["ADMIN", "SUPERVISOR"].includes(supRole)) {
    return { ok: false, code: "INVALID", msg: "Employee is not a supervisor" };
  }

  if ((sup.supervisor_employee_id || "").toString() !== seId) {
    return { ok: false, code: "FORBIDDEN", msg: "Supervisor does not report to this SE" };
  }

  return { ok: true, supervisor: sup };
}

async function getWorkersForSupervisor(client, supervisorId) {
  // Workers report to supervisor via supervisor_employee_id
  const q = `
    SELECT employee_id, full_name
    FROM employees
    WHERE supervisor_employee_id = $1
      AND UPPER(role) = 'WORKER'
    ORDER BY employee_id
  `;
  const r = await client.query(q, [supervisorId]);
  return r.rows;
}

async function anyOpenTaskSessions(client, employeeIds, workDate) {
  if (!employeeIds.length) return false;

  const q = `
    SELECT 1
    FROM task_session
    WHERE employee_id = ANY($1)
      AND work_date = $2::date
      AND status = 'OPEN'
    LIMIT 1
  `;
  const r = await client.query(q, [employeeIds, workDate]);
  return r.rowCount > 0;
}

// ----------------------------
// GET /api/v1/se/supervisors
// ----------------------------
router.get("/supervisors", requireAuth, async (req, res) => {
  if (!requireSE(req, res)) return;

  const seId = employeeIdFromReq(req);
  if (!seId) return fail(res, "UNAUTHORIZED", "Missing auth identity", 401);

  try {
    const data = await withClient(async (client) => {
      const q = `
        SELECT employee_id, full_name, role
        FROM employees
        WHERE supervisor_employee_id = $1
          AND UPPER(role) IN ('ADMIN','SUPERVISOR')
        ORDER BY employee_id
      `;
      const r = await client.query(q, [seId]);
      return { se_id: seId, supervisors: r.rows };
    });

    return ok(res, data);
  } catch (e) {
    return fail(res, "SERVER_ERROR", e?.message || String(e), 500);
  }
});

// ----------------------------------------------------------
// POST /api/v1/se/supervisors/:supervisorId/return-day
//   ?work_date=YYYY-MM-DD
// returns CLOSED worker-days back to OPEN for that supervisor
// ----------------------------------------------------------
router.post("/supervisors/:supervisorId/return-day", requireAuth, async (req, res) => {
  if (!requireSE(req, res)) return;

  const seId = employeeIdFromReq(req);
  if (!seId) return fail(res, "UNAUTHORIZED", "Missing auth identity", 401);

  const { supervisorId } = req.params;
  const workDate = (req.query.work_date || "").toString();
  if (!workDate) return fail(res, "VALIDATION", "work_date is required (YYYY-MM-DD)", 400);

  try {
    const data = await withClient(async (client) => {
      const check = await ensureSupervisorBelongsToSE(client, seId, supervisorId);
      if (!check.ok) return { __fail: check };

      const workers = await getWorkersForSupervisor(client, supervisorId);
      const workerIds = workers.map((w) => w.employee_id);

      // Return means: CLOSED -> OPEN (do NOT touch FINALIZED)
      const upd = `
        UPDATE work_day
        SET day_status = 'OPEN',
            reopened_at = NOW(),
            reopened_by = $3
        WHERE employee_id = ANY($1)
          AND work_date = $2::date
          AND day_status = 'CLOSED'
        RETURNING employee_id, work_date, day_status
      `;
      const r = await client.query(upd, [workerIds, workDate, seId]);

      return {
        se_id: seId,
        supervisor_id: supervisorId,
        work_date: workDate,
        returned_workers: r.rows,
        returned_count: r.rowCount,
      };
    });

    if (data && data.__fail) {
      const f = data.__fail;
      const status = f.code === "FORBIDDEN" ? 403 : f.code === "NOT_FOUND" ? 404 : 400;
      return fail(res, f.code, f.msg, status);
    }

    return ok(res, data);
  } catch (e) {
    return fail(res, "SERVER_ERROR", e?.message || String(e), 500);
  }
});

// ----------------------------------------------------------
// POST /api/v1/se/supervisors/:supervisorId/finalize-day
//   ?work_date=YYYY-MM-DD
// FINALIZED is done by SE for ALL workers under that supervisor
// ----------------------------------------------------------
router.post("/supervisors/:supervisorId/finalize-day", requireAuth, async (req, res) => {
  if (!requireSE(req, res)) return;

  const seId = employeeIdFromReq(req);
  if (!seId) return fail(res, "UNAUTHORIZED", "Missing auth identity", 401);

  const { supervisorId } = req.params;
  const workDate = (req.query.work_date || "").toString();
  if (!workDate) return fail(res, "VALIDATION", "work_date is required (YYYY-MM-DD)", 400);

  try {
    const data = await withClient(async (client) => {
      const check = await ensureSupervisorBelongsToSE(client, seId, supervisorId);
      if (!check.ok) return { __fail: check };

      const workers = await getWorkersForSupervisor(client, supervisorId);
      const workerIds = workers.map((w) => w.employee_id);

      // Safety: don’t finalize if any worker still has an OPEN task_session
      const hasOpen = await anyOpenTaskSessions(client, workerIds, workDate);
      if (hasOpen) {
        return { __fail: { ok: false, code: "CONFLICT", msg: "Some workers still have an OPEN task/session. Supervisor must close tasks first." } };
      }

      // Only CLOSED -> FINALIZED
      const upd = `
        UPDATE work_day
        SET day_status = 'FINALIZED',
            final_closed_at = NOW(),
            final_closed_by = $3
        WHERE employee_id = ANY($1)
          AND work_date = $2::date
          AND day_status = 'CLOSED'
        RETURNING employee_id, work_date, day_status
      `;
      const r = await client.query(upd, [workerIds, workDate, seId]);

      return {
        se_id: seId,
        supervisor_id: supervisorId,
        work_date: workDate,
        finalized_workers: r.rows,
        finalized_count: r.rowCount,
      };
    });

    if (data && data.__fail) {
      const f = data.__fail;
      const status =
        f.code === "FORBIDDEN" ? 403 :
        f.code === "NOT_FOUND" ? 404 :
        f.code === "CONFLICT" ? 409 :
        400;
      return fail(res, f.code, f.msg, status);
    }

    return ok(res, data);
  } catch (e) {
    return fail(res, "SERVER_ERROR", e?.message || String(e), 500);
  }
});

// ---- DEBUG: print registered routes once on load ----
try {
  const routes = router.stack
    .filter((l) => l.route && l.route.path)
    .map((l) => ({
      methods: Object.keys(l.route.methods).join(",").toUpperCase(),
      path: l.route.path,
    }));
  console.log("[SE ROUTES] registered:", routes);
} catch (e) {
  console.log("[SE ROUTES] could not print routes:", e.message);
}

// ------------------------------------------------------------------
// Worker-level: return ONE worker day back to OPEN (SE -> Supervisor)
// POST /api/v1/se/supervisors/:supervisorId/workers/:workerId/return-day?work_date=YYYY-MM-DD
// ------------------------------------------------------------------
router.post(
  "/supervisors/:supervisorId/workers/:workerId/return-day",
  requireAuth,
  async (req, res) => {
    if (!(await requireSE(req, res))) return;

    const seId = employeeIdFromReq(req);
    const { supervisorId, workerId } = req.params;
    const workDate = (req.query.work_date || "").toString().trim();
    if (!workDate) return fail(res, "VALIDATION", "work_date is required (YYYY-MM-DD)", 400);

    try {
      const data = await withClient(async (client) => {
        // Ensure supervisor belongs to this SE
        const check = await ensureSupervisorBelongsToSE(client, seId, supervisorId);
        if (!check.ok) return { __fail: check };

        // Ensure worker belongs to this supervisor
        const w = await client.query(
          `SELECT employee_id, supervisor_employee_id, role
           FROM employees
           WHERE employee_id = $1
           LIMIT 1`,
          [workerId]
        );
        if (!w.rowCount) return { __fail: { ok: false, code: "NOT_FOUND", msg: "Worker not found" } };
        if ((w.rows[0].supervisor_employee_id || "") !== supervisorId) {
          return { __fail: { ok: false, code: "FORBIDDEN", msg: "Worker not under this supervisor" } };
        }
        if ((w.rows[0].role || "").toString().toUpperCase() !== "WORKER") {
          return { __fail: { ok: false, code: "INVALID", msg: "Employee is not WORKER" } };
        }

        // Return only if CLOSED (do not reopen FINALIZED by default)
        const upd = await client.query(
          `
          UPDATE work_day
          SET day_status='OPEN',
              reopened_at=NOW(),
              reopened_by=$3
          WHERE employee_id=$1
            AND work_date=$2::date
            AND day_status='CLOSED'
          RETURNING employee_id, work_date, day_status
          `,
          [workerId, workDate, seId]
        );

        return {
          se_id: seId,
          supervisor_id: supervisorId,
          worker_id: workerId,
          work_date: workDate,
          returned: upd.rows[0] || null,
          returned_count: upd.rowCount,
        };
      });

      if (data && data.__fail) {
        const f = data.__fail;
        const status =
          f.code === "FORBIDDEN" ? 403 :
          f.code === "NOT_FOUND" ? 404 :
          400;
        return fail(res, f.code, f.msg, status);
      }

      return ok(res, data);
    } catch (e) {
      return fail(res, "SERVER_ERROR", e?.message || String(e), 500);
    }
  }
);

// ------------------------------------------------------------------
// Worker-level: finalize ONE worker day (CLOSED -> FINALIZED)
// POST /api/v1/se/supervisors/:supervisorId/workers/:workerId/finalize-day?work_date=YYYY-MM-DD
// ------------------------------------------------------------------
router.post(
  "/supervisors/:supervisorId/workers/:workerId/finalize-day",
  requireAuth,
  async (req, res) => {
    if (!(await requireSE(req, res))) return;

    const seId = employeeIdFromReq(req);
    const { supervisorId, workerId } = req.params;
    const workDate = (req.query.work_date || "").toString().trim();
    if (!workDate) return fail(res, "VALIDATION", "work_date is required (YYYY-MM-DD)", 400);

    try {
      const data = await withClient(async (client) => {
        // Ensure supervisor belongs to this SE
        const check = await ensureSupervisorBelongsToSE(client, seId, supervisorId);
        if (!check.ok) return { __fail: check };

        // Ensure worker belongs to this supervisor
        const w = await client.query(
          `SELECT employee_id, supervisor_employee_id, role
           FROM employees
           WHERE employee_id = $1
           LIMIT 1`,
          [workerId]
        );
        if (!w.rowCount) return { __fail: { ok: false, code: "NOT_FOUND", msg: "Worker not found" } };
        if ((w.rows[0].supervisor_employee_id || "") !== supervisorId) {
          return { __fail: { ok: false, code: "FORBIDDEN", msg: "Worker not under this supervisor" } };
        }

        // Safety: don't finalize if worker still has OPEN task_session
        const open = await client.query(
          `
          SELECT 1
          FROM task_session
          WHERE employee_id=$1
            AND work_date=$2::date
            AND status='OPEN'
          LIMIT 1
          `,
          [workerId, workDate]
        );
        if (open.rowCount > 0) {
          return { __fail: { ok: false, code: "CONFLICT", msg: "Worker has OPEN task/session. Supervisor must close tasks first." } };
        }

        const upd = await client.query(
          `
          UPDATE work_day
          SET day_status='FINALIZED',
              final_closed_at=NOW(),
              final_closed_by=$3
          WHERE employee_id=$1
            AND work_date=$2::date
            AND day_status='CLOSED'
          RETURNING employee_id, work_date, day_status
          `,
          [workerId, workDate, seId]
        );

        return {
          se_id: seId,
          supervisor_id: supervisorId,
          worker_id: workerId,
          work_date: workDate,
          finalized: upd.rows[0] || null,
          finalized_count: upd.rowCount,
        };
      });

      if (data && data.__fail) {
        const f = data.__fail;
        const status =
          f.code === "FORBIDDEN" ? 403 :
          f.code === "NOT_FOUND" ? 404 :
          f.code === "CONFLICT" ? 409 :
          400;
        return fail(res, f.code, f.msg, status);
      }

      return ok(res, data);
    } catch (e) {
      return fail(res, "SERVER_ERROR", e?.message || String(e), 500);
    }
  }
);

module.exports = router;