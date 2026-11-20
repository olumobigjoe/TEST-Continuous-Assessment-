const el = (id) => document.getElementById(id);
async function api(path, options={}) {
  const res = await fetch(path, {credentials:'same-origin', ...options});
  const data = await res.json().catch(()=>({detail:'Unexpected server response'}));
  if (!res.ok) throw new Error(data.detail || 'Request failed');
  return data;
}
function showError(target, error) { target.textContent = error.message; target.className = 'message error'; }
async function loadInstitution() {
  try {
    const [i, departments, subscription] = await Promise.all([
      api('/api/v2/institution'), api('/api/v2/departments'), api('/api/v2/subscription')
    ]);
    el('instName').textContent = i.name;
    el('studentCount').textContent = i.counts.students;
    el('lecturerCount').textContent = i.counts.lecturers;
    el('deptTestCount').textContent = `${i.counts.departments} / ${i.counts.tests}`;
    el('departmentList').replaceChildren();
    departments.forEach(d => { const p=document.createElement('p'); p.textContent=`${d.name}${d.code ? ` (${d.code})` : ''}`; el('departmentList').append(p); });
    el('subscriptionInfo').textContent = `${subscription.plan.toUpperCase()} · ${subscription.status} · ${subscription.seat_limit} student seats`;
  } catch (e) { showError(el('subscriptionInfo'), e); }
}
el('departmentForm').addEventListener('submit', async e => {
  e.preventDefault(); const f=new FormData(e.currentTarget);
  try { await api('/api/v2/departments',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:f.get('name'),code:f.get('code')||null})}); e.currentTarget.reset(); await loadInstitution(); }
  catch(err) { showError(el('departmentList'),err); }
});
el('importForm').addEventListener('submit', async e => {
  e.preventDefault(); const file=e.currentTarget.elements.file.files[0]; if(!file)return;
  const body=new FormData(); body.append('file',file);
  try {
    const result=await api('/api/v2/students/import',{method:'POST',body});
    el('importMessage').textContent=`Created ${result.created_count}; skipped ${result.skipped_count}; errors ${result.error_count}.`;
    el('invitationOutput').replaceChildren();
    if(result.invitations.length){ const heading=document.createElement('h3'); heading.textContent='One-time student setup tokens — share securely'; el('invitationOutput').append(heading);
      result.invitations.forEach(item=>{const p=document.createElement('p');p.textContent=`${item.email}: ${item.setup_token} (expires ${new Date(item.expires_at).toLocaleString()})`;el('invitationOutput').append(p);}); }
    await loadInstitution();
  } catch(err) { showError(el('importMessage'),err); }
});
loadInstitution();
