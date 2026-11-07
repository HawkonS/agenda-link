import {
  Controller,
  Get,
  ConflictException,
  Inject,
  Post,
} from "@nestjs/common";
import { ConfigurationService } from "./config/configuration.service.js";
@Controller("api/bootstrap")
export class BootstrapController {
  constructor(
    @Inject(ConfigurationService) private config: ConfigurationService,
  ) {}
  @Get("status") status() {
    return {
      initialized: this.config.isInitialized(),
      configFile: "agenda-link.properties",
      missingRequired: this.config.isInitialized()
        ? []
        : this.config.missingRequired(),
      appPort: this.config.getNumber("app.port", 18480),
      webPort: this.config.getNumber("web.port", 15173),
      appBaseUrl: this.config.baseUrl,
      defaults: this.config.isInitialized()
        ? undefined
        : this.config.setupDefaults(),
    };
  }
  @Post("initialize") async initialize() {
    throw new ConflictException("系统不再需要初始化，首次启动会自动生成内置管理员 hawkon 的密码，请读取 .runtime/initial-admin-password");
  }
}
