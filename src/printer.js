import { ThermalPrinter, PrinterTypes } from 'node-thermal-printer';
import { execSync } from 'child_process';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * ESC/POS 프린터 연결 및 출력 래퍼
 *
 * 기술적 결정:
 * 1. USB 인터페이스 사용 (PrinterTypes.EPSON) - 대부분의 58mm 영수증 프린터가 EPSON ESC/POS 호환
 * 2. 싱글톤 패턴으로 프린터 인스턴스 관리 - 동시 출력 충돌 방지
 * 3. wmic으로 SEWOO 프린터 자동 탐색
 * 4. Windows 프린터 스풀러 API로 RAW 데이터 전송 (fs.writeFile은 가상 포트 미지원)
 */

let printerInstance = null;
let sewooPrinterName = null;

/**
 * Windows 프린터 스풀러에 RAW 데이터를 전송하는 PowerShell 스크립트
 *
 * winspool.Drv의 Win32 API를 P/Invoke로 호출:
 * OpenPrinter → StartDocPrinter(RAW) → StartPagePrinter → WritePrinter → 정리
 */
const RAW_PRINT_SCRIPT = `param([string]$FilePath, [string]$PrinterName)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
public class DOCINFOA {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
}

public class RawPrinterHelper {
    [DllImport("winspool.Drv", EntryPoint="OpenPrinterA", SetLastError=true)]
    public static extern bool OpenPrinter([MarshalAs(UnmanagedType.LPStr)] string p, out IntPtr h, IntPtr d);
    [DllImport("winspool.Drv", EntryPoint="ClosePrinter", SetLastError=true)]
    public static extern bool ClosePrinter(IntPtr h);
    [DllImport("winspool.Drv", EntryPoint="StartDocPrinterA", SetLastError=true)]
    public static extern bool StartDocPrinter(IntPtr h, Int32 l, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA d);
    [DllImport("winspool.Drv", EntryPoint="EndDocPrinter", SetLastError=true)]
    public static extern bool EndDocPrinter(IntPtr h);
    [DllImport("winspool.Drv", EntryPoint="StartPagePrinter", SetLastError=true)]
    public static extern bool StartPagePrinter(IntPtr h);
    [DllImport("winspool.Drv", EntryPoint="EndPagePrinter", SetLastError=true)]
    public static extern bool EndPagePrinter(IntPtr h);
    [DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true)]
    public static extern bool WritePrinter(IntPtr h, IntPtr p, Int32 c, out Int32 w);

    public static bool Send(string name, byte[] data) {
        IntPtr hPrinter;
        DOCINFOA di = new DOCINFOA();
        di.pDocName = "ESC/POS Receipt";
        di.pDataType = "RAW";
        if (!OpenPrinter(name, out hPrinter, IntPtr.Zero)) return false;
        if (!StartDocPrinter(hPrinter, 1, di)) { ClosePrinter(hPrinter); return false; }
        if (!StartPagePrinter(hPrinter)) { EndDocPrinter(hPrinter); ClosePrinter(hPrinter); return false; }
        IntPtr pBytes = Marshal.AllocCoTaskMem(data.Length);
        Marshal.Copy(data, 0, pBytes, data.Length);
        int written;
        bool ok = WritePrinter(hPrinter, pBytes, data.Length, out written);
        Marshal.FreeCoTaskMem(pBytes);
        EndPagePrinter(hPrinter);
        EndDocPrinter(hPrinter);
        ClosePrinter(hPrinter);
        return ok;
    }
}
"@
` + String.raw`$bytes = [System.IO.File]::ReadAllBytes($FilePath)
if (-not [RawPrinterHelper]::Send($PrinterName, $bytes)) {
    Write-Error "RAW print failed"
    exit 1
}`;

let rawPrintScriptPath = null;

/**
 * PowerShell RAW 출력 스크립트를 임시 디렉토리에 생성 (최초 1회)
 */
function ensureRawPrintScript() {
  if (rawPrintScriptPath && existsSync(rawPrintScriptPath)) {
    return rawPrintScriptPath;
  }
  rawPrintScriptPath = join(tmpdir(), 'onuljang-raw-print.ps1');
  writeFileSync(rawPrintScriptPath, RAW_PRINT_SCRIPT, 'utf-8');
  return rawPrintScriptPath;
}

/**
 * wmic CSV에서 SEWOO 프린터 정보 조회
 *
 * @param {string[]} fields - wmic get 필드 목록
 * @param {number} targetIndex - 반환할 컬럼 인덱스
 * @param {boolean} [cleanAlphaNum=true] - true면 영숫자만 추출, false면 trim만
 * @returns {string|null}
 */
function querySewooPrinter(fields, targetIndex, cleanAlphaNum = true) {
  try {
    const result = execSync(`wmic printer get ${fields.join(',')} /format:csv`, {
      encoding: 'utf-8',
      timeout: 5000
    });
    const lines = result.trim().split('\n');
    for (const line of lines) {
      if (line.toUpperCase().includes('SEWOO')) {
        const columns = line.split(',');
        if (cleanAlphaNum) {
          return columns[targetIndex].replace(/[^A-Za-z0-9]/g, '') || null;
        }
        return columns[targetIndex].replace(/\r/g, '').trim() || null;
      }
    }
    return null;
  } catch (error) {
    return null;
  }
}

function findPrinterPort() {
  return querySewooPrinter(['Name', 'PortName'], 2);
}

/**
 * SEWOO 프린터의 Windows 등록 이름을 반환
 * @returns {string|null} 예: 'SEWOO SLK-TS 100'
 */
function findPrinterName() {
  // CSV 컬럼: Node(0), Name(1) — cleanAlphaNum=false로 원본 이름 보존
  return querySewooPrinter(['Name'], 1, false);
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
  sewooPrinterName = findPrinterName();
  if (port && sewooPrinterName) {
    console.log(`[Printer] ${sewooPrinterName} 발견 → 포트: ${port}`);
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
 * Windows 프린터 스풀러 API를 통해 RAW 데이터 전송:
 * 1. 프린터 내부 버퍼를 임시 .bin 파일로 저장
 * 2. PowerShell 스크립트가 winspool.Drv Win32 API로 프린터 스풀러에 전송
 * 3. 임시 파일 정리
 *
 * @param {ThermalPrinter} printer - 프린터 인스턴스
 * @returns {Promise<void>}
 */
export async function printReceipt(printer) {
  const buffer = printer.getBuffer();
  if (!buffer) throw new Error('출력할 데이터가 없습니다');

  const name = sewooPrinterName || 'SEWOO SLK-TS 100';
  const scriptPath = ensureRawPrintScript();
  const tmpBin = join(tmpdir(), `receipt-${Date.now()}.bin`);
  writeFileSync(tmpBin, buffer);

  try {
    execSync(
      `powershell -ExecutionPolicy Bypass -File "${scriptPath}" -FilePath "${tmpBin}" -PrinterName "${name}"`,
      { encoding: 'utf-8', timeout: 10000 }
    );
    printer.clear();
    console.log('[Printer] 출력 완료');
  } catch (error) {
    console.error('[Printer] 출력 실패:', error.message);
    throw new Error(`프린터 출력 오류: ${error.message}`);
  } finally {
    try { unlinkSync(tmpBin); } catch (e) {}
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
