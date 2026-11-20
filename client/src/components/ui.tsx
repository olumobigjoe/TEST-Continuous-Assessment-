import { ReactNode, useEffect, useState } from 'react';
import { api, ApiError, Plan, ScheduleChange, TestView } from '../api';
import { T } from '../../../shared/terms';

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header><h2>{title}</h2><button className="icon" onClick={onClose} aria-label="Close">×</button></header>
        {children}
      </div>
    </div>
  );
}

const PHASE: Record<string, [string, string]> = {
  draft: ['Draft', 'muted'], scheduled: ['Scheduled', 'info'], open: ['Open now', 'live'], closed: ['Ended', 'muted'], cancelled: ['Cancelled', 'danger'],
};
export const PhaseBadge = ({ phase }: { phase: string }) => <span className={`badge ${PHASE[phase]?.[1]}`}>{PHASE[phase]?.[0] ?? phase}</span>;

export function Banner({ kind, children }: { kind: 'error' | 'warn' | 'info' | 'ok'; children: ReactNode }) {
  return <div className={`banner ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</div>;
}

/**
 * Shows the server's old→new schedule comparison, and only applies after explicit confirmation.
 * The server re-validates on apply and rejects it if anything changed in between (version check).
 */
export function ScheduleConfirm({ test, change, title, onClose, onApplied }: {
  test: TestView; change: ScheduleChange; title?: string; onClose: () => void; onApplied: (t: TestView) => void;
}) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [reason, setReason] = useState(change.reason ?? '');
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);

  useEffect(() => {
    api<Plan>(`/api/lecturer/tests/${test.id}/schedule/preview`, { method: 'POST', json: change }).then(setPlan).catch(setErr);
  }, [test.id, change]);

  const apply = async () => {
    if (!plan) return;
    setBusy(true); setErr(null);
    try {
      const r = await api<{ test: TestView }>(`/api/lecturer/tests/${test.id}/schedule/apply`, {
        method: 'POST', json: { ...change, reason: reason || undefined, expectedVersion: plan.version, confirm: true },
      });
      onApplied(r.test);
    } catch (e) {
      const ae = e as ApiError;
      if (ae.code === 'VERSION_CONFLICT') setConflict(true);
      if (ae.details?.errors) setPlan({ ...(ae.details as Plan) });
      setErr(ae);
    } finally { setBusy(false); }
  };

  return (
    <Modal title={title ?? 'Confirm TEST schedule change'} onClose={onClose} wide>
      <p className="muted">{test.title} · times in {test.timezone}</p>
      {!plan && !err && <p>Checking the change with the server…</p>}
      {err && <Banner kind="error">{err.message}{conflict && <> <button className="link" onClick={() => location.reload()}>Reload</button></>}</Banner>}
      {plan && (
        <>
          {plan.changes.length > 0 && (
            <table className="diff">
              <thead><tr><th>Applies to</th><th>Setting</th><th>Current schedule</th><th>New schedule</th></tr></thead>
              <tbody>
                {plan.changes.map((c, i) => (
                  <tr key={i}><td>{c.scope}</td><td>{c.field}</td><td className="old">{c.old}</td><td className="new">{c.new}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          {plan.errors.map((e) => <Banner key={e} kind="error">{e}</Banner>)}
          {plan.warnings.map((w) => <Banner key={w} kind="warn">{w}</Banner>)}
          {plan.ok && test.status === 'published' && plan.affectedStudents > 0 && (
            <Banner kind="info">{plan.affectedStudents} student(s) will get an in-app notification and an email about this change.</Banner>
          )}
          {plan.ok && (
            <label className="field">Reason for the change (optional, saved in the audit log)
              <textarea value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} rows={2} />
            </label>
          )}
        </>
      )}
      <footer>
        <button onClick={onClose}>Back</button>
        <button className="primary" disabled={!plan?.ok || busy || conflict} onClick={apply}>{busy ? 'Applying…' : T.applyChanges}</button>
      </footer>
    </Modal>
  );
}

export function SimpleConfirm({ title, body, confirmLabel, danger, withReason, onClose, onConfirm }: {
  title: string; body: ReactNode; confirmLabel: string; danger?: boolean; withReason?: boolean;
  onClose: () => void; onConfirm: (reason?: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose}>
      <div className="stack">{body}</div>
      {withReason && <label className="field">Reason (shared with students where relevant)<textarea rows={2} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} /></label>}
      {err && <Banner kind="error">{err}</Banner>}
      <footer>
        <button onClick={onClose}>Back</button>
        <button className={danger ? 'danger' : 'primary'} disabled={busy} onClick={async () => {
          setBusy(true); setErr(null);
          try { await onConfirm(reason || undefined); } catch (e) { setErr((e as Error).message); setBusy(false); }
        }}>{busy ? 'Working…' : confirmLabel}</button>
      </footer>
    </Modal>
  );
}
