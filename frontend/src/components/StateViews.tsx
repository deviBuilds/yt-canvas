import type { ReactNode } from "react";

import type { ApiError } from "../api/http";

export function LoadingGrid({ count = 8, label = "Loading videos…" }: { count?: number; label?: string }) {
  return (
    <div className="grid" role="status" aria-label={label} aria-busy="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="card skeleton" aria-hidden="true">
          <div className="thumb" />
          <div className="line" />
          <div className="line short" />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="state empty-state" role="status">
      <h2>{title}</h2>
      {children ? <div className="muted">{children}</div> : null}
      {action ? <div className="row">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  return (
    <div className="state error-state" role="alert" data-code={error.info.code}>
      <h2>{error.isNetwork ? "Can't reach the server" : "Something went wrong"}</h2>
      <p>{error.message}</p>
      {error.info.hint ? <p className="muted small">{error.info.hint}</p> : null}
      {onRetry ? (
        <div className="row">
          <button type="button" className="button" onClick={onRetry}>
            Try again
          </button>
        </div>
      ) : null}
    </div>
  );
}
