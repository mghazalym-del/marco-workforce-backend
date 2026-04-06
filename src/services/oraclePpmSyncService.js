const axios = require("axios");
const db = require("../db");

// ---- DB helpers ----
function getPool() {
  if (db && typeof db.query === "function") return db;
  if (db && db.pool && typeof db.pool.query === "function") return db.pool;
  if (db && db.default && typeof db.default.query === "function") return db.default;
  throw new Error("DB pool not found: ../db must export a pg Pool or { pool }");
}

function blankToNull(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

function parseDateOrNull(value) {
  const v = blankToNull(value);
  return v === null ? null : v;
}

function parseNumericOrNull(value) {
  const v = blankToNull(value);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseBooleanOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "boolean") return value;
  const s = String(value).trim().toLowerCase();
  if (s === "true") return true;
  if (s === "false") return false;
  return null;
}

// ---- Fetch OIC payload using BASIC AUTH ----
async function fetchOraclePayload() {
  const apiUrl = process.env.ORACLE_API_URL;
  const username = process.env.ORACLE_USERNAME;
  const password = process.env.ORACLE_PASSWORD;

  if (!apiUrl || !username || !password) {
    throw new Error(
      "Missing Oracle OIC environment variables: ORACLE_API_URL / ORACLE_USERNAME / ORACLE_PASSWORD"
    );
  }

  const response = await axios.post(
    apiUrl,
    {},
    {
      auth: {
        username,
        password,
      },
      headers: {
        "Content-Type": "application/json",
      },
      timeout: 120000,
    }
  );

  return response.data;
}

// ---- Normalize live payload ----
// Expected live shape:
// {
//   Code,
//   Message,
//   Timestamp,
//   Response: {
//     Project: [
//       {
//         ProjectId, ...,
//         Tasks: [ ... ]
//       }
//     ]
//   }
// }
function normalizeOraclePayload(payload) {
  const projectRows = Array.isArray(payload?.Response?.Project)
    ? payload.Response.Project
    : [];

  const projects = [];
  const tasks = [];

  for (const p of projectRows) {
    if (!p || typeof p !== "object") continue;

    projects.push(p);

    const nestedTasks = Array.isArray(p.Tasks) ? p.Tasks : [];
    for (const t of nestedTasks) {
      if (!t || typeof t !== "object") continue;

      // inject parent project id into each task so linkage is guaranteed
      tasks.push({
        ...t,
        ProjectId: t.ProjectId ?? p.ProjectId ?? null,
      });
    }
  }

  // de-dup
  const dedupProjects = [];
  const seenProjects = new Set();
  for (const p of projects) {
    const key = String(p.ProjectId ?? "");
    if (!key || seenProjects.has(key)) continue;
    seenProjects.add(key);
    dedupProjects.push(p);
  }

  const dedupTasks = [];
  const seenTasks = new Set();
  for (const t of tasks) {
    const key = String(t.TaskId ?? "");
    if (!key || seenTasks.has(key)) continue;
    seenTasks.add(key);
    dedupTasks.push(t);
  }

  return {
    projects: dedupProjects,
    tasks: dedupTasks,
  };
}

// ---- Upsert projects into your EXISTING table + Oracle-named columns ----
async function upsertProjects(client, projects) {
  let count = 0;

  for (const p of projects) {
    await client.query(
      `
      INSERT INTO oracle_ppm_projects (
        oracle_project_id,
        project_number,
        project_name,
        project_status,
        project_type,
        start_date,
        end_date,
        source_payload,
        integration_status,
        last_sync_at,

        "Href",
        "ProjectDescription",
        "ProjectEndDate",
        "ProjectId",
        "ProjectManagerId",
        "ProjectManagerName",
        "ProjectName",
        "ProjectPlannedEndDate",
        "ProjectPlannedStartDate",
        "ProjectStartDate",
        "ProjectStatus",
        "ProjectTypeId",
        "ProjectTypeName"
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8::jsonb,'SYNCED',NOW(),
        $9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21
      )
      ON CONFLICT (oracle_project_id)
      DO UPDATE SET
        project_number        = EXCLUDED.project_number,
        project_name          = EXCLUDED.project_name,
        project_status        = EXCLUDED.project_status,
        project_type          = EXCLUDED.project_type,
        start_date            = EXCLUDED.start_date,
        end_date              = EXCLUDED.end_date,
        source_payload        = EXCLUDED.source_payload,
        integration_status    = 'SYNCED',
        last_sync_at          = NOW(),

        "Href"                = EXCLUDED."Href",
        "ProjectDescription"  = EXCLUDED."ProjectDescription",
        "ProjectEndDate"      = EXCLUDED."ProjectEndDate",
        "ProjectId"           = EXCLUDED."ProjectId",
        "ProjectManagerId"    = EXCLUDED."ProjectManagerId",
        "ProjectManagerName"  = EXCLUDED."ProjectManagerName",
        "ProjectName"         = EXCLUDED."ProjectName",
        "ProjectPlannedEndDate"   = EXCLUDED."ProjectPlannedEndDate",
        "ProjectPlannedStartDate" = EXCLUDED."ProjectPlannedStartDate",
        "ProjectStartDate"    = EXCLUDED."ProjectStartDate",
        "ProjectStatus"       = EXCLUDED."ProjectStatus",
        "ProjectTypeId"       = EXCLUDED."ProjectTypeId",
        "ProjectTypeName"     = EXCLUDED."ProjectTypeName"
      `,
      [
        blankToNull(p.ProjectId),                     // oracle_project_id
        blankToNull(p.ProjectNumber),                 // project_number
        blankToNull(p.ProjectName),                   // project_name
        blankToNull(p.ProjectStatus),                 // project_status
        blankToNull(p.ProjectTypeName),               // project_type
        parseDateOrNull(p.ProjectStartDate),          // start_date
        parseDateOrNull(p.ProjectEndDate),            // end_date
        JSON.stringify(p),                            // source_payload

        blankToNull(p.Href),
        blankToNull(p.ProjectDescription),
        parseDateOrNull(p.ProjectEndDate),
        blankToNull(p.ProjectId),
        blankToNull(p.ProjectManagerId),
        blankToNull(p.ProjectManagerName),
        blankToNull(p.ProjectName),
        parseDateOrNull(p.ProjectPlannedEndDate),
        parseDateOrNull(p.ProjectPlannedStartDate),
        parseDateOrNull(p.ProjectStartDate),
        blankToNull(p.ProjectStatus),
        blankToNull(p.ProjectTypeId),
        blankToNull(p.ProjectTypeName),
      ]
    );

    count++;
  }

  return count;
}

// ---- Upsert tasks into your EXISTING table + Oracle-named columns ----
async function upsertTasks(client, tasks) {
  let count = 0;

  for (const t of tasks) {
    await client.query(
      `
      INSERT INTO oracle_ppm_tasks (
        oracle_task_id,
        oracle_project_id,
        task_number,
        task_name,
        task_status,
        parent_task_id,
        start_date,
        end_date,
        source_payload,
        integration_status,
        last_sync_at,

        "ActualEndDate",
        "ActualStartDate",
        "Href",
        "MilestoneFlag",
        "PlannedEndDate",
        "PlannedStartDate",
        "ProgressStatus",
        "TaskDuration",
        "TaskId",
        "TaskName",
        "TaskNumber",
        "TaskParentId"
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'SYNCED',NOW(),
        $10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21
      )
      ON CONFLICT (oracle_task_id)
      DO UPDATE SET
        oracle_project_id    = EXCLUDED.oracle_project_id,
        task_number          = EXCLUDED.task_number,
        task_name            = EXCLUDED.task_name,
        task_status          = EXCLUDED.task_status,
        parent_task_id       = EXCLUDED.parent_task_id,
        start_date           = EXCLUDED.start_date,
        end_date             = EXCLUDED.end_date,
        source_payload       = EXCLUDED.source_payload,
        integration_status   = 'SYNCED',
        last_sync_at         = NOW(),

        "ActualEndDate"      = EXCLUDED."ActualEndDate",
        "ActualStartDate"    = EXCLUDED."ActualStartDate",
        "Href"               = EXCLUDED."Href",
        "MilestoneFlag"      = EXCLUDED."MilestoneFlag",
        "PlannedEndDate"     = EXCLUDED."PlannedEndDate",
        "PlannedStartDate"   = EXCLUDED."PlannedStartDate",
        "ProgressStatus"     = EXCLUDED."ProgressStatus",
        "TaskDuration"       = EXCLUDED."TaskDuration",
        "TaskId"             = EXCLUDED."TaskId",
        "TaskName"           = EXCLUDED."TaskName",
        "TaskNumber"         = EXCLUDED."TaskNumber",
        "TaskParentId"       = EXCLUDED."TaskParentId"
      `,
      [
        blankToNull(t.TaskId),                        // oracle_task_id
        blankToNull(t.ProjectId),                     // oracle_project_id
        blankToNull(t.TaskNumber),                    // task_number
        blankToNull(t.TaskName),                      // task_name
        blankToNull(t.ProgressStatus),                // task_status
        blankToNull(t.TaskParentId),                  // parent_task_id
        parseDateOrNull(t.PlannedStartDate ?? t.ActualStartDate), // start_date
        parseDateOrNull(t.PlannedEndDate ?? t.ActualEndDate),     // end_date
        JSON.stringify(t),                            // source_payload

        parseDateOrNull(t.ActualEndDate),
        parseDateOrNull(t.ActualStartDate),
        blankToNull(t.Href),
        parseBooleanOrNull(t.MilestoneFlag),
        parseDateOrNull(t.PlannedEndDate),
        parseDateOrNull(t.PlannedStartDate),
        blankToNull(t.ProgressStatus),
        parseNumericOrNull(t.TaskDuration),
        blankToNull(t.TaskId),
        blankToNull(t.TaskName),
        blankToNull(t.TaskNumber),
        blankToNull(t.TaskParentId),
      ]
    );

    count++;
  }

  return count;
}

// ---- Sync log helpers ----
async function createSyncLog(pool) {
  const r = await pool.query(
    `
    INSERT INTO oracle_ppm_sync_log (
      status,
      started_at,
      projects_count,
      tasks_count
    )
    VALUES ('STARTED', NOW(), 0, 0)
    RETURNING sync_id
    `
  );

  return r.rows[0].sync_id;
}

async function completeSyncLog(pool, syncId, status, projectsCount, tasksCount, errorMessage = null) {
  await pool.query(
    `
    UPDATE oracle_ppm_sync_log
    SET
      status = $1,
      completed_at = NOW(),
      projects_count = $2,
      tasks_count = $3,
      error_message = $4
    WHERE sync_id = $5
    `,
    [status, projectsCount, tasksCount, errorMessage, syncId]
  );
}

// ---- Main runner ----
async function runOracleSync() {
  const pool = getPool();
  const syncId = await createSyncLog(pool);

  let client = null;

  try {
    const rawPayload = await fetchOraclePayload();
    const { projects, tasks } = normalizeOraclePayload(rawPayload);

    console.log(`[ORACLE NORMALIZED] projects=${projects.length}, tasks=${tasks.length}`);

    client = await pool.connect();
    await client.query("BEGIN");

    const projectCount = await upsertProjects(client, projects);
    const taskCount = await upsertTasks(client, tasks);

    await client.query("COMMIT");
    client.release();
    client = null;

    await completeSyncLog(pool, syncId, "SUCCESS", projectCount, taskCount, null);

    return {
      sync_id: syncId,
      status: "SUCCESS",
      projects_count: projectCount,
      tasks_count: taskCount,
    };
  } catch (e) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
      try {
        client.release();
      } catch (_) {}
    }

    await completeSyncLog(pool, syncId, "FAILED", 0, 0, e.message || "Unknown error");
    throw e;
  }
}

module.exports = {
  runOracleSync,
};