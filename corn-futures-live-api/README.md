# Corn Futures Live API Dashboard

이 폴더는 HTML 차트가 서버 API를 통해 Yahoo Finance 지연 시세를 다시 조회하는 버전입니다.

- 로컬 실행: `node local-server.js`
- 접속: `http://localhost:8787`
- Vercel 배포: 이 폴더를 프로젝트 루트로 올리면 `api/corn-futures.js`가 서버리스 API로 동작합니다.

주의: CME 실시간 시세가 아니라 Yahoo Finance 지연 시세입니다. API 실패 시 HTML에 내장된 스냅샷으로 fallback 합니다.
