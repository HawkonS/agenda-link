import { Component, type ReactNode } from "react";
import { Button } from "../ui/button";

export class AppErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <main
          role="alert"
          className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center"
        >
          <h1 className="text-xl font-semibold">页面加载失败</h1>
          <p className="text-sm text-muted-foreground">请刷新页面后重试。</p>
          <Button onClick={() => window.location.reload()}>刷新页面</Button>
        </main>
      );
    }
    return this.props.children;
  }
}
