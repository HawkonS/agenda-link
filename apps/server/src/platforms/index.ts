import { feishuDirectory } from "./directory/feishu/index.js";
import { tencentDirectory } from "./directory/tencent/index.js";
import { feishuMeeting } from "./meeting/feishu/index.js";
import { tencentMeeting } from "./meeting/tencent/index.js";
import { localMeeting } from "./meeting/local/index.js";
import { feishuCalendar } from "./calendar/feishu/index.js";
import type { PlatformComponent } from "./contracts.js";
/** Add an implementation and register it here. HTTP, validation and UI discover it. */
export const platformComponents: PlatformComponent[] = [feishuDirectory,tencentDirectory,feishuMeeting,tencentMeeting,localMeeting,feishuCalendar];
