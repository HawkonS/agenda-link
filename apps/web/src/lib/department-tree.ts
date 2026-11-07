export type DirectoryDepartment = {
  id?: number;
  open_department_id: string;
  parent_department_id?: string;
  parentExternalId?: string | null;
  name: string;
  path?: string | null;
  tencentDepartmentId?: string | null;
};

export type DepartmentNode = {
  department: DirectoryDepartment;
  parent?: DepartmentNode;
  children: DepartmentNode[];
  depth: number;
  path: string;
};

/** Keep source sibling order, but always place children directly under their parent. */
export function buildDepartmentTree(departments: DirectoryDepartment[]) {
  const nodes = new Map<string, DepartmentNode>();
  for (const department of departments) {
    nodes.set(department.open_department_id, {
      department,
      children: [],
      depth: 0,
      path: department.name,
    });
  }
  for (const node of nodes.values()) {
    const parentId =
      node.department.parent_department_id ?? node.department.parentExternalId;
    if (parentId && parentId !== node.department.open_department_id)
      node.parent = nodes.get(parentId);
  }
  // Incomplete snapshots stay readable; malformed parent references cannot loop the UI.
  const visited = new Set<DepartmentNode>();
  for (const node of nodes.values()) {
    const trail = new Set<DepartmentNode>();
    let current: DepartmentNode | undefined = node;
    while (current && !visited.has(current)) {
      if (trail.has(current)) {
        current.parent = undefined;
        break;
      }
      trail.add(current);
      current = current.parent;
    }
    for (const entry of trail) visited.add(entry);
  }
  const roots: DepartmentNode[] = [];
  for (const node of nodes.values()) {
    if (node.parent) node.parent.children.push(node);
    else roots.push(node);
  }
  const ordered: DepartmentNode[] = [];
  const stack = [...roots].reverse();
  while (stack.length) {
    const node = stack.pop()!;
    node.depth = node.parent ? node.parent.depth + 1 : 0;
    node.path = node.parent
      ? `${node.parent.path} / ${node.department.name}`
      : node.department.name;
    ordered.push(node);
    for (let i = node.children.length - 1; i >= 0; i--)
      stack.push(node.children[i]!);
  }
  return { roots, nodes, ordered };
}

/** Searches retain ancestors as context, without implicitly selecting those ancestors. */
export function searchDepartmentTree(
  tree: ReturnType<typeof buildDepartmentTree>,
  query: string,
) {
  const term = query.trim().toLocaleLowerCase();
  const matches = new Set<string>();
  const included = new Set<string>();
  for (const node of tree.ordered) {
    if (
      !term ||
      `${node.department.name} ${node.path} ${node.department.path || ""}`
        .toLocaleLowerCase()
        .includes(term)
    ) {
      matches.add(node.department.open_department_id);
      let current: DepartmentNode | undefined = node;
      while (current && !included.has(current.department.open_department_id)) {
        included.add(current.department.open_department_id);
        current = current.parent;
      }
    }
  }
  return { matches, included };
}

export type DepartmentTreeRow = {
  node: DepartmentNode;
  last: boolean;
  ancestorLines: boolean[];
};

export function visibleDepartmentRows(
  roots: DepartmentNode[],
  included: Set<string>,
  isExpanded: (node: DepartmentNode) => boolean,
) {
  const rows: DepartmentTreeRow[] = [];
  const visit = (nodes: DepartmentNode[], ancestorLines: boolean[]) =>
    nodes
      .filter((n) => included.has(n.department.open_department_id))
      .map((node, index, siblings) => ({
        node,
        last: index === siblings.length - 1,
        ancestorLines,
      }));
  const stack = visit(roots, []).reverse();
  while (stack.length) {
    const row = stack.pop()!;
    rows.push(row);
    if (isExpanded(row.node)) {
      const children = visit(row.node.children, [
        ...row.ancestorLines,
        !row.last,
      ]);
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
    }
  }
  return rows;
}
