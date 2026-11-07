import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { SessionProvider } from "./lib/session";
import App from "./App";
import { AppErrorBoundary } from "./components/common/AppErrorBoundary";
import "./styles.css";
const client = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false, staleTime: 15000 },
  },
});
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={client}>
      <AppErrorBoundary>
        <SessionProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
          <Toaster richColors position="top-right" />
        </SessionProvider>
      </AppErrorBoundary>
    </QueryClientProvider>
  </React.StrictMode>,
);
