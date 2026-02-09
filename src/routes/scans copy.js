/**
 * MARCO Workforce - scans.js (auth fix + compatibility)
 *
 * Fixes:
 * - employee_id was undefined because requireAuth attaches user info on req.user (not req.employee_id)
 * - Adds safe employeeIdFromAuth(req) + DEV-TOKEN fallback (Bearer DEV-TOKEN-E1001)
 * - Accepts body.items OR body.scans; parses req.body if it's a string
 * - Removes work_day created_at/updated_at usage (schema mismatch)
 *
 * Business logic unchanged.
 */
const express = require("express");
const router = express.Router();

const { pool } = require("../db");

// IMPORTANT: keep using your existing middleware path/name
const requireAuth = require("../middleware/requireAuth");

// ---- Auth helpers ----
function employeeIdFromAuth(req) {
  const direct =
    req.employee_id ||
    req.employeeId ||
    (req.user && (req.user.employee_id || req.user.employeeId)) ||
    (req.auth && (req.auth.employee_id || req.auth.employeeId)) ||
    (req.claims && (req.claims.employee_id || req.claims.employeeId));

  if (direct) return String(direct);

  // DEV token fallback: "Bearer DEV-TOKEN-E1001"
  const h = req.headers.authorization || "";
  const m = h.match(/Bearer\s+DEV-TOKEN-([A-Za-z0-9_-]+)/i);
  if (m && m[1]) return String(m[1]);

  return null;
}

// --- QR helpers ---
function parseQrFlexible(qr) {
  if (typeof qr !== "string") return null;
  const s = qr.trim();
  if (!s) return null;
  const delim = s.includes("|") ? "|" : s.includes("/") ? "/" : null;
  if (!delim) return null;
  const parts = s.split(delim).map((x) => x.trim());
  if (parts.length !== 2) return null;
  const [project_id, task_id] = parts;
  if (!project_id || !task_id) return null;
  return { project_id, task_id };
}

// --- DB helpers ---
async function ensureWorkDay(client, employeeId, workDate) {
  await client.query(
    `INSERT INTO work_day (employee_id, work_date, day_status)
     VALUES ($1,$2,'OPEN')
     ON CONFLICT (employee_id, work_date) DO NOTHING`,
    [employeeId, workDate]
  );

  const r = await client.query(
    `SELECT employee_id, work_date, day_status, closed_at, closed_by, reopened_at, reopened_by
       FROM work_day
      WHERE employee_id=$1 AND work_date=$2`,
    [employeeId, workDate]
  );
  return r.rows[0];
}

async function getOrCreateAssignmentDay(client, employeeId, workDate) {
  const ins = await client.query(
    `INSERT INTO assignment_day (employee_id, work_date, status, total_tasks, has_offline_scans)
     VALUES ($1,$2,'Accepted',0,false)
     ON CONFLICT (employee_id, work_date) DO UPDATE SET employee_id=EXCLUDED.employee_id
     RETURNING assignment_day_id`,
    [employeeId, workDate]
  );
  return ins.rows[0].assignment_day_id;
}

async function isDuplicateScan(client, employeeId, workDate, projectId, taskId) {
  const r = await client.query(
    `SELECT 1
       FROM assignment_scan
      WHERE employee_id=$1 AND work_date=$2 AND project_id=$3 AND task_id=$4
        AND scan_status <> 'Rejected'
      LIMIT 1`,
    [employeeId, workDate, projectId, taskId]
  );
  return r.rowCount > 0;
}

async function acceptedCountForDay(client, employeeId, workDate) {
  const r = await client.query(
    `SELECT COUNT(*)::int AS c
       FROM assignment_scan
      WHERE employee_id=$1 AND work_date=$2 AND scan_status='Accepted'`,
    [employeeId, workDate]
  );
  return r.rows[0]?.c ?? 0;
}

// Keep your real implementation if you already have one elsewhere.
async function rebuildTaskSessionsForDay(client, employeeId, workDate) {
  const q = (t, p) => client.query(t, p);

  // Remove and rebuild sessions from scans
  await q(`DELETE FROM task_session WHERE employee_id=$1 AND work_date=$2`, [employeeId, workDate]);

  const scans = await q(
    `
    SELECT project_id, task_id, scan_timestamp_device
      FROM assignment_scan
     WHERE employee_id=$1 AND work_date=$2 AND scan_status <> 'Rejected'
     ORDER BY scan_timestamp_device ASC
    `,
    [employeeId, workDate]
  );

  const rows = scans.rows || [];
  for (let i = 0; i < rows.length; i++) {
    const cur = rows[i];
    const next = rows[i + 1] || null;

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
        employee_id, work_date,
        project_id, task_id,
        start_ts, end_ts, duration_minutes,
        is_offline, status, approval_id
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,false,$8,NULL)
      `,
      [employeeId, workDate, cur.project_id, cur.task_id, startTs, endTs, duration, status]
    );
  }
}


// --- Route ---
router.post("/batch", requireAuth, async (req, res) => {
  const employeeId = employeeIdFromAuth(req);
  const auth = req.headers.authorization || "";

  try {
    // Robust body parsing
    let b = req.body;
    if (typeof b === "string") {
      try { b = JSON.parse(b); } catch (_) {}
    }
    if (!b || typeof b !== "object") b = {};

    // Accept items OR scans (array or single object)
    let rawItems = [];
    if (Array.isArray(b.items)) rawItems = b.items;
    else if (Array.isArray(b.scans)) rawItems = b.scans;
    else if (b.items && typeof b.items === "object") rawItems = [b.items];
    else if (b.scans && typeof b.scans === "object") rawItems = [b.scans];

    const deviceId = b.device_id || b.deviceId || "unknown";
    const workDateTop = b.work_date || b.workDate || null;

    const scans = rawItems
      .map((it) => {
        if (!it || typeof it !== "object") return null;

        let projectId = it.project_id || it.projectId || null;
        let taskId = it.task_id || it.taskId || null;

        if ((!projectId || !taskId) && it.qr) {
          const parsed = parseQrFlexible(String(it.qr));
          if (parsed) {
            projectId = parsed.project_id;
            taskId = parsed.task_id;
          }
        }

        const workDate = it.work_date || it.workDate || workDateTop;
        const clientRef =
          it.client_reference_id ||
          it.clientReferenceId ||
          it.local_id ||
          it.localId ||
          null;

        const ts =
          it.scan_timestamp_device ||
          it.scanTimestampDevice ||
          new Date().toISOString();

        const isOffline = it.is_offline === true || it.is_offline === 1;

        if (!projectId || !taskId || !workDate) return null;

        return {
          client_reference_id:
            clientRef ||
            `${employeeId || "unknown"}-${workDate}-${projectId}-${taskId}-${Date.now()}`,
          work_date: workDate,
          project_id: String(projectId),
          task_id: String(taskId),
          scan_timestamp_device: ts,
          is_offline: !!isOffline,
          qr: it.qr ? String(it.qr) : `${projectId}|${taskId}`,
        };
      })
      .filter(Boolean);

    console.log("[SCANS] Authorization:", auth);
    console.log(
      "[SCANS] batch by employee=%s work_date=%s device=%s count=%d bodyKeys=%s",
      employeeId,
      scans[0]?.work_date || workDateTop || "-",
      deviceId,
      scans.length,
      Object.keys(b)
    );

    if (!employeeId) {
      return res.status(401).json({
        success: false,
        error: { code: "UNAUTHORIZED", message: "Unauthorized" },
      });
    }

    if (!Array.isArray(scans) || scans.length === 0) {
      return res.status(400).json({
        success: false,
        error: { code: "NO_SCANS", message: "No scans provided" },
      });
    }

    const client = await pool.connect();
    const results = [];

    try {
      await client.query("BEGIN");

      const batchWorkDate = scans[0].work_date;

      const wd = await ensureWorkDay(client, employeeId, batchWorkDate);
      if (String(wd.day_status || "").toUpperCase() === "CLOSED") {
        await client.query("ROLLBACK");
        return res.status(409).json({
          success: false,
          error: {
            code: "DAY_CLOSED",
            message: "Day is CLOSED. Contact your supervisor to assign a new task.",
          },
          data: { employee_id: employeeId, work_date: batchWorkDate },
        });
      }

      const assignmentDayId = await getOrCreateAssignmentDay(client, employeeId, batchWorkDate);

      for (const s of scans) {
        const dup = await isDuplicateScan(client, employeeId, s.work_date, s.project_id, s.task_id);
        if (dup) {
          results.push({
            client_reference_id: s.client_reference_id,
            qr: s.qr,
            status: "Rejected",
            error: { code: "DUPLICATE", message: "Duplicate task for this day." },
          });
          continue;
        }

        const acceptedCount = await acceptedCountForDay(client, employeeId, s.work_date);

        let scanStatus = "Accepted";
        let approvalId = null;
        let note = "Accepted.";

        if (acceptedCount >= 3) {
          scanStatus = "PendingApproval";
          note = "Pending supervisor approval (>3 tasks/day).";

          const ai = await client.query(
            `INSERT INTO approval_item (
               approval_type, employee_id, supervisor_employee_id,
               assignment_day_id, status, requested_payload, created_at, updated_at
             )
             VALUES ('Over3Tasks', $1, NULL, $2, 'Submitted', $3::jsonb, NOW(), NOW())
             RETURNING approval_id`,
            [
              employeeId,
              assignmentDayId,
              JSON.stringify({
                work_date: s.work_date,
                project_id: s.project_id,
                task_id: s.task_id,
                via: "WorkerScan",
              }),
            ]
          );
          approvalId = ai.rows[0].approval_id;
        }

        // ✅ FIX: include client_reference_id in INSERT (your DB requires it NOT NULL)
        const ins = await client.query(
          `INSERT INTO assignment_scan (
             client_reference_id,
             assignment_day_id, employee_id, work_date, project_id, task_id,
             scan_timestamp_device, scan_timestamp_server,
             is_offline, scan_status
           )
           VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),$8,$9)
           RETURNING scan_id`,
          [
            s.client_reference_id,
            assignmentDayId,
            employeeId,
            s.work_date,
            s.project_id,
            s.task_id,
            s.scan_timestamp_device,
            s.is_offline,
            scanStatus,
          ]
        );

        // ✅ Small safe improvement: store scan_id inside approval payload (helps approval decision find the scan)
        if (approvalId) {
          await client.query(
            `UPDATE approval_item
               SET requested_payload = COALESCE(requested_payload, '{}'::jsonb)
                   || jsonb_build_object('scan_id', $2::text),
                   updated_at = NOW()
             WHERE approval_id = $1`,
            [approvalId, ins.rows[0].scan_id]
          );
        }

        if (scanStatus === "Accepted") {
          await rebuildTaskSessionsForDay(client, employeeId, s.work_date);
        }

        results.push({
          client_reference_id: s.client_reference_id,
          qr: s.qr,
          status: scanStatus,
          note,
          scan_id: ins.rows[0].scan_id,
          approval_id: approvalId,
        });
      }

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("[SCANS] error:", e);
      return res.status(500).json({
        success: false,
        error: { code: "SERVER_ERROR", message: e.message || "Server error" },
      });
    } finally {
      client.release();
    }
   return res.json({
    success: true,
    data: {
      results,
    },
  });

  } catch (e) {
    console.error("[SCANS] fatal:", e);
    return res.status(500).json({
      success: false,
      error: { code: "INTERNAL_ERROR", message: e.message || "Internal error" },
    });
  }
});

module.exports = router;
