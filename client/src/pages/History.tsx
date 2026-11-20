import { Fragment, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, AuditRow } from '../api';
import { useLoad } from '../hooks';
import { Banner } from '../components/ui';
import { T } from '../../../shared/terms';

const ACTION: Record<string, string> = {
  created: 'Created', published: 'Published', schedule_updated: 'Schedule changed', postponed: 'Postponed',
  locked: 'Locked', unlocked: 'Unlocked', cancelled: 'Cancelled',
};

export default function History() {
  const [params] = useSearchParams();
  const testId = params.get('test');
  const { data, error } = useLoad(() => api<AuditRow[]>(testId ? `/api/lecturer/tests/${testId}/audit` : '/api/lecturer/audit'), [testId]);
  const [open, setOpen] = useState<number | null>(null);
  if (error) return <Banner kind="error">{error.message}</Banner>;
  return (
    <div className="page">
      <h1>{T.history}</h1>
      <p className="muted">Every scheduling change, with who made it and when. {testId && <Link to="/lecturer/history">Show all TESTS</Link>}</p>
      {!data ? <p>Loading…</p> : !data.length ? <p className="empty">No changes recorded yet.</p> : (
        <table className="audit card">
          <thead><tr><th>When</th><th>Who</th><th>TEST</th><th>Action</th><th>Details</th></tr></thead>
          <tbody>
            {data.map((r) => (
              <Fragment key={r.id}>
                <tr>
                  <td className="mono small">{new Date(r.createdAt).toLocaleString('en-GB')}</td>
                  <td>{r.actorName}</td>
                  <td>{r.testTitle}</td>
                  <td><span className={`badge ${r.action}`}>{ACTION[r.action] ?? r.action}</span></td>
                  <td>{r.summary}{r.reason && <div className="muted small">Reason: {r.reason}</div>}
                    {r.changes.length > 0 && <button className="link" onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? 'Hide' : 'Show'} old → new</button>}</td>
                </tr>
                {open === r.id && (
                  <tr className="sub"><td colSpan={5}>
                    <table className="diff"><thead><tr><th>Applies to</th><th>Setting</th><th>Old</th><th>New</th></tr></thead>
                      <tbody>{r.changes.map((c, i) => <tr key={i}><td>{c.scope}</td><td>{c.field}</td><td className="old">{c.old}</td><td className="new">{c.new}</td></tr>)}</tbody></table>
                  </td></tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
