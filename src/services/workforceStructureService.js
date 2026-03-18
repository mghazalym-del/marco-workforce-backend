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
      structure_id: row.structure_id,
      project_id: row.project_id,
      employee_id: row.employee_id,
      employee_name: row.employee_name,
      position_title: row.position_title,
      role_code: row.structure_role_code,
      reports_to_employee_id: row.reports_to_employee_id,
      reports_to_employee_name: row.reports_to_employee_name,
      hierarchy_level: row.hierarchy_level,
      valid_from: row.valid_from,
      valid_to: row.valid_to,
      is_active: row.is_active,
      created_at: row.created_at,
      updated_at: row.updated_at,
      remarks: row.remarks,
      children: [],
    });
  }

  for (const row of rows) {
    const currentNode = nodeMap.get(row.employee_id);

    if (!row.reports_to_employee_id) {
      roots.push(currentNode);
      continue;
    }

    const parentNode = nodeMap.get(row.reports_to_employee_id);

    if (parentNode) {
      parentNode.children.push(currentNode);
    } else {
      roots.push(currentNode);
    }
  }

  return roots;
}

async function getProjectStructureTree(projectId) {
  const rows = await getProjectStructure(projectId);
  const tree = buildProjectStructureTree(rows);

  return {
    items: rows,
    tree,
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

    const childRes = await client.query(
      `
      SELECT
        structure_id,
        project_id,
        employee_id,
        structure_role_code,
        reports_to_employee_id,
        hierarchy_level,
        is_active
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

    const parentRes = await client.query(
      `
      SELECT
        structure_id,
        employee_id,
        structure_role_code,
        hierarchy_level,
        is_active
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

    if (!isAllowedParent(child.structure_role_code, parent.structure_role_code)) {
      throw new Error("INVALID_HIERARCHY_RELATION");
    }

    if (child.employee_id === parent.employee_id) {
      throw new Error("SELF_REPORTING_NOT_ALLOWED");
    }

    // Prevent cycles
    const allRowsRes = await client.query(
      `
      SELECT employee_id, reports_to_employee_id
      FROM public.workforce_project_structure
      WHERE project_id = $1
        AND is_active = TRUE
      `,
      [project_id]
    );

    const rows = allRowsRes.rows;

    const descendantsMap = new Map();
    for (const row of rows) {
      const managerId = row.reports_to_employee_id;
      if (!managerId) continue;
      if (!descendantsMap.has(managerId)) descendantsMap.set(managerId, []);
      descendantsMap.get(managerId).push(row.employee_id);
    }

    const stack = [...(descendantsMap.get(child.employee_id) || [])];
    const descendants = new Set();

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || descendants.has(current)) continue;
      descendants.add(current);
      const next = descendantsMap.get(current) || [];
      stack.push(...next);
    }

    if (descendants.has(parent.employee_id)) {
      throw new Error("CYCLE_NOT_ALLOWED");
    }

    const newHierarchyLevel = Number(parent.hierarchy_level) + 1;

    await client.query(
      `
      UPDATE public.workforce_project_structure
      SET
        reports_to_employee_id = $1,
        hierarchy_level = $2,
        updated_at = NOW(),
        updated_by = $3
      WHERE project_id = $4
        AND employee_id = $5
        AND is_active = TRUE
      `,
      [
        new_reports_to_employee_id,
        newHierarchyLevel,
        updated_by || null,
        project_id,
        employee_id,
      ]
    );

    await client.query("COMMIT");

    return {
      success: true,
      project_id,
      employee_id,
      new_reports_to_employee_id,
      updated_by: updated_by || null,
      new_hierarchy_level: newHierarchyLevel,
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