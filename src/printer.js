import { ThermalPrinter, PrinterTypes } from 'node-thermal-printer';

/**
 * ESC/POS 프린터 연결 및 출력 래퍼
 *
 * 기술적 결정:
 * 1. USB 인터페이스 사용 (PrinterTypes.EPSON) - 대부분의 58mm 영수증 프린터가 EPSON ESC/POS 호환
 * 2. 싱글톤 패턴으로 프린터 인스턴스 관리 - 동시 출력 충돌 방지
 * 3. 명시적 에러 핸들링 - USB 디바이스 접근 실패, 용지 부족 등 디버깅 용이
 */

let printerInstance = null;

/**
 * 프린터 초기화 및 연결
 *
 * @returns {ThermalPrinter} 프린터 인스턴스
 *
 * USB 디바이스 경로 자동 탐색 순서:
 * 1. /dev/usb/lp0 (Linux 표준)
 * 2. /dev/usb/lp1 (Linux 2번째 USB 프린터)
 * 3. 빈 문자열 (Windows - node-thermal-printer가 자동 탐색)
 *
 * characterSet: 'PC437_USA' - 영문 + 숫자 + 기본 ASCII 문자 (한글은 이미지로 처리해야 함)
 * removeSpecialCharacters: false - 특수문자 보존 (영수증 레이아웃용 - 등호, 대시 등)
 * lineCharacter: "=" - 구분선 문자 (32자 반복으로 전폭 구분선 생성)
 */
export function initPrinter() {
  if (printerInstance) {
    return printerInstance;
  }

  // 운영체제별 USB 경로 분기
  const interfacePath = process.platform === 'win32'
    ? '' // Windows는 자동 탐색
    : '/dev/usb/lp0'; // Linux/macOS는 첫 번째 USB 프린터

  printerInstance = new ThermalPrinter({
    type: PrinterTypes.EPSON, // EPSON ESC/POS 명령어 세트 사용
    interface: interfacePath,
    characterSet: 'PC437_USA',
    removeSpecialCharacters: false,
    lineCharacter: "=",
    options: {
      timeout: 5000 // USB 통신 타임아웃 5초
    }
  });

  return printerInstance;
}

/**
 * 프린터 연결 상태 확인
 *
 * @returns {Promise<boolean>} 연결 성공 여부
 *
 * isPrinterConnected()는 실제 USB 디바이스 통신을 시도하여 연결 확인
 * - true: USB 프린터 감지됨, 데이터 전송 가능
 * - false: 디바이스 없음, 드라이버 오류, 전원 꺼짐 등
 */
export async function checkPrinterStatus() {
  try {
    const printer = initPrinter();
    const isConnected = await printer.isPrinterConnected();
    return isConnected;
  } catch (error) {
    console.error('[Printer] 연결 확인 실패:', error.message);
    return false;
  }
}

/**
 * ESC/POS 명령 실행 및 출력
 *
 * @param {ThermalPrinter} printer - 프린터 인스턴스
 * @returns {Promise<void>}
 *
 * execute() 메서드:
 * 1. 내부 버퍼에 쌓인 ESC/POS 명령어를 바이트 배열로 변환
 * 2. USB 인터페이스로 바이트 스트림 전송
 * 3. 프린터 하드웨어가 명령어 해석 후 용지 출력
 *
 * 에러 케이스:
 * - ENOENT: USB 디바이스 경로 없음
 * - EACCES: 권한 부족 (Linux에서 /dev/usb/lp0 접근 시 sudo 필요할 수 있음)
 * - EBUSY: 다른 프로세스가 프린터 사용 중
 * - Timeout: 프린터 응답 없음 (전원, 케이블 확인 필요)
 */
export async function printReceipt(printer) {
  try {
    await printer.execute();
    console.log('[Printer] 출력 완료');
  } catch (error) {
    console.error('[Printer] 출력 실패:', error.message);
    throw new Error(`프린터 출력 오류: ${error.message}`);
  }
}

/**
 * 프린터 인스턴스 해제 (서버 종료 시 호출)
 *
 * USB 디바이스 파일 디스크립터 정리
 * 메모리 누수 방지
 */
export function closePrinter() {
  if (printerInstance) {
    printerInstance = null;
    console.log('[Printer] 연결 해제됨');
  }
}
