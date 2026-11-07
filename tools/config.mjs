import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
export const root = path.resolve(
  process.env.AGENDA_LINK_WORKSPACE || fileURLToPath(new URL("..", import.meta.url)),
);
export function configuration() {
  return Object.fromEntries(
    readFileSync(path.join(root, "agenda-link.properties"), "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim() && !/^[\s]*[#;]/.test(l))
      .map((l) => {
        const i = l.indexOf("=");
        return [
          l.slice(0, i).trim(),
          l
            .slice(i + 1)
            .trim()
            .replace(/\\n/g, "\n"),
        ];
      }),
  );
}
export function port(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535)
    throw new Error("Invalid configured port");
  return n;
}
