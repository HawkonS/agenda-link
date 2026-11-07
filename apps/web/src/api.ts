import axios from "axios";
import { toast } from "sonner";

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || "/api",
  timeout: 60000,
  withCredentials: true,
});

api.interceptors.response.use(undefined, (error) => {
  if (axios.isCancel(error) || error.config?.headers?.["X-Silent-Request"])
    return Promise.reject(error);
  const loginHandlesError = ["/auth/login", "/auth/feishu/url"].includes(
    error.config?.url || "",
  );
  if (error.response?.status === 401 && window.location.pathname !== "/login") {
    window.dispatchEvent(new CustomEvent("agenda-link:unauthorized"));
  }
  if (error.response?.status !== 401 && !loginHandlesError)
    toast.error(
      String(
        error.response?.data?.message ||
          (error.response?.status === 429
            ? "请求过于频繁，请稍后重试"
            : "请求失败，请检查服务连接"),
      ),
    );
  return Promise.reject(error);
});

export type Branding = {
  name: string;
  title?: string;
  logo: string;
  favicon: string;
  primaryColor: string;
  footer: string;
};

export async function getBranding(): Promise<Branding> {
  const { data } = await api.get<Branding>("/system/branding");
  return data;
}

export type SessionUser = {
  id: number;
  username: string;
  displayName: string;
  avatarUrl?: string | null;
  role: "system_admin" | "operation_admin" | "user";
};
export async function login(username: string, password: string) {
  const { data } = await api.post<{ token: string; user: SessionUser }>(
    "/auth/login",
    { username, password },
  );
  return data;
}
export async function logout() {
  await api.post("/auth/logout");
}
export async function me() {
  const { data } = await api.get<{ user: SessionUser }>("/auth/me");
  return data.user;
}
export async function getProfile() {
  const { data } = await api.get("/profile");
  return data;
}
export async function updateProfile(payload: Record<string, unknown>) {
  const { data } = await api.patch("/profile", payload);
  return data;
}
export async function getSummary() {
  const { data } = await api.get("/dashboard/summary");
  return data;
}
export async function getUsers() {
  const { data } = await api.get("/users");
  return data;
}
export async function createUser(payload: Record<string, unknown>) {
  const { data } = await api.post("/users", payload);
  return data;
}
export async function updateUser(id: number, payload: Record<string, unknown>) {
  const { data } = await api.patch(`/users/${id}`, payload);
  return data;
}
export async function getDepartments() {
  const { data } = await api.get("/departments");
  return data;
}
export async function getSyncRuns() {
  const { data } = await api.get("/sync/runs");
  return data;
}
export async function getSyncRules() {
  const { data } = await api.get("/sync/rules");
  return data;
}
export async function createSyncRule(payload: Record<string, unknown>) {
  const { data } = await api.post("/sync/rules", payload);
  return data;
}
export async function runSync() {
  const { data } = await api.post("/sync/run");
  return data;
}
export async function getPools() {
  const { data } = await api.get("/account-pools");
  return data;
}
export async function getMeetingAccounts() {
  const { data } = await api.get("/meeting-accounts");
  return data;
}
export async function createPool(payload: Record<string, unknown>) {
  const { data } = await api.post("/account-pools", payload);
  return data;
}
export async function createMeetingAccount(payload: Record<string, unknown>) {
  const { data } = await api.post("/meeting-accounts", payload);
  return data;
}
export async function getTemplates() {
  const { data } = await api.get("/calendar-templates");
  return data;
}
export async function createTemplate(payload: Record<string, unknown>) {
  const { data } = await api.post("/calendar-templates", payload);
  return data;
}
export async function getMeetings() {
  const { data } = await api.get("/meetings");
  return data;
}
export async function createMeeting(
  payload: Record<string, unknown>,
  key: string,
) {
  const { data } = await api.post("/meetings", payload, {
    headers: { "Idempotency-Key": key },
  });
  return data;
}
export async function cancelMeeting(id: number) {
  const { data } = await api.post(`/meetings/${id}/cancel`);
  return data;
}
export async function request(
  path: string,
  method = "GET",
  body?: unknown,
  timeout?: number,
) {
  return (
    await api.request({
      url: path,
      method,
      data: body,
      ...(timeout ? { timeout } : {}),
    })
  ).data;
}
/**
 * Generate an idempotency key without requiring the newer randomUUID API.
 * Some embedded browsers expose Web Crypto but omit randomUUID.
 */
export const requestKey = () => {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function")
    return cryptoApi.randomUUID().replaceAll("-", "");

  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === "function") {
    cryptoApi.getRandomValues(bytes);
  } else {
    const now = Date.now();
    for (let i = 0; i < bytes.length; i++)
      bytes[i] = (Math.random() * 256 + (now >> (i % 8))) & 0xff;
  }
  // Keep UUID v4 formatting while returning the historical dash-free key.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
};
