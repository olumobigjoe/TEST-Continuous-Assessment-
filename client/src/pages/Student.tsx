import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, Attempt, fmtDuration, fmtWhen, Question, syncFrom } from '../api';
import { useClockSync, useLoad, useServerNow } from '../hooks';
import { Banner, PhaseBadge } from '../components/ui';
import { T } from '../../../shared/terms';

interface StudentTest {
  id: string; title: string; status: string; locked: boolean; timezone: string; cancelReason: string | null;
  batch: { name: string; startAt: string; endAt: string; durationMinutes: number; phase: string };
  attempt: { id: string; state: 'not_started' | 'in_progress' | 'submitted'; submitReason: string | null } | null;
  canStart: boolean; canResume: boolean; testLink: string;
}

function groupOf(t: StudentTest) {
  if (t.status === 'cancelled') return 'cancelled';
  if (t.attempt?.state === 'submitted' || t.batch.phase === 'closed') return 'completed';
  if (t.batch.phase === 'open') return 'active';
  return 'upcoming';
}

export function StudentTests() {
  const { data, error } = useLoad(async () => {
    const r = await api<{ serverNow: string; tests: StudentTest[] }>('/api/student/tests');
    syncFrom(r.serverNow);
    return r.tests;
  }, [], 15_000);
  const { data: notes } = useLoad(() => api<{ id: number; subject: string; body: string; createdAt: string }[]>('/api/me/notifications'), [], 30_000);
  const now = useServerNow();
  if (error) return <Banner kind="error">{error.message}</Banner>;
  if (!data) return <p className="muted">Loading {T.myTests}…</p>;
  const sections: [string, string][] = [['active', T.active], ['upcoming', T.upcoming], ['completed', T.completed], ['cancelled', T.cancelled]];
  return (
    <div className="page two-col">
      <div>
        <h1>{T.myTests}</h1>
        {sections.map(([k, label]) => {
          const list = data.filter((t) => groupOf(t) === k);
          if (!list.length) return null;
          return (
            <section key={k}>
              <h2 className="group-title">{label}</h2>
              {list.map((t) => {
                const opens = new Date(t.batch.startAt).getTime() - now;
                return (
                  <article key={t.id} className="card student-card">
                    <div>
                      <h3>{t.title}</h3>
                      <div className="meta">
                        <span>{T.date}: {fmtWhen(t.batch.startAt, t.timezone)} – {fmtWhen(t.batch.endAt, t.timezone, false)}</span>
                        <span>{T.duration}: {t.batch.durationMinutes} min</span><span>{t.batch.name}</span>
                        <PhaseBadge phase={t.batch.phase} />
                      </div>
                      {t.locked && t.status === 'published' && <Banner kind="warn">Your lecturer has locked this TEST for now. You can start once it is unlocked.</Banner>}
                      {t.cancelReason && <p className="muted">Reason: {t.cancelReason}</p>}
                    </div>
                    <div className="cta">
                      {t.canResume && <Link className="button primary" to={t.testLink}>{T.resume}</Link>}
                      {t.canStart && <Link className="button primary" to={t.testLink}>{T.start}</Link>}
                      {t.batch.phase === 'scheduled' && t.status === 'published' && <span className="mono">Opens in {fmtDuration(opens)}</span>}
                      {t.attempt?.state === 'submitted' && <span className="badge ok">Submitted{t.attempt.submitReason === 'auto_expired' ? ' (time ran out)' : ''}</span>}
                    </div>
                  </article>
                );
              })}
            </section>
          );
        })}
        {!data.length && <p className="empty">You have no TESTS yet.</p>}
      </div>
      <aside className="card notes">
        <h2>Notifications</h2>
        {!notes?.length ? <p className="muted small">Nothing new.</p> : notes.map((n) => (
          <div key={n.id} className="note"><b>{n.subject}</b><pre>{n.body}</pre><span className="muted small">{new Date(n.createdAt).toLocaleString('en-GB')}</span></div>
        ))}
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------- taking a TEST

const backupKey = (id: string) => `tm.answers.${id}`;
const readBackup = (id: string): Record<string, unknown> => { try { return JSON.parse(localStorage.getItem(backupKey(id)) ?? '{}'); } catch { return {}; } };
const writeBackup = (id: string, a: Record<string, unknown>) => { try { localStorage.setItem(backupKey(id), JSON.stringify(a)); } catch { /* ignore */ } };

export function TakeTest() {
  const { id } = useParams();
  const [info, setInfo] = useState<StudentTest | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [err, setErr] = useState<ApiError | null>(null);
  const [starting, setStarting] = useState(false);

  const loadInfo = useCallback(async () => {
    try {
      const r = await api<{ serverNow: string; test: StudentTest }>(`/api/student/tests/${id}`);
      syncFrom(r.serverNow);
      setInfo(r.test);
      if (r.test.attempt) await begin(); // resume after refresh / reconnect
    } catch (e) { setErr(e as ApiError); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const begin = async () => {
    setStarting(true);
    try {
      const r = await api<{ attempt: Attempt; questions: Question[] }>(`/api/student/tests/${id}/start`, { method: 'POST' });
      syncFrom(r.attempt.serverNow);
      setAttempt(r.attempt); setQuestions(r.questions); setErr(null);
    } catch (e) { setErr(e as ApiError); } finally { setStarting(false); }
  };

  useEffect(() => { loadInfo(); }, [loadInfo]);

  if (attempt) return <Session attempt={attempt} questions={questions} title={info?.title ?? 'TEST'} onUpdate={setAttempt} />;
  if (!info) return err ? <Banner kind="error">{err.message}</Banner> : <p className="muted">Loading…</p>;
  return <Lobby t={info} err={err} starting={starting} onStart={begin} onRecheck={loadInfo} />;
}

function Lobby({ t, err, starting, onStart, onRecheck }: { t: StudentTest; err: ApiError | null; starting: boolean; onStart: () => void; onRecheck: () => void }) {
  const now = useServerNow();
  const opens = new Date(t.batch.startAt).getTime() - now;
  const closes = new Date(t.batch.endAt).getTime() - now;
  useEffect(() => { if (t.batch.phase === 'scheduled' && opens <= 0) onRecheck(); }, [opens <= 0]); // eslint-disable-line
  const effective = Math.min(t.batch.durationMinutes * 60_000, Math.max(0, closes));
  return (
    <div className="page narrow">
      <p><Link to="/student">← {T.myTests}</Link></p>
      <div className="card lobby">
        <h1>{t.title}</h1>
        <dl>
          <dt>{T.batch}</dt><dd>{t.batch.name}</dd>
          <dt>Window</dt><dd>{fmtWhen(t.batch.startAt, t.timezone)} – {fmtWhen(t.batch.endAt, t.timezone, false)} ({t.timezone})</dd>
          <dt>{T.duration}</dt><dd>{t.batch.durationMinutes} minutes</dd>
        </dl>
        {err && <Banner kind="error">{err.message}</Banner>}
        {t.status === 'cancelled' && <Banner kind="error">This TEST has been cancelled.</Banner>}
        {t.locked && t.status === 'published' && <Banner kind="warn">Your lecturer has locked this TEST for now. Please wait. This page checks again automatically.</Banner>}
        {t.batch.phase === 'scheduled' && <p className="big mono">Opens in {fmtDuration(opens)}</p>}
        {t.batch.phase === 'closed' && <Banner kind="info">Your batch window has closed.</Banner>}
        {t.canStart && (
          <>
            <Banner kind="info">Your timer starts when you press {T.start} and keeps running if you refresh or lose connection.
              You will have <b>{fmtDuration(effective)}</b>{effective < t.batch.durationMinutes * 60_000 ? ' because your batch window closes soon' : ''}. The TEST is submitted automatically when time runs out.</Banner>
            <button className="primary big" disabled={starting} onClick={onStart}>{starting ? 'Starting…' : T.start}</button>
          </>
        )}
        {t.locked && <AutoRecheck onRecheck={onRecheck} />}
      </div>
    </div>
  );
}
function AutoRecheck({ onRecheck }: { onRecheck: () => void }) {
  useEffect(() => { const i = setInterval(onRecheck, 10_000); return () => clearInterval(i); }, [onRecheck]);
  return null;
}

function Session({ attempt, questions, title, onUpdate }: { attempt: Attempt; questions: Question[]; title: string; onUpdate: (a: Attempt) => void }) {
  const online = useClockSync(20_000);
  const now = useServerNow(250);
  const deadline = new Date(attempt.deadlineAt).getTime();
  const remaining = attempt.submittedAt ? 0 : Math.max(0, deadline - now);
  const [answers, setAnswers] = useState<Record<string, unknown>>(() => ({ ...attempt.answers, ...readBackup(attempt.id) }));
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'pending' | 'offline'>('saved');
  const [submitting, setSubmitting] = useState(false);
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const pending = useRef(false);
  const answersRef = useRef(answers);
  answersRef.current = answers;
  const done = !!attempt.submittedAt;

  const handleFinal = (e: unknown) => {
    const ae = e as ApiError;
    if ((ae.code === 'TIME_UP' || ae.code === 'ALREADY_SUBMITTED') && ae.details) { onUpdate(ae.details as Attempt); return true; }
    return false;
  };

  const save = useCallback(async () => {
    if (!pending.current || done) return;
    setSaveState('saving');
    try {
      await api(`/api/student/attempts/${attempt.id}/answers`, { method: 'PUT', json: { answers: answersRef.current } });
      pending.current = false; setSaveState('saved');
    } catch (e) {
      if (!handleFinal(e)) setSaveState((e as ApiError).code === 'OFFLINE' ? 'offline' : 'pending');
    }
  }, [attempt.id, done]); // eslint-disable-line

  // debounce autosave + retry loop while anything is unsaved
  useEffect(() => { if (!pending.current) return; const t = setTimeout(save, 800); return () => clearTimeout(t); }, [answers, save]);
  useEffect(() => { const i = setInterval(() => pending.current && save(), 4000); return () => clearInterval(i); }, [save]);

  const submit = useCallback(async () => {
    if (done || submitting) return;
    setSubmitting(true);
    try {
      const r = await api<{ attempt: Attempt }>(`/api/student/attempts/${attempt.id}/submit`, { method: 'POST', json: { answers: answersRef.current } });
      onUpdate(r.attempt);
    } catch (e) {
      if (!handleFinal(e)) { setSubmitting(false); setSaveState('offline'); }
    }
  }, [attempt.id, done, submitting]); // eslint-disable-line

  // auto-submit at zero (server also auto-submits on its own)
  useEffect(() => { if (!done && remaining <= 0 && !submitting) submit(); }, [remaining <= 0, done, submitting]); // eslint-disable-line
  // if we went offline at zero, keep trying once connection returns
  useEffect(() => { if (!done && remaining <= 0 && online) { setSubmitting(false); } }, [online]); // eslint-disable-line

  const setAnswer = (qid: string, v: unknown) => {
    if (done || remaining <= 0) return;
    const next = { ...answers, [qid]: v };
    pending.current = true; setSaveState('pending');
    writeBackup(attempt.id, next);
    setAnswers(next);
  };

  if (done) return (
    <div className="page narrow"><div className="card lobby">
      <h1>{title}</h1>
      <Banner kind="ok">{attempt.submitReason === 'auto_expired' ? T.autoSubmitted : T.submitted}</Banner>
      <p className="muted">Submitted at {new Date(attempt.submittedAt!).toLocaleTimeString('en-GB')}.</p>
      <Link className="button" to="/student">Back to {T.myTests}</Link>
    </div></div>
  );

  const warn = remaining < 5 * 60_000;
  return (
    <div className="page narrow session">
      <div className={`timer-bar ${warn ? 'warn' : ''}`} role="timer" aria-live="off">
        <div><b>{title}</b><div className="small muted">Ends at {new Date(deadline).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</div></div>
        <div className="countdown mono" aria-label={`${T.timeRemaining} ${fmtDuration(remaining)}`}>{fmtDuration(remaining)}</div>
        <div className="small">
          {!online || saveState === 'offline' ? <span className="danger-text">Offline · answers kept on this device</span>
            : saveState === 'saved' ? <span className="muted">All answers saved</span> : <span className="muted">Saving…</span>}
        </div>
      </div>
      {remaining <= 0 && <Banner kind="warn">Time is up. Submitting your TEST…{!online && ' Waiting for your connection to return. Your saved answers are already with the server.'}</Banner>}
      {questions.map((q, i) => (
        <section key={q.id} className="card question">
          <h3><span className="qn">{i + 1}</span> {q.text}</h3>
          {q.type === 'mcq' ? q.options!.map((o, j) => (
            <label key={j} className={`option ${answers[q.id] === j ? 'on' : ''}`}>
              <input type="radio" name={q.id} checked={answers[q.id] === j} disabled={remaining <= 0} onChange={() => setAnswer(q.id, j)} /> {o}
            </label>
          )) : <textarea rows={4} disabled={remaining <= 0} value={(answers[q.id] as string) ?? ''} onChange={(e) => setAnswer(q.id, e.target.value)} />}
        </section>
      ))}
      <div className="sticky-bar">
        <span className="muted">{Object.keys(answers).length} of {questions.length} answered</span>
        {confirmSubmit
          ? <><span>Submit now? You can't change answers afterwards.</span><button onClick={() => setConfirmSubmit(false)}>Keep working</button><button className="primary" disabled={submitting} onClick={submit}>{T.submit}</button></>
          : <button className="primary" disabled={remaining <= 0} onClick={() => setConfirmSubmit(true)}>{T.submit}</button>}
      </div>
    </div>
  );
}


