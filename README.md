# 학교 캐릭터 공모전 투표 사이트

학생이 제출한 캐릭터 작품을 갤러리로 보여주고, 학생이 로그인 후 **하트·댓글**로 투표하는 사이트입니다.
프로그램 설치 없이 **Supabase(무료)** 와 **GitHub Pages(무료)** 만으로 운영합니다.

| 파일 | 역할 |
|---|---|
| `index.html`, `css/style.css`, `js/app.js` | 학생 화면 |
| `admin.html`, `css/admin.css`, `js/admin.js` | 교사(관리자) 화면 |
| `js/config.js` | Supabase 주소와 공개용 키를 넣는 곳 |
| `supabase/schema.sql` | 데이터베이스(표·보안·함수) 한 번에 만들기 |
| `작품정보.csv` | 작품 제목·출품자·설명 (관리자 화면에서 불러오기용) |

---

## 1단계. Supabase 설정 (처음 한 번)

1. <https://supabase.com> 에 가입 → **New project** → 이름 `db_hyunuk`, 비밀번호 생성, 지역 Asia-Pacific.
2. **SQL 만들기**: 왼쪽 메뉴 **SQL Editor → New query** 에 `supabase/schema.sql` 전체를 붙여넣고 **Run**.
   "Potential issue detected" 창이 뜨면 **Run query**. `Success` 가 나오면 끝입니다. (여러 번 실행해도 안전합니다.)
3. **익명 로그인 켜기**: **Authentication → Sign In / Providers** →
   `Allow anonymous sign-ins` 켜기, `Confirm email` 끄기 → **Save changes**.
4. **로그인 횟수 제한 올리기**: **Authentication → Rate Limits** →
   `Rate limit for anonymous users` 를 학생 수 이상(예: 1000)으로 → **Save changes**.
   (학교 와이파이는 같은 IP를 쓰기 때문에, 기본값 30은 금방 찹니다.)
5. **키 확인**: **Project Settings → API Keys** 에서 Project URL 과 **Publishable key** 를 복사해
   `js/config.js` 에 입력합니다.
   > ⚠ `secret key` / `service_role key` 는 절대 넣지 마세요. 사이트 코드는 공개됩니다.

## 2단계. 교사(관리자) 계정 만들기

`supabase/schema.sql` 맨 끝에 `eeoq124@gmail.com` 이 관리자 목록에 미리 들어 있습니다.
방법은 둘 중 하나입니다.

- **방법 A (권장)**: `admin.html` → **관리자 계정 만들기** → 이메일, 비밀번호(6자 이상), **관리자 가입 코드(기본값 `sonline`)** 입력.
- **방법 B**: Supabase **Authentication → Users → Add user → Create new user** 에서 이메일·비밀번호 입력, **Auto Confirm User** 체크.

> 가입 코드를 바꾸려면 SQL Editor 에서
> `update public.secrets set value = '새코드' where key = 'admin_signup_code';`
> 가입 코드는 화면에서 읽을 수 없고, 아는 사람만 교사 계정을 만들 수 있습니다.

## 3단계. 내 컴퓨터에서 테스트

`index.html` 을 더블클릭해도 대부분 동작하지만, 정확히 보려면 간단한 웹 서버를 켭니다.

- VS Code 의 **Live Server** 확장을 설치해 `index.html` 을 우클릭 → *Open with Live Server*
- 또는 Python 이 있다면 폴더에서 `python -m http.server 8000` 후 <http://localhost:8000>

확인 순서: ① `admin.html` 로그인 → ② **작품** 탭에서 이미지 올리기 → ③ `index.html` 에서 학생처럼 로그인, 하트·댓글.

## 4단계. GitHub Pages 배포

1. GitHub 에서 새 저장소(Repository) 생성 (예: `character-vote`).
2. 이 폴더의 파일을 모두 업로드합니다. (**Add file → Upload files**, `supabase` 폴더도 포함 가능)
3. 저장소 **Settings → Pages → Build and deployment**: Source `Deploy from a branch`, Branch `main`, 폴더 `/ (root)` → **Save**.
4. 1~2분 뒤 `https://<내아이디>.github.io/<저장소이름>/` 주소가 생깁니다. 이 주소를 학생에게 안내하세요.
   관리자 화면은 같은 주소 뒤에 `admin.html` 입니다.

## 5단계. 운영 방법

**대회 전**
- **작품** 탭 → 이미지 끌어다 놓기 → 제목·출품자·설명 입력 → **모두 등록**.
- 정보를 한꺼번에 넣으려면 **작품정보 CSV 불러오기**. 열 이름은 `제목, 출품자, 설명, 파일명키워드`.
  이미지 파일 이름에 `파일명키워드` 가 들어 있으면 자동으로 채워지고, 아니면 드롭다운에서 고릅니다.
- **대시보드**에서 사이트 제목·안내문을 수정합니다.

**투표 중**
- **대시보드**의 스위치가 켜져 있으면 투표 중입니다. 학생은 학교·학번·이름으로 로그인합니다.
- 부적절한 댓글은 **댓글** 탭에서 *숨기기* 또는 *삭제*.
- 학교명은 띄어쓰기와 "고등학교/학교" 꼬리를 무시하고 같은 곳으로 봅니다. 같은 학교·학번은 1명만 투표할 수 있고, 다른 이름으로 로그인하면 거부됩니다.
- 학생이 폰을 바꿨다면 다시 로그인하면 됩니다(이전 기기는 투표 불가). 오류가 나면 **학생** 탭에서 *기기 연결 해제*.

**투표 마감 후**
- 스위치를 끄면 학생은 보기만 가능합니다.
- **결과** 탭에서 순위표와 CSV 3종(작품별 집계·하트 상세·댓글 상세)을 내려받습니다. 엑셀에서 한글이 깨지지 않습니다.
- 개인정보 안내 약속대로, 끝난 뒤 **학생** 탭에서 프로필을 삭제(하트·댓글도 함께 삭제)하세요. 삭제 전에 CSV를 받아 두세요.

## 문제 해결

| 증상 | 해결 |
|---|---|
| 작품이 안 보이고 "불러오지 못했어요" | `js/config.js` 의 URL·키 확인, 1단계 2번 SQL 실행 여부 확인 |
| 학생 로그인 시 "로그인 정보가 없어요" | 1단계 3번 익명 로그인이 꺼져 있음 |
| 학생이 많이 들어오면 로그인 실패 | 1단계 4번의 익명 로그인 제한 올리기 |
| 관리자 로그인 후 "권한이 없어요" | 2단계로 계정 생성, 또는 `admins` 표에 이메일이 있는지 확인 |
| 이미지 업로드 실패 | 10MB 이하 jpg·png·webp·gif 인지 확인, SQL(Storage 부분) 재실행 |
| 이메일 인증 메일을 요구함 | 1단계 3번의 `Confirm email` 을 끄세요 |
| 학생이 "이미 다른 이름으로 등록" 이라고 나옴 | 이름 오타이거나 학번 도용. 필요하면 **학생** 탭에서 해당 프로필 삭제 |
| 수정한 코드가 반영 안 됨 | 브라우저 강력 새로고침(Ctrl+Shift+R), GitHub Pages 는 1~2분 지연 |

## 보안 요약

- 사이트에 들어 있는 키는 공개용(publishable)뿐이며, 모든 표는 RLS 로 잠겨 있습니다.
- 학생의 쓰기는 `claim_student`, `toggle_like`, `add_comment`, `delete_my_comment` 함수로만 가능하고, 함수 안에서 투표 기간·본인 여부·글자 수를 다시 검사합니다.
- 댓글 작성자 이름은 저장할 때 마스킹(예: 강*욱)되어 학생에게 실명이 전달되지 않습니다.
