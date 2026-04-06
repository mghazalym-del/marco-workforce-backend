const { pool } = require("../db");

async function getProjectStructure(projectId) {
  const sql = `
    SELECT
      wps.structure_id,
      wps.project_id,
      wps.employee_id,
      e.full_name AS employee_name,
      e.position_title,
      wps.structure_role_code,
      wps.reports_to_employee_id,
      mgr.full_name AS reports_to_employee_name,
      wps.hierarchy_level,
      wps.valid_from,
      wps.valid_to,
      wps.is_active,
      wps.created_at,
      wps.updated_at,
      wps.remarks
    FROM public.workforce_project_structure wps
    LEFT JOIN public.employees e
      ON e.employee_id = wps.employee_id
    LEFT JOIN public.employees mgr
      ON mgr.employee_id = wps.reports_to_employee_id
    WHERE wps.project_id = $1
      AND wps.is_active = TRUE
    ORDER BY
      wps.hierarchy_level ASC,
      wps.reports_to_employee_id NULLS FIRST,
      wps.employee_id ASC
  `;

  const result = await pool.query(sql, [projectId]);
  return result.rows;
}

function buildProjectStructureTree(rows) {
  const nodeMap = new Map();
  const roots = [];

  for (const row of rows) {
    nodeMap.set(row.employee_id, {
      ...row,
      role_code: row.structure_role_code,
      children: [],
    });
  }

  for (const row of rows) {
    const node = nodeMap.get(row.employee_id);

    if (!row.reports_to_employee_id) {
      roots.push(node);
      continue;
    }

    const parent = nodeMap.get(row.reports_to_employee_id);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  return roots;
}

async function getProjectStructureTree(projectId) {
  const rows = await getProjectStructure(projectId);
  return {
    items: rows,
    tree: buildProjectStructureTree(rows),
  };
}

function isAllowedParent(childRole, parentRole) {
  const c = String(childRole || "").toUpperCase();
  const p = String(parentRole || "").toUpperCase();

  if (c === "SE" && p === "PM") return true;
  if (c === "SUPERVISOR" && p === "SE") return true;
  if (c === "WORKER" && p === "SUPERVISOR") return true;

  return false;
}

async function reassignWorkforceNode({
  project_id,
  employee_id,
  new_reports_to_employee_id,
  updated_by,
}) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // --- Child ---
    const childRes = await client.query(
      `
      SELECT *
      FROM public.workforce_project_structure
      WHERE project_id = $1
        AND employee_id = $2
        AND is_active = TRUE
      `,
      [project_id, employee_id]
    );

    if (childRes.rowCount === 0) {
      throw new Error("CHILD_NODE_NOT_FOUND");
    }

    const child = childRes.rows[0];

    // --- Parent ---
    const parentRes = await client.query(
      `
      SELECT *
      FROM public.workforce_project_structure
      WHERE project_id = $1
        AND employee_id = $2
        AND is_active = TRUE
      `,
      [project_id, new_reports_to_employee_id]
    );

    if (parentRes.rowCount === 0) {
      throw new Error("PARENT_NODE_NOT_FOUND");
    }

    const parent = parentRes.rows[0];

    // --- Validation ---
    if (!isAllowedParent(child.structure_role_code, parent.structure_role_code)) {
      throw new Error("INVALID_HIERARCHY_RELATION");
    }

    if (child.employee_id === parent.employee_id) {
      throw new Error("SELF_REPORTING_NOT_ALLOWED");
    }

    // --- Prevent cycles ---
    const allRows = await client.query(
      `
      SELECT employee_id, reports_to_employee_id
      FROM public.workforce_project_structure
      WHERE project_id = $1 AND is_active = TRUE
      `,
      [project_id]
    );

    const map = new Map();
    for (const r of allRows.rows) {
      if (!r.reports_to_employee_id) continue;
      if (!map.has(r.reports_to_employee_id)) map.set(r.reports_to_employee_id, []);
      map.get(r.reports_to_employee_id).push(r.employee_id);
    }

    const stack = [...(map.get(child.employee_id) || [])];
    const visited = new Set();

    while (stack.length) {
      const cur = stack.pop();
      if (!cur || visited.has(cur)) continue;
      visited.add(cur);
      stack.push(...(map.get(cur) || []));
    }

    if (visited.has(parent.employee_id)) {
      throw new Error("CYCLE_NOT_ALLOWED");
    }

    const newLevel = Number(parent.hierarchy_level) + 1;

    // --- UPDATE STRUCTURE ---
    await client.query(
      `
      UPDATE public.workforce_project_structure
      SET reports_to_employee_id = $1,
          hierarchy_level = $2,
          updated_at = NOW(),
          updated_by = $3
      WHERE project_id = $4
        AND employee_id = $5
        AND is_active = TRUE
      `,
      [
        new_reports_to_employee_id,
        newLevel,
        updated_by || null,
        project_id,
        employee_id,
      ]
    );

    // 🔥🔥🔥 CRITICAL FIX HERE 🔥🔥🔥
    // Sync employees table if WORKER moved under SUPERVISOR
    if (child.structure_role_code === "WORKER") {
      await client.query(
        `
        UPDATE public.employees
        SET supervisor_employee_id = $1
        WHERE employee_id = $2
        `,
        [new_reports_to_employee_id, employee_id]
      );

      console.log("[WORKFORCE SYNC] Updated employee supervisor", {
        employee_id,
        new_supervisor: new_reports_to_employee_id,
      });
    }

    await client.query("COMMIT");

    return {
      success: true,
      project_id,
      employee_id,
      new_reports_to_employee_id,
      new_hierarchy_level: newLevel,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  getProjectStructure,
  getProjectStructureTree,
  reassignWorkforceNode,
};