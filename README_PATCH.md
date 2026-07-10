# WR Picker v3.0.0 대규모 안정화 패치

## 바로 적용
현재 저장소 루트에서 이 ZIP의 파일을 덮어쓴 뒤 실행합니다.

```bash
git add index.html manifest.webmanifest sw.js icon.svg README_PATCH.md
git commit -m "feat: apply WR picker v3 normalized stability patch"
git push origin main
```

## 주요 변경
- 추천 총점을 0~100 가중평균으로 정규화
- 챔피언 배열 순서와 무관한 안정 ID 적용
- 기존 v2 전적/챔폭 데이터를 시작 시 자동 마이그레이션
- 패배만으로 자동 숙련도가 폭증하던 계산식 수정
- 부라인 페널티를 전체 점수가 아닌 메타 축에만 적용
- 7.2 화면과 7.1h 승률 스냅샷 차이를 명시하고 신뢰도 감쇠
- 통계 없는 신규 챔피언은 49.5% 확정값이 아니라 ‘통계 부족’으로 표시
- 추천 신뢰도와 종합/안전/카운터/숙련 유형 표시
- 우리팀 4명, 상대팀 5명, 밴 10명 입력 제한
- 가져오기 데이터 검증, 최대 10,000전 제한
- 전적에 패치/모델 버전/점수 스냅샷 저장
- 정적 manifest 및 service worker 기반 오프라인 PWA 지원

## 주의
서비스 워커 캐시가 남아 이전 화면이 보이면 브라우저 새로고침을 한 번 강하게 실행하거나 사이트 데이터를 삭제합니다.
