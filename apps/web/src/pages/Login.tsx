import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { loginSchema } from "../lib/form-schemas";
import { FieldError } from "../components/ui/field";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "../lib/session";
import { usePage } from "../lib/hooks";
import { request } from "../api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";

import { BUILD_NUMBER, BUILD_TIME, formatBuildTime } from "../lib/build-info";

export default function Login() {
  const { branding, login } = useSession();
  const platformTitle = branding.title || "议链会议日程协同平台";
  const copyrightYear = new Date().getFullYear();
  const copyright =
    copyrightYear === 2026
      ? `© 2026 ${branding.name}`
      : `© 2026-${copyrightYear} ${branding.name}`;
  const [search, setSearch] = useSearchParams();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(loginSchema),
    defaultValues: { username: "", password: "" },
    mode: "onTouched",
  });
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feishuBusy, setFeishuBusy] = useState(false);
  const submitting = useRef(false);
  const feishu = usePage("login-feishu", () => request("/auth/feishu/status"));
  const processing = busy || feishuBusy;
  useEffect(() => {
    const authError = search.get("auth_error") || search.get("error");
    if (!authError) return;
    toast.error(
      "飞书登录失败，请重新发起授权后重试。若问题持续，请联系管理员。",
    );
    const next = new URLSearchParams(search);
    next.delete("auth_error");
    next.delete("error");
    setSearch(next, { replace: true });
  }, [search, setSearch]);
  const logo = (
    <img
      src={branding.logo || "/logo.svg"}
      alt=""
      className="login-logo"
      onError={(event) => {
        if (!event.currentTarget.src.endsWith("/logo.svg"))
          event.currentTarget.src = "/logo.svg";
      }}
    />
  );

  return (
    <main className="login-page">
      <aside className="login-brand" aria-label="平台介绍">
        <div
          className="login-brand-circle login-brand-circle-top"
          aria-hidden="true"
        />
        <div
          className="login-brand-circle login-brand-circle-center"
          aria-hidden="true"
        />
        <div
          className="login-brand-circle login-brand-circle-bottom"
          aria-hidden="true"
        />
        <div className="login-brand-content">
          <div className="login-brand-logo">{logo}</div>
          <p className="login-brand-name">{platformTitle}</p>
          <p className="login-brand-description">
            从会议预约、日程安排到通讯录协作，让团队沟通与协同更清晰、更高效。
          </p>
        </div>
        <footer className="login-brand-footer">{copyright}</footer>
      </aside>
      <div className="login-panel">
        <div className="login-mobile-brand">
          <div className="login-brand-logo">{logo}</div>
          <p>{platformTitle}</p>
        </div>
        <section className="login-content" aria-labelledby="login-heading">
          <header className="login-header">
            <h1 id="login-heading">欢迎回来</h1>
            <p>请登录您的账号以继续</p>
          </header>

          <form
            className="login-form"
            noValidate
            onSubmit={handleSubmit(async ({ username, password }) => {
              if (submitting.current) return;
              submitting.current = true;
              setBusy(true);
              try {
                await login(username.trim(), password);
              } catch (err: any) {
                toast.error(
                  String(
                    err.response?.data?.message || "登录失败，请检查账号与密码",
                  ),
                );
              } finally {
                submitting.current = false;
                setBusy(false);
              }
            })}
          >
            <div className="login-field">
              <label htmlFor="login-username">用户名</label>
              <Input
                id="login-username"
                {...register("username")}
                aria-invalid={!!errors.username}
                aria-describedby={
                  errors.username ? "login-username-error" : undefined
                }
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="请输入用户名"
                className="login-input"
                disabled={processing}
                required
              />
              <FieldError id="login-username-error">
                {errors.username?.message}
              </FieldError>
            </div>
            <div className="login-field">
              <label htmlFor="login-password">密码</label>
              <div className="login-password">
                <Input
                  id="login-password"
                  {...register("password")}
                  aria-invalid={!!errors.password}
                  aria-describedby={
                    errors.password ? "login-password-error" : undefined
                  }
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder="请输入密码"
                  className="login-input"
                  disabled={processing}
                  required
                />
                <button
                  type="button"
                  className="login-password-toggle"
                  aria-label={showPassword ? "隐藏密码" : "显示密码"}
                  aria-pressed={showPassword}
                  aria-controls="login-password"
                  disabled={processing}
                  onClick={() => setShowPassword((value) => !value)}
                >
                  {showPassword ? (
                    <EyeOff aria-hidden="true" />
                  ) : (
                    <Eye aria-hidden="true" />
                  )}
                </button>
              </div>
            </div>
            <FieldError id="login-password-error">
              {errors.password?.message}
            </FieldError>
            <Button
              type="submit"
              className="login-submit"
              disabled={processing}
            >
              {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
              {busy ? "正在登录…" : "登录"}
            </Button>
          </form>

          {feishu.data?.enabled && (
            <div className="login-enterprise">
              <div className="login-divider">
                <span>或</span>
              </div>
              <Button
                type="button"
                variant="outline"
                className="login-feishu"
                disabled={processing}
                onClick={async () => {
                  setFeishuBusy(true);
                  try {
                    window.location.assign(
                      (await request("/auth/feishu/url")).url,
                    );
                  } catch {
                    toast.error("飞书登录暂时不可用，请稍后重试。");
                    setFeishuBusy(false);
                  }
                }}
              >
                {feishuBusy ? (
                  <Loader2 className="animate-spin" aria-hidden="true" />
                ) : (
                  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M4.93 4.93l5.66 5.66-2.83 2.83-5.66-5.66a4 4 0 012.83-2.83z"
                      fill="#3370FF"
                    />
                    <path
                      d="M19.07 4.93l-5.66 5.66 2.83 2.83 5.66-5.66a4 4 0 00-2.83-2.83z"
                      fill="#3370FF"
                    />
                    <path
                      d="M4.93 19.07l5.66-5.66 2.83 2.83-5.66 5.66a4 4 0 01-2.83-2.83z"
                      fill="#3370FF"
                    />
                    <path
                      d="M19.07 19.07l-5.66-5.66-2.83 2.83 5.66 5.66a4 4 0 002.83-2.83z"
                      fill="#3370FF"
                    />
                  </svg>
                )}
                {feishuBusy ? "正在跳转…" : "飞书登录"}
              </Button>
            </div>
          )}
        </section>
        <footer className="login-mobile-footer">{copyright}</footer>
        <div className="login-build-info" aria-label="构建信息">
          <span title={`构建号 ${BUILD_NUMBER}`} aria-label={`构建号 ${BUILD_NUMBER}`}>
            {BUILD_NUMBER}
          </span>
          <span>最后更新: {formatBuildTime(BUILD_TIME)}</span>
        </div>
      </div>
    </main>
  );
}
