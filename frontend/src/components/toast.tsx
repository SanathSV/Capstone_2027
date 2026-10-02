"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

type Toast = { id: number; message: string; tone: "success" | "error" };
type ToastContextValue = { success: (message: string) => void; error: (message: string) => void };
const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, tone: Toast["tone"]) => { const id = Date.now(); setToasts((current) => [...current, { id, message, tone }]); window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4000); }, []);
  const value = useMemo(() => ({ success: (message: string) => push(message, "success"), error: (message: string) => push(message, "error") }), [push]);
  return <ToastContext.Provider value={value}>{children}<div className="toast-region" aria-live="polite">{toasts.map((toast) => <div className={`toast ${toast.tone}`} key={toast.id}>{toast.message}</div>)}</div></ToastContext.Provider>;
}

export function useToast() { const context = useContext(ToastContext); if (!context) throw new Error("useToast must be used within ToastProvider"); return context; }