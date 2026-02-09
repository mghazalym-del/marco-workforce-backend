async function rebuildTaskSessionsForDay(client, employee_id, work_date) {
  const accepted = await client.query(
    `
    SELECT id, project_id, task_id, scan_timestamp_device
    FROM assignment_scan
    WHERE employee_id = $1
      AND work_date = $2
      AND status = 'Accepted'
    ORDER BY scan_timestamp_device ASC
    `,
    [employee_id, work_date]
  );

  await client.query(
    `DELETE FROM task_session WHERE employee_id = $1 AND work_date = $2`,
    [employee_id, work_date]
  );

  if (accepted.rowCount === 0) return;

  for (let i = 0; i < accepted.rows.length; i++) {
    const cur = accepted.rows[i];
    const next = accepted.rows[i + 1] || null;

    const start_ts = cur.scan_timestamp_device;
    const end_ts = next ? next.scan_timestamp_device : null;

    let duration_minutes = null;
    if (end_ts) {
      const mins = Math.max(
        0,
        Math.floor(
          (new Date(end_ts).getTime() - new Date(start_ts).getTime()) / 60000
        )
      );
      duration_minutes = mins;
    }

    await client.query(
      `
      INSERT INTO task_session
        (employee_id, work_date, project_id, task_id, start_ts, end_ts, duration_minutes, status)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8)
      `,
      [
        employee_id,
        work_date,
        cur.project_id,
        cur.task_id,
        start_ts,
        end_ts,
        duration_minutes,
        end_ts ? "CLOSED" : "OPEN",
      ]
    );
  }
}

module.exports = { rebuildTaskSessionsForDay };
