import { ThermalPrinter, PrinterTypes } from 'node-thermal-printer';
import { execSync } from 'child_process';

/**
 * ESC/POS 프린터 연결 및 출력 래퍼
 *
 * 기술적 결정:
 * 1. USB 인터페이스 사용 (PrinterTypes.EPSON) - 대부분의 58mm 영수증 프린터가 EPSON ESC/POS 호환
 * 2. 싱글톤 패턴으로 프린터 인스턴스 관리 - 동시 출력 충돌 방지
 * 3. wmic으로 SEWOO 프린터 포트 자동 탐색 - 포트 변경 시에도 재빌드 불필요
 */

let printerInstance = null;

/**
 * Windows에서 SEWOO 프린터의 포트를 자동 탐색
 *
 * wmic printer get Name,PortName /format:csv 출력 예시:
 *   Node,Name,PortName
 *   DESKTOP-XXX,SEWOO SLK-TS 100,LPT1
 *
 * @returns {string|null} 포트 이름 (예: 'LPT1') 또는 탐색 실패 시 null
 */
/**
 * wmic CSV 출력에서 SEWOO 프린터 행을 찾아 지정 컬럼 값을 반환
 *
 * @param {string[]} fields - wmic get 필드 목록 (예: ['Name', 'PortName'])
 * @param {number} targetIndex - 반환할 필드의 CSV 컬럼 인덱스 (Node 컬럼 제외하지 않은 원본 인덱스)
 * @returns {string|null}
 */
function querySewooPrinter(fields, targetIndex) {
  try {
    const result = execSync(`wmic printer get ${fields.join(',')} /format:csv`, {
      encoding: 'utf-8',
      timeout: 5000
    });
    const lines = result.trim().split('\n');
    for (const line of lines) {
      if (line.toUpperCase().includes('SEWOO')) {
        const columns = line.split(',');
        // 영숫자만 추출 (콜론, \r, 공백 등 모두 제거)
        return columns[targetIndex].replace(/[^A-Za-z0-9]/g, '') || null;
      }
    }
    return null;
  } catch (error) {
    return null;
  }
}

function findPrinterPort() {
  // CSV 컬럼: Node(0), Name(1), PortName(2)
  return querySewooPrinter(['Name', 'PortName'], 2);
}

/**
 * 프린터 초기화 및 연결
 *
 * @returns {ThermalPrinter} 프린터 인스턴스
 *
 * Windows 포트 탐색 순서:
 * 1. wmic으로 SEWOO 프린터 포트 자동 탐색
 * 2. 탐색 실패 시 LPT1 폴백
 */
export function initPrinter() {
  if (printerInstance) {
    return printerInstance;
  }

  const port = findPrinterPort();
  if (port) {
    console.log(`[Printer] SEWOO 프린터 발견 → 포트: ${port}`);
  } else {
    console.warn('[Printer] SEWOO 프린터를 찾을 수 없습니다. LPT1으로 시도합니다.');
  }
  const interfacePath = `\\\\.\\${port || 'LPT1'}`;

  printerInstance = new ThermalPrinter({
    type: PrinterTypes.EPSON,
    interface: interfacePath,
    characterSet: 'PC437_USA',
    removeSpecialCharacters: false,
    lineCharacter: "=",
    options: {
      timeout: 5000
    }
  });

  return printerInstance;
}

/**
 * 프린터 연결 상태 확인
 *
 * @returns {Promise<boolean>} 연결 성공 여부
 *
 * Windows: fs.existsSync가 디바이스 경로(\\.\LPT1)를 인식하지 못하므로
 *          wmic으로 프린터 오프라인 여부를 확인
 */
export async function checkPrinterStatus() {
  try {
    initPrinter();
    // CSV 컬럼: Node(0), Name(1), WorkOffline(2)
    const offline = querySewooPrinter(['Name', 'WorkOffline'], 2);
    if (offline) {
      return offline.toUpperCase() === 'FALSE'; // FALSE = 온라인
    }
    return findPrinterPort() !== null;
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
