import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fmtDuration, ScheduleChange, Student, syncFrom, TestView } from '../api';
import { useLoad, useServerNow } from '../hooks';
import { Banner, PhaseBadge, ScheduleConfirm } from '../components/ui';
import { T } from '../../../shared/terms';

interface BatchForm { id?: string; key: string; name: string; startTime: string; endTime: string; durationMinutes: number; remove?: boolean }
interface Form { date: string; startTime: string; endTime: string; durationMinutes: number; shiftBatches: boolean; batches: BatchForm[]; assign: Record<string, string> }

const toForm = (t: TestView): Form => ({
  date: t.date, startTime: t.startTime, endTime: t.endTime, durationMinutes: t.durationMinutes, shiftBatches: true,
  batches: t.batches.map((b) => ({ id: b.id, key: b.id, name: b.name, startTime: b.startTime, endTime: b.endTime, durationMinutes: b.durationMinutes })),
  assign: Object.fromEntries(t.batches.flatMap((b) => b.studentIds.map((s) => [s, b.id]))),
});

/** Builds a minimal change: only fields that differ from the saved schedule are sent. */
function buildChange(t: TestView, f: Form): ScheduleChange {
  const c: ScheduleChange = { shiftBatches: f.shiftBatches, test: {}, batches: [] };
  if (f.date !== t.date) c.test!.date = f.date;
  if (f.startTime !== t.startTime) c.test!.startTime = f.startTime;
  if (f.endTime !== t.endTime) c.test!.endTime = f.endTime;
  if (f.durationMinutes !== t.durationMinutes) c.test!.durationMinutes = f.durationMinutes;
  const members = (key: string) => Object.entries(f.assign).filter(([, b]) => b === key).map(([s]) => s).sort();
  for (const b of f.batches) {
    const orig = t.batches.find((x) => x.id === b.id);
    if (b.remove) { if (orig) c.batches!.push({ id: orig.id, remove: true }); continue; }
    const out: NonNullable<ScheduleChange['batches']>[number] = orig ? { id: orig.id } : { name: b.name, startTime: b.startTime, endTime: b.endTime, durationMinutes: b.durationMinutes };
    if (orig) {
      if (b.name !== orig.name) out.name = b.name;
      if (b.startTime !== orig.startTime) out.startTime = b.startTime;
      if (b.endTime !== orig.endTime || (b.startTime !== orig.startTime)) out.endTime = b.endTime;
      if (b.durationMinutes !== orig.durationMinutes) out.durationMinutes = b.durationMinutes;
    }
    const m = members(b.key);
    if (!orig || m.join() !== [...orig.studentIds].sort().join()) out.studentIds = m;
    if (Object.keys(out).length > 1 || !orig) c.batches!.push(out);
  }
  if (!Object.keys(c.test!).length) delete c.test;
  if (!c.batches!.length) delete c.batches;
  return c;
}

export default function ScheduleEditor() {
  const { id } = useParams();
  const [savedAt, setSavedAt] = useState(0);
  const { data, error, setData } = useLoad(async () => {
    const [r, students] = await Promise.all([
      api<{ serverNow: string; test: TestView }>(`/api/lecturer/tests/${id}`),
      api<Student[]>('/api/lecturer/students'),
    ]);
    syncFrom(r.serverNow);
    return { test: r.test, students };
  }, [id]);
  if (error) return <Banner kind="error">{error.message}</Banner>;
  if (!data) return <p className="muted">Loading…</p>;
  return <Editor key={data.test.version} test={data.test} students={data.students} saved={savedAt > 0}
    onSaved={(t) => { setSavedAt(Date.now()); setData({ ...data, test: t }); }} />;
}

function Editor({ test: t, students, saved, onSaved }: { test: TestView; students: Student[]; saved: boolean; onSaved: (t: TestView) => void }) {
  const [f, setF] = useState<Form>(() => toForm(t));
  const [confirm, setConfirm] = useState<ScheduleChange | null>(null);
  const now = useServerNow();
  const change = useMemo(() => buildChange(t, f), [t, f]);
  const dirty = !!(change.test || change.batches);
  const timingLocked = !t.editable.timing;
  const readOnly = t.status === 'cancelled';
  const started = new Set(t.batches.flatMap((b) => b.startedStudentIds));
  const lockedBatch = (b: BatchForm) => { const o = t.batches.find((x) => x.id === b.id); return o ? !o.editable : false; };
  const setB = (key: string, patch: Partial<BatchForm>) => setF({ ...f, batches: f.batches.map((b) => (b.key === key ? { ...b, ...patch } : b)) });

  const addBatch = () => {
    const key = `new_${Date.now()}`;
    setF({ ...f, batches: [...f.batches, { key, name: `${T.batch} ${String.fromCharCode(65 + f.batches.length)}`, startTime: f.startTime, endTime: f.endTime, durationMinutes: f.durationMinutes }] });
  };
  const liveBatches = f.batches.filter((b) => !b.remove);

  return (
    <div className="page">
      <p><Link to="/lecturer/schedule">← {T.schedule}</Link></p>
      <div className="page-head">
        <div>
          <h1>{T.editSchedule}</h1>
          <p className="muted">{t.title} · {t.status === 'draft' ? 'Draft' : t.status === 'published' ? 'Published' : 'Cancelled'}{t.locked ? ' · Locked' : ''} · times in {t.timezone}</p>
        </div>
        <Link className="button ghost" to={`/lecturer/history?test=${t.id}`}>{T.history}</Link>
      </div>
      {saved && <Banner kind="ok">Schedule updated. Access windows now follow the new times.</Banner>}
      {readOnly && <Banner kind="info">This TEST is cancelled and can no longer be edited.</Banner>}

      <section className="card">
        <h2>TEST timing</h2>
        {timingLocked && !readOnly && <Banner kind="info">🔒 {t.editable.timingReason}</Banner>}
        <div className="grid4">
          <label className="field">{T.date}<input type="date" disabled={timingLocked} value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></label>
          <label className="field">{T.startTime}<input type="time" disabled={timingLocked} value={f.startTime} onChange={(e) => setF({ ...f, startTime: e.target.value })} /></label>
          <label className="field">{T.endTime}<input type="time" disabled={timingLocked} value={f.endTime} onChange={(e) => setF({ ...f, endTime: e.target.value })} /></label>
          <label className="field">{T.durationMinutes}<input type="number" min={1} disabled={timingLocked} value={f.durationMinutes} onChange={(e) => setF({ ...f, durationMinutes: Number(e.target.value) })} /></label>
        </div>
        {!timingLocked && (
          <label className="check"><input type="checkbox" checked={f.shiftBatches} onChange={(e) => setF({ ...f, shiftBatches: e.target.checked })} />
            Move batches with the TEST when the date or start time changes</label>
        )}
        <p className="muted small">An end time earlier than the start time means the TEST ends the next day. Batches that use the TEST duration follow any change to it.</p>
      </section>

      <section className="card">
        <div className="section-head"><h2>{T.batches} <span className="muted">({liveBatches.length})</span></h2>
          {!readOnly && <button onClick={addBatch}>+ Add batch</button>}</div>
        <table className="edit-batches">
          <thead><tr><th>Name</th><th>Status</th><th>{T.batchStart}</th><th>{T.batchEnd}</th><th>Duration (min)</th><th>Students</th><th></th></tr></thead>
          <tbody>
            {f.batches.map((b) => {
              const o = t.batches.find((x) => x.id === b.id);
              const locked = lockedBatch(b) || readOnly;
              const count = Object.values(f.assign).filter((k) => k === b.key).length;
              return (
                <tr key={b.key} className={b.remove ? 'removed' : ''}>
                  <td><input value={b.name} disabled={readOnly || b.remove} onChange={(e) => setB(b.key, { name: e.target.value })} /></td>
                  <td>
                    {o ? <PhaseBadge phase={o.phase} /> : <span className="badge info">New</span>}
                    {o?.phase === 'open' && <div className="small mono live">{fmtDuration(new Date(o.endAt).getTime() - now)} left</div>}
                    {locked && o?.lockReason && <div className="small muted">🔒 {o.lockReason}</div>}
                  </td>
                  <td><input type="time" disabled={locked || b.remove} value={b.startTime} onChange={(e) => setB(b.key, { startTime: e.target.value })} /></td>
                  <td><input type="time" disabled={locked || b.remove} value={b.endTime} onChange={(e) => setB(b.key, { endTime: e.target.value })} /></td>
                  <td><input type="number" min={1} disabled={locked || b.remove} value={b.durationMinutes} onChange={(e) => setB(b.key, { durationMinutes: Number(e.target.value) })} /></td>
                  <td>{count}</td>
                  <td>{!locked && (b.remove
                    ? <button className="link" onClick={() => setB(b.key, { remove: false })}>Undo</button>
                    : <button className="link danger" onClick={() => {
                        const assign = Object.fromEntries(Object.entries(f.assign).filter(([, k]) => k !== b.key));
                        setF({ ...f, assign, batches: o ? f.batches.map((x) => (x.key === b.key ? { ...x, remove: true } : x)) : f.batches.filter((x) => x.key !== b.key) });
                      }}>Remove</button>)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>{T.batchStudents}</h2>
        <p className="muted small">Students who have already started cannot be moved. Changes apply to access immediately after you confirm.</p>
        <div className="assign-wrap">
          <table className="assign">
            <thead><tr><th>Student</th><th>Not assigned</th>{liveBatches.map((b) => <th key={b.key}>{b.name}</th>)}</tr></thead>
            <tbody>
              {students.map((s) => {
                const isStarted = started.has(s.id);
                const cur = f.assign[s.id];
                return (
                  <tr key={s.id}>
                    <td>{s.name}{isStarted && <span className="badge live small-badge">started</span>}</td>
                    <td><input type="radio" name={`a_${s.id}`} aria-label={`${s.name} not assigned`} disabled={isStarted || readOnly} checked={!cur}
                      onChange={() => { const a = { ...f.assign }; delete a[s.id]; setF({ ...f, assign: a }); }} /></td>
                    {liveBatches.map((b) => (
                      <td key={b.key}><input type="radio" name={`a_${s.id}`} aria-label={`${s.name} in ${b.name}`} disabled={isStarted || readOnly || (lockedBatch(b) && t.batches.find((x) => x.id === b.id)?.phase === 'closed')}
                        checked={cur === b.key} onChange={() => setF({ ...f, assign: { ...f.assign, [s.id]: b.key } })} /></td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {!readOnly && (
        <div className="sticky-bar">
          <span className="muted">{dirty ? 'You have unsaved schedule changes.' : 'No changes yet.'}</span>
          <button disabled={!dirty} onClick={() => setF(toForm(t))}>Discard</button>
          <button className="primary" disabled={!dirty} onClick={() => setConfirm(change)}>{T.reviewChanges}</button>
        </div>
      )}
      {confirm && <ScheduleConfirm test={t} change={confirm} onClose={() => setConfirm(null)} onApplied={(nt) => { setConfirm(null); onSaved(nt); }} />}
    </div>
  );
}
