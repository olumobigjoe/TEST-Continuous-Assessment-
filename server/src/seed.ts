import { DB } from './db.js';
import { MINUTE } from './time.js';

const QUESTIONS = [
  { id: 'q1', type: 'mcq', text: 'Which data structure uses FIFO ordering?', options: ['Stack', 'Queue', 'Tree', 'Graph'], answer: 1 },
  { id: 'q2', type: 'mcq', text: 'What is the time complexity of binary search?', options: ['O(n)', 'O(log n)', 'O(n log n)', 'O(1)'], answer: 1 },
  { id: 'q3', type: 'mcq', text: 'Which of these is not a primitive type in JavaScript?', options: ['string', 'boolean', 'array', 'number'], answer: 2 },
  { id: 'q4', type: 'text', text: 'Briefly explain what a hash collision is.' },
];

/** Demo data relative to "now" so there is always an active, upcoming, draft and completed TEST. */
export function seed(db: DB, now: number) {
  if ((db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n > 0) return;
  const tz = 'Africa/Lagos';
  const users: [string, string, string, string][] = [
    ['lec_ada', 'Dr. Ada Okafor', 'ada.okafor@example.edu', 'lecturer'],
    ['lec_tunde', 'Prof. Tunde Bello', 'tunde.bello@example.edu', 'lecturer'],
  ];
  const studentNames = ['Amaka Eze', 'Bola Adeyemi', 'Chidi Nwosu', 'Damilola Ojo', 'Efe Okoro', 'Funmi Lawal', 'Gbenga Ade', 'Halima Musa'];
  studentNames.forEach((n, i) => users.push([`stu_${i + 1}`, n, `${n.split(' ')[0].toLowerCase()}@students.example.edu`, 'student']));
  for (const u of users) db.prepare('INSERT INTO users (id, name, email, role) VALUES (?,?,?,?)').run(...u);

  const m = (x: number) => now + x * MINUTE;
  const round = (t: number) => Math.floor(t / (5 * MINUTE)) * 5 * MINUTE;
  const base = round(now);
  const r = (x: number) => base + x * MINUTE;
  const q = JSON.stringify(QUESTIONS);
  const test = (id: string, title: string, status: string, ws: number, we: number, dur: number, mode = 'manual') =>
    db.prepare(`INSERT INTO tests (id, title, lecturer_id, generation_mode, status, timezone, window_start, window_end, duration_minutes, questions_json, created_at, updated_at)
                VALUES (?, ?, 'lec_ada', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, title, mode, status, tz, ws, we, dur, q, now, now);
  const batch = (id: string, tid: string, name: string, pos: number, s: number, e: number, dur: number, students: number[]) => {
    db.prepare('INSERT INTO batches (id, test_id, name, position, start_at, end_at, duration_minutes) VALUES (?,?,?,?,?,?,?)').run(id, tid, name, pos, s, e, dur);
    for (const n of students) db.prepare('INSERT INTO batch_students (test_id, batch_id, student_id) VALUES (?,?,?)').run(tid, id, `stu_${n}`);
  };
  const audit = (tid: string, action: string, summary: string) =>
    db.prepare("INSERT INTO schedule_audit (test_id, actor_id, actor_name, action, summary, changes_json, created_at) VALUES (?, 'lec_ada', 'Dr. Ada Okafor', ?, ?, '[]', ?)").run(tid, action, summary, m(-60 * 24));

  // 1. Active: batch A open with sessions in progress, batch B later today (still editable)
  test('tst_ds', 'CSC 201 Data Structures – Continuous Assessment TEST', 'published', r(-20), r(160), 40);
  batch('bat_ds_a', 'tst_ds', 'Batch A', 0, r(-20), r(60), 40, [1, 2, 3, 4]);
  batch('bat_ds_b', 'tst_ds', 'Batch B', 1, r(90), r(160), 40, [5, 6, 7, 8]);
  db.prepare("INSERT INTO attempts (id, test_id, batch_id, student_id, started_at, deadline_at, allocated_minutes) VALUES ('att_seed1','tst_ds','bat_ds_a','stu_2',?,?,40)").run(m(-12), m(28));
  db.prepare("INSERT INTO attempts (id, test_id, batch_id, student_id, started_at, deadline_at, allocated_minutes) VALUES ('att_seed2','tst_ds','bat_ds_a','stu_3',?,?,40)").run(m(-5), m(35));
  audit('tst_ds', 'created', 'Created draft TEST with 2 batch(es)');
  audit('tst_ds', 'published', 'Published TEST');

  // 2. Upcoming tomorrow, fully editable
  test('tst_os', 'CSC 305 Operating Systems – Mid-Semester TEST', 'published', r(24 * 60), r(24 * 60 + 180), 60, 'ai');
  batch('bat_os_a', 'tst_os', 'Batch A', 0, r(24 * 60), r(24 * 60 + 75), 60, [1, 3, 5, 7]);
  batch('bat_os_b', 'tst_os', 'Batch B', 1, r(24 * 60 + 90), r(24 * 60 + 180), 60, [2, 4, 6, 8]);
  audit('tst_os', 'created', 'Created draft TEST with 2 batch(es)');
  audit('tst_os', 'published', 'Published TEST');

  // 3. Draft
  test('tst_db', 'CSC 310 Database Systems – Quiz TEST', 'draft', r(3 * 24 * 60), r(3 * 24 * 60 + 60), 30, 'ai');
  batch('bat_db_a', 'tst_db', 'Batch A', 0, r(3 * 24 * 60), r(3 * 24 * 60 + 60), 30, [1, 2, 3, 4, 5, 6, 7, 8]);
  audit('tst_db', 'created', 'Created draft TEST with 1 batch(es)');

  // 4. Completed yesterday
  test('tst_prog', 'CSC 101 Introduction to Programming – TEST 1', 'published', r(-24 * 60), r(-24 * 60 + 60), 45);
  batch('bat_prog_a', 'tst_prog', 'Batch A', 0, r(-24 * 60), r(-24 * 60 + 60), 45, [1, 2, 3, 4, 5, 6, 7, 8]);
  db.prepare("INSERT INTO attempts (id, test_id, batch_id, student_id, started_at, deadline_at, allocated_minutes, submitted_at, submit_reason) VALUES ('att_seed3','tst_prog','bat_prog_a','stu_1',?,?,45,?, 'student')").run(r(-24 * 60 + 2), r(-24 * 60 + 47), r(-24 * 60 + 40));
  audit('tst_prog', 'created', 'Created draft TEST with 1 batch(es)');
}
