/**
 * 공통 티켓 출력기 — 무엇을 찍는지 모르는 줄 단위 ESC/POS 렌더러.
 *
 * <p>화면(어드민 FE)이 라벨 내용을 줄 목록으로 만들어 보내고, 브릿지는 그 줄을 프린터 명령으로 바꿔
 * **티켓 한 장 = 내용 길이만큼 + 커팅 한 번**으로 찍는다. 크롬 인쇄는 드라이버 용지 크기(예: 72×60mm)에
 * 맞춰 통째로 줄이거나 빈 종이를 남기지만, 이 경로는 드라이버 용지 크기를 거치지 않는다(RAW 전송).
 * 라벨 내용이 바뀌어도 매장 PC의 exe를 다시 깔지 않도록 도메인 지식은 여기 두지 않는다.
 *
 * <p>용지 기준 — 72mm 인쇄 폭(운영자 확인 2026-11-20, SEWOO SLK-TS100 · 80mm 롤 · 드라이버 Print Width 72mm).
 * 203dpi = 8점/mm → 72mm = 576점, 기본 글꼴(Font A) 한 글자 = 12점 → 한 줄 48칸. 한글은 두 칸.
 * 프린터 메모리 설정에 기대지 않도록 티켓마다 인쇄 영역(GS L 0 · GS W 576)을 먼저 보낸다.
 */

export const PRINT_WIDTH_MM = 72;
const DOTS_PER_MM = 8;
const FONT_A_DOT_WIDTH = 12;
export const PRINT_WIDTH_DOTS = PRINT_WIDTH_MM * DOTS_PER_MM;
export const PAPER_COLUMNS = PRINT_WIDTH_DOTS / FONT_A_DOT_WIDTH;

/** GS L 0 (왼쪽 여백 0점) + GS W 576 (인쇄 영역 576점). 둘 다 줄 머리에서만 유효하므로 티켓 시작에 보낸다. */
const PRINT_AREA_COMMAND = Buffer.from([
  0x1d, 0x4c, 0x00, 0x00,
  0x1d, 0x57, PRINT_WIDTH_DOTS & 0xff, (PRINT_WIDTH_DOTS >> 8) & 0xff,
]);

/** 커터 날이 인쇄 헤드보다 아래에 있어 마지막 줄이 잘리지 않게 밀어 주는 줄 수 — 배달 영수증과 같은 값. */
const FEED_BEFORE_CUT = 3;

const MAX_TICKETS = 200;
const MAX_LINES_PER_TICKET = 80;
const MAX_TEXT_LENGTH = 500;
const MAX_FEED = 10;

const SIZES = {
  normal: { columns: PAPER_COLUMNS, apply: (p) => p.setTextNormal() },
  tall: { columns: PAPER_COLUMNS, apply: (p) => p.setTextDoubleHeight() },
  wide: { columns: PAPER_COLUMNS / 2, apply: (p) => p.setTextDoubleWidth() },
  big: { columns: PAPER_COLUMNS / 2, apply: (p) => p.setTextQuadArea() },
};
const ALIGNS = {
  left: (p) => p.alignLeft(),
  center: (p) => p.alignCenter(),
  right: (p) => p.alignRight(),
};
const DIVIDER_CHARS = { single: '-', double: '=' };

export class TicketValidationError extends Error {}

const WIDE_CHAR = /[ᄀ-ᇿ⺀-鿿가-힣豈-﫿︰-﹏＀-｠￠-￦]/;

/**
 * 한 줄에서 차지하는 칸 수. 한글·한자·전각 문자는 두 칸.
 * @param {string} text
 * @returns {number}
 */
export function displayWidth(text) {
  let width = 0;
  for (const char of text) width += WIDE_CHAR.test(char) ? 2 : 1;
  return width;
}

/** 칸 수를 넘는 한 단어를 글자 단위로 자른다. */
function splitWord(word, columns) {
  const pieces = [];
  let current = '';
  for (const char of word) {
    if (current && displayWidth(current + char) > columns) {
      pieces.push(current);
      current = '';
    }
    current += char;
  }
  if (current) pieces.push(current);
  return pieces;
}

/**
 * 단어 단위로 접어 각 줄이 칸 수를 넘지 않게 한다. 한 단어가 칸 수보다 길면 글자 단위로 자른다.
 * @param {string} text
 * @param {number} columns
 * @returns {string[]}
 */
export function wrapText(text, columns) {
  const lines = [];
  let current = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word;
    if (displayWidth(candidate) <= columns) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    const pieces = splitWord(word, columns);
    current = pieces.pop() ?? '';
    lines.push(...pieces);
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

function fail(message) {
  throw new TicketValidationError(message);
}

function requireText(value, field, where) {
  if (typeof value !== 'string') fail(`${where}: ${field}는 문자열이어야 합니다`);
  if (value.length > MAX_TEXT_LENGTH) fail(`${where}: ${field}가 ${MAX_TEXT_LENGTH}자를 넘습니다`);
  return value;
}

function pickOption(value, options, fallback, field, where) {
  if (value === undefined || value === null) return fallback;
  if (!Object.hasOwn(options, value)) fail(`${where}: ${field} '${value}'는 지원하지 않습니다 (${Object.keys(options).join('·')})`);
  return value;
}

function parseLine(line, where) {
  if (!line || typeof line !== 'object') fail(`${where}: 줄은 객체여야 합니다`);
  const size = () => pickOption(line.size, SIZES, 'normal', 'size', where);
  const bold = line.bold === true;
  switch (line.type) {
    case 'text':
      return { type: 'text', text: requireText(line.text, 'text', where), size: size(), bold, align: pickOption(line.align, ALIGNS, 'left', 'align', where) };
    case 'row':
      return { type: 'row', left: requireText(line.left, 'left', where), right: requireText(line.right, 'right', where), size: size(), bold };
    case 'divider':
      return { type: 'divider', style: pickOption(line.style, DIVIDER_CHARS, 'single', 'style', where) };
    case 'feed': {
      const count = line.count ?? 1;
      if (!Number.isInteger(count) || count < 1 || count > MAX_FEED) fail(`${where}: feed count는 1~${MAX_FEED} 정수여야 합니다`);
      return { type: 'feed', count };
    }
    default:
      return fail(`${where}: type '${line.type}'는 지원하지 않습니다 (text·row·divider·feed)`);
  }
}

/**
 * 요청 본문을 검증해 기본값을 채운 티켓 목록으로 돌려준다. 틀리면 TicketValidationError.
 * @param {unknown} body
 * @returns {{ lines: object[] }[]}
 */
export function parseTickets(body) {
  const tickets = body && typeof body === 'object' ? body.tickets : undefined;
  if (!Array.isArray(tickets)) fail('tickets 배열이 필요합니다');
  if (tickets.length === 0) fail('tickets가 비어 있습니다');
  if (tickets.length > MAX_TICKETS) fail(`한 번에 ${MAX_TICKETS}장까지 찍을 수 있습니다`);
  return tickets.map((ticket, t) => {
    const lines = ticket && typeof ticket === 'object' ? ticket.lines : undefined;
    if (!Array.isArray(lines) || lines.length === 0) fail(`tickets[${t}]: lines가 비어 있습니다`);
    if (lines.length > MAX_LINES_PER_TICKET) fail(`tickets[${t}]: 한 장에 ${MAX_LINES_PER_TICKET}줄까지입니다`);
    return { lines: lines.map((line, l) => parseLine(line, `tickets[${t}].lines[${l}]`)) };
  });
}

/** 오른쪽 값을 줄 끝에 붙이고, 왼쪽이 길면 남은 칸으로 접어 다음 줄에 잇는다. */
function rowLines(left, right, columns) {
  const rightWidth = displayWidth(right);
  const leftColumns = Math.max(1, columns - rightWidth - 1);
  const [first, ...rest] = wrapText(left, leftColumns);
  const gap = Math.max(1, columns - displayWidth(first) - rightWidth);
  return [`${first}${' '.repeat(gap)}${right}`, ...rest];
}

function renderLine(printer, line) {
  if (line.type === 'feed') {
    for (let i = 0; i < line.count; i += 1) printer.newLine();
    return;
  }
  if (line.type === 'divider') {
    printer.println(DIVIDER_CHARS[line.style].repeat(PAPER_COLUMNS));
    return;
  }
  const size = SIZES[line.size];
  size.apply(printer);
  if (line.bold) printer.bold(true);
  if (line.type === 'text') {
    ALIGNS[line.align](printer);
    wrapText(line.text, size.columns).forEach((text) => printer.println(text));
  } else {
    rowLines(line.left, line.right, size.columns).forEach((text) => printer.println(text));
  }
  if (line.bold) printer.bold(false);
  printer.setTextNormal();
  printer.alignLeft();
}

/**
 * 검증된 티켓을 프린터 버퍼에 쌓는다. 실제 전송은 호출하는 쪽(printReceipt)이 한다.
 * @param {import('node-thermal-printer').ThermalPrinter} printer
 * @param {{ lines: object[] }[]} tickets
 */
export function renderTickets(printer, tickets) {
  for (const ticket of tickets) {
    printer.append(PRINT_AREA_COMMAND);
    printer.setTextNormal();
    printer.alignLeft();
    ticket.lines.forEach((line) => renderLine(printer, line));
    for (let i = 0; i < FEED_BEFORE_CUT; i += 1) printer.newLine();
    printer.cut();
  }
}
