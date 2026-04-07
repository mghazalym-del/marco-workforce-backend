const { pool } = require("../db");

function parseMonthStart(value) {
  if (!value || typeof value !== "string") return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;

  const yyyy = Number(m[1]);
  const mm = Number(m[2]);
  const dd = Number(m[3]);

  if (!yyyy || !mm || !dd) return null;
  if (dd !== 1) return null;

  return value;
}

function monthEnd(monthStart) {
  const d = new Date(`${monthStart}T00:00:00Z`);
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return end.toISOString().substring(0, 10);
}

async function queryMany(text, params) {
  const r = await pool.query(text, params);
  return r.rows || [];
}

async function queryOne(text, params) {
  const r = await pool.query(text, params);
  return r.rows[0] || null;
}

async function validateMonthlyCost({
  project_id,
  cost_month,
  option_type,
}) {
  if (!project_id) {
    throw new Error("project_id is required");
  }

  const parsedMonth = parseMonthStart(cost_month);
  if (!parsedMonth) {
    throw new Error("cost_month must be first day of month in YYYY-MM-DD format");
  }

  const option = String(option_type || "").toUpperCase();
  if (!["OPTION1", "OPTION2"].includes(option)) {
    throw new Error("option_type must be OPTION1 or OPTION2");
  }

  const from = parsedMonth;
  const to = monthEnd(parsedMonth);

  // 1) OPEN SESSIONS
  const openSessions = await queryMany(
    `
    SELECT
      ts.employee_id,
      e.full_name AS employee_name,
      ts.work_date,
      ts.project_id,
      ts.task_id,
      e.supervisor_employee_id,
      sup.full_name AS supervisor_name,
      sup.supervisor_employee_id AS se_employee_id,
      se.full_name AS se_name,
      ts.start_ts,
      ts.end_ts,
      ts.status
    FROM public.task_session ts
    LEFT JOIN public.employees e
      ON e.employee_id = ts.employee_id
    LEFT JOIN public.employees sup
      ON sup.employee_id = e.supervisor_employee_id
    LEFT JOIN public.employees se
      ON se.employee_id = sup.supervisor_employee_id
    WHERE ts.project_id = $1
      AND ts.work_date BETWEEN $2 AND $3
      AND UPPER(COALESCE(ts.status, 'OPEN')) = 'OPEN'
    ORDER BY ts.work_date ASC, ts.employee_id ASC, ts.start_ts ASC
    `,
    [project_id, from, to]
  );

  // 2) DAYS NOT FINALIZED
  const unfinalizedDays = await queryMany(
    `
    SELECT
      wd.employee_id,
      e.full_name AS employee_name,
      wd.work_date,
      wd.day_status,
      e.supervisor_employee_id,
      sup.full_name AS supervisor_name,
      sup.supervisor_employee_id AS se_employee_id,
      se.full_name AS se_name
    FROM public.work_day wd
    LEFT JOIN public.employees e
      ON e.employee_id = wd.employee_id
    LEFT JOIN public.employees sup
      ON sup.employee_id = e.supervisor_employee_id
    LEFT JOIN public.employees se
      ON se.employee_id = sup.supervisor_employee_id
    WHERE wd.work_date BETWEEN $2 AND $3
      AND EXISTS (
        SELECT 1
        FROM public.task_session ts
        WHERE ts.employee_id = wd.employee_id
          AND ts.work_date = wd.work_date
          AND ts.project_id = $1
      )
      AND UPPER(COALESCE(wd.day_status, 'OPEN')) <> 'FINALIZED'
    ORDER BY wd.work_date ASC, wd.employee_id ASC
    `,
    [project_id, from, to]
  );

  // 3) MISSING DAILY ADJUSTMENT RUNS
  const missingRuns = await queryMany(
    `
    WITH candidate_days AS (
      SELECT DISTINCT
        ts.employee_id,
        ts.work_date,
        ts.project_id
      FROM public.task_session ts
      WHERE ts.project_id = $1
        AND ts.work_date BETWEEN $2 AND $3
    )
    SELECT
      cd.employee_id,
      e.full_name AS employee_name,
      cd.work_date,
      cd.project_id,
      e.supervisor_employee_id,
      sup.full_name AS supervisor_name,
      sup.supervisor_employee_id AS se_employee_id,
      se.full_name AS se_name
    FROM candidate_days cd
    LEFT JOIN public.employees e
      ON e.employee_id = cd.employee_id
    LEFT JOIN public.employees sup
      ON sup.employee_id = e.supervisor_employee_id
    LEFT JOIN public.employees se
      ON se.employee_id = sup.supervisor_employee_id
    LEFT JOIN public.worker_day_adjustment_run r
      ON r.employee_id = cd.employee_id
     AND r.work_date = cd.work_date
     AND r.project_id = cd.project_id
    WHERE r.adjustment_run_id IS NULL
    ORDER BY cd.work_date ASC, cd.employee_id ASC
    `,
    [project_id, from, to]
  );

  // 4) ALREADY FINALIZED MONTHLY BATCH CHECK
  const finalizedBatch = await queryOne(
    `
    SELECT
      batch_id,
      project_id,
      cost_month,
      option_type,
      status,
      approved_by,
      approved_at,
      locked_at
    FROM public.monthly_cost_batch
    WHERE project_id = $1
      AND cost_month = $2
      AND option_type = $3
      AND status IN ('PM_APPROVED', 'FINALIZED')
    LIMIT 1
    `,
    [project_id, from, option]
  );

  const issues = [];

  for (const r of openSessions) {
    issues.push({
      issue_type: "OPEN_SESSION",
      severity: "BLOCKER",
      employee_id: r.employee_id,
      employee_name: r.employee_name,
      supervisor_employee_id: r.supervisor_employee_id,
      supervisor_name: r.supervisor_name,
      se_employee_id: r.se_employee_id,
      se_name: r.se_name,
      work_date: r.work_date,
      project_id: r.project_id,
      task_id: r.task_id,
      message: `Open session found for ${r.employee_id}${r.employee_name ? " - " + r.employee_name : ""} on ${r.work_date}`,
      details: {
        start_ts: r.start_ts,
        end_ts: r.end_ts,
        status: r.status,
      },
    });
  }

  for (const r of unfinalizedDays) {
    issues.push({
      issue_type: "DAY_NOT_FINALIZED",
      severity: "BLOCKER",
      employee_id: r.employee_id,
      employee_name: r.employee_name,
      supervisor_employee_id: r.supervisor_employee_id,
      supervisor_name: r.supervisor_name,
      se_employee_id: r.se_employee_id,
      se_name: r.se_name,
      work_date: r.work_date,
      project_id,
      task_id: null,
      message: `Work day is not finalized for ${r.employee_id}${r.employee_name ? " - " + r.employee_name : ""} on ${r.work_date}`,
      details: {
        day_status: r.day_status,
      },
    });
  }

  for (const r of missingRuns) {
    issues.push({
      issue_type: "MISSING_ADJUSTMENT_RUN",
      severity: "BLOCKER",
      employee_id: r.employee_id,
      employee_name: r.employee_name,
      supervisor_employee_id: r.supervisor_employee_id,
      supervisor_name: r.supervisor_name,
      se_employee_id: r.se_employee_id,
      se_name: r.se_name,
      work_date: r.work_date,
      project_id: r.project_id,
      task_id: null,
      message: `No daily adjustment run exists for ${r.employee_id}${r.employee_name ? " - " + r.employee_name : ""} on ${r.work_date}`,
      details: {},
    });
  }

  if (finalizedBatch) {
    issues.push({
      issue_type: "MONTH_ALREADY_LOCKED",
      severity: "BLOCKER",
      employee_id: null,
      employee_name: null,
      supervisor_employee_id: null,
      supervisor_name: null,
      se_employee_id: null,
      se_name: null,
      work_date: from,
      project_id,
      task_id: null,
      message: `A locked monthly batch already exists for ${project_id} / ${from} / ${option}`,
      details: finalizedBatch,
    });
  }

  const blockerCount = issues.filter((x) => x.severity === "BLOCKER").length;

  return {
    project_id,
    cost_month: from,
    month_end: to,
    option_type: option,
    ready: blockerCount === 0,
    counts: {
      open_sessions: openSessions.length,
      unfinalized_days: unfinalizedDays.length,
      missing_adjustment_runs: missingRuns.length,
      blocker_issues: blockerCount,
      total_issues: issues.length,
    },
    issues,
  };
}

module.exports = {
  validateMonthlyCost,
};