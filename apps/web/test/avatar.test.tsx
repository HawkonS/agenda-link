import { fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { UserAvatar } from "../src/components/common/UserAvatar";

describe("user avatars", () => {
  it("shows the Feishu image and falls back after a failed load, then retries a changed URL", () => {
    const { rerender } = render(
      <UserAvatar name="张三" src="https://example.com/first.jpg" />,
    );
    const image = screen.getByRole("img", { name: "张三的头像" });
    expect(image.getAttribute("src")).toBe("https://example.com/first.jpg");
    fireEvent.error(image);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByLabelText("张三的默认头像").textContent).toBe("张");
    rerender(<UserAvatar name="张三" src="https://example.com/new.jpg" />);
    expect(
      screen.getByRole("img", { name: "张三的头像" }).getAttribute("src"),
    ).toBe("https://example.com/new.jpg");
  });
  it("shows a default avatar when Feishu has no photo", () => {
    render(<UserAvatar name="李四" />);
    expect(screen.getByLabelText("李四的默认头像").textContent).toBe("李");
  });
});
