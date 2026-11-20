import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, Student, TestView } from '../api';
import { useLoad } from '../hooks';
import { Banner } from '../components/ui';
import { T } from '../../../shared/terms';

const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Africa/Lagos';
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

export default function CreateTest() {
  const nav = useNavigate();
  const { data: students } = useLoad(() => api<Student[]>('/api/lecturer/students'), []);
  const [f, setF] = useState({
    title: '', generationMode: 'manual' as 'ai' | 'manual', timezone: browserTz, date: tomorrow(), startTime: '09:00', endTime: '12:00',
    durationMinutes: 60, numberOfBatches: 2, gapMinutes: 15,
  });
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sel = picked ?? new Set(students?.map((s) => s.id) ?? []);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF({ ...f, [k]: v });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const t = await api<TestView>('/api/lecturer/tests', { method: 'POST', json: { ...f, studentIds: [...sel] } });
      nav(`/lecturer/tests/${t.id}/schedule`);
    } catch (e2) { setErr((e2 as ApiError).message); setBusy(false); }
  };

  return (
    <form className="page" onSubmit={submit}>
      <h1>{T.create}</h1>
      <section className="card">
        <label className="field">{T.title}<input required value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="e.g. CSC 201 Continuous Assessment TEST" /></label>
        <fieldset className="mode">
          <legend>How will the {T.questions} be created?</legend>
          <label className={f.generationMode === 'ai' ? 'on' : ''}><input type="radio" checked={f.generationMode === 'ai'} onChange={() => set('generationMode', 'ai')} /> <b>{T.aiGeneration}</b><span className="muted small">Generate questions from your course material</span></label>
          <label className={f.generationMode === 'manual' ? 'on' : ''}><input type="radio" checked={f.generationMode === 'manual'} onChange={() => set('generationMode', 'manual')} /> <b>{T.manualGeneration}</b><span className="muted small">Write or import questions yourself</span></label>
        </fieldset>
      </section>
      <section className="card">
        <h2>Schedule</h2>
        <div className="grid4">
          <label className="field">{T.date}<input type="date" required value={f.date} onChange={(e) => set('date', e.target.value)} /></label>
          <label className="field">{T.startTime}<input type="time" required value={f.startTime} onChange={(e) => set('startTime', e.target.value)} /></label>
          <label className="field">{T.endTime}<input type="time" required value={f.endTime} onChange={(e) => set('endTime', e.target.value)} /></label>
          <label className="field">{T.durationMinutes}<input type="number" min={1} required value={f.durationMinutes} onChange={(e) => set('durationMinutes', Number(e.target.value))} /></label>
          <label className="field">{T.numberOfBatches}<input type="number" min={1} max={50} value={f.numberOfBatches} onChange={(e) => set('numberOfBatches', Number(e.target.value))} /></label>
          <label className="field">Gap between batches (min)<input type="number" min={0} value={f.gapMinutes} onChange={(e) => set('gapMinutes', Number(e.target.value))} /></label>
          <label className="field">{T.timezone}<input value={f.timezone} onChange={(e) => set('timezone', e.target.value)} /></label>
        </div>
        <p className="muted small">The window is split into equal, back-to-back batches and students are spread across them. You can fine-tune each batch after saving.</p>
      </section>
      <section className="card">
        <div className="section-head"><h2>Students <span className="muted">({sel.size} selected)</span></h2>
          <div><button type="button" className="link" onClick={() => setPicked(new Set(students?.map((s) => s.id)))}>Select all</button> · <button type="button" className="link" onClick={() => setPicked(new Set())}>None</button></div></div>
        <div className="student-grid">
          {students?.map((s) => (
            <label key={s.id} className="check"><input type="checkbox" checked={sel.has(s.id)} onChange={(e) => {
              const n = new Set(sel); if (e.target.checked) n.add(s.id); else n.delete(s.id); setPicked(n);
            }} /> {s.name}</label>
          ))}
        </div>
      </section>
      {err && <Banner kind="error">{err}</Banner>}
      <div className="sticky-bar"><span className="muted">Saved as a draft. Publish it from the {T.schedule} when you're ready.</span>
        <button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save draft TEST'}</button></div>
    </form>
  );
}
