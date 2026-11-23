import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAPER_COLUMNS, PRINT_WIDTH_DOTS, TicketValidationError, displayWidth, parseTickets, renderTickets, wrapText } from './ticket.js';

/** 서버와 같은 길 — 검증해 기본값을 채운 뒤 찍는다. */
const print = (printer, tickets) => renderTickets(printer, parseTickets({ tickets }));

/** 흰 바탕에 왼쪽 위 8×2점만 검은 PNG — 화면이 보내는 그림 줄과 같은 형태. */
async function blackCornerPng(width, height) {
  const { PNG } = await import('pngjs');
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (width * y + x) << 2;
      const black = x < 8 && y < 2;
      png.data[i] = png.data[i + 1] = png.data[i + 2] = black ? 0 : 255;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png).toString('base64');
}

/** 프린터 명령을 순서대로 적어 두는 대역 — node-thermal-printer와 같은 메서드 이름으로 답한다. */
function fakePrinter() {
  const calls = [];
  const record = (name) => (...args) => calls.push(args.length ? [name, ...args] : [name]);
  const printer = {};
  for (const name of [
    'setTextNormal', 'setTextDoubleHeight', 'setTextDoubleWidth', 'setTextQuadArea',
    'alignLeft', 'alignCenter', 'alignRight', 'bold', 'println', 'newLine', 'cut', 'clear', 'append', 'printImageBuffer',
  ]) {
    printer[name] = record(name);
  }
  return { printer, calls, printed: () => calls.filter((c) => c[0] === 'println').map((c) => c[1]) };
}

test('72mm 인쇄 폭 = 576점 = 기본 글꼴 48칸', () => {
  assert.equal(PRINT_WIDTH_DOTS, 576);
  assert.equal(PAPER_COLUMNS, 48);
});

test('티켓마다 맨 앞에 인쇄 영역(왼쪽 여백 0 · 폭 576점)을 보낸다 — 프린터 메모리 설정에 기대지 않는다', async () => {
  const { printer, calls } = fakePrinter();
  await print(printer, [{ lines: [{ type: 'text', text: 'a' }] }, { lines: [{ type: 'text', text: 'b' }] }]);
  const areas = calls.filter((c) => c[0] === 'append').map((c) => [...c[1]]);
  assert.deepEqual(areas, [
    [0x1d, 0x4c, 0x00, 0x00, 0x1d, 0x57, 0x40, 0x02],
    [0x1d, 0x4c, 0x00, 0x00, 0x1d, 0x57, 0x40, 0x02],
  ]);
  assert.equal(calls[0][0], 'append');
});

test('한글은 두 칸, 영문·숫자는 한 칸으로 센다', () => {
  assert.equal(displayWidth('B2B-261119'), 10);
  assert.equal(displayWidth('과일맛집'), 8);
  assert.equal(displayWidth('10박스'), 6);
});

test('긴 문장은 단어 단위로 접고, 한 줄이 칸 수를 넘지 않는다', () => {
  const lines = wrapText('서울 송파구 송이로20길 12-7 1층 달달퐁 매장 앞', 20);
  for (const line of lines) assert.ok(displayWidth(line) <= 20, line);
  assert.equal(lines.join(' '), '서울 송파구 송이로20길 12-7 1층 달달퐁 매장 앞');
});

test('칸 수보다 긴 한 단어는 글자 단위로 자른다', () => {
  const lines = wrapText('가나다라마바사아자차', 8);
  assert.deepEqual(lines, ['가나다라', '마바사아', '자차']);
});

test('티켓마다 마지막에 여백을 두고 자른다 — 한 장 = 한 번 커팅', async () => {
  const { printer, calls } = fakePrinter();
  await print(printer, [
    { lines: [{ type: 'text', text: '첫 장' }] },
    { lines: [{ type: 'text', text: '둘째 장' }] },
  ]);
  assert.equal(calls.filter((c) => c[0] === 'cut').length, 2);
  const lastCut = calls.map((c) => c[0]).lastIndexOf('cut');
  assert.equal(lastCut, calls.length - 1);
});

test('크기·굵기·정렬은 줄마다 걸고 줄이 끝나면 보통으로 되돌린다', async () => {
  const { printer, calls } = fakePrinter();
  await print(printer, [{ lines: [{ type: 'text', text: 'B2B-261119-055', size: 'big', bold: true, align: 'center' }] }]);
  const names = calls.map((c) => c[0]);
  const at = names.indexOf('println');
  assert.ok(names.slice(0, at).includes('setTextQuadArea'));
  assert.ok(names.slice(0, at).includes('alignCenter'));
  assert.deepEqual(calls.slice(0, at).find((c) => c[0] === 'bold'), ['bold', true]);
  const after = names.slice(at + 1);
  assert.ok(after.includes('setTextNormal'));
  assert.ok(after.includes('alignLeft'));
});

test('큰 글자는 칸 수가 절반이라 그 폭에 맞춰 접는다', async () => {
  const { printer, printed } = fakePrinter();
  await print(printer, [{ lines: [{ type: 'text', text: '가'.repeat(20), size: 'big' }] }]);
  for (const line of printed()) assert.ok(displayWidth(line) <= PAPER_COLUMNS / 2, line);
});

test('row는 오른쪽 값을 줄 끝에 붙이고, 왼쪽이 길면 다음 줄로 넘긴다', async () => {
  const { printer, printed } = fakePrinter();
  const left = '하동 설향 딸기 (4*5 / 2kg) 4*5사이즈 특품 선별 박스 포장';
  await print(printer, [{ lines: [{ type: 'row', left, right: '10박스' }] }]);
  const lines = printed();
  assert.ok(lines.length >= 2);
  assert.ok(lines[0].endsWith('10박스'));
  assert.equal(displayWidth(lines[0]), PAPER_COLUMNS);
  for (const line of lines) assert.ok(displayWidth(line) <= PAPER_COLUMNS, line);
  assert.ok(!lines.slice(1).some((line) => line.includes('10박스')));
});

test('구분선은 용지 폭만큼 찍는다', async () => {
  const { printer, printed } = fakePrinter();
  await print(printer, [{ lines: [{ type: 'divider' }, { type: 'divider', style: 'double' }] }]);
  assert.deepEqual(printed(), ['-'.repeat(PAPER_COLUMNS), '='.repeat(PAPER_COLUMNS)]);
});

test('형식이 틀린 요청은 무엇이 틀렸는지 알려 주며 거절한다', () => {
  assert.throws(() => parseTickets({}), TicketValidationError);
  assert.throws(() => parseTickets({ tickets: [] }), /비어/);
  assert.throws(() => parseTickets({ tickets: [{ lines: [{ type: 'barcode' }] }] }), /type/);
  assert.throws(() => parseTickets({ tickets: [{ lines: [{ type: 'text', text: 'a', size: 'huge' }] }] }), /size/);
  assert.throws(() => parseTickets({ tickets: [{ lines: [{ type: 'row', left: 'a' }] }] }), /right/);
});

test('올바른 요청은 기본값을 채워 돌려준다', () => {
  const tickets = parseTickets({ tickets: [{ lines: [{ type: 'text', text: '안녕' }, { type: 'feed' }] }] });
  assert.deepEqual(tickets[0].lines[0], { type: 'text', text: '안녕', size: 'normal', bold: false, align: 'left' });
  assert.deepEqual(tickets[0].lines[1], { type: 'feed', count: 1 });
});

test('실물 라이브러리로 찍으면 인쇄 영역·한글 코드 페이지(EUC-KR)·커팅 명령이 버퍼에 들어간다', async () => {
  const { ThermalPrinter, PrinterTypes } = await import('node-thermal-printer');
  const printer = new ThermalPrinter({ type: PrinterTypes.EPSON, interface: 'tcp://127.0.0.1:9', characterSet: 'PC437_USA' });
  await print(printer, [{ lines: [{ type: 'text', text: '받는 곳 차민아', size: 'big', bold: true }, { type: 'row', left: '박스 수', right: '10박스' }] }]);
  const buffer = printer.getBuffer();
  assert.ok(buffer.includes(Buffer.from([0x1d, 0x57, 0x40, 0x02])), '인쇄 영역 576점');
  assert.ok(buffer.includes(Buffer.from([0x1b, 0x52, 0x0d])), '한글 코드 페이지 전환');
  assert.ok(buffer.includes(Buffer.from([0xc2, 0xf7])), "EUC-KR '차'");
  assert.ok(buffer.includes(Buffer.from([0x1d, 0x56])), '커팅');
});

test('그림 줄은 폭 576점 이하 PNG만 받는다 — 넘으면 프린터가 오른쪽을 잘라 버린다', async () => {
  const ok = await blackCornerPng(576, 40);
  assert.equal(parseTickets({ tickets: [{ lines: [{ type: 'image', png: ok }] }] })[0].lines[0].width, 576);
  const wide = await blackCornerPng(584, 40);
  assert.throws(() => parseTickets({ tickets: [{ lines: [{ type: 'image', png: wide }] }] }), /폭 584점/);
  assert.throws(() => parseTickets({ tickets: [{ lines: [{ type: 'image' }] }] }), /png/);
  assert.throws(() => parseTickets({ tickets: [{ lines: [{ type: 'image', png: 'not base64!' }] }] }), /base64/);
  assert.throws(() => parseTickets({ tickets: [{ lines: [{ type: 'image', png: Buffer.from('GIF89a-not-a-png-file-at-all').toString('base64') }] }] }), /PNG/);
});

test('그림 줄도 티켓 한 장 = 인쇄 영역 → 그림 → 여백 → 커팅 순서로 찍는다', async () => {
  const { printer, calls } = fakePrinter();
  await print(printer, [{ lines: [{ type: 'image', png: await blackCornerPng(576, 40) }] }]);
  const names = calls.map((c) => c[0]);
  assert.equal(names[0], 'append');
  assert.ok(names.indexOf('printImageBuffer') < names.indexOf('cut'));
  assert.equal(names.at(-1), 'cut');
});

test('실물 라이브러리로 그림을 찍으면 GS v 0 래스터(가로 72바이트)와 검은 점이 버퍼에 들어간다', async () => {
  const { ThermalPrinter, PrinterTypes } = await import('node-thermal-printer');
  const printer = new ThermalPrinter({ type: PrinterTypes.EPSON, interface: 'tcp://127.0.0.1:9', characterSet: 'PC437_USA' });
  await print(printer, [{ lines: [{ type: 'image', png: await blackCornerPng(576, 40) }] }]);
  const buffer = printer.getBuffer();
  const at = buffer.indexOf(Buffer.from([0x1d, 0x76, 0x30]));
  assert.ok(at >= 0, '래스터 명령');
  assert.deepEqual([...buffer.subarray(at + 4, at + 8)], [72, 0, 40, 0], '가로 72바이트 · 세로 40줄');
  assert.equal(buffer[at + 8], 0xff, '첫 줄 왼쪽 8점은 검정');
  assert.equal(buffer[at + 9], 0x00, '그 오른쪽은 흰색');
  assert.ok(buffer.includes(Buffer.from([0x1d, 0x56])), '커팅');
});
