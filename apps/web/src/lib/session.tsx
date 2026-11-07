import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getBranding,
  login as loginApi,
  logout as logoutApi,
  me,
  type Branding,
  type SessionUser,
} from "../api";
const defaults: Branding = {
  name: "AgendaLink",
  title: "议链会议日程协同平台",
  logo: "/logo.svg",
  favicon: "/favicon.svg",
  primaryColor: "#1677ff",
  footer: "",
};
type Session = {
  user: SessionUser | null;
  loading: boolean;
  isAdmin: boolean;
  isOperator: boolean;
  branding: Branding;
  login: (u: string, p: string) => Promise<void>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
  reloadBranding: () => Promise<unknown>;
};
const Context = createContext<Session | null>(null);
export function SessionProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const [user, setUser] = useState<SessionUser | null>(null),
    [loading, setLoading] = useState(true);
  const brand = useQuery({ queryKey: ["branding"], queryFn: getBranding });
  const branding = brand.data || defaults;
  async function reload() {
    try {
      setUser(await me());
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    let live = true;
    me()
      .then((u) => {
        if (live) setUser(u);
      })
      .catch(() => {
        if (live) setUser(null);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    const expire = () => {
      setUser(null);
      void client.cancelQueries();
      client.removeQueries({ predicate: (q) => q.queryKey[0] !== "branding" });
    };
    window.addEventListener("agenda-link:unauthorized", expire);
    return () => {
      live = false;
      window.removeEventListener("agenda-link:unauthorized", expire);
    };
  }, [client]);
  useEffect(() => {
    document.title = branding.name;
    const color = /^#[0-9a-f]{6}$/i.test(branding.primaryColor)
      ? branding.primaryColor
      : defaults.primaryColor;
    document.documentElement.style.setProperty("--brand-color", color);
    // Solid primary buttons use white text consistently across configured brand colors.
    document.documentElement.style.setProperty("--brand-foreground", "#ffffff");
    let icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!icon) {
      icon = document.createElement("link");
      icon.rel = "icon";
      document.head.appendChild(icon);
    }
    icon.removeAttribute("type");
    icon.href = branding.favicon || "/favicon.svg";
  }, [branding]);
  async function login(u: string, p: string) {
    const result = await loginApi(u, p);
    await client.cancelQueries();
    client.removeQueries({ predicate: (q) => q.queryKey[0] !== "branding" });
    setUser(result.user);
  }
  async function logout() {
    await logoutApi();
    setUser(null);
    await client.cancelQueries();
    client.removeQueries({ predicate: (q) => q.queryKey[0] !== "branding" });
  }
  return (
    <Context.Provider
      value={{
        user,
        loading,
        isAdmin: user?.role === "system_admin",
        isOperator: user?.role !== "user" && !!user,
        branding,
        login,
        logout,
        reload,
        reloadBranding: () => brand.refetch(),
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useSession() {
  const value = useContext(Context);
  if (!value) throw new Error("SessionProvider required");
  return value;
}
