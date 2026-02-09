const express = require("express");
const router = express.Router();
const { pool } = require("../db");

/**
 * DEV AUTH (MVP)
 * Header: Authorization: Bearer DEV-TOKEN-E1001
 */
function devAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.replace("Bearer ", "");
  if (!token.startsWith("DEV-TOKEN-")) {
    return res.status(401).json({ success: false, error: { code: "NOT_AUTHORIZED", message: "Missing/invalid token" } });
  }
  req.employee_id = token.replace("DEV-TOKEN-", "");
  next();
}

/**
 * Helper: fetch supervisor for an employee.
 * Tries `employee` then falls back to `employees` if your schema differs.
 */
async function getSupervisorEmployeeId(employeeId) {
  try {
    const q = await pool.query(`SELECT supervisor_employee_id FROM employee WHERE employee_id=$1`, [employeeId]);
    return q.rows[0]?.supervisor_employee_id ?? null;
  } catch (e) {
    try {
      const q2 = await pool.query(`SELECT supervisor_employee_id FROM employees WHERE employee_id=$1`, [employeeId]);
      return q2.rows[0]?.supervisor_employee_id ?? null;
    } catch (_) {
      return null;
    }
  }
}

/**
 * Phase 2 — Rule 4 (Worker Exceptions)
 *
 * A) "I forgot to scan"  -> creates approval_item (type ForgotScan)
 *    Worker provides intended task + start/end time.
 *    Supervisor approves -> backend inserts a manual Accepted scan + CLOSED task_session.
 *
 * B) "Wrong task scanned" -> creates approval_item (type WrongTask)
 *    Worker references the wrong scan_id and provides corrected project/task.
 *    Supervisor approves -> backend updates that scan to corrected project/task.
 *
 * Supervisor uses existing /approvals/pending and /approvals/:id/decision.
 */

// POST /api/v1/exceptions/forgot-scan
router.post("/forgot-scan", devAuth, async (req, res) => {
  const { work_date, project_id, task_id, start_ts, end_ts, note } = req.body || {};

  if (!work_date || !project_id || !task_id || !start_ts || !end_ts) {
    return res.status(400).json({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "work_date, project_id, task_id, start_ts, end_ts are required" },
    });
  }

  const s = new Date(start_ts);
  const e = new Date(end_ts);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e <= s) {
    return res.status(400).json({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "start_ts/end_ts must be valid ISO timestamps and end_ts > start_ts" },
    });
  }

  const supervisor_employee_id = await getSupervisorEmployeeId(req.employee_id);
  if (!supervisor_employee_id) {
    return res.status(400).json({
      success: false,
      error: { code: "NO_SUPERVISOR", message: "Supervisor is not configured for this employee" },
    });
  }

  try {
    // Ensure assignment_day exists
    const dayQ = await pool.query(
      `SELECT assignment_day_id FROM assignment_day WHERE employee_id=$1 AND work_date=$2`,
      [req.employee_id, work_date]
    );

    let assignment_day_id = dayQ.rows[0]?.assignment_day_id ?? null;
    if (!assignment_day_id) {
      const ins = await pool.query(
        `INSERT INTO assignment_day(employee_id, work_date, status, total_tasks, has_offline_scans)
         VALUES ($1,$2,'PendingApproval',0,false)
         RETURNING assignment_day_id`,
        [req.employee_id, work_date]
      );
      assignment_day_id = ins.rows[0].assignment_day_id;
    }

    const payload = {
      type: "ForgotScan",
      work_date,
      project_id,
      task_id,
      start_ts: s.toISOString(),
      end_ts: e.toISOString(),
      note: note || null,
    };

    const insAppr = await pool.query(
      `INSERT INTO approval_item(
         approval_type, employee_id, supervisor_employee_id,
         assignment_day_id, related_scan_id, status, requested_payload
       )
       VALUES ($1,$2,$3,$4,NULL,'Submitted',$5)
       RETURNING approval_id, created_at`,
      ["ForgotScan", req.employee_id, supervisor_employee_id, assignment_day_id, JSON.stringify(payload)]
    );

    return res.json({
      success: true,
      data: {
        approval_id: insAppr.rows[0].approval_id,
        status: "Submitted",
        supervisor_employee_id,
        created_at: insAppr.rows[0].created_at,
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Unexpected error" } });
  }
});

// POST /api/v1/exceptions/wrong-task
router.post("/wrong-task", devAuth, async (req, res) => {
  const { scan_id, correct_project_id, correct_task_id, note } = req.body || {};

  if (!scan_id || !correct_project_id || !correct_task_id) {
    return res.status(400).json({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "scan_id, correct_project_id, correct_task_id are required" },
    });
  }

  const supervisor_employee_id = await getSupervisorEmployeeId(req.employee_id);
  if (!supervisor_employee_id) {
    return res.status(400).json({
      success: false,
      error: { code: "NO_SUPERVISOR", message: "Supervisor is not configured for this employee" },
    });
  }

  try {
    // Validate scan exists and belongs to this employee
    const scanQ = await pool.query(
      `SELECT scan_id, work_date, project_id, task_id, scan_status
       FROM assignment_scan
       WHERE scan_id=$1 AND employee_id=$2`,
      [scan_id, req.employee_id]
    );

    if (scanQ.rowCount === 0) {
      return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Scan not found for this employee" } });
    }

    const scan = scanQ.rows[0];

    // Ensure assignment_day exists
    const dayQ = await pool.query(
      `SELECT assignment_day_id FROM assignment_day WHERE employee_id=$1 AND work_date=$2`,
      [req.employee_id, scan.work_date]
    );

    let assignment_day_id = dayQ.rows[0]?.assignment_day_id ?? null;
    if (!assignment_day_id) {
      const ins = await pool.query(
        `INSERT INTO assignment_day(employee_id, work_date, status, total_tasks, has_offline_scans)
         VALUES ($1,$2,'PendingApproval',0,false)
         RETURNING assignment_day_id`,
        [req.employee_id, scan.work_date]
      );
      assignment_day_id = ins.rows[0].assignment_day_id;
    }

    const payload = {
      type: "WrongTask",
      scan_id,
      work_date: scan.work_date,
      wrong_project_id: scan.project_id,
      wrong_task_id: scan.task_id,
      correct_project_id,
      correct_task_id,
      note: note || null,
    };

    const insAppr = await pool.query(
      `INSERT INTO approval_item(
         approval_type, employee_id, supervisor_employee_id,
         assignment_day_id, related_scan_id, status, requested_payload
       )
       VALUES ($1,$2,$3,$4,$5,'Submitted',$6)
       RETURNING approval_id, created_at`,
      ["WrongTask", req.employee_id, supervisor_employee_id, assignment_day_id, scan_id, JSON.stringify(payload)]
    );

    return res.json({
      success: true,
      data: {
        approval_id: insAppr.rows[0].approval_id,
        status: "Submitted",
        supervisor_employee_id,
        created_at: insAppr.rows[0].created_at,
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, error: { code: "SERVER_ERROR", message: "Unexpected error" } });
  }
});

module.exports = router;
