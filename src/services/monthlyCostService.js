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

function normalizeOption(option_type) {
  const option = String(option_type || "").toUpperCase();
  if (!["OPTION1", "OPTION2"].includes(option)) {
    throw new Error("option_type must be OPTION1 or OPTION2");
  }
  return option;
}

function validateInputs({ project_id, cost_month, option_type }) {
  if (!project_id) {
    throw new Error("project_id is required");
  }

  const parsedMonth = parseMonthStart(cost_month);
  if (!parsedMonth) {
    throw new Error("cost_month must be first day of month in YYYY-MM-DD format");
  }

  const option = normalizeOption(option_type);

  return {
    project_id,
    cost_month: parsedMonth,
    option_type: option,
    from: parsedMonth,
    to: monthEnd(parsedMonth),
  };
}

async function buildValidationPayload({
  project_id,
  cost_month,
  option_type,
}) {
  const validated = validateInputs({ project_id, cost_month, option_type });
  const { from, to, option_type: option } = validated;

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

async function validateMonthlyCost(input) {
  return buildValidationPayload(input);
}

async function upsertBatch(client, { project_id, cost_month, option_type, actor_id }) {
  const existing = await client.query(
    `
    SELECT batch_id, status
    FROM public.monthly_cost_batch
    WHERE project_id = $1
      AND cost_month = $2
      AND option_type = $3
    LIMIT 1
    `,
    [project_id, cost_month, option_type]
  );

  if (existing.rowCount > 0) {
    const batch = existing.rows[0];
    const status = String(batch.status || "").toUpperCase();

    if (["SUBMITTED", "PM_APPROVED", "FINALIZED"].includes(status)) {
      throw new Error(`Batch is already in status ${batch.status} and cannot be regenerated`);
    }

    await client.query(
      `
      UPDATE public.monthly_cost_batch
      SET status = 'DRAFT',
          generated_by = $2,
          generated_at = NULL,
          submitted_by = NULL,
          submitted_at = NULL,
          approved_by = NULL,
          approved_at = NULL,
          returned_by = NULL,
          returned_at = NULL,
          return_reason = NULL,
          locked_at = NULL,
          updated_at = NOW()
      WHERE batch_id = $1
      `,
      [batch.batch_id, actor_id]
    );

    return batch.batch_id;
  }

  const inserted = await client.query(
    `
    INSERT INTO public.monthly_cost_batch
    (
      project_id,
      cost_month,
      option_type,
      status,
      generated_by
    )
    VALUES ($1, $2, $3, 'DRAFT', $4)
    RETURNING batch_id
    `,
    [project_id, cost_month, option_type, actor_id]
  );

  return inserted.rows[0].batch_id;
}

async function replaceValidationIssues(client, batch_id, issues) {
  await client.query(
    `DELETE FROM public.monthly_cost_validation_issue WHERE batch_id = $1`,
    [batch_id]
  );

  for (const issue of issues) {
    await client.query(
      `
      INSERT INTO public.monthly_cost_validation_issue
      (
        batch_id,
        issue_type,
        severity,
        employee_id,
        supervisor_employee_id,
        se_employee_id,
        work_date,
        project_id,
        task_id,
        message,
        details
      )
      VALUES
      (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
      )
      `,
      [
        batch_id,
        issue.issue_type,
        issue.severity,
        issue.employee_id,
        issue.supervisor_employee_id,
        issue.se_employee_id,
        issue.work_date,
        issue.project_id,
        issue.task_id,
        issue.message,
        JSON.stringify(issue.details || {}),
      ]
    );
  }
}

async function deleteBatchItemsAndGeneratedHistory(client, batch_id) {
  await client.query(
    `DELETE FROM public.monthly_cost_batch_item WHERE batch_id = $1`,
    [batch_id]
  );

  await client.query(
    `
    DELETE FROM public.monthly_cost_approval_history
    WHERE batch_id = $1
      AND action = 'GENERATED'
    `,
    [batch_id]
  );
}

async function insertOption1BatchItems(client, { batch_id, project_id, from, to }) {
  const result = await client.query(
    `
    INSERT INTO public.monthly_cost_batch_item
    (
      batch_id,
      adjustment_run_id,
      employee_id,
      work_date,
      project_id,
      option_type,
      original_total_minutes,
      added_or_distributed_minutes,
      adjusted_total_minutes
    )
    SELECT
      $1 AS batch_id,
      r.adjustment_run_id,
      r.employee_id,
      r.work_date,
      r.project_id,
      'OPTION1' AS option_type,
      COALESCE(r.original_total_minutes, 0)::numeric(12,2),
      COALESCE(h.added_to_last_task_minutes, 0)::numeric(12,2),
      COALESCE(h.adjusted_total_minutes, 0)::numeric(12,2)
    FROM public.worker_day_adjustment_run r
    JOIN public.worker_day_adjustment_option1_hdr h
      ON h.adjustment_run_id = r.adjustment_run_id
    WHERE r.project_id = $2
      AND r.work_date BETWEEN $3 AND $4
    `,
    [batch_id, project_id, from, to]
  );

  return result.rowCount || 0;
}

async function insertOption2BatchItems(client, { batch_id, project_id, from, to }) {
  const result = await client.query(
    `
    INSERT INTO public.monthly_cost_batch_item
    (
      batch_id,
      adjustment_run_id,
      employee_id,
      work_date,
      project_id,
      option_type,
      original_total_minutes,
      added_or_distributed_minutes,
      adjusted_total_minutes
    )
    SELECT
      $1 AS batch_id,
      r.adjustment_run_id,
      r.employee_id,
      r.work_date,
      r.project_id,
      'OPTION2' AS option_type,
      COALESCE(r.original_total_minutes, 0)::numeric(12,2),
      COALESCE(h.distributed_minutes_per_task, 0)::numeric(12,2),
      COALESCE(h.adjusted_total_minutes, 0)::numeric(12,2)
    FROM public.worker_day_adjustment_run r
    JOIN public.worker_day_adjustment_option2_hdr h
      ON h.adjustment_run_id = r.adjustment_run_id
    WHERE r.project_id = $2
      AND r.work_date BETWEEN $3 AND $4
    `,
    [batch_id, project_id, from, to]
  );

  return result.rowCount || 0;
}

async function insertHistory(client, { batch_id, action, actor_id, comments = null, details = null }) {
  await client.query(
    `
    INSERT INTO public.monthly_cost_approval_history
    (
      batch_id,
      action,
      actor_id,
      comments,
      details
    )
    VALUES ($1, $2, $3, $4, $5)
    `,
    [batch_id, action, actor_id, comments, details ? JSON.stringify(details) : null]
  );
}

async function generateMonthlyCost({
  project_id,
  cost_month,
  option_type,
  actor_id,
}) {
  if (!actor_id) {
    throw new Error("actor_id is required");
  }

  const validation = await buildValidationPayload({
    project_id,
    cost_month,
    option_type,
  });

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const batch_id = await upsertBatch(client, {
      project_id: validation.project_id,
      cost_month: validation.cost_month,
      option_type: validation.option_type,
      actor_id,
    });

    await replaceValidationIssues(client, batch_id, validation.issues);

    if (!validation.ready) {
      await client.query(
        `
        UPDATE public.monthly_cost_batch
        SET status = 'DRAFT',
            updated_at = NOW()
        WHERE batch_id = $1
        `,
        [batch_id]
      );

      await insertHistory(client, {
        batch_id,
        action: "VALIDATED",
        actor_id,
        comments: "Validation completed with blockers",
        details: validation.counts,
      });

      await client.query("COMMIT");

      return {
        batch_id,
        generated: false,
        ...validation,
      };
    }

    await deleteBatchItemsAndGeneratedHistory(client, batch_id);

    let inserted_count = 0;

    if (validation.option_type === "OPTION1") {
      inserted_count = await insertOption1BatchItems(client, {
        batch_id,
        project_id: validation.project_id,
        from: validation.cost_month,
        to: validation.month_end,
      });
    } else {
      inserted_count = await insertOption2BatchItems(client, {
        batch_id,
        project_id: validation.project_id,
        from: validation.cost_month,
        to: validation.month_end,
      });
    }

    await client.query(
      `
      UPDATE public.monthly_cost_batch
      SET status = 'GENERATED',
          generated_by = $2,
          generated_at = NOW(),
          updated_at = NOW()
      WHERE batch_id = $1
      `,
      [batch_id, actor_id]
    );

    await insertHistory(client, {
      batch_id,
      action: "VALIDATED",
      actor_id,
      comments: "Validation completed successfully",
      details: validation.counts,
    });

    await insertHistory(client, {
      batch_id,
      action: "GENERATED",
      actor_id,
      comments: `Generated ${inserted_count} monthly batch item(s)`,
      details: {
        item_count: inserted_count,
        option_type: validation.option_type,
        project_id: validation.project_id,
        cost_month: validation.cost_month,
      },
    });

    await client.query("COMMIT");

    return {
      batch_id,
      generated: true,
      inserted_count,
      ...validation,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function listBatches({ project_id = null, cost_month = null, option_type = null, status = null }) {
  const clauses = [];
  const params = [];

  if (project_id) {
    params.push(project_id);
    clauses.push(`b.project_id = $${params.length}`);
  }

  if (cost_month) {
    params.push(cost_month);
    clauses.push(`b.cost_month = $${params.length}`);
  }

  if (option_type) {
    params.push(String(option_type).toUpperCase());
    clauses.push(`b.option_type = $${params.length}`);
  }

  if (status) {
    params.push(String(status).toUpperCase());
    clauses.push(`b.status = $${params.length}`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  return queryMany(
    `
    SELECT
      b.batch_id,
      b.project_id,
      b.cost_month,
      b.option_type,
      b.status,
      b.generated_by,
      b.generated_at,
      b.submitted_by,
      b.submitted_at,
      b.approved_by,
      b.approved_at,
      b.returned_by,
      b.returned_at,
      b.return_reason,
      b.locked_at,
      b.created_at,
      b.updated_at,
      COUNT(i.batch_item_id)::int AS item_count
    FROM public.monthly_cost_batch b
    LEFT JOIN public.monthly_cost_batch_item i
      ON i.batch_id = b.batch_id
    ${where}
    GROUP BY
      b.batch_id, b.project_id, b.cost_month, b.option_type, b.status,
      b.generated_by, b.generated_at, b.submitted_by, b.submitted_at,
      b.approved_by, b.approved_at, b.returned_by, b.returned_at,
      b.return_reason, b.locked_at, b.created_at, b.updated_at
    ORDER BY b.cost_month DESC, b.created_at DESC
    `,
    params
  );
}

async function getBatchDetail(batch_id) {
  const batch = await queryOne(
    `
    SELECT *
    FROM public.monthly_cost_batch
    WHERE batch_id = $1
    `,
    [batch_id]
  );

  if (!batch) {
    throw new Error("BATCH_NOT_FOUND");
  }

  const items = await queryMany(
    `
    SELECT *
    FROM public.monthly_cost_batch_item
    WHERE batch_id = $1
    ORDER BY work_date ASC, employee_id ASC
    `,
    [batch_id]
  );

  const issues = await queryMany(
    `
    SELECT *
    FROM public.monthly_cost_validation_issue
    WHERE batch_id = $1
    ORDER BY work_date ASC NULLS FIRST, employee_id ASC NULLS FIRST
    `,
    [batch_id]
  );

  const history = await queryMany(
    `
    SELECT *
    FROM public.monthly_cost_approval_history
    WHERE batch_id = $1
    ORDER BY created_at ASC
    `,
    [batch_id]
  );

  const totals = await queryOne(
    `
    SELECT
      COUNT(*)::int AS item_count,
      COALESCE(SUM(original_total_minutes), 0)::numeric(12,2) AS original_total_minutes,
      COALESCE(SUM(added_or_distributed_minutes), 0)::numeric(12,2) AS added_or_distributed_minutes,
      COALESCE(SUM(adjusted_total_minutes), 0)::numeric(12,2) AS adjusted_total_minutes
    FROM public.monthly_cost_batch_item
    WHERE batch_id = $1
    `,
    [batch_id]
  );

  return {
    batch,
    totals,
    items,
    issues,
    history,
  };
}

async function submitBatch({ batch_id, actor_id }) {
  if (!actor_id) throw new Error("actor_id is required");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const batch = await client.query(
      `SELECT * FROM public.monthly_cost_batch WHERE batch_id = $1 FOR UPDATE`,
      [batch_id]
    );

    if (batch.rowCount === 0) throw new Error("BATCH_NOT_FOUND");

    const row = batch.rows[0];
    const status = String(row.status || "").toUpperCase();

    if (!["GENERATED", "PM_RETURNED"].includes(status)) {
      throw new Error(`BATCH_SUBMIT_INVALID_STATUS:${status}`);
    }

    await client.query(
      `
      UPDATE public.monthly_cost_batch
      SET status = 'SUBMITTED',
          submitted_by = $2,
          submitted_at = NOW(),
          updated_at = NOW()
      WHERE batch_id = $1
      `,
      [batch_id, actor_id]
    );

    await insertHistory(client, {
      batch_id,
      action: "SUBMITTED",
      actor_id,
      comments: "Submitted to PM for approval",
    });

    await client.query("COMMIT");
    return getBatchDetail(batch_id);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function approveBatch({ batch_id, actor_id, comments = null }) {
  if (!actor_id) throw new Error("actor_id is required");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const batch = await client.query(
      `SELECT * FROM public.monthly_cost_batch WHERE batch_id = $1 FOR UPDATE`,
      [batch_id]
    );

    if (batch.rowCount === 0) throw new Error("BATCH_NOT_FOUND");

    const row = batch.rows[0];
    const status = String(row.status || "").toUpperCase();

    if (status !== "SUBMITTED") {
      throw new Error(`BATCH_APPROVE_INVALID_STATUS:${status}`);
    }

    await client.query(
      `
      UPDATE public.monthly_cost_batch
      SET status = 'PM_APPROVED',
          approved_by = $2,
          approved_at = NOW(),
          locked_at = NOW(),
          updated_at = NOW()
      WHERE batch_id = $1
      `,
      [batch_id, actor_id]
    );

    await insertHistory(client, {
      batch_id,
      action: "PM_APPROVED",
      actor_id,
      comments: comments || "Approved by PM",
    });

    await client.query("COMMIT");
    return getBatchDetail(batch_id);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function rejectBatch({ batch_id, actor_id, reason }) {
  if (!actor_id) throw new Error("actor_id is required");
  if (!reason || !String(reason).trim()) throw new Error("reason is required");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const batch = await client.query(
      `SELECT * FROM public.monthly_cost_batch WHERE batch_id = $1 FOR UPDATE`,
      [batch_id]
    );

    if (batch.rowCount === 0) throw new Error("BATCH_NOT_FOUND");

    const row = batch.rows[0];
    const status = String(row.status || "").toUpperCase();

    if (status !== "SUBMITTED") {
      throw new Error(`BATCH_REJECT_INVALID_STATUS:${status}`);
    }

    await client.query(
      `
      UPDATE public.monthly_cost_batch
      SET status = 'PM_RETURNED',
          returned_by = $2,
          returned_at = NOW(),
          return_reason = $3,
          locked_at = NULL,
          updated_at = NOW()
      WHERE batch_id = $1
      `,
      [batch_id, actor_id, String(reason).trim()]
    );

    await insertHistory(client, {
      batch_id,
      action: "PM_RETURNED",
      actor_id,
      comments: String(reason).trim(),
    });

    await client.query("COMMIT");
    return getBatchDetail(batch_id);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  validateMonthlyCost,
  generateMonthlyCost,
  listBatches,
  getBatchDetail,
  submitBatch,
  approveBatch,
  rejectBatch,
};