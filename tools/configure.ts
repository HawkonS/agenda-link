import path from "node:path";
import { ConfigurationService } from "../apps/server/src/config/configuration.service.js";
const config = new ConfigurationService();
console.log(
  JSON.stringify({
    apiPort: config.getNumber("app.port", 18480),
    webPort: config.getNumber("web.port", 15173),
    logDir: path.resolve(config.workspaceRoot, config.get("logging.dir")),
    root: config.workspaceRoot,
  }),
);
