import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLabels, splitByWidth } from './label.js';

// 호출 순서를 그대로 적는 프린터 대역. node-thermal-printer와 같은 메서드 이름을 쓴다.
function fakePrinter() {
  const calls = [];
  const record = (name) => (...args) => { calls.push([name, ...args]); };
  return {
    calls,
    alignLeft: record('alignLeft'),
    setTextQuadArea: record('setTextQuadArea'),
    setTextDoubleHeight: record('setTextDoubleHeight'),
    setTextNormal: record('setTextNormal'),
    bold: record('bold'),
    println: record('println'),
    newLine: record('newLine'),
    cut: record('cut'),
  };
}

const printed = (printer) => printer.calls.filter(([name]) => name === 'println').map(([, text]) => text);

test('splitByWidth는 한글을 2폭으로 세어 줄을 나누고 maxLines에서 멈춘다', () => {
  assert.deepEqual(splitByWidth('가나다라마', 6, 2), ['가나다', '라마']);
  assert.deepEqual(splitByWidth('가나다라마바사아자', 6, 2), ['가나다', '라마바']);
  assert.deepEqual(splitByWidth('abc가', 4, 2), ['abc', '가']);
  assert.deepEqual(splitByWidth('', 6, 2), []);
});

test('이름표 한 장은 이름, 상품명, 순번과 받을 상품 수, 뒷번호 순서로 찍고 자른다', () => {
  const printer = fakePrinter();
  buildLabels(printer, [
    { name: '홍길동', productName: '딸기', seq: '1/3', customerTotal: 4, contact: '뒷번호 5678 / 과일러버' },
  ]);
  assert.deepEqual(printed(printer), [
    '홍길동',
    '딸기',
    '[1/3]           받을 상품 총 4개',
    '뒷번호 5678 / 과일러버',
  ]);
  assert.equal(printer.calls.at(-1)[0], 'cut');
  // 이름은 4배 면적으로 찍는다
  assert.equal(printer.calls.findIndex(([name]) => name === 'setTextQuadArea') < printer.calls.findIndex(([name]) => name === 'println'), true);
});

test('순번 줄은 영수증 한 줄 폭 32자를 채운다', () => {
  const printer = fakePrinter();
  buildLabels(printer, [{ name: '가', productName: '나', seq: '12/12', customerTotal: 12, contact: '' }]);
  const row = printed(printer)[2];
  const width = [...row].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x7f ? 2 : 1), 0);
  assert.equal(width, 32);
});

test('이름표마다 자르고, 긴 이름은 한글 8자에서, 긴 상품명은 두 줄에서 끊는다', () => {
  const printer = fakePrinter();
  buildLabels(printer, [
    { name: '가나다라마바사아자차', productName: '가'.repeat(40), seq: '1/2', customerTotal: 2, contact: '' },
    { name: '김', productName: '', seq: '2/2', customerTotal: 2 },
  ]);
  assert.equal(printer.calls.filter(([name]) => name === 'cut').length, 2);
  const lines = printed(printer);
  assert.equal(lines[0], '가나다라마바사아');
  assert.deepEqual(lines.slice(1, 3), ['가'.repeat(16), '가'.repeat(16)]);
  // 뒷번호가 없으면 그 줄을 찍지 않고, 상품명이 비어도 이름표는 나온다
  assert.deepEqual(lines.slice(3), ['[1/2]           받을 상품 총 2개', '김', '[2/2]           받을 상품 총 2개']);
});
