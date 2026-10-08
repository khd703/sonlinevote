// =====================================================================
// 관리자(교사) 화면 스크립트 (admin.html)
// ---------------------------------------------------------------------
// - 이메일+비밀번호로 로그인하고, DB 의 is_admin() 이 true 인 계정만 들어올 수 있음
// - 실제 권한 검사는 DB(RLS)가 하므로, 화면을 억지로 열어도 데이터는 바뀌지 않음
// - 관리자 계정 만들기: signUp → register_admin_with_code(가입 코드 검사) 순서
// =====================================================================
(function () {
  'use strict';

  const CFG = window.APP_CONFIG;
  // 관리자용 클라이언트 (학생 화면과 로그인 정보가 섞이지 않도록 storageKey 분리)
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY, {
    auth: { storageKey: 'sb-admin-auth', persistSession: true, autoRefreshToken: true },
  });

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let me = null;           // 로그인한 교사 정보
  let settings = null;
  let toastTimer;
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('is-show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('is-show'), 2600);
  }
  const fmt = (d) => d ? new Date(d).toLocaleString('ko-KR', { hour12: false }) : '';
  const pub = (path) => sb.storage.from(CFG.BUCKET).getPublicUrl(path).data.publicUrl;

  // DB 오류 → 한국어
  function errText(e) {
    const m = (e && e.message) || '';
    if (m.includes('INVALID_CODE')) return '가입 코드가 맞지 않아요.';
    if (m.includes('USER_NOT_FOUND')) return '계정을 찾을 수 없어요.';
    if (m.includes('CANNOT_REMOVE_SELF')) return '본인 권한은 해제할 수 없어요.';
    if (m.includes('NOT_ADMIN')) return '관리자 권한이 없어요.';
    if (/Invalid login credentials/i.test(m)) return '이메일 또는 비밀번호가 맞지 않아요.';
    if (/at least 6/i.test(m) || /weak/i.test(m)) return '비밀번호는 6자 이상이어야 해요.';
    if (/rate limit/i.test(m)) return '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.';
    return m || '문제가 생겼어요.';
  }

  // 1000행이 넘는 표도 끝까지 읽기 (Supabase 기본 한도가 1000행)
  async function fetchAll(build) {
    const out = []; const size = 1000;
    for (let from = 0; ; from += size) {
      const { data, error } = await build().range(from, from + size - 1);
      if (error) throw error;
      out.push(...data);
      if (data.length < size) return out;
    }
  }

  // CSV 내려받기: 맨 앞 BOM(﻿)이 있어야 엑셀에서 한글이 안 깨짐
  function downloadCsv(name, rows) {
    const cell = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const text = '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    a.download = name; a.click(); URL.revokeObjectURL(a.href);
  }

  // 간단한 CSV 읽기 (따옴표·쉼표·줄바꿈 처리)
  function parseCsv(text) {
    text = text.replace(/^﻿/, '');
    const rows = []; let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cur); cur = ''; rows.push(row); row = [];
      } else cur += c;
    }
    if (cur || row.length) { row.push(cur); rows.push(row); }
    return rows.filter((r) => r.some((x) => x.trim() !== ''));
  }

  // =================== 로그인 / 가입 ===================
  let signupMode = false;
  function setMode(signup) {
    signupMode = signup;
    $('authTitle').textContent = signup ? '관리자 계정 만들기' : '교사 로그인';
    $('codeField').hidden = !signup;
    $('authSubmit').textContent = signup ? '계정 만들고 시작하기' : '로그인';
    $('authToggle').textContent = signup ? '← 로그인으로 돌아가기' : '관리자 계정 만들기';
    $('authError').textContent = '';
  }
  $('authToggle').onclick = () => setMode(!signupMode);

  // 계정 생성 + 가입 코드 검증 + 관리자 등록 (client 를 바꿔 "교사 추가"에서도 재사용)
  async function createAdminAccount(client, email, pw, code) {
    let { data, error } = await client.auth.signUp({ email, password: pw });
    if (error && /already/i.test(error.message)) {
      // 이미 만든 계정이면 로그인해서 관리자 등록만 진행
      ({ data, error } = await client.auth.signInWithPassword({ email, password: pw }));
    }
    if (error) throw error;
    const { error: e2 } = await client.rpc('register_admin_with_code', { p_email: email, p_code: code });
    if (e2) throw e2;
    if (!data.session) {   // 이메일 인증이 켜져 있어 세션이 없다면, 활성화된 지금 다시 로그인
      const r = await client.auth.signInWithPassword({ email, password: pw });
      if (r.error) throw r.error;
    }
  }

  $('authForm').onsubmit = async (e) => {
    e.preventDefault();
    const email = $('authEmail').value.trim(), pw = $('authPw').value, code = $('authCode').value;
    const err = $('authError'); err.textContent = '';
    if (!email || !pw) { err.textContent = '이메일과 비밀번호를 입력해 주세요.'; return; }
    if (signupMode && !code) { err.textContent = '관리자 가입 코드를 입력해 주세요.'; return; }
    const btn = $('authSubmit'); btn.disabled = true;
    try {
      if (signupMode) await createAdminAccount(sb, email, pw, code);
      else {
        const { error } = await sb.auth.signInWithPassword({ email, password: pw });
        if (error) throw error;
      }
      await enter();
    } catch (ex) { err.textContent = errText(ex); }
    btn.disabled = false;
  };

  // 로그인 후 관리자인지 확인하고 대시보드 열기
  async function enter() {
    const { data: ok } = await sb.rpc('is_admin');
    const { data: { user } } = await sb.auth.getUser();
    if (!ok || !user) {
      await sb.auth.signOut();
      $('authError').textContent = '관리자 권한이 없는 계정이에요. (관리자 가입 코드로 계정을 만들어 주세요)';
      show(false); return;
    }
    me = user;
    $('adminEmail').textContent = user.email;
    show(true);
    await loadDash();
  }
  function show(app) { $('authView').hidden = app; $('appView').hidden = !app; }
  $('logoutBtn').onclick = async () => { await sb.auth.signOut(); me = null; show(false); };

  // =================== 탭 ===================
  const loaders = { dash: loadDash, art: loadArtworks, stu: loadStudents, cmt: loadComments, res: loadResults, adm: loadAdmins };
  $('tabs').onclick = (e) => {
    const b = e.target.closest('[data-tab]'); if (!b) return;
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('is-active', x === b));
    document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.id !== 'tab-' + b.dataset.tab; });
    loaders[b.dataset.tab]().catch((ex) => toast(errText(ex)));
  };

  // =================== 대시보드 ===================
  async function count(table, filter) {
    let q = sb.from(table).select('*', { count: 'exact', head: true });
    if (filter) q = filter(q);
    const { count: n, error } = await q; if (error) throw error; return n;
  }
  async function loadDash() {
    const { data, error } = await sb.from('settings').select('*').eq('id', 1).single();
    if (error) throw error;
    settings = data;
    paintVote();
    $('setTitle').value = settings.site_title; $('setNotice').value = settings.notice;
    const [a, s, l, c] = await Promise.all([count('artworks'), count('students'), count('likes'), count('comments')]);
    $('statsBox').innerHTML = [['작품', a], ['로그인 학생', s], ['하트', l], ['댓글', c]]
      .map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join('');
  }
  function paintVote() {
    $('voteSwitch').setAttribute('aria-checked', settings.voting_open);
    $('voteLabel').textContent = settings.voting_open ? '투표 진행 중 (학생이 하트·댓글을 남길 수 있어요)' : '투표 마감 (보기만 가능)';
  }
  $('voteSwitch').onclick = async () => {
    const next = !settings.voting_open;
    if (!next && !confirm('투표를 마감할까요? 학생은 하트와 댓글을 더 이상 남길 수 없어요.')) return;
    const { error } = await sb.from('settings').update({ voting_open: next, updated_at: new Date().toISOString() }).eq('id', 1);
    if (error) return toast(errText(error));
    settings.voting_open = next; paintVote(); toast(next ? '투표를 시작했어요.' : '투표를 마감했어요.');
  };
  $('settingsForm').onsubmit = async (e) => {
    e.preventDefault();
    const { error } = await sb.from('settings').update({
      site_title: $('setTitle').value.trim(), notice: $('setNotice').value.trim(), updated_at: new Date().toISOString(),
    }).eq('id', 1);
    toast(error ? errText(error) : '저장했어요.');
  };

  // =================== 작품 ===================
  let drafts = [];       // 아직 올리지 않은 파일들 {file, title, author, description}
  let csvRows = [];      // CSV 에서 읽은 작품 정보 [{제목, 출품자, 설명, 키워드}]

  $('drop').onclick = () => $('fileInput').click();
  $('drop').onkeydown = (e) => { if (e.key === 'Enter') $('fileInput').click(); };
  $('fileInput').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
  ['dragenter', 'dragover'].forEach((t) => $('drop').addEventListener(t, (e) => { e.preventDefault(); $('drop').classList.add('is-over'); }));
  ['dragleave', 'drop'].forEach((t) => $('drop').addEventListener(t, (e) => { e.preventDefault(); $('drop').classList.remove('is-over'); }));
  $('drop').addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

  function addFiles(list) {
    for (const f of list) {
      if (!/^image\/(jpeg|png|webp|gif)$/.test(f.type)) { toast(`${f.name}: 지원하지 않는 형식이에요.`); continue; }
      if (f.size > 10 * 1024 * 1024) { toast(`${f.name}: 10MB 를 넘어요.`); continue; }
      drafts.push({ file: f, title: '', author: '', description: '', url: URL.createObjectURL(f) });
    }
    autoMatch(); renderDrafts();
  }

  $('csvBtn').onclick = () => $('csvInput').click();
  $('csvInput').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    const rows = parseCsv(await f.text());
    const head = rows.shift() || [];
    const col = (n) => head.findIndex((h) => h.trim().replace(/\s/g, '') === n);
    const ix = { t: col('제목'), a: col('출품자'), d: col('설명'), k: col('파일명키워드') };
    if (ix.t < 0) return toast('CSV 첫 줄에 "제목" 열이 필요해요.');
    csvRows = rows.map((r) => ({ title: r[ix.t] || '', author: ix.a < 0 ? '' : r[ix.a] || '',
      description: ix.d < 0 ? '' : r[ix.d] || '', keyword: ix.k < 0 ? '' : (r[ix.k] || '').trim() }));
    $('csvInfo').textContent = `${csvRows.length}개 작품 정보를 불러왔어요.`;
    autoMatch(); renderDrafts();
  };

  // 파일 이름에 CSV 의 "파일명키워드"가 들어 있으면 자동으로 채움
  function autoMatch() {
    drafts.forEach((d) => {
      if (d.title || d.author || d.description || d.matched === false) return;
      const m = csvRows.find((r) => r.keyword && d.file.name.toLowerCase().includes(r.keyword.toLowerCase()));
      if (m) { d.title = m.title; d.author = m.author; d.description = m.description; }
    });
  }

  function renderDrafts() {
    $('uploadAll').hidden = !drafts.length;
    $('drafts').innerHTML = drafts.map((d, i) => `<div class="draft" data-i="${i}">
      <img src="${d.url}" alt="" />
      <div class="draft__fields">
        <span class="draft__file">${esc(d.file.name)}</span>
        ${csvRows.length ? `<select data-pick><option value="">CSV 에서 작품 정보 고르기…</option>${
          csvRows.map((r, j) => `<option value="${j}">${esc(r.title)} (${esc(r.author)})</option>`).join('')}</select>` : ''}
        <input data-f="title" placeholder="제목" value="${esc(d.title)}" />
        <input data-f="author" placeholder="출품자" value="${esc(d.author)}" />
        <textarea data-f="description" rows="2" placeholder="설명">${esc(d.description)}</textarea>
        <button class="btn btn--danger" data-rm type="button">목록에서 빼기</button>
      </div></div>`).join('');
  }
  $('drafts').addEventListener('input', (e) => {
    const f = e.target.dataset.f; if (!f) return;
    drafts[Number(e.target.closest('.draft').dataset.i)][f] = e.target.value;
  });
  $('drafts').addEventListener('change', (e) => {
    if (!('pick' in e.target.dataset)) return;
    const d = drafts[Number(e.target.closest('.draft').dataset.i)], r = csvRows[Number(e.target.value)];
    if (r) { d.title = r.title; d.author = r.author; d.description = r.description; renderDrafts(); }
  });
  $('drafts').addEventListener('click', (e) => {
    if (!('rm' in e.target.dataset)) return;
    drafts.splice(Number(e.target.closest('.draft').dataset.i), 1); renderDrafts();
  });

  $('uploadAll').onclick = async () => {
    if (drafts.some((d) => !d.title.trim())) return toast('제목이 비어 있는 작품이 있어요.');
    const btn = $('uploadAll'); btn.disabled = true;
    let ok = 0;
    for (const d of [...drafts]) {
      btn.textContent = `올리는 중… (${ok + 1}/${drafts.length + ok})`;
      // 저장 경로는 영문·숫자만 사용 (한글 파일명은 Storage 가 거부할 수 있음)
      const ext = (d.file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
      const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const up = await sb.storage.from(CFG.BUCKET).upload(path, d.file, { contentType: d.file.type });
      if (up.error) { toast(`${d.file.name}: ${up.error.message}`); continue; }
      const ins = await sb.from('artworks').insert({
        title: d.title.trim(), author: d.author.trim(), description: d.description.trim(), image_path: path });
      if (ins.error) {
        await sb.storage.from(CFG.BUCKET).remove([path]);   // 정보 저장 실패 시 올린 파일도 정리
        toast(errText(ins.error)); continue;
      }
      drafts.splice(drafts.indexOf(d), 1); ok++;
    }
    btn.disabled = false; btn.textContent = '모두 등록';
    renderDrafts(); toast(`${ok}개 작품을 등록했어요.`); loadArtworks();
  };

  async function loadArtworks() {
    const { data, error } = await sb.from('artworks').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    $('artCount').textContent = `(${data.length})`;
    $('artList').innerHTML = data.length ? data.map((a) => `<div class="art${a.is_hidden ? ' is-hidden' : ''}" data-id="${a.id}" data-path="${esc(a.image_path)}">
      <img src="${esc(pub(a.image_path))}" alt="" loading="lazy" />
      <div class="art__fields">
        <input data-f="title" value="${esc(a.title)}" placeholder="제목" />
        <input data-f="author" value="${esc(a.author)}" placeholder="출품자" />
        <textarea data-f="description" rows="3" placeholder="설명">${esc(a.description)}</textarea>
        <div class="art__btns">
          <button class="btn btn--primary" data-act="save" type="button">저장</button>
          <button class="btn" data-act="hide" type="button">${a.is_hidden ? '보이기' : '숨기기'}</button>
          <button class="btn btn--danger" data-act="del" type="button">삭제</button>
        </div></div></div>`).join('') : '<div class="empty-box">등록된 작품이 없어요.</div>';
  }
  $('artList').addEventListener('click', async (e) => {
    const act = e.target.dataset.act; if (!act) return;
    const box = e.target.closest('.art'), id = Number(box.dataset.id);
    const val = (f) => box.querySelector(`[data-f=${f}]`).value.trim();
    let r;
    if (act === 'save') {
      if (!val('title')) return toast('제목을 입력해 주세요.');
      r = await sb.from('artworks').update({ title: val('title'), author: val('author'), description: val('description') }).eq('id', id);
      if (!r.error) toast('저장했어요.');
    } else if (act === 'hide') {
      r = await sb.from('artworks').update({ is_hidden: !box.classList.contains('is-hidden') }).eq('id', id);
      if (!r.error) loadArtworks();
    } else if (act === 'del') {
      if (!confirm('이 작품을 삭제할까요? 하트·댓글과 이미지 파일도 함께 삭제되며 되돌릴 수 없어요.')) return;
      r = await sb.from('artworks').delete().eq('id', id);
      if (!r.error) { await sb.storage.from(CFG.BUCKET).remove([box.dataset.path]); loadArtworks(); toast('삭제했어요.'); }
    }
    if (r && r.error) toast(errText(r.error));
  });

  // =================== 학생 ===================
  let students = [];
  async function loadStudents() {
    students = await fetchAll(() => sb.from('students').select('*').order('last_login_at', { ascending: false }));
    renderStudents();
  }
  function renderStudents() {
    const k = $('stuSearch').value.trim().toLowerCase();
    const list = students.filter((s) => !k || `${s.school} ${s.student_no} ${s.name}`.toLowerCase().includes(k));
    $('stuTable').innerHTML = '<tr><th>학교</th><th>학번</th><th>이름</th><th>마지막 로그인</th><th>기기</th><th></th></tr>' +
      (list.length ? list.map((s) => `<tr data-id="${s.id}"><td>${esc(s.school)}</td><td>${esc(s.student_no)}</td><td>${esc(s.name)}</td>
        <td>${fmt(s.last_login_at)}</td><td>${s.user_id ? '<span class="tag">연결됨</span>' : '-'}</td>
        <td><button class="btn" data-act="unlink" type="button"${s.user_id ? '' : ' disabled'}>기기 연결 해제</button>
        <button class="btn btn--danger" data-act="del" type="button">삭제</button></td></tr>`).join('')
        : '<tr><td colspan="6" class="empty-box">학생이 없어요.</td></tr>');
  }
  $('stuSearch').oninput = renderStudents;
  $('stuTable').addEventListener('click', async (e) => {
    const act = e.target.dataset.act; if (!act) return;
    const id = e.target.closest('tr').dataset.id, s = students.find((x) => x.id === id);
    let r;
    if (act === 'unlink') {
      if (!confirm(`${s.name} 학생의 기기 연결을 해제할까요? 해당 기기는 다시 로그인해야 투표할 수 있어요.`)) return;
      r = await sb.from('students').update({ user_id: null }).eq('id', id);
    } else {
      if (!confirm(`${s.name} 학생 프로필을 삭제할까요? 이 학생의 하트와 댓글도 모두 삭제돼요.`)) return;
      r = await sb.from('students').delete().eq('id', id);
    }
    if (r.error) return toast(errText(r.error));
    loadStudents();
  });
  $('stuCsv').onclick = () => downloadCsv('학생목록.csv', [['학교', '학번', '이름', '최초 로그인', '마지막 로그인']]
    .concat(students.map((s) => [s.school, s.student_no, s.name, fmt(s.created_at), fmt(s.last_login_at)])));

  // =================== 댓글 ===================
  async function loadComments() {
    const only = $('cmtHiddenOnly').checked;
    const list = await fetchAll(() => {
      let q = sb.from('comments').select('*, students(school,student_no,name), artworks(title)').order('created_at', { ascending: false });
      return only ? q.eq('is_hidden', true) : q;
    });
    $('cmtTable').innerHTML = '<tr><th>작성자(실명)</th><th>작품</th><th>내용</th><th>시간</th><th></th></tr>' +
      (list.length ? list.map((c) => `<tr data-id="${c.id}"><td>${esc(c.students?.name)}<br /><small class="muted">${esc(c.students?.school)} ${esc(c.students?.student_no)}</small></td>
        <td>${esc(c.artworks?.title)}</td><td>${c.is_hidden ? '<span class="tag">숨김</span> ' : ''}${esc(c.body)}</td><td>${fmt(c.created_at)}</td>
        <td><button class="btn" data-act="hide" data-h="${c.is_hidden}" type="button">${c.is_hidden ? '보이기' : '숨기기'}</button>
        <button class="btn btn--danger" data-act="del" type="button">삭제</button></td></tr>`).join('')
        : '<tr><td colspan="5" class="empty-box">댓글이 없어요.</td></tr>');
  }
  $('cmtHiddenOnly').onchange = () => loadComments().catch((x) => toast(errText(x)));
  $('cmtTable').addEventListener('click', async (e) => {
    const act = e.target.dataset.act; if (!act) return;
    const id = Number(e.target.closest('tr').dataset.id);
    let r;
    if (act === 'hide') r = await sb.from('comments').update({ is_hidden: e.target.dataset.h !== 'true' }).eq('id', id);
    else { if (!confirm('이 댓글을 삭제할까요?')) return; r = await sb.from('comments').delete().eq('id', id); }
    if (r.error) return toast(errText(r.error));
    loadComments();
  });

  // =================== 결과 ===================
  async function loadResults() {
    const [arts, likes, cmts] = await Promise.all([
      fetchAll(() => sb.from('artworks').select('id,title,author').order('id')),
      fetchAll(() => sb.from('likes').select('artwork_id,created_at,students(school,student_no,name)').order('created_at')),
      fetchAll(() => sb.from('comments').select('artwork_id,body,is_hidden,created_at,students(school,student_no,name)').order('created_at')),
    ]);
    const lk = {}, cm = {};
    likes.forEach((l) => { lk[l.artwork_id] = (lk[l.artwork_id] || 0) + 1; });
    cmts.forEach((c) => { cm[c.artwork_id] = (cm[c.artwork_id] || 0) + 1; });
    const rank = arts.map((a) => ({ ...a, likes: lk[a.id] || 0, comments: cm[a.id] || 0 }))
      .sort((x, y) => y.likes - x.likes || y.comments - x.comments);
    // 동점은 같은 순위로 표시
    rank.forEach((r, i) => { r.rank = i && r.likes === rank[i - 1].likes ? rank[i - 1].rank : i + 1; });
    window._res = { rank, likes, cmts, arts };
    $('rankTable').innerHTML = '<tr><th>순위</th><th>작품</th><th>출품자</th><th class="num">하트</th><th class="num">댓글</th></tr>' +
      (rank.length ? rank.map((r) => `<tr><td>${r.rank}</td><td>${esc(r.title)}</td><td>${esc(r.author)}</td><td class="num">${r.likes}</td><td class="num">${r.comments}</td></tr>`).join('')
        : '<tr><td colspan="5" class="empty-box">작품이 없어요.</td></tr>');
  }
  document.querySelector('#tab-res .row').addEventListener('click', (e) => {
    const k = e.target.dataset.csv; const R = window._res; if (!k || !R) return toast('결과를 먼저 불러와 주세요.');
    const title = (id) => (R.arts.find((a) => a.id === id) || {}).title || '';
    if (k === 'art') downloadCsv('작품별집계.csv', [['순위', '제목', '출품자', '하트', '댓글']].concat(R.rank.map((r) => [r.rank, r.title, r.author, r.likes, r.comments])));
    if (k === 'likes') downloadCsv('하트상세.csv', [['작품', '학교', '학번', '이름', '시간']].concat(R.likes.map((l) => [title(l.artwork_id), l.students?.school, l.students?.student_no, l.students?.name, fmt(l.created_at)])));
    if (k === 'cmts') downloadCsv('댓글상세.csv', [['작품', '학교', '학번', '이름', '내용', '숨김', '시간']].concat(R.cmts.map((c) => [title(c.artwork_id), c.students?.school, c.students?.student_no, c.students?.name, c.body, c.is_hidden ? '예' : '', fmt(c.created_at)])));
  });

  // =================== 교사 계정 ===================
  async function loadAdmins() {
    const { data, error } = await sb.from('admins').select('*').order('created_at');
    if (error) throw error;
    $('adminList').innerHTML = data.map((a) => `<div class="admin-item"><span>${esc(a.email)}${a.email.toLowerCase() === (me.email || '').toLowerCase() ? ' <span class="tag">나</span>' : ''}</span>
      ${a.email.toLowerCase() === (me.email || '').toLowerCase() ? '' : `<button class="btn btn--danger" data-email="${esc(a.email)}" type="button">권한 해제</button>`}</div>`).join('');
  }
  $('adminList').addEventListener('click', async (e) => {
    const em = e.target.dataset.email; if (!em) return;
    if (!confirm(`${em} 의 관리자 권한을 해제할까요?`)) return;
    const { error } = await sb.rpc('admin_remove', { p_email: em });
    if (error) return toast(errText(error));
    loadAdmins();
  });
  $('addAdminForm').onsubmit = async (e) => {
    e.preventDefault();
    const err = $('addAdminErr'); err.textContent = '';
    const email = $('newEmail').value.trim(), pw = $('newPw').value, code = $('newCode').value;
    if (!email || !pw || !code) { err.textContent = '모두 입력해 주세요.'; return; }
    // 내 로그인이 새 계정으로 바뀌지 않도록, 저장하지 않는 임시 클라이언트를 사용
    const tmp = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false, storageKey: 'sb-tmp' } });
    try {
      await createAdminAccount(tmp, email, pw, code);
      $('addAdminForm').reset(); toast('교사를 추가했어요.'); loadAdmins();
    } catch (ex) { err.textContent = errText(ex); }
  };

  // =================== 시작 ===================
  (async function init() {
    const { data: { session } } = await sb.auth.getSession();
    if (session && !session.user.is_anonymous) await enter(); else show(false);
  })();
  document.getElementById('authView').hidden = false;   // 확인 전에도 로그인 화면이 비어 보이지 않게
})();
