import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
// jsdom has no layout engine; Radix observes switch dimensions in browsers.
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
HTMLElement.prototype.scrollIntoView = () => {};
HTMLElement.prototype.hasPointerCapture = () => false;
HTMLElement.prototype.setPointerCapture = () => {};
HTMLElement.prototype.releasePointerCapture = () => {};
if (!globalThis.PointerEvent)
  globalThis.PointerEvent = MouseEvent as typeof PointerEvent;
afterEach(cleanup);
