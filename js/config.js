// =====================================================================
// Supabase 연결 정보
// ---------------------------------------------------------------------
// Supabase 대시보드 → Project Settings → API Keys 에서 확인할 수 있습니다.
//
// ⚠ 여기에는 "공개용" 키(publishable key, sb_publishable_... 또는 예전 anon key)만
//   넣어야 합니다. 이 파일은 GitHub Pages에서 누구나 볼 수 있기 때문입니다.
//   secret key(sb_secret_...)나 service_role key는 절대 넣지 마세요!
//   공개용 키가 알려져도 괜찮은 이유: 데이터베이스의 RLS(행 단위 보안)와
//   함수 안의 검사가 "누가 무엇을 할 수 있는지"를 막아 주기 때문입니다.
// =====================================================================
window.APP_CONFIG = {
  SUPABASE_URL: 'https://jhoiyqbacsbzbtypndvu.supabase.co',
  SUPABASE_KEY: 'sb_publishable_-V8QSAXPY6jp_0jMVpCO-A_MHobDL6I',

  // 작품 이미지를 저장하는 Storage 버킷 이름 (schema.sql 과 같아야 함)
  BUCKET: 'artworks',
};
