/**
 * MARCO Workforce - scans.js
 *  replaced to fix scan issue 
 * Current behavior kept:
 * - auth via requireAuth
 * - DEV-TOKEN fallback
 * - accepts body.items OR body.scans
 * - duplicate check
 * - >3 tasks/day => PendingApproval
 * - rebuild task sessions for accepted scans
 * - day closed check
 *
 * Secure QR support:
 * - NEW: release_id|work_date
 * - LEGACY: MARCO|RLS|<release_id>
 * - OLD fallback: project_id|task_id
 * - slash fallback: project_id/task_id
 *
 * Team validation:
 * - worker can only scan a task released to their supervisor team
 * - compare supervisor ids safely with trim + uppercase
 */

const express = require("express");
const router = express.Router();

const { pool } = require("../db");
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

function isIsoDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.trim());
}

function looksLikeUuid(s) {
  return typeof s === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s.trim());
}

function norm(v) {
  return String(v || "").trim().toUpperCase();
}

// --- QR helpers ---
function parseQrFlexible(qr) {
  if (typeof qr !== "string") return null;
  const s = qr.trim();
  if (!s) return null;

  const parts = s.split("|").map((x) => x.trim());

  // LEGACY secure QR format: MARCO|RLS|release_id
  if (parts.length === 3 && parts[0].toUpperCase() === "MARCO" && parts[1].toUpperCase() === "RLS") {
    if (!parts[2]) return null;
    return { release_id: parts[2] };
  }

  // NEW secure QR format: release_id|work_date
  if (parts.length === 2 && looksLikeUuid(parts[0]) && isIsoDate(parts[1])) {
    return {
      release_id: parts[0],
      qr_work_date: parts[1],
    };
  }

  // OLD QR fallback: project_id|task_id
  if (parts.length === 2) {
    const [project_id, task_id] = parts;
    if (!project_id || !task_id) return null;
    return { project_id, task_id };
  }

  // optional slash fallback
  if (s.includes("/")) {
    const slashParts = s.split("/").map((x) => x.trim());
    if (slashParts.length === 2) {
      const [project_id, task_id] = slashParts;
      if (!project_id || !task_id) return null;
      return { project_id, task_id };
    }
  }

  return null;
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

async function getWorkerSupervisorId(client, employeeId) {
  const r = await client.query(
    `
    SELECT supervisor_employee_id
    FROM employees
    WHERE employee_id = $1
    LIMIT 1
    `,
    [employeeId]
  );

  if (r.rowCount === 0) return null;
  return r.rows[0]?.supervisor_employee_id || null;
}

async function findActiveReleaseForSupervisor(client, projectId, taskId, supervisorEmployeeId) {
  if (!supervisorEmployeeId) return null;

  const r = await client.query(
    `
    SELECT
      release_id,
      project_id,
      task_id,
      se_employee_id,
      supervisor_employee_id,
      release_status,
      released_at,
      released_by,
      min_workers,
      max_workers
    FROM task_releases
    WHERE project_id = $1
      AND task_id = $2
      AND supervisor_employee_id = $3
      AND release_status = 'ACTIVE'
    ORDER BY released_at DESC
    LIMIT 1
    `,
    [projectId, taskId, supervisorEmployeeId]
  );

  return r.rowCount > 0 ? r.rows[0] : null;
}

async function findReleaseById(client, releaseId) {
  if (!releaseId) return null;

  const r = await client.query(
    `
    SELECT
      release_id,
      project_id,
      task_id,
      se_employee_id,
      supervisor_employee_id,
      release_status,
      released_at,
      released_by,
      min_workers,
      max_workers
    FROM task_releases
    WHERE release_id = $1
    LIMIT 1
    `,
    [releaseId]
  );

  return r.rowCount > 0 ? r.rows[0] : null;
}

async function currentOpenWorkersForTask(client, projectId, taskId, workDate) {
  const r = await client.query(
    `
    SELECT COUNT(DISTINCT employee_id)::int AS c
    FROM task_session
    WHERE project_id = $1
      AND task_id = $2
      AND work_date = $3
      AND status = 'OPEN'
    `,
    [projectId, taskId, workDate]
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
      try {
        b = JSON.parse(b);
      } catch (_) {}
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
        let releaseId = null;
        let qrWorkDate = null;

        if (it.qr) {
          const parsed = parseQrFlexible(String(it.qr));
          if (parsed) {
            if (parsed.release_id) {
              releaseId = parsed.release_id;
            }
            if (parsed.qr_work_date) {
              qrWorkDate = parsed.qr_work_date;
            }
            if (parsed.project_id && parsed.task_id) {
              projectId = parsed.project_id;
              taskId = parsed.task_id;
            }
          }
        }

        const workDate = it.work_date || it.workDate || qrWorkDate || workDateTop;
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

        // For secure QR, project/task may be resolved later from releaseId.
        if (!workDate) return null;
        if (!releaseId && (!projectId || !taskId)) return null;

        return {
          client_reference_id:
            clientRef ||
            `${employeeId || "unknown"}-${workDate}-${projectId || "release"}-${taskId || releaseId}-${Date.now()}`,
          work_date: workDate,
          project_id: projectId ? String(projectId) : null,
          task_id: taskId ? String(taskId) : null,
          release_id: releaseId ? String(releaseId) : null,
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

      const workerSupervisorId = await getWorkerSupervisorId(client, employeeId);
      if (!workerSupervisorId) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          success: false,
          error: {
            code: "SUPERVISOR_NOT_FOUND",
            message: "Worker has no supervisor assigned.",
          },
          data: { employee_id: employeeId },
        });
      }

      const assignmentDayId = await getOrCreateAssignmentDay(client, employeeId, batchWorkDate);

      for (const s of scans) {
        let activeRelease = null;

        // NEW secure QR flow:
        // If release_id was scanned, resolve exact release here.
        if (s.release_id) {
          const rel = await findReleaseById(client, s.release_id);

          if (!rel) {
            results.push({
              client_reference_id: s.client_reference_id,
              qr: s.qr,
              status: "Rejected",
              error: {
                code: "INVALID_RELEASE",
                message: "QR release not found.",
              },
            });
            continue;
          }

          if (String(rel.release_status || "").toUpperCase() !== "ACTIVE") {
            results.push({
              client_reference_id: s.client_reference_id,
              qr: s.qr,
              status: "Rejected",
              error: {
                code: "RELEASE_INACTIVE",
                message: "Task release is not active.",
              },
            });
            continue;
          }

          console.log("[SCAN TEAM CHECK]", {
            workerId: employeeId,
            workerSupervisorId,
            releaseSupervisorId: rel.supervisor_employee_id,
            releaseId: rel.release_id,
          });

          if (norm(rel.supervisor_employee_id) !== norm(workerSupervisorId)) {
            results.push({
              client_reference_id: s.client_reference_id,
              qr: s.qr,
              status: "Rejected",
              error: {
                code: "TASK_NOT_RELEASED",
                message: "Task not released for your team.",
              },
            });
            continue;
          }

          s.project_id = rel.project_id;
          s.task_id = rel.task_id;
          activeRelease = rel;
        } else {
          // OLD QR flow
          activeRelease = await findActiveReleaseForSupervisor(
            client,
            s.project_id,
            s.task_id,
            workerSupervisorId
          );

          if (!activeRelease) {
            results.push({
              client_reference_id: s.client_reference_id,
              qr: s.qr,
              status: "Rejected",
              error: {
                code: "TASK_NOT_RELEASED",
                message: "Task not released for your team.",
              },
            });
            continue;
          }
        }

        if (!s.project_id || !s.task_id) {
          results.push({
            client_reference_id: s.client_reference_id,
            qr: s.qr,
            status: "Rejected",
            error: {
              code: "INVALID_QR",
              message: "QR does not contain a valid task reference.",
            },
          });
          continue;
        }

        // Capacity enforcement
        const maxWorkers =
          activeRelease.max_workers === null || activeRelease.max_workers === undefined
            ? null
            : Number(activeRelease.max_workers);

        if (maxWorkers !== null && Number.isFinite(maxWorkers)) {
          const currentWorkers = await currentOpenWorkersForTask(
            client,
            s.project_id,
            s.task_id,
            s.work_date
          );

          if (currentWorkers >= maxWorkers) {
            results.push({
              client_reference_id: s.client_reference_id,
              qr: s.qr,
              status: "Rejected",
              error: {
                code: "CAPACITY_REACHED",
                message: `Task capacity reached (${currentWorkers}/${maxWorkers}). Contact your supervisor.`,
              },
              release_id: activeRelease.release_id,
              current_workers: currentWorkers,
              min_workers: activeRelease.min_workers ?? 0,
              max_workers: maxWorkers,
            });
            continue;
          }
        }

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
             VALUES ('Over3Tasks', $1, $2, $3, 'Submitted', $4::jsonb, NOW(), NOW())
             RETURNING approval_id`,
            [
              employeeId,
              workerSupervisorId,
              assignmentDayId,
              JSON.stringify({
                work_date: s.work_date,
                project_id: s.project_id,
                task_id: s.task_id,
                via: "WorkerScan",
                release_id: activeRelease.release_id,
                supervisor_employee_id: workerSupervisorId,
              }),
            ]
          );
          approvalId = ai.rows[0].approval_id;
        }

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
          release_id: activeRelease.release_id,
          supervisor_employee_id: workerSupervisorId,
          min_workers: activeRelease.min_workers ?? 0,
          max_workers: activeRelease.max_workers ?? null,
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
