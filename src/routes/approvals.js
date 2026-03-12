const express = require("express");
const router = express.Router();
const { pool } = require("../db");

/**
 * DEV AUTH (MVP)
 * Header: Authorization: Bearer DEV-TOKEN-E2001
 */
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

function getPayload(appr) {
  // pg jsonb usually comes as object already; but keep backward compatibility
  if (!appr) return null;
  const rp = appr.requested_payload;
  if (!rp) return null;
  if (typeof rp === "object") return rp;
  try {
    return JSON.parse(rp);
  } catch {
    return null;
  }
}

async function computeDayRollup(client, employeeId, workDate) {
  const dayQ = await client.query(
    `SELECT assignment_day_id
     FROM assignment_day
     WHERE employee_id=$1 AND work_date=$2`,
    [employeeId, workDate]
  );

  if (dayQ.rowCount === 0) {
    return { assignment_day_id: null, total_tasks: 0, status: "NotAssigned" };
  }

  const assignment_day_id = dayQ.rows[0].assignment_day_id;

  const rollQ = await client.query(
    `SELECT
       COUNT(DISTINCT (project_id || '|' || task_id))::int AS distinct_tasks,
       BOOL_OR(scan_status='PendingApproval') AS has_pending
     FROM assignment_scan
     WHERE assignment_day_id=$1`,
    [assignment_day_id]
  );

  const distinctTasks = rollQ.rows[0]?.distinct_tasks ?? 0;
  const hasPending = Boolean(rollQ.rows[0]?.has_pending);
  const status = hasPending ? "PendingApproval" : distinctTasks === 0 ? "NotAssigned" : "Accepted";

  await client.query(
    `UPDATE assignment_day
     SET total_tasks=$1, status=$2, updated_at=now()
     WHERE assignment_day_id=$3`,
    [distinctTasks, status, assignment_day_id]
  );

  return { assignment_day_id, total_tasks: distinctTasks, status };
}

router.get("/pending", devAuth, async (req, res) => {
  try {
    const q = await pool.query(
      `SELECT
         approval_id, approval_type, employee_id, supervisor_employee_id,
         assignment_day_id, related_scan_id, status, requested_payload, created_at
       FROM approval_item
       WHERE status='Submitted' AND (supervisor_employee_id IS NULL OR supervisor_employee_id = $1)
       ORDER BY created_at ASC`,
      [req.employee_id]
    );

    return res.json({
      success: true,
      data: { supervisor_employee_id: req.employee_id, items: q.rows },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      success: false,
      error: { code: "SERVER_ERROR", message: "Unexpected error" },
    });
  }
});

/**
 * Decisions
 * - Over3Tasks: approve/reject scan + rollup day + manage task_session on approve
 * - ForgotScan: approve -> insert Accepted manual scan + CLOSED task_session
 * - WrongTask: approve -> update the scan to corrected project/task (MVP)
 *
 * Uses task_session (not task_sessions)
 */
router.post("/:approval_id/decision", devAuth, async (req, res) => {
  const approvalId = req.params.approval_id;
  const { decision, note } = req.body || {};

  if (!approvalId) {
    return res.status(400).json({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "approval_id is required" },
    });
  }

  const normalized = String(decision || "").trim();
  if (normalized !== "Approved" && normalized !== "Rejected") {
    return res.status(400).json({
      success: false,
      error: { code: "VALIDATION_ERROR", message: 'decision must be "Approved" or "Rejected"' },
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const apprQ = await client.query(
      `SELECT approval_id, approval_type, employee_id, supervisor_employee_id, assignment_day_id,
              related_scan_id, status, requested_payload
       FROM approval_item
       WHERE approval_id=$1
       FOR UPDATE`,
      [approvalId]
    );

    if (apprQ.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "Approval not found" },
      });
    }

    const appr = apprQ.rows[0];

    if (appr.supervisor_employee_id && appr.supervisor_employee_id !== req.employee_id) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        success: false,
        error: { code: "NOT_AUTHORIZED", message: "Not your approval item" },
      });
    }

    if (appr.status !== "Submitted") {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        error: { code: "ALREADY_DECIDED", message: `Approval already ${appr.status}` },
      });
    }

    // update approval item
    await client.query(
      `UPDATE approval_item
       SET status=$1, supervisor_employee_id=COALESCE(supervisor_employee_id,$2)
       WHERE approval_id=$3`,
      [normalized, req.employee_id, approvalId]
    );

    const approvalType = appr.approval_type;
    const payload = getPayload(appr);

    // ----- Over3Tasks -----
    if (approvalType === "Over3Tasks" || approvalType === "RepeatTaskSameDay") {
      // ✅ FIX: use related_scan_id OR fallback to payload.scan_id
      const scanId =
        appr.related_scan_id ||
        payload?.scan_id ||
        payload?.scanId ||
        null;

      if (!scanId) {
        await client.query("ROLLBACK");
        return res.status(500).json({
          success: false,
          error: { code: "SERVER_ERROR", message: "Related scan not found (missing scan_id)" },
        });
      }

      const scanQ = await client.query(
        `SELECT scan_id, employee_id, work_date, project_id, task_id, is_offline, scan_status
         FROM assignment_scan
         WHERE scan_id=$1
         FOR UPDATE`,
        [scanId]
      );

      if (scanQ.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(500).json({
          success: false,
          error: { code: "SERVER_ERROR", message: "Related scan not found" },
        });
      }

      const scan = scanQ.rows[0];
      const newScanStatus = normalized === "Approved" ? "Accepted" : "Rejected";

      await client.query(`UPDATE assignment_scan SET scan_status=$1 WHERE scan_id=$2`, [
        newScanStatus,
        scan.scan_id,
      ]);

      if (normalized === "Approved") {
        const now = new Date();

        // Close existing OPEN session (if any)
        const openQ = await client.query(
          `SELECT session_id, start_ts
           FROM task_session
           WHERE employee_id=$1 AND work_date=$2 AND status='OPEN'
           FOR UPDATE`,
          [scan.employee_id, scan.work_date]
        );

        if (openQ.rowCount > 0) {
          const open = openQ.rows[0];
          await client.query(
            `UPDATE task_session
             SET end_ts=$1,
                 duration_minutes=GREATEST(0, FLOOR(EXTRACT(EPOCH FROM ($1 - start_ts))/60)::int),
                 status='CLOSED'
             WHERE session_id=$2`,
            [now, open.session_id]
          );
        }

        // ✅ IMPORTANT: do NOT insert approval_id into task_session (schema safety)
        await client.query(
          `INSERT INTO task_session(
             employee_id, work_date, project_id, task_id,
             start_ts, end_ts, duration_minutes, is_offline, status
           )
           VALUES ($1,$2,$3,$4,$5,NULL,NULL,$6,'OPEN')`,
          [scan.employee_id, scan.work_date, scan.project_id, scan.task_id, now, Boolean(scan.is_offline)]
        );
      }

      const dayRoll = await computeDayRollup(client, scan.employee_id, scan.work_date);
      await client.query("COMMIT");

      return res.json({
        success: true,
        data: {
          approval_id: approvalId,
          decision: normalized,
          approval_type: approvalType,
          scan_id: scan.scan_id,
          scan_status: newScanStatus,
          note: note || null,
          employee_id: scan.employee_id,
          work_date: scan.work_date,
          assignment_day_status: dayRoll.status,
          assignment_day_total_tasks: dayRoll.total_tasks,
        },
      });
    }

    // ----- ForgotScan -----
    if (approvalType === "ForgotScan") {
      const employeeId = appr.employee_id;
      const workDate = payload?.work_date;
      const projectId = payload?.project_id;
      const taskId = payload?.task_id;
      const startTs = payload?.start_ts;
      const endTs = payload?.end_ts;

      if (!workDate || !projectId || !taskId || !startTs || !endTs) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          success: false,
          error: { code: "VALIDATION_ERROR", message: "ForgotScan payload is missing required fields" },
        });
      }

      const s = new Date(startTs);
      const e = new Date(endTs);
      if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e <= s) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          success: false,
          error: { code: "VALIDATION_ERROR", message: "ForgotScan payload timestamps invalid" },
        });
      }

      if (normalized === "Approved") {
        const clientRef = `MANUAL-FORGOT-${approvalId}`;

        // ensure day exists (lock)
        const dayQ = await client.query(
          `SELECT assignment_day_id
           FROM assignment_day
           WHERE employee_id=$1 AND work_date=$2
           FOR UPDATE`,
          [employeeId, workDate]
        );

        let assignment_day_id = dayQ.rows[0]?.assignment_day_id ?? null;
        if (!assignment_day_id) {
          const ins = await client.query(
            `INSERT INTO assignment_day(employee_id, work_date, status, total_tasks, has_offline_scans)
             VALUES ($1,$2,'Accepted',0,false)
             RETURNING assignment_day_id`,
            [employeeId, workDate]
          );
          assignment_day_id = ins.rows[0].assignment_day_id;
        }

        const insScan = await client.query(
          `INSERT INTO assignment_scan(
            assignment_day_id, employee_id, work_date, project_id, task_id,
            scan_timestamp_device, supervisor_employee_id, gps_lat, gps_lon,
            is_offline, scan_status, client_reference_id
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,NULL,false,'Accepted',$8)
          RETURNING scan_id`,
          [assignment_day_id, employeeId, workDate, projectId, taskId, s, req.employee_id, clientRef]
        );

        // ✅ no approval_id column
        await client.query(
          `INSERT INTO task_session(
             employee_id, work_date, project_id, task_id,
             start_ts, end_ts, duration_minutes, is_offline, status
           )
           VALUES ($1,$2,$3,$4,$5,$6,
             GREATEST(0, FLOOR(EXTRACT(EPOCH FROM ($6 - $5))/60)::int),
             false,'CLOSED')`,
          [employeeId, workDate, projectId, taskId, s, e]
        );

        const dayRoll = await computeDayRollup(client, employeeId, workDate);
        await client.query("COMMIT");

        return res.json({
          success: true,
          data: {
            approval_id: approvalId,
            decision: normalized,
            approval_type: approvalType,
            scan_status: "Accepted",
            created_scan_id: insScan.rows[0].scan_id,
            note: note || payload?.note || null,
            employee_id: employeeId,
            work_date: workDate,
            assignment_day_status: dayRoll.status,
            assignment_day_total_tasks: dayRoll.total_tasks,
          },
        });
      } else {
        const dayRoll = await computeDayRollup(client, employeeId, workDate);
        await client.query("COMMIT");
        return res.json({
          success: true,
          data: {
            approval_id: approvalId,
            decision: normalized,
            approval_type: approvalType,
            scan_status: null,
            note: note || payload?.note || null,
            employee_id: employeeId,
            work_date: workDate,
            assignment_day_status: dayRoll.status,
            assignment_day_total_tasks: dayRoll.total_tasks,
          },
        });
      }
    }

    // ----- WrongTask -----
    if (approvalType === "WrongTask") {
      const scanId = appr.related_scan_id || payload?.scan_id || payload?.scanId;
      const correctProjectId = payload?.correct_project_id;
      const correctTaskId = payload?.correct_task_id;

      if (!scanId || !correctProjectId || !correctTaskId) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          success: false,
          error: { code: "VALIDATION_ERROR", message: "WrongTask payload is missing required fields" },
        });
      }

      const scanQ = await client.query(
        `SELECT scan_id, employee_id, work_date, project_id, task_id, scan_status
         FROM assignment_scan
         WHERE scan_id=$1
         FOR UPDATE`,
        [scanId]
      );

      if (scanQ.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          success: false,
          error: { code: "NOT_FOUND", message: "Scan not found" },
        });
      }

      const scan = scanQ.rows[0];

      if (normalized === "Approved") {
        await client.query(
          `UPDATE assignment_scan
           SET project_id=$1, task_id=$2, scan_status='Accepted'
           WHERE scan_id=$3`,
          [correctProjectId, correctTaskId, scan.scan_id]
        );

        await client.query(
          `UPDATE task_session
           SET project_id=$1, task_id=$2
           WHERE employee_id=$3 AND work_date=$4 AND status='OPEN' AND project_id=$5 AND task_id=$6`,
          [correctProjectId, correctTaskId, scan.employee_id, scan.work_date, scan.project_id, scan.task_id]
        );
      }

      const dayRoll = await computeDayRollup(client, scan.employee_id, scan.work_date);
      await client.query("COMMIT");

      return res.json({
        success: true,
        data: {
          approval_id: approvalId,
          decision: normalized,
          approval_type: approvalType,
          scan_id: scan.scan_id,
          scan_status: normalized === "Approved" ? "Accepted" : scan.scan_status,
          note: note || payload?.note || null,
          employee_id: scan.employee_id,
          work_date: scan.work_date,
          assignment_day_status: dayRoll.status,
          assignment_day_total_tasks: dayRoll.total_tasks,
        },
      });
    }

    await client.query("ROLLBACK");
    return res.status(400).json({
      success: false,
      error: { code: "VALIDATION_ERROR", message: `Unsupported approval_type: ${approvalType}` },
    });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    console.error(e);
    return res.status(500).json({
      success: false,
      error: { code: "SERVER_ERROR", message: "Unexpected error" },
    });
  } finally {
    client.release();
  }
});

module.exports = router;
