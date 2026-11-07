import { useMemo, useState, type ReactNode } from "react";
import {
  Building2,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Folder,
  FolderOpen,
  Users,
} from "lucide-react";
import { Button } from "../ui/button";
import { OptionSelect } from "../common/OptionSelect";
import { Empty, SearchBox, SelectionControl } from "../common/workspace";
import {
  buildDepartmentTree,
  searchDepartmentTree,
  visibleDepartmentRows,
  type DepartmentNode,
  type DirectoryDepartment,
} from "../../lib/department-tree";

export function DepartmentTree({
  departments,
  selected,
  onSelectionChange,
  actions,
}: {
  departments: DirectoryDepartment[];
  selected: string[];
  onSelectionChange: (ids: string[]) => void;
  actions?: ReactNode;
}) {
  const tree = useMemo(() => buildDepartmentTree(departments), [departments]);
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState<"roots" | "all" | "none">("roots");
  const [overrides, setOverrides] = useState<Set<string>>(() => new Set());
  const [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(10);
  const searching = !!search.trim();
  const filtered = useMemo(
    () => searchDepartmentTree(tree, search),
    [tree, search],
  );
  const roots = tree.roots.filter((n) =>
    filtered.included.has(n.department.open_department_id),
  );
  const pageCount = Math.max(1, Math.ceil(roots.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageRoots = roots.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );
  const selectedSet = new Set(selected);
  const selectedCount = selected.filter((id) => tree.nodes.has(id)).length;
  const matchedSelected = [...filtered.matches].filter((id) =>
    selectedSet.has(id),
  ).length;
  function expanded(node: DepartmentNode) {
    if (searching) return true;
    const initial = mode === "all" || (mode === "roots" && node.depth === 0);
    return overrides.has(node.department.open_department_id)
      ? !initial
      : initial;
  }
  const rows = visibleDepartmentRows(pageRoots, filtered.included, expanded);
  function toggle(node: DepartmentNode) {
    setOverrides((current) => {
      const next = new Set(current),
        id = node.department.open_department_id;
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function select(ids: Iterable<string>, checked: boolean) {
    const next = new Set(selected);
    for (const id of ids) {
      if (checked) next.add(id);
      else next.delete(id);
    }
    onSelectionChange([...next]);
  }
  const hasBranches = tree.ordered.some((n) => n.children.length);
  return (
    <div className="department-tree">
      <div className="department-tree-toolbar">
        <SearchBox
          value={search}
          onChange={(value) => {
            setSearch(value);
            setPage(1);
          }}
          placeholder="搜索部门名称或路径"
        />
        <div className="department-tree-tools">
          <Button
            variant="ghost"
            size="sm"
            disabled={!hasBranches || searching}
            onClick={() => {
              setMode("all");
              setOverrides(new Set());
            }}
          >
            <ChevronsUpDown />
            全部展开
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!hasBranches || searching}
            onClick={() => {
              setMode("none");
              setOverrides(new Set());
            }}
          >
            <ChevronsDownUp />
            全部收起
          </Button>
        </div>
        <SelectionControl
          count={selectedCount}
          total={departments.length}
          unit="个部门"
          ariaLabel={searching ? "选择搜索结果" : "选择全部部门"}
          checked={
            filtered.matches.size > 0 &&
            matchedSelected === filtered.matches.size
          }
          indeterminate={
            matchedSelected > 0 && matchedSelected < filtered.matches.size
          }
          disabled={!filtered.matches.size}
          onChange={(checked) => select(filtered.matches, checked)}
        />
        {actions}
      </div>
      {!departments.length ? (
        <div className="department-tree-empty">
          <Empty
            title="先读取飞书组织架构"
            hint="在系统设置中配置飞书同步机器人及通讯录权限，再点击右上角的读取按钮。"
          />
        </div>
      ) : !rows.length ? (
        <div className="department-tree-empty">
          <Empty
            title="没有找到匹配的部门"
            hint="试试其他部门名称，或清除关键词查看完整组织架构。"
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSearch("");
                  setPage(1);
                }}
              >
                清除搜索
              </Button>
            }
          />
        </div>
      ) : (
        <div className="department-tree-scroll">
          <table className="department-tree-table" aria-label="飞书组织架构">
            <thead>
              <tr>
                <th scope="col" className="department-tree-select-column">
                  <span className="sr-only">选择部门</span>
                </th>
                <th scope="col">部门层级</th>
                <th scope="col" className="department-tree-status-column">
                  腾讯会议
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ node, last, ancestorLines }) => {
                const d = node.department,
                  open = expanded(node),
                  branch = node.children.some((n) =>
                    filtered.included.has(n.department.open_department_id),
                  );
                const Icon = !node.parent
                  ? Building2
                  : node.children.length
                    ? open
                      ? FolderOpen
                      : Folder
                    : Users;
                return (
                  <tr
                    key={d.open_department_id}
                    data-department-id={d.open_department_id}
                    data-depth={node.depth}
                    className={
                      searching && !filtered.matches.has(d.open_department_id)
                        ? "department-tree-context"
                        : undefined
                    }
                  >
                    <td className="department-tree-select-column">
                      <input
                        type="checkbox"
                        className="workspace-checkbox"
                        aria-label={`选择 ${d.name}`}
                        checked={selectedSet.has(d.open_department_id)}
                        onChange={(e) =>
                          select([d.open_department_id], e.target.checked)
                        }
                      />
                    </td>
                    <td>
                      <div className="department-tree-node">
                        <span
                          className="department-tree-indent"
                          aria-hidden="true"
                        >
                          {ancestorLines.slice(-6).map((line, index, lines) => (
                            <span
                              key={index}
                              className={`department-tree-lane ${index === lines.length - 1 ? `department-tree-joint${last ? " department-tree-joint-last" : ""}` : lines[index + 1] ? "department-tree-line" : ""}`}
                            />
                          ))}
                        </span>
                        {branch ? (
                          <button
                            type="button"
                            className="department-tree-toggle"
                            disabled={searching}
                            aria-label={`${open ? "收起" : "展开"}${d.name}`}
                            aria-expanded={open}
                            onClick={() => toggle(node)}
                          >
                            <ChevronRight
                              className={
                                open
                                  ? "department-tree-chevron-open"
                                  : undefined
                              }
                            />
                          </button>
                        ) : (
                          <span
                            className="department-tree-toggle-placeholder"
                            aria-hidden="true"
                          />
                        )}
                        <Icon
                          className={`department-tree-icon${!node.parent ? " department-tree-icon-root" : ""}`}
                          aria-hidden="true"
                        />
                        <div
                          className="department-tree-label"
                          title={node.path}
                        >
                          <div className="department-tree-name-row">
                            <span>{d.name}</span>
                            {node.children.length > 0 && (
                              <small
                                aria-label={`${node.children.length} 个直属子部门`}
                              >
                                {node.children.length}
                              </small>
                            )}
                            {searching &&
                              !filtered.matches.has(d.open_department_id) && (
                                <em>上级部门</em>
                              )}
                          </div>
                          {node.depth > 3 && (
                            <small className="department-tree-deep-parent">
                              第 {node.depth + 1} 级 · 上级：
                              {node.parent?.department.name}
                            </small>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="department-tree-status-column">
                      <span
                        className={`department-tree-status${d.tencentDepartmentId ? " department-tree-status-linked" : ""}`}
                      >
                        {d.tencentDepartmentId ? (
                          <Check aria-hidden="true" />
                        ) : (
                          <span
                            className="department-tree-status-dot"
                            aria-hidden="true"
                          />
                        )}
                        {d.tencentDepartmentId ? "已关联" : "待同步"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="department-tree-footer">
        <span>
          共 {departments.length} 个部门
          <span className="department-tree-visible-count">
            {" "}
            · 当前展示 {rows.length} 个
          </span>
        </span>
        {roots.length > 10 && (
          <div className="department-tree-pagination">
            <OptionSelect
              label="每页顶层部门数"
              value={pageSize}
              onChange={(value) => {
                setPageSize(Number(value));
                setPage(1);
              }}
              options={[10, 20, 50].map((value) => ({
                value,
                label: `${value} 个顶层部门`,
              }))}
            />
            <span>
              {currentPage} / {pageCount}
            </span>
            <Button
              variant="outline"
              size="icon"
              aria-label="上一页组织"
              disabled={currentPage <= 1}
              onClick={() => setPage(currentPage - 1)}
            >
              <ChevronLeft />
            </Button>
            <Button
              variant="outline"
              size="icon"
              aria-label="下一页组织"
              disabled={currentPage >= pageCount}
              onClick={() => setPage(currentPage + 1)}
            >
              <ChevronRight />
            </Button>
          </div>
        )}
        {searching && <span>找到 {filtered.matches.size} 个匹配部门</span>}
      </div>
    </div>
  );
}
