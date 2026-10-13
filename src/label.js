/**
 * 픽업 이름표 ESC/POS 명령 생성기
 *
 * 영수증과 같은 58mm 용지(영문 32자 폭) 기준이다. 이름표 하나를 찍고 자르기를 반복한다.
 * - 이름: 4배 면적(가로·세로 2배)이라 한 줄에 영문 16자, 한글 8자
 * - 상품명: 세로 2배라 폭은 그대로 32자, 두 줄까지
 */

const LINE_WIDTH = 32;
const NAME_WIDTH = 16;
const PRODUCT_MAX_LINES = 2;

// ASCII 밖의 글자는 모두 2폭으로 센다. 한글이 2폭이고, 그 밖의 글자를 1폭으로 세어 줄이 넘치는 것보다 일찍 자르는 쪽이 안전하다.
const charWidth = (ch) => (ch.charCodeAt(0) > 0x7f ? 2 : 1);

/**
 * 글자 폭 기준으로 줄을 나눈다. maxLines를 넘는 부분은 버린다.
 *
 * @param {string} text
 * @param {number} width - 한 줄 폭 (영문 기준 글자 수)
 * @param {number} maxLines
 * @returns {string[]}
 */
export function splitByWidth(text, width, maxLines) {
  const lines = [];
  let line = '';
  let lineWidth = 0;
  for (const ch of text) {
    const w = charWidth(ch);
    if (lineWidth + w > width) {
      lines.push(line);
      if (lines.length === maxLines) return lines;
      line = '';
      lineWidth = 0;
    }
    line += ch;
    lineWidth += w;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * 좌측 텍스트와 우측 텍스트를 한 줄 양 끝에 놓는다.
 */
function formatRow(left, right, width = LINE_WIDTH) {
  const used = [...left, ...right].reduce((sum, ch) => sum + charWidth(ch), 0);
  return left + ' '.repeat(Math.max(1, width - used)) + right;
}

/**
 * 이름표 목록을 ESC/POS 명령으로 변환한다. 이름표마다 용지를 자른다.
 *
 * @param {ThermalPrinter} printer - 프린터 인스턴스
 * @param {Array<{name: string, productName: string, seq: string, customerTotal: number, contact?: string}>} labels
 *
 * 이름표 한 장:
 * 1. 이름 (4배 면적, 볼드) — 고객이 멀리서 찾는 글자
 * 2. 상품명 (세로 2배, 볼드) — 직원이 상품과 맞춰 보는 글자
 * 3. [몇 번째/수량] + 받을 상품 수
 * 4. 뒷번호·닉네임 (있을 때만)
 */
export function buildLabels(printer, labels) {
  labels.forEach((label) => {
    printer.alignLeft();

    printer.setTextQuadArea();
    printer.bold(true);
    printer.println(splitByWidth(label.name, NAME_WIDTH, 1)[0] || '');

    printer.setTextNormal();
    printer.setTextDoubleHeight();
    splitByWidth(label.productName || '', LINE_WIDTH, PRODUCT_MAX_LINES)
      .forEach((line) => printer.println(line));
    printer.bold(false);
    printer.setTextNormal();

    printer.println(formatRow(`[${label.seq}]`, `받을 상품 총 ${label.customerTotal}개`));
    if (label.contact) {
      printer.println(splitByWidth(label.contact, LINE_WIDTH, 1)[0]);
    }

    // 용지 여백 추가 (절단 시 내용 잘림 방지)
    printer.newLine();
    printer.newLine();
    printer.newLine();

    printer.cut();
  });
}
