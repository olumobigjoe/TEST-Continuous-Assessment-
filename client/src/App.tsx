import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { api, currentUserId, setCurrentUserId, User } from './api';
import ScheduleDashboard from './pages/ScheduleDashboard';
import ScheduleEditor from './pages/ScheduleEditor';
import CreateTest from './pages/CreateTest';
import History from './pages/History';
import { StudentTests, TakeTest } from './pages/Student';
import { T } from '../../shared/terms';

function Shell() {
  const [users, setUsers] = useState<User[]>([]);
  const [uid, setUid] = useState(currentUserId());
  const nav = useNavigate();
  useEffect(() => { api<User[]>('/api/users').then(setUsers).catch(() => {}); }, []);
  const me = users.find((u) => u.id === uid);
  const lecturer = me ? me.role === 'lecturer' : uid.startsWith('lec');

  return (
    <>
      <header className="topbar">
        <div className="brand"><span className="logo">T</span>{T.management}</div>
        <nav>
          {lecturer ? (
            <>
              <NavLink to="/lecturer/schedule">{T.schedule}</NavLink>
              <NavLink to="/lecturer/create">{T.create}</NavLink>
              <NavLink to="/lecturer/history">{T.history}</NavLink>
            </>
          ) : <NavLink to="/student">{T.myTests}</NavLink>}
        </nav>
        <label className="who" title="Demo sign-in: replace with your real authentication">
          <span className="muted small">Signed in as</span>
          <select value={uid} onChange={(e) => {
            const u = users.find((x) => x.id === e.target.value)!;
            setCurrentUserId(u.id); setUid(u.id);
            nav(u.role === 'lecturer' ? '/lecturer/schedule' : '/student');
          }}>
            <optgroup label="Lecturers">{users.filter((u) => u.role === 'lecturer').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</optgroup>
            <optgroup label="Students">{users.filter((u) => u.role === 'student').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</optgroup>
          </select>
        </label>
      </header>
      <main key={uid}>
        <Routes>
          <Route path="/" element={<Navigate to={lecturer ? '/lecturer/schedule' : '/student'} replace />} />
          <Route path="/lecturer/schedule" element={<ScheduleDashboard />} />
          <Route path="/lecturer/create" element={<CreateTest />} />
          <Route path="/lecturer/tests/:id/schedule" element={<ScheduleEditor />} />
          <Route path="/lecturer/history" element={<History />} />
          <Route path="/student" element={<StudentTests />} />
          <Route path="/student/tests/:id" element={<TakeTest />} />
          <Route path="*" element={<p className="page">Page not found.</p>} />
        </Routes>
      </main>
    </>
  );
}

export default function App() {
  return <BrowserRouter><Shell /></BrowserRouter>;
}
