// src/services/dailyCostService.js

const { pool } = require("../db");
const dayAdjustmentsService = require("./dayAdjustmentsService");

function toDateOnly(value) {
  return String(value || "").substring(0, 10);
}

function monthKeyFromDate(value) {
  const s = toDateOnly(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s.substring(0, 7); // YYYY-MM
}

function monthKeyToStartDate(monthKey) {
  return `${monthKey}-01`;
}

function buildMonthKeysInRange(from, to) {
  const fromKey = monthKeyFromDate(from);
  const toKey = monthKeyFromDate(to);

  if (!fromKey || !toKey) return [];

  const [fromY, fromM] = fromKey.split("-").map(Number);
  const [toY, toM] = toKey.split("-").map(Number);

  const start = new Date(Date.UTC(fromY, fromM - 1, 1));
  const end = new Date(Date.UTC(toY, toM - 1, 1));

  const keys = [];
  const d = new Date(start);

  while (d <= end) {
    const y = d.getUTCFullYear().toString().padStart(4, "0");
    const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
    keys.push(`${y}-${m}`);
    d.setUTCMonth(d.getUTCMonth() + 1);
  }

  return keys;
}

async function getApprovedMonthsInRange(project_id, from, to) {
  const monthKeys = buildMonthKeysInRange(from, to);
  if (!project_id || monthKeys.length === 0) return [];

  const result = await pool.query(
    `
    SELECT DISTINCT SUBSTRING(CAST(cost_month AS text), 1, 7) AS ym
    FROM public.monthly_cost_batch
    WHERE project_id = $1
      AND status = 'PM_APPROVED'
      AND SUBSTRING(CAST(cost_month AS text), 1, 7) = ANY($2::text[])
    `,
    [project_id, monthKeys]
  );

  return result.rows.map((r) => String(r.ym));
}

async function hasApprovedMonthInRange(project_id, from, to) {
  const rows = await getApprovedMonthsInRange(project_id, from, to);
  return rows.length > 0;
}

// 🔍 VALIDATE
async function validateDailyCost({ project_id, from, to }) {
  if (!project_id) throw new Error("project_id is required");
  if (!from || !to) throw new Error("from and to dates are required");

  const approvedMonths = await getApprovedMonthsInRange(project_id, from, to);
  const approvedMonthSet = new Set(approvedMonths);

  const client = await pool.connect();
  try {
    const result = await client.query(
      `
      WITH candidate_days AS (
        SELECT DISTINCT
          ts.employee_id,
          ts.work_date,
          ts.project_id
        FROM task_session ts
        WHERE ts.project_id = $1
          AND ts.work_date BETWEEN $2 AND $3
      )
      SELECT
        cd.employee_id,
        e.full_name AS employee_name,
        cd.work_date,
        COALESCE(wd.day_status, 'OPEN') AS day_status,

        (
          SELECT COUNT(*)
          FROM task_session ts2
          WHERE ts2.employee_id = cd.employee_id
            AND ts2.work_date = cd.work_date
            AND ts2.project_id = cd.project_id
            AND UPPER(COALESCE(ts2.status, 'OPEN')) = 'OPEN'
        ) AS open_sessions,

        EXISTS (
          SELECT 1
          FROM worker_day_adjustment_run r
          WHERE r.employee_id = cd.employee_id
            AND r.work_date = cd.work_date
            AND r.project_id = cd.project_id
        ) AS already_generated

      FROM candidate_days cd
      LEFT JOIN employees e
        ON e.employee_id = cd.employee_id
      LEFT JOIN work_day wd
        ON wd.employee_id = cd.employee_id
       AND wd.work_date = cd.work_date

      ORDER BY cd.work_date, cd.employee_id
      `,
      [project_id, from, to]
    );

    const rows = result.rows.map((r) => {
      let eligible = true;
      let reason = null;

      const workMonth = monthKeyFromDate(r.work_date);

      if (workMonth && approvedMonthSet.has(workMonth)) {
        eligible = false;
        reason = "MONTH_ALREADY_APPROVED";
      } else if (r.day_status !== "FINALIZED") {
        eligible = false;
        reason = "DAY_NOT_FINALIZED";
      } else if (Number(r.open_sessions) > 0) {
        eligible = false;
        reason = "OPEN_SESSIONS_EXIST";
      } else if (r.already_generated) {
        eligible = false;
        reason = "ALREADY_GENERATED";
      }

      return {
        ...r,
        eligible,
        blocker_reason: reason,
      };
    });

    return rows;
  } finally {
    client.release();
  }
}

// 🚀 GENERATE
async function generateDailyCost({
  project_id,
  from,
  to,
  generated_by,
}) {
  if (!generated_by) {
    throw new Error("generated_by is required");
  }

  const locked = await hasApprovedMonthInRange(project_id, from, to);
  if (locked) {
    throw new Error("MONTH_ALREADY_APPROVED_LOCKED");
  }

  const validation = await validateDailyCost({
    project_id,
    from,
    to,
  });

  let generated = 0;
  let skipped = 0;

  for (const row of validation) {
    if (!row.eligible) {
      skipped++;
      continue;
    }

    await dayAdjustmentsService.generateDayAdjustments({
      employee_id: row.employee_id,
      work_date: row.work_date,
      project_id,
      generated_by,
    });

    generated++;
  }

  return {
    total: validation.length,
    generated,
    skipped,
    validation,
  };
}

module.exports = {
  validateDailyCost,
  generateDailyCost,
};