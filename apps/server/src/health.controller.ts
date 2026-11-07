import { bootId, revision } from "./runtime.controller.js";
import { Controller, Get, Inject } from "@nestjs/common";
import { ConfigurationService } from "./config/configuration.service.js";

@Controller("api/health")
export class HealthController {
  constructor(
    @Inject(ConfigurationService)
    private readonly configuration: ConfigurationService,
  ) {}

  @Get()
  health() {
    return {
      status: "ok",
      initialized: this.configuration.isInitialized(),
      bootId,
      revision: revision(this.configuration.workspaceRoot),
    };
  }
}
