// =====================================================================
// 학생 화면 스크립트 (index.html)
// ---------------------------------------------------------------------
// 전체 흐름
//   1) 페이지가 열리면 설정·작품·하트/댓글 숫자를 불러와 카드로 보여줌 (로그인 불필요)
//   2) 하트·댓글을 누르려면 로그인 필요 → 학교·학번·이름 입력
//        - 내부적으로 Supabase "익명 로그인"을 한 뒤 claim_student 함수로
//          이 기기를 학생 프로필에 연결함
//   3) 하트·댓글 쓰기는 전부 DB 함수(toggle_like 등)로만 이루어지며,
//      투표 기간·본인 여부는 서버(DB)에서 다시 검사함
// =====================================================================
(function () {
  'use strict';

  const CFG = window.APP_CONFIG;

  // 학생용 Supabase 클라이언트.
  // storageKey 를 따로 지정한 이유: 같은 브라우저에서 교사가 admin.html 에
  // 로그인해 둔 상태와 학생 로그인이 서로 섞이지 않게 하기 위함입니다.
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY, {
    auth: { storageKey: 'sb-student-auth', persistSession: true, autoRefreshToken: true },
  });

  // ---------- 화면 상태 ----------
  const state = {
    settings: { site_title: '', notice: '', voting_open: true },
    student: null,        // 로그인한 학생 {id, school, student_no, name} 또는 null
    artworks: [],         // 작품 목록
    stats: {},            // { 작품id: {like_count, comment_count, liked_by_me} }
    sort: 'random',       // 'random' | 'popular' | 'latest'
    randomRank: {},       // 랜덤 순서 (세션 동안 고정): { 작품id: 난수 }
    openId: null,         // 지금 상세 모달에 열려 있는 작품 id
    busy: new Set(),      // 하트 요청 중인 작품 id (연타 방지)
  };

  // ---------- 작은 도우미 ----------
  const $ = (id) => document.getElementById(id);
  const gallery = $('gallery');

  // 사용자 입력을 화면에 넣을 때는 반드시 이스케이프 (악성 HTML 삽입 방지)
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // 하트 모양 SVG
  const HEART_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7.5-4.6-10-9.3C.4 8.5 2.3 4 6.4 4c2.3 0 3.9 1.3 5.6 3.3C13.7 5.3 15.3 4 17.6 4 21.7 4 23.6 8.5 22 11.7 19.5 16.4 12 21 12 21z"/></svg>';

  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('is-show'), 2600);
  }

  // DB 함수가 던지는 영어 오류 코드를 학생이 읽을 한국어로 바꿈
  const ERRORS = {
    NOT_SIGNED_IN: '로그인 정보가 없어요. 다시 시도해 주세요.',
    NOT_LOGGED_IN: '먼저 로그인해 주세요.',
    VOTING_CLOSED: '투표가 마감되었어요.',
    INVALID_SCHOOL: '학교명을 확인해 주세요.',
    INVALID_STUDENT_NO: '학번을 확인해 주세요.',
    INVALID_NAME: '이름을 확인해 주세요.',
    NAME_MISMATCH: '이 학교·학번은 다른 이름으로 이미 등록되어 있어요. 이름을 다시 확인해 주세요.',
    ARTWORK_NOT_FOUND: '작품을 찾을 수 없어요.',
    EMPTY_COMMENT: '댓글 내용을 입력해 주세요.',
    COMMENT_TOO_LONG: '댓글은 200자까지 쓸 수 있어요.',
    NOT_YOUR_COMMENT: '내가 쓴 댓글만 지울 수 있어요.',
  };
  function errText(err) {
    const msg = (err && err.message) || '';
    for (const code in ERRORS) if (msg.includes(code)) return ERRORS[code];
    return '문제가 생겼어요. 잠시 후 다시 시도해 주세요.';
  }

  // ---------- 데이터 불러오기 ----------
  async function loadSettings() {
    const { data, error } = await sb.from('settings').select('*').eq('id', 1).maybeSingle();
    if (error) throw error;
    if (data) state.settings = data;
    $('siteTitle').textContent = state.settings.site_title;
    document.title = state.settings.site_title;
    $('notice').textContent = state.settings.notice;
    $('closedBanner').hidden = state.settings.voting_open;
  }

  async function loadArtworks() {
    const { data, error } = await sb
      .from('artworks')
      .select('id,title,author,description,image_path,created_at,sort_order')
      .eq('is_hidden', false)
      .order('created_at', { ascending: false });
    if (error) throw error;
    state.artworks = data || [];
    // 랜덤 순서는 처음 한 번만 정해서 세션 동안 유지
    state.artworks.forEach((a) => {
      if (!(a.id in state.randomRank)) state.randomRank[a.id] = Math.random();
    });
  }

  async function loadStats() {
    const { data, error } = await sb.rpc('get_artwork_stats');
    if (error) throw error;
    state.stats = {};
    (data || []).forEach((r) => {
      state.stats[r.artwork_id] = {
        like_count: r.like_count, comment_count: r.comment_count, liked_by_me: r.liked_by_me,
      };
    });
  }

  function imageUrl(path) {
    return sb.storage.from(CFG.BUCKET).getPublicUrl(path).data.publicUrl;
  }
  const stat = (id) => state.stats[id] || { like_count: 0, comment_count: 0, liked_by_me: false };

  // ---------- 갤러리 그리기 ----------
  function sortedArtworks() {
    const list = [...state.artworks];
    if (state.sort === 'popular') {
      // 하트 많은 순, 같으면 최신순
      list.sort((a, b) => stat(b.id).like_count - stat(a.id).like_count ||
        new Date(b.created_at) - new Date(a.created_at));
    } else if (state.sort === 'latest') {
      list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    } else {
      list.sort((a, b) => state.randomRank[a.id] - state.randomRank[b.id]);
    }
    return list;
  }

  function showSkeleton() {
    gallery.innerHTML = Array.from({ length: 6 }, () =>
      '<div class="skeleton"><div class="skeleton__img"></div>' +
      '<div class="skeleton__line"></div><div class="skeleton__line skeleton__line--short"></div></div>').join('');
  }

  function showState(icon, text, retry) {
    gallery.innerHTML = `<div class="state"><div class="state__icon">${icon}</div><p>${esc(text)}</p>` +
      (retry ? '<button class="btn" id="retryBtn" type="button">다시 불러오기</button>' : '') + '</div>';
    if (retry) $('retryBtn').onclick = init;
  }

  // 하트 버튼 HTML (카드·상세 공통). 투표 마감이면 버튼 대신 안내 문구
  function heartHtml(id, big) {
    const s = stat(id);
    if (!state.settings.voting_open) {
      return `<span class="like-closed"><b>♥ ${s.like_count}</b> 투표가 마감되었어요</span>`;
    }
    return `<button class="heart${big ? ' heart--big' : ''}${s.liked_by_me ? ' is-on' : ''}" type="button"
      data-like="${id}" aria-pressed="${s.liked_by_me}" aria-label="하트">${HEART_SVG}<span>${s.like_count}</span></button>`;
  }

  function renderGallery() {
    const list = sortedArtworks();
    if (!list.length) return showState('🎨', '아직 등록된 작품이 없어요.');
    gallery.innerHTML = list.map((a) => `
      <article class="card" data-card="${a.id}">
        <button class="card__open" type="button" data-open="${a.id}">
          <img class="card__img" src="${esc(imageUrl(a.image_path))}" alt="${esc(a.title)}" loading="lazy" />
          <div class="card__info">
            <h2 class="card__title">${esc(a.title)}</h2>
            <p class="card__author">${esc(a.author)}</p>
          </div>
        </button>
        <div class="card__foot">
          <span class="card__comments" data-ccount="${a.id}">💬 ${stat(a.id).comment_count}</span>
          <span data-heartslot="${a.id}">${heartHtml(a.id, false)}</span>
        </div>
      </article>`).join('');
  }

  // 하트 숫자·색만 바꿔 그림 (카드 전체를 다시 그리지 않아 즉시 반응)
  function refreshHearts(id) {
    const card = document.querySelector(`[data-heartslot="${id}"]`);
    if (card) card.innerHTML = heartHtml(id, false);
    if (state.openId === id) $('detailLikeArea').innerHTML = heartHtml(id, true);
  }
  function refreshCommentCount(id) {
    const c = document.querySelector(`[data-ccount="${id}"]`);
    if (c) c.textContent = '💬 ' + stat(id).comment_count;
    if (state.openId === id) $('commentCount').textContent = stat(id).comment_count;
  }

  // ---------- 로그인 ----------
  function renderUser() {
    const area = $('userArea');
    if (state.student) {
      area.innerHTML = `<span class="topbar__name">${esc(state.student.name)}님</span>
        <button class="btn btn--text" id="logoutBtn" type="button">로그아웃</button>`;
      $('logoutBtn').onclick = logout;
    } else {
      area.innerHTML = '<button class="btn btn--primary" id="loginBtn" type="button">참여하기</button>';
      $('loginBtn').onclick = openLogin;
    }
  }

  // 새로고침 후에도 로그인 유지: 저장된 익명 세션이 있으면 내 프로필을 다시 읽어 옴
  async function restoreStudent() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return;
    const { data } = await sb.from('students').select('id,school,student_no,name').maybeSingle();
    state.student = data || null;   // 다른 기기로 연결이 넘어갔다면 null → 다시 로그인 필요
  }

  function openLogin() {
    $('loginError').textContent = '';
    $('loginModal').hidden = false;
    document.body.classList.add('no-scroll');
    $('inSchool').focus();
  }

  async function submitLogin(e) {
    e.preventDefault();
    const school = $('inSchool').value.trim();
    const no = $('inNo').value.trim();
    const name = $('inName').value.trim();
    const err = $('loginError');
    if (!school || !no || !name) { err.textContent = '학교명, 학번, 이름을 모두 입력해 주세요.'; return; }
    if (!$('inAgree').checked) { err.textContent = '개인정보 수집·이용에 동의해야 참여할 수 있어요.'; return; }

    const btn = $('loginSubmit');
    btn.disabled = true; btn.textContent = '확인 중…'; err.textContent = '';
    try {
      // 1) 익명 로그인 (이미 세션이 있으면 재사용)
      const { data: { session } } = await sb.auth.getSession();
      if (!session) {
        const { error } = await sb.auth.signInAnonymously();
        if (error) throw error;
      }
      // 2) 학생 프로필에 이 기기 연결
      const { data, error } = await sb.rpc('claim_student',
        { p_school: school, p_student_no: no, p_name: name });
      if (error) throw error;
      state.student = Array.isArray(data) ? data[0] : data;
      closeModals('loginModal');
      renderUser();
      await loadStats();                 // "내가 누른 하트" 표시를 위해 다시 불러옴
      renderGallery();
      if (state.openId) openDetail(state.openId, true);
      toast(`${state.student.name}님, 환영해요!`);
    } catch (ex) {
      err.textContent = errText(ex);
    } finally {
      btn.disabled = false; btn.textContent = '참여하기';
    }
  }

  async function logout() {
    await sb.auth.signOut();
    state.student = null;
    await loadStats();
    renderUser();
    renderGallery();
    if (state.openId) openDetail(state.openId, true);
    toast('로그아웃했어요.');
  }

  // ---------- 하트 (낙관적 업데이트: 먼저 화면을 바꾸고, 서버 결과로 확정) ----------
  async function toggleLike(id, btn) {
    if (!state.settings.voting_open) return toast('투표가 마감되었어요.');
    if (!state.student) { toast('로그인하면 하트를 누를 수 있어요.'); return openLogin(); }
    if (state.busy.has(id)) return;
    state.busy.add(id);

    const s = stat(id);
    const before = { ...s };
    // 1) 즉시 화면 반영
    state.stats[id] = { ...s, liked_by_me: !s.liked_by_me, like_count: s.like_count + (s.liked_by_me ? -1 : 1) };
    refreshHearts(id);
    popAnimation(id, state.stats[id].liked_by_me);

    // 2) 서버에 저장하고 서버가 알려 준 값으로 보정
    try {
      const { data, error } = await sb.rpc('toggle_like', { p_artwork_id: id });
      if (error) throw error;
      const r = Array.isArray(data) ? data[0] : data;
      state.stats[id] = { ...state.stats[id], liked_by_me: r.liked, like_count: r.like_count };
    } catch (ex) {
      state.stats[id] = before;          // 실패하면 원래대로 되돌림
      toast(errText(ex));
      if (/VOTING_CLOSED/.test(ex.message || '')) { await loadSettings(); renderGallery(); }
    } finally {
      state.busy.delete(id);
      refreshHearts(id);
    }
  }

  // 누를 때 "톡" 튀는 애니메이션 + 떠오르는 하트
  function popAnimation(id, on) {
    document.querySelectorAll(`[data-like="${id}"]`).forEach((b) => {
      b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop');
      if (on) {
        b.insertAdjacentHTML('beforeend', HEART_SVG.replace('<svg', '<svg class="heart__float"'));
        setTimeout(() => b.querySelector('.heart__float')?.remove(), 700);
      }
    });
  }

  // ---------- 상세 모달 ----------
  async function openDetail(id, keepScroll) {
    const a = state.artworks.find((x) => x.id === id);
    if (!a) return;
    state.openId = id;
    $('detailImg').src = imageUrl(a.image_path);
    $('detailImg').alt = a.title;
    $('detailTitle').textContent = a.title;
    $('detailAuthor').textContent = a.author;
    $('detailDesc').textContent = a.description;
    $('detailLikeArea').innerHTML = heartHtml(id, true);
    $('commentCount').textContent = stat(id).comment_count;
    renderCommentForm();
    $('commentList').innerHTML = '<li class="comments__empty">불러오는 중…</li>';
    $('detailModal').hidden = false;
    document.body.classList.add('no-scroll');
    if (!keepScroll) $('detailModal').querySelector('.detail__body').scrollTop = 0;
    await loadComments(id);
  }

  function renderCommentForm() {
    const area = $('commentFormArea');
    if (!state.settings.voting_open) {
      area.innerHTML = '<p class="comments__notice">투표가 마감되어 댓글을 쓸 수 없어요.</p>';
    } else if (!state.student) {
      area.innerHTML = '<p class="comments__notice">댓글과 하트는 <button type="button" id="loginInline">참여하기</button> 후에 남길 수 있어요.</p>';
      $('loginInline').onclick = openLogin;
    } else {
      area.innerHTML = `<form class="comment-form" id="commentForm">
        <textarea id="commentText" maxlength="200" placeholder="응원의 한마디를 남겨 보세요 (200자까지)"></textarea>
        <div class="comment-form__row"><span id="commentLen">0 / 200</span>
        <button class="btn btn--primary" type="submit">등록</button></div></form>`;
      const ta = $('commentText');
      ta.oninput = () => { $('commentLen').textContent = ta.value.length + ' / 200'; };
      $('commentForm').onsubmit = submitComment;
    }
  }

  async function loadComments(id) {
    const { data, error } = await sb.rpc('get_comments', { p_artwork_id: id });
    if (state.openId !== id) return;      // 그 사이 다른 작품을 열었다면 무시
    const ul = $('commentList');
    if (error) { ul.innerHTML = '<li class="comments__empty">댓글을 불러오지 못했어요.</li>'; return; }
    state.stats[id] = { ...stat(id), comment_count: data.length };
    refreshCommentCount(id);
    ul.innerHTML = data.length ? data.map(commentHtml).join('') :
      '<li class="comments__empty">첫 댓글을 남겨 보세요!</li>';
  }

  function commentHtml(c) {
    const d = new Date(c.created_at);
    const when = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return `<li class="comment"><div class="comment__meta"><span class="comment__author">${esc(c.author_masked)}</span>
      <span>${when}</span>${c.is_mine && state.settings.voting_open
        ? `<button class="btn btn--text comment__del" type="button" data-delcomment="${c.id}">삭제</button>` : ''}</div>
      <p class="comment__body">${esc(c.body)}</p></li>`;
  }

  async function submitComment(e) {
    e.preventDefault();
    const ta = $('commentText');
    const body = ta.value.trim();
    if (!body) return toast('댓글 내용을 입력해 주세요.');
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const { error } = await sb.rpc('add_comment', { p_artwork_id: state.openId, p_body: body });
      if (error) throw error;
      ta.value = ''; $('commentLen').textContent = '0 / 200';
      await loadComments(state.openId);
    } catch (ex) { toast(errText(ex)); }
    btn.disabled = false;
  }

  async function deleteComment(cid) {
    if (!confirm('이 댓글을 삭제할까요?')) return;
    try {
      const { error } = await sb.rpc('delete_my_comment', { p_comment_id: cid });
      if (error) throw error;
      await loadComments(state.openId);
    } catch (ex) { toast(errText(ex)); }
  }

  // ---------- 모달 닫기 ----------
  function closeModals(only) {
    ['detailModal', 'loginModal'].forEach((m) => { if (!only || only === m) $(m).hidden = true; });
    if (!only || only === 'detailModal') state.openId = null;
    if ($('detailModal').hidden && $('loginModal').hidden) document.body.classList.remove('no-scroll');
  }

  // ---------- 이벤트 연결 (이벤트 위임: 카드가 다시 그려져도 계속 동작) ----------
  document.addEventListener('click', (e) => {
    const t = e.target;
    const like = t.closest('[data-like]');
    if (like) return toggleLike(Number(like.dataset.like), like);
    const open = t.closest('[data-open]');
    if (open) return openDetail(Number(open.dataset.open));
    const del = t.closest('[data-delcomment]');
    if (del) return deleteComment(Number(del.dataset.delcomment));
    const close = t.closest('[data-close]');
    if (close) return closeModals(close.closest('.modal').id);
    const sort = t.closest('[data-sort]');
    if (sort) {
      state.sort = sort.dataset.sort;
      document.querySelectorAll('.sortbar__btn').forEach((b) => b.classList.toggle('is-active', b === sort));
      renderGallery();
    }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModals(); });
  $('loginForm').addEventListener('submit', submitLogin);

  // ---------- 시작 ----------
  async function init() {
    showSkeleton();
    try {
      await loadSettings();
      await Promise.all([loadArtworks(), restoreStudent()]);
      await loadStats();
      renderUser();
      renderGallery();
    } catch (ex) {
      console.error(ex);
      renderUser();
      showState('⚠️', '작품을 불러오지 못했어요. 인터넷 연결을 확인해 주세요.', true);
    }
  }
  init();
})();
