import { RuntimeController } from "./runtime.controller.js";
import { LogFilesService } from "./log-files.service.js";
import { SystemUsersService } from "./system-users.service.js";
import { Module } from "@nestjs/common";
import { ConfigurationService } from "./config/configuration.service.js";
import { DatabaseService } from "./database.service.js";
import { BootstrapController } from "./bootstrap.controller.js";
import { HealthController } from "./health.controller.js";
import { SystemController } from "./system.controller.js";
import { RecordsController } from "./records.controller.js";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { BusinessController } from "./business.controller.js";
import { WorkerService } from "./worker.service.js";
import { PlatformHttp } from "./platforms/shared/http.js";
import { FeishuAdapter } from "./platforms/shared/feishu/client.js";
import { TencentAdapter } from "./platforms/shared/tencent/client.js";
import { MeetingService } from "./meeting.service.js";
import { MeetingQueryService } from "./meeting-query.service.js";
import { MeetingLifecycleService } from "./meeting-lifecycle.service.js";
import { CalendarService } from "./calendar.service.js";
import { RecordingService } from "./recording.service.js";
import { SyncService } from "./sync.service.js";
import { PlatformConnectionService } from "./platform-connection.service.js";
import { PlatformRegistry } from "./platforms/registry.js";
import { platformComponents } from "./platforms/index.js";
import { COMPONENTS } from "./platforms/contracts.js";
import { DirectoryService } from "./directory.service.js";

@Module({
  controllers: [
    BootstrapController,
    HealthController,
    SystemController,
    RuntimeController,
    RecordsController,
    AuthController,
    BusinessController,
  ],
  providers: [
    {provide: COMPONENTS, useValue: platformComponents},
    {provide:"PlatformConnectionService",useExisting:PlatformConnectionService},
    PlatformRegistry,
    DirectoryService,
    ConfigurationService,
    LogFilesService,
    DatabaseService,
    AuthService,
    WorkerService,
    PlatformHttp,
    FeishuAdapter,
    TencentAdapter,
    MeetingService,
    MeetingQueryService,
    MeetingLifecycleService,
    CalendarService,
    RecordingService,
    SyncService,
    SystemUsersService,
    PlatformConnectionService,
  ],
})
export class AppModule {}
