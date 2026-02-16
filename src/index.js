import express from 'express';
import cors from 'cors';
import { initPrinter, checkPrinterStatus, printReceipt, closePrinter } from './printer.js';
import { buildReceipt } from './receipt.js';

/**
 * ESC/POS 프린터 브릿지 서버
 *
 * 포트: 18181
 * - 과일맛집 시스템 포트 규칙: 백엔드 8088, 프론트엔드 3000, 프린터 18181
 * - 1만 단위 포트 사용으로 시스템 포트(0-1023) 충돌 회피
 *
 * 아키텍처 결정:
 * 1. HTTP 서버 (WebSocket 아님) - 단방향 출력만 필요, 복잡도 최소화
 * 2. Express 프레임워크 - 미들웨어 생태계, 에러 핸들링 용이
 * 3. CORS 전체 허용 - 로컬 네트워크 내 프린터 서버는 보안 경계 밖 (매장 내부망)
 */

const app = express();
const PORT = 18181;

/**
 * CORS 미들웨어 설정
 *
 * origin: true - 모든 Origin 허용
 *
 * 동작 흐름:
 * 1. 관리자가 매장 PC 브라우저에서 https://fruit-matjip.store/admin 접속
 * 2. 프론트엔드 JS가 fetch('http://127.0.0.1:18181/print') 호출
 * 3. 이 프린터 브릿지 서버가 USB 프린터로 ESC/POS 명령 전송
 *
 * Mixed Content 해결:
 * - Chrome은 http://127.0.0.1을 secure context로 취급하므로
 *   HTTPS 사이트에서 호출해도 Mixed Content 차단이 발생하지 않음
 * - 따라서 프린터 서버에 HTTPS 설정이 불필요
 */
app.use(cors({
  origin: true,
  credentials: true
}));

/**
 * Chrome Private Network Access (PNA) 대응
 *
 * HTTPS 사이트(fruit-matjip.store)에서 로컬 서버(127.0.0.1)로 요청 시
 * Chrome이 preflight에 Access-Control-Request-Private-Network 헤더를 추가.
 * 서버가 Access-Control-Allow-Private-Network: true로 응답해야 요청이 허용됨.
 */
app.use((req, res, next) => {
  if (req.headers['access-control-request-private-network']) {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  next();
});

/**
 * JSON 바디 파서
 *
 * limit: '10mb' - 대량 주문 시 items 배열이 클 수 있으므로 여유 있게 설정
 * strict: true - 배열/객체만 허용, 원시값(문자열/숫자) 거부 (보안)
 */
app.use(express.json({ limit: '10mb', strict: true }));

/**
 * POST /print - 영수증 출력
 *
 * Request Body:
 * {
 *   orderId: number,
 *   paidAt: string (ISO 8601),
 *   deliveryHour: number,
 *   deliveryMinute: number,
 *   buyerName: string,
 *   phone: string,
 *   items: [{ productName, quantity, amount }],
 *   totalProductAmount: number,
 *   deliveryFee: number,
 *   distanceKm: number,
 *   address1: string,
 *   address2: string
 * }
 *
 * Response:
 * 200 - { message: "영수증 출력 완료" }
 * 400 - { error: "필수 필드 누락" }
 * 500 - { error: "프린터 연결 실패" | "출력 오류: ..." }
 *
 * 에러 핸들링 전략:
 * 1. 필수 필드 검증 (orderId, items 등)
 * 2. 프린터 연결 확인
 * 3. ESC/POS 명령 생성 및 전송
 * 4. 각 단계별 에러 시 명확한 메시지 반환 (프론트엔드 디버깅 용이)
 */
app.post('/print', async (req, res) => {
  try {
    const data = req.body;

    // 예약배달 디버그 로그
    console.log('[DEBUG] scheduledDeliveryHour:', data.scheduledDeliveryHour, '| scheduledDeliveryMinute:', data.scheduledDeliveryMinute);

    // 필수 필드 검증
    const requiredFields = [
      'orderId', 'paidAt', 'deliveryHour', 'deliveryMinute',
      'buyerName', 'phone', 'items', 'totalProductAmount',
      'deliveryFee', 'distanceKm', 'address1'
    ];

    for (const field of requiredFields) {
      if (data[field] === undefined || data[field] === null) {
        return res.status(400).json({
          error: `필수 필드 누락: ${field}`
        });
      }
    }

    // items 배열 검증
    if (!Array.isArray(data.items) || data.items.length === 0) {
      return res.status(400).json({
        error: '상품 목록(items)이 비어 있습니다'
      });
    }

    // 프린터 초기화
    const printer = initPrinter();

    // 프린터 연결 확인
    const isConnected = await checkPrinterStatus();
    if (!isConnected) {
      return res.status(500).json({
        error: '프린터 연결 실패 - USB 케이블 및 전원을 확인하세요'
      });
    }

    // 영수증 ESC/POS 명령 생성
    buildReceipt(printer, data);

    // 프린터 출력 실행
    await printReceipt(printer);

    // 성공 응답
    res.json({
      message: '영수증 출력 완료',
      orderId: data.orderId
    });

  } catch (error) {
    console.error('[API /print] 에러:', error);

    // 에러 상세 정보 반환 (개발/디버깅용)
    // 운영 환경에서는 민감 정보 노출 주의
    res.status(500).json({
      error: `출력 실패: ${error.message}`,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

/**
 * GET /health - 프린터 상태 확인
 *
 * Response:
 * 200 - { status: "connected", message: "프린터 정상" }
 * 503 - { status: "disconnected", message: "프린터 연결 안 됨" }
 *
 * 용도:
 * - 프론트엔드에서 출력 버튼 활성화/비활성화 판단
 * - 헬스체크 엔드포인트 (모니터링 시스템 연동 가능)
 * - 주기적 폴링으로 프린터 상태 실시간 표시
 */
app.get('/health', async (req, res) => {
  try {
    const isConnected = await checkPrinterStatus();

    if (isConnected) {
      res.json({
        status: 'connected',
        message: '프린터 정상'
      });
    } else {
      res.status(503).json({
        status: 'disconnected',
        message: '프린터 연결 안 됨'
      });
    }
  } catch (error) {
    console.error('[API /health] 에러:', error);
    res.status(503).json({
      status: 'error',
      message: `상태 확인 실패: ${error.message}`
    });
  }
});

/**
 * 404 핸들러 - 정의되지 않은 경로 접근 시
 */
app.use((req, res) => {
  res.status(404).json({
    error: '존재하지 않는 엔드포인트',
    path: req.path
  });
});

/**
 * 글로벌 에러 핸들러
 *
 * Express의 4-파라미터 시그니처를 가진 미들웨어는 에러 핸들러로 인식됨
 * 모든 라우트/미들웨어에서 발생한 에러를 여기서 최종 처리
 */
app.use((err, req, res, next) => {
  console.error('[Global Error Handler]', err);
  res.status(500).json({
    error: '서버 내부 오류',
    message: err.message
  });
});

/**
 * 서버 시작
 *
 * listen() 성공 시 프린터 초기화 시도
 * - 서버 시작 시점에 프린터 미연결 상태여도 정상 기동 (나중에 연결 가능)
 * - /health 엔드포인트로 실시간 상태 확인 가능
 */
const server = app.listen(PORT, () => {
  console.log(`\n🖨️  프린터 브릿지 서버 시작`);
  console.log(`   포트: ${PORT}`);
  console.log(`   헬스체크: http://localhost:${PORT}/health`);
  console.log(`   출력 API: http://localhost:${PORT}/print\n`);

  // 초기 프린터 연결 확인 (비차단)
  checkPrinterStatus()
    .then(isConnected => {
      if (isConnected) {
        console.log('✅ 프린터 연결 확인됨');
      } else {
        console.log('⚠️  프린터 연결 안 됨 - USB 케이블 확인');
      }
    })
    .catch(err => {
      console.error('⚠️  프린터 상태 확인 실패:', err.message);
    });
});

/**
 * Graceful Shutdown 핸들러
 *
 * SIGTERM/SIGINT (Ctrl+C) 신호 수신 시:
 * 1. HTTP 서버 종료 (새 요청 거부)
 * 2. 진행 중인 요청 완료 대기
 * 3. 프린터 연결 해제
 * 4. 프로세스 종료
 *
 * 목적: USB 디바이스 파일 디스크립터 누수 방지
 */
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function shutdown() {
  console.log('\n서버 종료 중...');
  server.close(() => {
    console.log('HTTP 서버 종료됨');
    closePrinter();
    process.exit(0);
  });

  // 강제 종료 타임아웃 (10초)
  setTimeout(() => {
    console.error('강제 종료 (타임아웃)');
    process.exit(1);
  }, 10000);
}
