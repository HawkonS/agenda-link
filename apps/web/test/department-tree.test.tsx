import { useState } from "react";
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DepartmentTree } from "../src/components/sync/DepartmentTree";
import {
  buildDepartmentTree,
  visibleDepartmentRows,
  type DirectoryDepartment,
} from "../src/lib/department-tree";

function mount(departments: DirectoryDepartment[]) {
  function Preview() {
    const [selected, setSelected] = useState<string[]>([]);
    return (
      <DepartmentTree
        departments={departments}
        selected={selected}
        onSelectionChange={setSelected}
      />
    );
  }
  return render(<Preview />);
}
const departments: DirectoryDepartment[] = [
  {
    open_department_id: "support",
    parent_department_id: "platform",
    name: "平台 / 支持",
    tencentDepartmentId: "tc-support",
  },
  {
    open_department_id: "company",
    parent_department_id: "0",
    name: "示例公司",
  },
  {
    open_department_id: "sales",
    parent_department_id: "company",
    name: "销售中心",
  },
  {
    open_department_id: "platform",
    parent_department_id: "company",
    name: "研发中心",
  },
];
const rowIds = () =>
  [
    ...screen
      .getByRole("table")
      .querySelectorAll<HTMLTableRowElement>("tbody tr"),
  ].map((row) => row.dataset.departmentId);

describe("organization hierarchy", () => {
  it("groups out-of-order departments by their actual parent and keeps selection when collapsed", async () => {
    mount(departments);
    const user = userEvent.setup();
    expect(rowIds()).toEqual(["company", "sales", "platform"]);
    await user.click(screen.getByRole("button", { name: "展开研发中心" }));
    expect(rowIds()).toEqual(["company", "sales", "platform", "support"]);
    const row = screen
      .getByRole("checkbox", { name: "选择 平台 / 支持" })
      .closest("tr")!;
    // A slash in the department's own name does not create an extra hierarchy level.
    expect(row.getAttribute("data-depth")).toBe("2");
    expect(within(row).getByText("已关联")).not.toBeNull();
    await user.click(
      screen.getByRole("checkbox", { name: "选择 平台 / 支持" }),
    );
    expect(
      (
        screen.getByRole("checkbox", {
          name: "选择 研发中心",
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
    expect(
      (
        screen.getByRole("checkbox", {
          name: "选择全部部门",
        }) as HTMLInputElement
      ).indeterminate,
    ).toBe(true);
    await user.click(screen.getByRole("button", { name: "收起示例公司" }));
    expect(rowIds()).toEqual(["company"]);
    await user.click(screen.getByRole("button", { name: "展开示例公司" }));
    expect(
      (
        screen.getByRole("checkbox", {
          name: "选择 平台 / 支持",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: "选择全部部门" }));
    await user.click(screen.getByRole("checkbox", { name: "选择全部部门" }));
    expect(
      (
        screen.getByRole("checkbox", {
          name: "选择全部部门",
        }) as HTMLInputElement
      ).indeterminate,
    ).toBe(false);
    await user.click(screen.getByRole("button", { name: "全部收起" }));
    expect(rowIds()).toEqual(["company"]);
    await user.click(screen.getByRole("button", { name: "全部展开" }));
    expect(rowIds()).toEqual(["company", "sales", "platform", "support"]);
  });
  it("searches reveal matching departments and their ancestors without selecting ancestors", async () => {
    mount(departments);
    const user = userEvent.setup();
    await user.type(
      screen.getByRole("textbox", { name: "搜索部门名称或路径" }),
      "平台 / 支持",
    );
    expect(rowIds()).toEqual(["company", "platform", "support"]);
    expect(screen.getAllByText("上级部门")).toHaveLength(2);
    await user.click(screen.getByRole("checkbox", { name: "选择搜索结果" }));
    expect(
      (
        screen.getByRole("checkbox", {
          name: "选择 平台 / 支持",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(
      (
        screen.getByRole("checkbox", {
          name: "选择 研发中心",
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
    expect(
      (
        screen.getByRole("checkbox", {
          name: "选择 示例公司",
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
    await user.clear(
      screen.getByRole("textbox", { name: "搜索部门名称或路径" }),
    );
    expect(rowIds()).toEqual(["company", "sales", "platform"]);
    await user.type(
      screen.getByRole("textbox", { name: "搜索部门名称或路径" }),
      "不存在",
    );
    expect(screen.getByText("没有找到匹配的部门")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "清除搜索" }));
    expect(rowIds()).toEqual(["company", "sales", "platform"]);
  });
  it("paginates whole top-level branches so children never lose their parent", async () => {
    mount(
      Array.from({ length: 12 }, (_, i) => [
        {
          open_department_id: `child-${i}`,
          parent_department_id: `root-${i}`,
          name: `子部门 ${i + 1}`,
        },
        {
          open_department_id: `root-${i}`,
          parent_department_id: "0",
          name: `顶层部门 ${i + 1}`,
        },
      ]).flat(),
    );
    const user = userEvent.setup();
    expect(rowIds()).toHaveLength(20);
    expect(screen.queryByText("顶层部门 11", { exact: true })).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: "选择 子部门 1" }));
    await user.click(screen.getByRole("button", { name: "下一页组织" }));
    expect(rowIds()).toEqual(["root-10", "child-10", "root-11", "child-11"]);
    await user.click(screen.getByRole("button", { name: "上一页组织" }));
    expect(
      (
        screen.getByRole("checkbox", {
          name: "选择 子部门 1",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
  });
  it("keeps orphaned and malformed departments reachable without recursive loops", () => {
    const tree = buildDepartmentTree([
      {
        open_department_id: "orphan",
        parent_department_id: "missing",
        name: "缺失上级",
      },
      { open_department_id: "a", parent_department_id: "b", name: "A" },
      { open_department_id: "b", parent_department_id: "a", name: "B" },
      {
        open_department_id: "self",
        parent_department_id: "self",
        name: "自身引用",
      },
    ]);
    const rows = visibleDepartmentRows(
      tree.roots,
      new Set(tree.nodes.keys()),
      () => true,
    );
    expect(
      new Set(rows.map((row) => row.node.department.open_department_id)),
    ).toEqual(new Set(["orphan", "a", "b", "self"]));
  });
});
