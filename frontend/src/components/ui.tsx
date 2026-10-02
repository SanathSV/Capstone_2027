import type { ReactNode } from "react";

export function StatusBadge({ value }: { value: string }) {
  const tone = value.includes("COMPLETE") || value === "ACTIVE" || value === "ONLINE" ? "success" : value === "BLOCKED" || value === "ON_HOLD" ? "danger" : value === "IN_PROGRESS" ? "info" : "muted";
  return <span className={`badge badge-${tone}`}><span className="badge-dot" />{value.replaceAll("_", " ")}</span>;
}

export function ProgressBar({ value }: { value: number }) { return <div className="progress-track" aria-label={`${value}% complete`}><span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div>; }
export function StatCard({ label, value, detail, accent = "blue" }: { label: string; value: string | number; detail: string; accent?: string }) { return <div className="stat-card"><div className={`stat-accent ${accent}`} /><p className="eyebrow">{label}</p><strong>{value}</strong><span>{detail}</span></div>; }
export function EmptyState({ title, children }: { title: string; children: ReactNode }) { return <div className="empty-state"><div className="empty-mark">+</div><h3>{title}</h3><p>{children}</p></div>; }
export function ErrorState({ message, retry }: { message: string; retry?: () => void }) { return <div className="error-state"><strong>Unable to load this view</strong><p>{message}</p>{retry && <button className="button secondary" onClick={retry}>Try again</button>}</div>; }
export function Skeleton({ className = "" }: { className?: string }) { return <div className={`skeleton ${className}`} />; }