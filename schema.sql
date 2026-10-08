-- =====================================================================
-- 학교 캐릭터 공모전 투표 사이트 - 데이터베이스 설정 파일
-- ---------------------------------------------------------------------
-- 사용법: Supabase 대시보드 → SQL Editor → New query 에 이 파일 전체를
--         붙여넣고 Run 을 누르면 표·보안 규칙(RLS)·이미지 저장소·함수가
--         한 번에 만들어집니다.
-- 여러 번 실행해도 안전합니다. (이미 있는 것은 건너뛰거나 새 내용으로 교체)
--   단, 표에 들어 있는 데이터(작품·하트·댓글)는 지워지지 않습니다.
--
-- 보안 설계 요약
--   1) 모든 표에 RLS(행 단위 보안)를 켜서 "허용한 것만" 읽고 쓸 수 있게 함
--   2) 학생은 표에 직접 쓰지 못하고, 아래의 SECURITY DEFINER 함수로만 씀
--      (함수 안에서 투표 기간·본인 여부·글자 수를 다시 검사)
--   3) 교사(관리자)는 admins 표에 이메일이 있고, 익명 계정이 아닐 때만 인정
--   4) 관리자 가입 코드는 secrets 표에만 있고, 누구도 직접 읽을 수 없음
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0. 작은 도우미 함수들
-- ---------------------------------------------------------------------

-- 학교 이름 정규화: "서울 고등학교", "서울고등학교", "서울고" 를 모두 "서울고"로 맞춤
--   1) 모든 공백 제거  2) 끝의 "등학교" 또는 "학교" 제거  3) 영문은 소문자로
create or replace function public.normalize_school(p_school text)
returns text
language sql
immutable
as $$
  select lower(
    regexp_replace(
      regexp_replace(coalesce(p_school, ''), '\s+', '', 'g'),
      '(등학교|학교)$', ''
    )
  );
$$;

-- 이름 마스킹: 강현욱 → 강*욱, 김철 → 김*, 남궁민수 → 남**수
-- 댓글을 저장하는 순간 이 결과만 저장하므로, 학생 화면에는 실제 이름이 갈 길이 없음
create or replace function public.mask_name(p_name text)
returns text
language plpgsql
immutable
as $$
declare
  n text := regexp_replace(coalesce(p_name, ''), '\s+', '', 'g');
  len int := char_length(n);
begin
  if len <= 1 then
    return '*';
  elsif len = 2 then
    return left(n, 1) || '*';
  else
    return left(n, 1) || repeat('*', len - 2) || right(n, 1);
  end if;
end;
$$;


-- ---------------------------------------------------------------------
-- 1. 표(테이블) 만들기
-- ---------------------------------------------------------------------

-- 1-1. 사이트 설정 (행이 딱 1개만 존재: id = 1)
create table if not exists public.settings (
  id          int primary key default 1 check (id = 1),
  site_title  text not null default '학교 캐릭터 공모전',
  notice      text not null default '마음에 드는 캐릭터에 하트를 눌러 응원해 주세요! 작품마다 한 번씩 누를 수 있어요.',
  voting_open boolean not null default true,          -- true = 투표 중, false = 마감
  updated_at  timestamptz not null default now()
);
insert into public.settings (id) values (1) on conflict (id) do nothing;

-- 1-2. 비밀 값 보관함 (관리자 가입 코드 등). 누구도 직접 읽을 수 없음
create table if not exists public.secrets (
  key   text primary key,
  value text not null
);
-- 기본 가입 코드: sonline (이미 다른 값으로 바꿨다면 그대로 둠)
insert into public.secrets (key, value) values ('admin_signup_code', 'sonline')
on conflict (key) do nothing;

-- 1-3. 관리자(교사) 이메일 목록
create table if not exists public.admins (
  email      text primary key,
  created_at timestamptz not null default now()
);

-- 1-4. 학생 프로필
--   user_id : 지금 이 학생이 로그인한 기기(익명 계정)의 id
--             다른 기기에서 로그인하면 새 기기 id로 바뀌고, 이전 기기는 연결이 끊김
create table if not exists public.students (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid unique references auth.users(id) on delete set null,
  school        text not null,                 -- 학생이 입력한 학교명 (보여주기용)
  school_norm   text not null,                 -- 정규화한 학교명 (비교용)
  student_no    text not null,                 -- 학번
  name          text not null,                 -- 실제 이름 (관리자만 볼 수 있음)
  created_at    timestamptz not null default now(),
  last_login_at timestamptz not null default now()
);
-- 같은 (정규화한 학교, 학번)은 딱 1명 → 중복 투표 원천 차단
create unique index if not exists students_school_no_uidx
  on public.students (school_norm, student_no);

-- 1-5. 출품작
create table if not exists public.artworks (
  id          bigint generated always as identity primary key,
  title       text not null default '',
  author      text not null default '',         -- 출품자 (공개용 표기)
  description text not null default '',
  image_path  text not null,                     -- Storage 안의 파일 경로
  is_hidden   boolean not null default false,    -- true면 학생 화면에서 숨김
  sort_order  int not null default 0,
  created_at  timestamptz not null default now()
);

-- 1-6. 하트(좋아요): (작품, 학생) 조합은 1번만 → 기본키로 중복 차단
create table if not exists public.likes (
  artwork_id bigint not null references public.artworks(id) on delete cascade,
  student_id uuid   not null references public.students(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (artwork_id, student_id)
);
create index if not exists likes_student_idx on public.likes (student_id);

-- 1-7. 댓글
create table if not exists public.comments (
  id            bigint generated always as identity primary key,
  artwork_id    bigint not null references public.artworks(id) on delete cascade,
  student_id    uuid   not null references public.students(id) on delete cascade,
  author_masked text   not null,                 -- 저장 시점에 마스킹된 이름 (예: 강*욱)
  body          text   not null check (char_length(body) between 1 and 200),
  is_hidden     boolean not null default false,  -- 관리자가 숨긴 댓글
  created_at    timestamptz not null default now()
);
create index if not exists comments_artwork_idx on public.comments (artwork_id, created_at desc);


-- ---------------------------------------------------------------------
-- 2. 관리자 판정 함수
--   로그인한 계정의 이메일이 admins 표에 있고, 익명 계정이 아니면 true
--   SECURITY DEFINER: admins 표를 직접 못 읽는 사람도 판정은 받을 수 있게 함
-- ---------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
    and exists (
      select 1 from public.admins a
      where lower(a.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    );
$$;


-- ---------------------------------------------------------------------
-- 3. RLS(행 단위 보안) 켜기 + 정책
--   정책이 없는 동작은 전부 거부됩니다. (최소 권한)
-- ---------------------------------------------------------------------
alter table public.settings enable row level security;
alter table public.secrets  enable row level security;
alter table public.admins   enable row level security;
alter table public.students enable row level security;
alter table public.artworks enable row level security;
alter table public.likes    enable row level security;
alter table public.comments enable row level security;

-- 표 권한도 한 번 비우고 필요한 것만 다시 줌 (RLS와 이중 잠금)
revoke all on public.settings, public.secrets, public.admins, public.students,
              public.artworks, public.likes, public.comments
  from anon, authenticated;

-- settings: 누구나 읽기, 관리자만 수정
grant select on public.settings to anon, authenticated;
grant update on public.settings to authenticated;
drop policy if exists settings_read on public.settings;
create policy settings_read on public.settings for select using (true);
drop policy if exists settings_admin_update on public.settings;
create policy settings_admin_update on public.settings for update
  using (public.is_admin()) with check (public.is_admin());

-- secrets: 정책 없음 + 권한 없음 → 아무도 읽거나 쓸 수 없음 (함수 안에서만 사용)

-- admins: 관리자만 목록 보기 (추가는 가입 코드 함수, 삭제는 admin_remove 함수로만)
grant select on public.admins to authenticated;
drop policy if exists admins_admin_read on public.admins;
create policy admins_admin_read on public.admins for select using (public.is_admin());

-- students: 학생은 "내 프로필"만 보기, 관리자는 보기·수정(기기 연결 해제)·삭제
grant select, update, delete on public.students to authenticated;
drop policy if exists students_self_read on public.students;
create policy students_self_read on public.students for select
  using (user_id = auth.uid() or public.is_admin());
drop policy if exists students_admin_update on public.students;
create policy students_admin_update on public.students for update
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists students_admin_delete on public.students;
create policy students_admin_delete on public.students for delete
  using (public.is_admin());

-- artworks: 누구나 "숨기지 않은 작품" 보기, 관리자는 전부 보기·추가·수정·삭제
grant select on public.artworks to anon, authenticated;
grant insert, update, delete on public.artworks to authenticated;
drop policy if exists artworks_read on public.artworks;
create policy artworks_read on public.artworks for select
  using (is_hidden = false or public.is_admin());
drop policy if exists artworks_admin_insert on public.artworks;
create policy artworks_admin_insert on public.artworks for insert
  with check (public.is_admin());
drop policy if exists artworks_admin_update on public.artworks;
create policy artworks_admin_update on public.artworks for update
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists artworks_admin_delete on public.artworks;
create policy artworks_admin_delete on public.artworks for delete
  using (public.is_admin());

-- likes: 관리자만 직접 보기·삭제 (학생은 toggle_like / get_artwork_stats 함수로만)
grant select, delete on public.likes to authenticated;
drop policy if exists likes_admin_read on public.likes;
create policy likes_admin_read on public.likes for select using (public.is_admin());
drop policy if exists likes_admin_delete on public.likes;
create policy likes_admin_delete on public.likes for delete using (public.is_admin());

-- comments: 관리자만 직접 보기·수정(숨김)·삭제 (학생은 get_comments 등 함수로만)
grant select, update, delete on public.comments to authenticated;
drop policy if exists comments_admin_read on public.comments;
create policy comments_admin_read on public.comments for select using (public.is_admin());
drop policy if exists comments_admin_update on public.comments;
create policy comments_admin_update on public.comments for update
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists comments_admin_delete on public.comments;
create policy comments_admin_delete on public.comments for delete using (public.is_admin());


-- ---------------------------------------------------------------------
-- 4. 학생용 함수 (SECURITY DEFINER = 함수 주인 권한으로 실행)
--   학생이 할 수 있는 "쓰기"는 오직 이 함수들뿐입니다.
--   오류는 영어 코드로 던지고, 화면(js/app.js)에서 한국어 안내로 바꿉니다.
-- ---------------------------------------------------------------------

-- 지금 로그인한 기기(익명 계정)에 연결된 학생 id 찾기 (내부용)
create or replace function public.current_student_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select s.id from public.students s where s.user_id = auth.uid();
$$;

-- 4-1. 학생 로그인(프로필 연결)
--   - (정규화한 학교, 학번)이 처음이면 새 프로필 생성
--   - 이미 있으면 이름이 같은지 확인 → 다르면 거부(학번 도용 방지)
--   - 이름이 같으면 이 기기로 연결을 옮김 (이전 기기는 투표 불가)
create or replace function public.claim_student(p_school text, p_student_no text, p_name text)
returns table (id uuid, school text, student_no text, name text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_school text := btrim(coalesce(p_school, ''));
  v_norm   text := public.normalize_school(p_school);
  v_no     text := regexp_replace(coalesce(p_student_no, ''), '\s+', '', 'g');
  v_name   text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_row    public.students%rowtype;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN';
  end if;
  -- 입력값 검사 (빈 값·너무 긴 값 거부)
  if v_norm = '' or char_length(v_school) > 40 then
    raise exception 'INVALID_SCHOOL';
  end if;
  if v_no = '' or char_length(v_no) > 20 then
    raise exception 'INVALID_STUDENT_NO';
  end if;
  if v_name = '' or char_length(v_name) > 20 then
    raise exception 'INVALID_NAME';
  end if;

  -- 같은 학교·학번이 이미 있는지 확인 (동시에 두 번 눌러도 안전하도록 잠금)
  select * into v_row from public.students s
   where s.school_norm = v_norm and s.student_no = v_no
   for update;

  if found then
    -- 이름 비교는 띄어쓰기를 무시하고 함
    if replace(v_row.name, ' ', '') <> replace(v_name, ' ', '') then
      raise exception 'NAME_MISMATCH';
    end if;
  end if;

  -- 이 기기가 혹시 다른 학생과 연결돼 있었다면 먼저 끊음
  update public.students s set user_id = null
   where s.user_id = v_uid
     and (v_row.id is null or s.id <> v_row.id);

  if v_row.id is not null then
    -- 기존 학생: 이 기기로 연결을 옮김
    update public.students s
       set user_id = v_uid, last_login_at = now()
     where s.id = v_row.id
     returning * into v_row;
  else
    -- 새 학생: 프로필 생성
    insert into public.students (user_id, school, school_norm, student_no, name)
    values (v_uid, v_school, v_norm, v_no, v_name)
    returning * into v_row;
  end if;

  return query select v_row.id, v_row.school, v_row.student_no, v_row.name;
end;
$$;

-- 4-2. 하트 누르기/취소 (토글)
create or replace function public.toggle_like(p_artwork_id bigint)
returns table (liked boolean, like_count int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_student uuid := public.current_student_id();
  v_liked   boolean;
begin
  if v_student is null then
    raise exception 'NOT_LOGGED_IN';
  end if;
  if not (select s.voting_open from public.settings s where s.id = 1) then
    raise exception 'VOTING_CLOSED';
  end if;
  if not exists (select 1 from public.artworks a where a.id = p_artwork_id and a.is_hidden = false) then
    raise exception 'ARTWORK_NOT_FOUND';
  end if;

  -- 이미 눌렀으면 지우고(취소), 아니면 추가
  delete from public.likes l where l.artwork_id = p_artwork_id and l.student_id = v_student;
  if found then
    v_liked := false;
  else
    insert into public.likes (artwork_id, student_id) values (p_artwork_id, v_student)
    on conflict do nothing;
    v_liked := true;
  end if;

  return query
    select v_liked, (select count(*)::int from public.likes l where l.artwork_id = p_artwork_id);
end;
$$;

-- 4-3. 댓글 쓰기 (최대 200자, 이름은 저장 시점에 마스킹)
create or replace function public.add_comment(p_artwork_id bigint, p_body text)
returns table (id bigint, author_masked text, body text, created_at timestamptz, is_mine boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_student uuid := public.current_student_id();
  v_body    text := btrim(coalesce(p_body, ''));
  v_name    text;
  v_row     public.comments%rowtype;
begin
  if v_student is null then
    raise exception 'NOT_LOGGED_IN';
  end if;
  if not (select s.voting_open from public.settings s where s.id = 1) then
    raise exception 'VOTING_CLOSED';
  end if;
  if char_length(v_body) = 0 then
    raise exception 'EMPTY_COMMENT';
  end if;
  if char_length(v_body) > 200 then
    raise exception 'COMMENT_TOO_LONG';
  end if;
  if not exists (select 1 from public.artworks a where a.id = p_artwork_id and a.is_hidden = false) then
    raise exception 'ARTWORK_NOT_FOUND';
  end if;

  select s.name into v_name from public.students s where s.id = v_student;

  insert into public.comments (artwork_id, student_id, author_masked, body)
  values (p_artwork_id, v_student, public.mask_name(v_name), v_body)
  returning * into v_row;

  return query select v_row.id, v_row.author_masked, v_row.body, v_row.created_at, true;
end;
$$;

-- 4-4. 내 댓글 삭제 (본인 것만)
create or replace function public.delete_my_comment(p_comment_id bigint)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_student uuid := public.current_student_id();
begin
  if v_student is null then
    raise exception 'NOT_LOGGED_IN';
  end if;
  if not (select s.voting_open from public.settings s where s.id = 1) then
    raise exception 'VOTING_CLOSED';
  end if;
  delete from public.comments c where c.id = p_comment_id and c.student_id = v_student;
  if not found then
    raise exception 'NOT_YOUR_COMMENT';
  end if;
  return true;
end;
$$;

-- 4-5. 작품별 하트 수·댓글 수·내가 눌렀는지 (로그인 전에도 호출 가능)
create or replace function public.get_artwork_stats()
returns table (artwork_id bigint, like_count int, comment_count int, liked_by_me boolean)
language sql
stable
security definer
set search_path = public
as $$
  select
    a.id,
    (select count(*)::int from public.likes l where l.artwork_id = a.id),
    (select count(*)::int from public.comments c where c.artwork_id = a.id and c.is_hidden = false),
    exists (select 1 from public.likes l
             where l.artwork_id = a.id and l.student_id = public.current_student_id())
  from public.artworks a
  where a.is_hidden = false;
$$;

-- 4-6. 작품의 댓글 목록 (숨긴 댓글 제외, 실제 이름·학생 id는 내보내지 않음)
create or replace function public.get_comments(p_artwork_id bigint)
returns table (id bigint, author_masked text, body text, created_at timestamptz, is_mine boolean)
language sql
stable
security definer
set search_path = public
as $$
  select c.id, c.author_masked, c.body, c.created_at,
         (c.student_id = public.current_student_id())
    from public.comments c
    join public.artworks a on a.id = c.artwork_id and a.is_hidden = false
   where c.artwork_id = p_artwork_id and c.is_hidden = false
   order by c.created_at desc
   limit 500;
$$;


-- ---------------------------------------------------------------------
-- 5. 관리자 계정 함수
-- ---------------------------------------------------------------------

-- 5-1. 가입 코드로 관리자 등록 (계정 활성화 + admins 표 추가를 한 번에)
--   화면에서는 supabase.auth.signUp 으로 계정을 만든 뒤 이 함수를 부릅니다.
--   코드가 맞으면 이메일 인증을 건너뛰도록 계정을 "인증됨"으로 표시합니다.
create or replace function public.register_admin_with_code(p_email text, p_code text)
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_code  text;
begin
  select s.value into v_code from public.secrets s where s.key = 'admin_signup_code';
  if v_code is null or coalesce(p_code, '') <> v_code then
    perform pg_sleep(1);            -- 코드 무작위 대입을 느리게 만듦
    raise exception 'INVALID_CODE';
  end if;

  -- 계정 활성화 (이메일 인증 처리)
  update auth.users u
     set email_confirmed_at = coalesce(u.email_confirmed_at, now())
   where lower(u.email) = v_email
     and coalesce(u.is_anonymous, false) = false;
  if not found then
    raise exception 'USER_NOT_FOUND';
  end if;

  insert into public.admins (email) values (v_email) on conflict (email) do nothing;
  return true;
end;
$$;

-- 5-2. 관리자 권한 해제 (관리자만, 본인은 해제 불가)
create or replace function public.admin_remove(p_email text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'NOT_ADMIN';
  end if;
  if lower(btrim(p_email)) = lower(coalesce(auth.jwt() ->> 'email', '')) then
    raise exception 'CANNOT_REMOVE_SELF';
  end if;
  delete from public.admins a where lower(a.email) = lower(btrim(p_email));
  return found;
end;
$$;


-- ---------------------------------------------------------------------
-- 6. 함수 실행 권한 정리
--   기본으로 "모두 실행 가능"인 것을 먼저 빼고, 필요한 사람에게만 다시 줌
-- ---------------------------------------------------------------------
revoke execute on function
  public.is_admin(),
  public.current_student_id(),
  public.claim_student(text, text, text),
  public.toggle_like(bigint),
  public.add_comment(bigint, text),
  public.delete_my_comment(bigint),
  public.get_artwork_stats(),
  public.get_comments(bigint),
  public.register_admin_with_code(text, text),
  public.admin_remove(text)
from public, anon, authenticated;

-- 로그인 전(anon)에도 필요한 것: 갤러리 숫자·댓글 보기, 관리자 가입
grant execute on function
  public.is_admin(),
  public.get_artwork_stats(),
  public.get_comments(bigint),
  public.register_admin_with_code(text, text)
to anon, authenticated;

-- 로그인 후(authenticated: 익명 학생 포함)에만 필요한 것
grant execute on function
  public.current_student_id(),
  public.claim_student(text, text, text),
  public.toggle_like(bigint),
  public.add_comment(bigint, text),
  public.delete_my_comment(bigint),
  public.admin_remove(text)
to authenticated;


-- ---------------------------------------------------------------------
-- 7. 이미지 저장소(Storage) 버킷
--   'artworks' 버킷은 공개(누구나 이미지 주소로 보기 가능)
--   올리기·바꾸기·지우기는 관리자만
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('artworks', 'artworks', true, 10485760,
        array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists artworks_storage_admin_insert on storage.objects;
create policy artworks_storage_admin_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'artworks' and public.is_admin());
drop policy if exists artworks_storage_admin_update on storage.objects;
create policy artworks_storage_admin_update on storage.objects for update to authenticated
  using (bucket_id = 'artworks' and public.is_admin());
drop policy if exists artworks_storage_admin_delete on storage.objects;
create policy artworks_storage_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'artworks' and public.is_admin());
-- (공개 버킷이라 이미지 보기에는 별도 정책이 필요 없음.
--  관리자가 파일을 지울 때 목록 확인용으로 select 정책만 관리자에게 줌)
drop policy if exists artworks_storage_admin_select on storage.objects;
create policy artworks_storage_admin_select on storage.objects for select to authenticated
  using (bucket_id = 'artworks' and public.is_admin());


-- ---------------------------------------------------------------------
-- 8. 처음 관리자 등록
--   이 이메일로 admin.html 에서 "관리자 계정 만들기"(가입 코드 입력)를 하면
--   바로 관리자로 쓸 수 있습니다. 다른 교사를 미리 넣고 싶으면 줄을 추가하세요.
-- ---------------------------------------------------------------------
insert into public.admins (email) values ('eeoq124@gmail.com') on conflict (email) do nothing;

-- PostgREST(자동 API)가 바뀐 표·함수를 바로 알도록 새로고침 신호
notify pgrst, 'reload schema';
