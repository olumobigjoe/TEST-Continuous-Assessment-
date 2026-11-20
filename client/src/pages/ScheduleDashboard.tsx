import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, fmtDate, fmtDuration, fmtWhen, ScheduleChange, syncFrom, TestView } from '../api';
import { useLoad, useServerNow } from '../hooks';
import { Banner, Modal, PhaseBadge, ScheduleConfirm, SimpleConfirm } from '../components/ui';
import { T } from '../../../shared/terms';

const GROUPS: { key: TestView['group']; label: string }[] = [
  { key: 'active', label: T.active }, { key: 'upcoming', label: T.upcoming }, { key: 'draft', label: T.drafts },
  { key: 'completed', label: T.completed }, { key: 'cancelled', label: T.cancelled },
];

export default function ScheduleDashboard() {
  const { data, error, reload } = useLoad(async () => {
    const r = await api<{ serverNow: string; tests: TestView[] }>('/api/lecturer/tests');
    syncFrom(r.serverNow);
    return r.tests;
  }, [], 15_000);
  const [tab, setTab] = useState<TestView['group'] | 'all'>('all');

  if (error) return <Banner kind="error">{error.message}</Banner>;
  if (!data) return <p className="muted">Loading {T.schedule}…</p>;
  const counts = Object.fromEntries(GROUPS.map((g) => [g.key, data.filter((t) => t.group === g.key).length]));
  const shown = GROUPS.filter((g) => tab === 'all' || tab === g.key);

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>{T.schedule}</h1><p className="muted">All your scheduled TESTS. Times are shown in each TEST's time zone.</p></div>
        <Link className="button primary" to="/lecturer/create">+ {T.create}</Link>
      </div>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'all'} className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>All <b>{data.length}</b></button>
        {GROUPS.map((g) => (
          <button key={g.key} role="tab" aria-selected={tab === g.key} className={tab === g.key ? 'on' : ''} onClick={() => setTab(g.key)}>
            {g.label} <b>{counts[g.key]}</b>
          </button>
        ))}
      </div>
      {shown.map((g) => {
        const list = data.filter((t) => t.group === g.key);
        if (!list.length) return tab === g.key ? <p key={g.key} className="empty">No {g.label} right now.</p> : null;
        return (
          <section key={g.key}>
            <h2 className="group-title">{g.label}</h2>
            {list.map((t) => <TestCard key={t.id} t={t} onChanged={reload} />)}
          </section>
        );
      })}
    </div>
  );
}

function TestCard({ t, onChanged }: { t: TestView; onChanged: () => void }) {
  const now = useServerNow();
  const nav = useNavigate();
  const [dialog, setDialog] = useState<null | 'lock' | 'unlock' | 'cancel' | 'publish' | 'postpone'>(null);
  const [postponeChange, setPostponeChange] = useState<ScheduleChange | null>(null);
  const [copied, setCopied] = useState(false);
  const act = (path: string) => async (reason?: string) => {
    await api(`/api/lecturer/tests/${t.id}/${path}`, { method: 'POST', json: { reason } });
    setDialog(null); onChanged();
  };
  const students = new Set(t.batches.flatMap((b) => b.studentIds)).size;

  return (
    <article className={`card test-card ${t.group}`}>
      <header>
        <div>
          <h3>{t.title}</h3>
          <div className="meta">
            <span>{fmtDate(t.date)}</span>
            <span>{t.startTime} – {t.endTime}{t.endsNextDay ? ' (+1 day)' : ''}</span>
            <span>{T.duration}: {t.durationMinutes} min</span>
            <span>{t.batches.length} batch{t.batches.length === 1 ? '' : 'es'} · {students} students</span>
            <span className="badge muted">{t.generationMode === 'ai' ? T.aiGeneration : T.manualGeneration}</span>
            {t.locked && <span className="badge warn">Locked</span>}
          </div>
        </div>
        <div className="actions">
          <button onClick={() => nav(`/lecturer/tests/${t.id}/schedule`)}>{t.group === 'completed' || t.group === 'cancelled' ? 'View schedule' : T.editSchedule}</button>
          {t.editable.canPublish && <button className="primary" onClick={() => setDialog('publish')}>{T.publish}</button>}
          {t.editable.canPostpone && t.status === 'published' && <button onClick={() => setDialog('postpone')}>{T.postpone}</button>}
          {t.editable.canLock && <button onClick={() => setDialog('lock')}>{T.lock}</button>}
          {t.editable.canUnlock && <button onClick={() => setDialog('unlock')}>{T.unlock}</button>}
          {t.editable.canCancel && <button className="danger-outline" onClick={() => setDialog('cancel')}>{T.cancel}</button>}
          <Link className="button ghost" to={`/lecturer/history?test=${t.id}`}>{T.history}</Link>
        </div>
      </header>
      {t.cancelReason && <p className="muted">Cancelled: {t.cancelReason}</p>}
      <table className="batches">
        <thead><tr><th>Batch</th><th>Status</th><th>Window</th><th>Duration</th><th>Students</th><th>Sessions</th><th>Time</th></tr></thead>
        <tbody>
          {t.batches.map((b) => {
            const start = new Date(b.startAt).getTime(), end = new Date(b.endAt).getTime();
            return (
              <tr key={b.id}>
                <td>{b.name}</td>
                <td><PhaseBadge phase={b.phase} />{!b.editable && t.status !== 'cancelled' && <span className="lock" title={b.lockReason ?? ''}> 🔒</span>}</td>
                <td>{b.startTime} – {b.endTime}{b.date !== t.date ? ` (${fmtDate(b.date)})` : ''}</td>
                <td>{b.durationMinutes} min</td>
                <td>{b.studentIds.length}</td>
                <td>{b.attemptsStarted ? `${b.activeSessions} active · ${b.submitted} submitted` : '—'}</td>
                <td className="mono">
                  {b.phase === 'open' && <span className="live">Closes in {fmtDuration(end - now)}</span>}
                  {b.phase === 'open' && b.lastSessionEndsAt && <div className="muted small">Last session ends {fmtWhen(b.lastSessionEndsAt, t.timezone, false)}</div>}
                  {b.phase === 'scheduled' && <span>Opens in {fmtDuration(start - now)}</span>}
                  {b.phase === 'closed' && <span className="muted">Ended</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {t.status === 'published' && (
        <div className="link-row">
          <span className="muted">{T.link}:</span> <code>{location.origin}{t.testLink}</code>
          <button className="link" onClick={() => navigator.clipboard?.writeText(location.origin + t.testLink).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
      )}

      {dialog === 'publish' && <SimpleConfirm title={T.publish} confirmLabel={T.publish} onClose={() => setDialog(null)} onConfirm={act('publish')}
        body={<p>Students will be notified and can start during their batch window. You can still edit the schedule until a student starts.</p>} />}
      {dialog === 'lock' && <SimpleConfirm title={T.lock} confirmLabel={T.lock} withReason onClose={() => setDialog(null)} onConfirm={act('lock')}
        body={<p>While locked, no student can start this TEST. Students already writing it continue, and their timers are not affected.</p>} />}
      {dialog === 'unlock' && <SimpleConfirm title={T.unlock} confirmLabel={T.unlock} onClose={() => setDialog(null)} onConfirm={act('unlock')}
        body={<p>Students can start again during their batch window.</p>} />}
      {dialog === 'cancel' && <SimpleConfirm title={T.cancel} confirmLabel={T.cancel} danger withReason onClose={() => setDialog(null)} onConfirm={act('cancel')}
        body={<p>This cannot be undone. Assigned students will be told the TEST is cancelled.</p>} />}
      {dialog === 'postpone' && <PostponeDialog t={t} onClose={() => setDialog(null)} onNext={(c) => { setDialog(null); setPostponeChange(c); }} />}
      {postponeChange && <ScheduleConfirm test={t} change={postponeChange} title={`${T.postpone}: review`} onClose={() => setPostponeChange(null)} onApplied={() => { setPostponeChange(null); onChanged(); }} />}
    </article>
  );
}

function PostponeDialog({ t, onClose, onNext }: { t: TestView; onClose: () => void; onNext: (c: ScheduleChange) => void }) {
  const [date, setDate] = useState(t.date);
  const [start, setStart] = useState(t.startTime);
  return (
    <Modal title={T.postpone} onClose={onClose}>
      <p>Move the whole TEST, with every batch, to a later date or time. Batches keep their positions in the window.</p>
      <div className="grid2">
        <label className="field">New {T.date}<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="field">New {T.startTime}<input type="time" value={start} onChange={(e) => setStart(e.target.value)} /></label>
      </div>
      <footer>
        <button onClick={onClose}>Back</button>
        <button className="primary" onClick={() => onNext({ action: 'postpone', shiftBatches: true, test: { date, startTime: start } })}>{T.reviewChanges}</button>
      </footer>
    </Modal>
  );
}
